// Window-side state: a mirror of what the backend holds, kept current by events.

import { useSyncExternalStore } from 'react'
import type { AppState, SearchHit, WebService, WebState } from '@shared/ipc'
import type {
  ApprovalRequest,
  Conversation,
  HandoffVariant,
  MemoryNote,
  Message,
  PermissionDenial,
  Profile,
  ProviderChoice,
  ProviderId,
  ProviderUsage,
  RouteDecision,
  RunMode,
  SavedPrompt,
  SyncRecord
} from '@shared/types'

export type View = { kind: 'chat'; conversationId?: string; focusMessageId?: string } | { kind: 'web'; service: WebService } | { kind: 'settings'; tab?: string }

/** Choices made before a conversation exists. */
export interface Draft {
  provider: ProviderChoice
  models: Partial<Record<ProviderId, string>>
  mode: RunMode
  private: boolean
}

export interface UiState {
  app: AppState | null
  view: View
  messages: Record<string, Message[]>
  streaming: Record<string, Message>
  routes: Record<string, RouteDecision>
  approvals: Record<string, { messageId: string; request: ApprovalRequest }[]>
  denials: Record<string, { messageId: string; denials: PermissionDenial[] }>
  web: Partial<Record<WebService, WebState>>
  draft: Draft
  /** Context file chosen for the next turn after a switch. */
  variants: Record<string, HandoffVariant>
  /** Limit banners the user closed, by "conversation:provider:window". */
  dismissed: Record<string, true>
  dialog: null | { kind: 'search' } | { kind: 'switch'; conversationId: string; target?: ProviderId }
  toast: string
}

let state: UiState = {
  app: null,
  view: { kind: 'chat' },
  messages: {},
  streaming: {},
  routes: {},
  approvals: {},
  denials: {},
  web: {},
  draft: { provider: 'auto', models: {}, mode: 'chat', private: false },
  variants: {},
  dismissed: {},
  dialog: null,
  toast: ''
}

const listeners = new Set<() => void>()

export function getState(): UiState {
  return state
}

export function setState(patch: Partial<UiState> | ((s: UiState) => Partial<UiState>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...next }
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Select a slice of state. The selector must return a value that is stable when nothing changed. */
export function useUi<T>(selector: (s: UiState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state))
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function toast(message: string): void {
  setState({ toast: message })
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => setState({ toast: '' }), 4200)
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id)
  if (idx < 0) return [...list, item]
  const next = list.slice()
  next[idx] = item
  return next
}

function sortMessages(list: Message[]): Message[] {
  return list.slice().sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

function applyRecords(records: SyncRecord[]): void {
  const app = state.app
  if (!app) return
  let conversations = app.conversations
  let notes = app.notes
  let prompts = app.prompts
  let profile = app.profile
  let usage = app.usage
  let messages = state.messages
  let streaming = state.streaming

  for (const r of records) {
    switch (r.kind) {
      case 'conversation': {
        const c = r.data as Conversation
        conversations = r.deleted ? conversations.filter((x) => x.id !== r.id) : upsert(conversations, c)
        break
      }
      case 'note':
        notes = r.deleted ? notes.filter((x) => x.id !== r.id) : upsert(notes, r.data as MemoryNote)
        break
      case 'prompt':
        prompts = r.deleted ? prompts.filter((x) => x.id !== r.id) : upsert(prompts, r.data as SavedPrompt)
        break
      case 'profile':
        profile = r.data as Profile
        break
      case 'usage': {
        const u = r.data as ProviderUsage
        usage = { ...usage, [u.provider]: u }
        break
      }
      case 'message': {
        const m = r.data as Message
        if (streaming[m.id]) {
          streaming = { ...streaming }
          delete streaming[m.id]
        }
        const loaded = messages[m.conversationId]
        if (!loaded) break
        const next = r.deleted ? loaded.filter((x) => x.id !== m.id) : sortMessages(upsert(loaded, m))
        messages = { ...messages, [m.conversationId]: next }
        break
      }
    }
  }

  let view = state.view
  const openId = view.kind === 'chat' ? view.conversationId : undefined
  if (openId && !conversations.some((c) => c.id === openId)) view = { kind: 'chat' }
  setState({ app: { ...app, conversations, notes, prompts, profile, usage }, messages, streaming, view })
}

export async function boot(): Promise<void> {
  const api = window.api
  api.on('records', applyRecords)
  api.on('stream', (m) => setState((s) => ({ streaming: { ...s.streaming, [m.id]: m } })))
  api.on('busy', ({ conversationId, busy }) =>
    setState((s) => {
      if (!s.app) return {}
      const set = new Set(s.app.busy)
      if (busy) set.add(conversationId)
      else set.delete(conversationId)
      const patch: Partial<UiState> = { app: { ...s.app, busy: [...set] } }
      if (!busy) {
        // Anything still marked as streaming for this conversation is finished or was discarded.
        const streaming = Object.fromEntries(Object.entries(s.streaming).filter(([, m]) => m.conversationId !== conversationId))
        const approvals = { ...s.approvals }
        delete approvals[conversationId]
        Object.assign(patch, { streaming, approvals })
      }
      return patch
    })
  )
  api.on('route', ({ conversationId, decision }) => setState((s) => ({ routes: { ...s.routes, [conversationId]: decision } })))
  api.on('approval', ({ conversationId, messageId, request }) =>
    setState((s) => ({ approvals: { ...s.approvals, [conversationId]: [...(s.approvals[conversationId] ?? []), { messageId, request }] } }))
  )
  api.on('denials', ({ conversationId, messageId, denials }) => setState((s) => ({ denials: { ...s.denials, [conversationId]: { messageId, denials } } })))
  api.on('providers', ({ providers, localModels }) => setState((s) => (s.app ? { app: { ...s.app, providers, localModels } } : {})))
  api.on('hub', (hub) => setState((s) => (s.app ? { app: { ...s.app, hub } } : {})))
  api.on('settings', (settings) => setState((s) => (s.app ? { app: { ...s.app, settings } } : {})))
  api.on('web', (web) => setState((s) => ({ web: { ...s.web, [web.service]: web } })))
  api.on('command', (command) => {
    if (command === 'new-chat') openChat(undefined)
    else if (command === 'search') setState({ dialog: { kind: 'search' } })
    else setState({ view: { kind: 'settings' } })
  })

  const app = await api.state()
  setState({ app, draft: { provider: app.settings.defaultProvider, models: {}, mode: app.settings.defaultMode, private: false } })
}

export async function loadMessages(conversationId: string): Promise<void> {
  if (state.messages[conversationId]) return
  const list = await window.api.messages(conversationId)
  setState((s) => ({ messages: { ...s.messages, [conversationId]: sortMessages(list) } }))
}

export function openChat(conversationId: string | undefined, focusMessageId?: string): void {
  const app = state.app
  const patch: Partial<UiState> = { view: { kind: 'chat', conversationId, focusMessageId }, dialog: null }
  if (!conversationId && app) patch.draft = { provider: app.settings.defaultProvider, models: {}, mode: app.settings.defaultMode, private: false }
  setState(patch)
  if (conversationId) void loadMessages(conversationId)
}

export function openSearchHit(hit: SearchHit): void {
  openChat(hit.conversationId, hit.messageId)
}

export function dismissRemoved(conversationId: string): void {
  setState((s) => {
    const denials = { ...s.denials }
    delete denials[conversationId]
    return { denials }
  })
}

/** Turn the choices made on the new-chat screen into a saved conversation and open it. */
export async function createFromDraft(): Promise<Conversation> {
  const d = state.draft
  const conv = await window.api.createConversation({ provider: d.provider, models: d.models, mode: d.mode, private: d.private || undefined })
  setState((s) => ({ messages: { ...s.messages, [conv.id]: s.messages[conv.id] ?? [] }, view: { kind: 'chat', conversationId: conv.id } }))
  return conv
}
