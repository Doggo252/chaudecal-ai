// Window-side state: a mirror of what the backend holds, kept current by events.

import { useSyncExternalStore } from 'react'
import type { AppState, SearchHit, WebService, WebState } from '@shared/ipc'
import type {
  ApprovalRequest,
  Attachment,
  Conversation,
  HandoffVariant,
  McpServer,
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
  Project,
  ScheduledTask,
  SyncRecord,
  ConversationKind
} from '@shared/types'
import { kindOf } from '@shared/types'

export type View = { kind: 'chat'; conversationId?: string; focusMessageId?: string } | { kind: 'settings'; tab?: string } | { kind: 'project'; projectId: string } | { kind: 'projects' } | { kind: 'chats' } | { kind: 'artifacts' }

/** Which assistants the app shows. One assistant alone makes the app look and work like that assistant's own app. */
export type Show = 'all' | ProviderId

/** The assistant a chat belongs to, for the show-only choice. Auto chats count for Claude and ChatGPT. */
export function chatShown(c: Conversation, show: Show): boolean {
  if (show === 'all') return true
  const p = c.source?.service ?? c.provider
  return p === show || (p === 'auto' && show !== 'local')
}

/** Projects from a site show with that site's assistant. The app's own projects always show. */
export function projectShown(p: Project, show: Show): boolean {
  if (show === 'all') return true
  const site = /^web-(claude|chatgpt)-p-/.exec(p.id)?.[1]
  return !site || site === show
}

const SHOW_KEY = 'chaude.show'

/** Shows one assistant only, or all of them, and remembers it. */
export function setShow(show: Show): void {
  try {
    localStorage.setItem(SHOW_KEY, show)
  } catch {
    // Remembering is a nicety.
  }
  // Local AI has no regular chats on a website, so it shows the Code tab.
  setState((s) => {
    const tab = show === 'local' ? 'code' : s.tab
    return { show, tab, ...(s.app && s.view.kind === 'chat' && !s.view.conversationId ? { draft: newDraft(s.app, tab, show) } : {}) }
  })
}

/** Choices made before a conversation exists. */
export interface Draft {
  /** A regular chat on claude.ai or chatgpt.com, or a work and code chat on this computer. */
  kind: ConversationKind
  provider: ProviderChoice
  models: Partial<Record<ProviderId, string>>
  mode: RunMode
  private: boolean
  /** Run on the hub machine instead of this one. */
  runOnHub: boolean
  /** Start the chat inside this project. */
  projectId?: string
  /** How hard the model thinks. */
  effort?: string
}

/** The starting choices for a new conversation of this kind. */
export function newDraft(app: AppState, kind: ConversationKind = state.tab, show: Show = state.show): Draft {
  const only = show === 'all' ? undefined : show
  if (kind === 'chat') return { kind, provider: only === 'chatgpt' || (!only && app.settings.defaultProvider === 'chatgpt') ? 'chatgpt' : 'claude', models: {}, mode: 'chat', private: false, runOnHub: false }
  return { kind, provider: only ?? app.settings.defaultProvider, models: {}, mode: app.settings.defaultMode, private: false, runOnHub: app.settings.runOnHubByDefault && !!app.remote?.enabled }
}

const TAB_KEY = 'chaude.tab'

/** Shows regular chats or work and code chats in the sidebar, and remembers which. */
export function setTab(tab: ConversationKind): void {
  try {
    localStorage.setItem(TAB_KEY, tab)
  } catch {
    // Remembering is a nicety.
  }
  setState((s) => ({ tab, ...(s.view.kind === 'chat' && !s.view.conversationId && s.app ? { draft: newDraft(s.app, tab) } : {}) }))
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
  dialog: null | { kind: 'search' } | { kind: 'usage' } | { kind: 'shortcuts' } | { kind: 'switch'; conversationId: string; target?: ProviderId }
  toast: string
  /** On a narrow screen the sidebar slides over the page; this says whether it is out. */
  sideOpen?: boolean
  /** The artifact open in the side panel: the one written at that place in that message. */
  artifact: OpenArtifact | null
  /** Which chats the sidebar lists: regular chats or work and code chats. */
  tab: ConversationKind
  /** All assistants, or one only. */
  show: Show
  /** Messages written while a chat was answering, sent in turn once it finishes. */
  queued: Record<string, Queued[]>
  /** Chats whose queue waits because the answer was stopped. */
  held: Record<string, true>
  /** Chats that finished an answer you have not looked at yet. Kept on this device only. */
  unread: Record<string, true>
}

const UNREAD_KEY = 'chaude:unread'

function readUnread(): Record<string, true> {
  try {
    const ids = JSON.parse(localStorage.getItem(UNREAD_KEY) ?? '[]') as string[]
    return Object.fromEntries(ids.map((id) => [id, true as const]))
  } catch {
    return {}
  }
}

function saveUnread(unread: Record<string, true>) {
  try {
    localStorage.setItem(UNREAD_KEY, JSON.stringify(Object.keys(unread)))
  } catch {
    // Remembering is a nicety.
  }
}

/** Marks a chat as read or unread, here and across restarts. */
export function markUnread(conversationId: string, on: boolean): void {
  if (!!state.unread[conversationId] === on) return
  const unread = { ...state.unread }
  if (on) unread[conversationId] = true
  else delete unread[conversationId]
  saveUnread(unread)
  setState({ unread })
}

/** The chat in front of the user right now, if any. */
function chatInView(): string | undefined {
  return !document.hidden && state.view.kind === 'chat' ? state.view.conversationId : undefined
}

/** A message waiting for its chat to finish answering. */
export interface Queued {
  id: string
  text: string
  compare?: ProviderId[]
  attachments?: Attachment[]
  research?: boolean
  computer?: boolean
}

export interface OpenArtifact {
  conversationId: string
  messageId: string
  index: number
  /** Keep showing the newest version while a reply is being written. */
  follow?: boolean
  /** The panel fills the whole window. */
  wide?: boolean
  tab?: 'preview' | 'code'
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
  draft: { kind: 'chat', provider: 'claude', models: {}, mode: 'chat', private: false, runOnHub: false },
  variants: {},
  dismissed: {},
  dialog: null,
  toast: '',
  artifact: null,
  queued: {},
  held: {},
  unread: readUnread(),
  tab: (() => {
    try {
      return localStorage.getItem(TAB_KEY) === 'code' || localStorage.getItem(SHOW_KEY) === 'local' ? 'code' : 'chat'
    } catch {
      return 'chat'
    }
  })(),
  show: (() => {
    try {
      const v = localStorage.getItem(SHOW_KEY)
      return v === 'claude' || v === 'chatgpt' || v === 'local' ? v : 'all'
    } catch {
      return 'all'
    }
  })()
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

/** Chats a queued message was just sent to, before the backend says they are answering. */
const starting = new Set<string>()

/** Keeps a message until the chat has finished answering. */
export function queueMessage(conversationId: string, item: Omit<Queued, 'id'>): void {
  setState((s) => {
    const held = { ...s.held }
    delete held[conversationId]
    return { queued: { ...s.queued, [conversationId]: [...(s.queued[conversationId] ?? []), { ...item, id: crypto.randomUUID() }] }, held }
  })
  // The answer may have finished while this was being written.
  sendQueued(conversationId)
}

/** Takes a waiting message back off the queue, with the files it carried. */
export function unqueue(conversationId: string, id: string): void {
  const item = state.queued[conversationId]?.find((q) => q.id === id)
  for (const a of item?.attachments ?? []) void window.api.discardAttachment(a.id)
  setState((s) => ({ queued: { ...s.queued, [conversationId]: (s.queued[conversationId] ?? []).filter((q) => q.id !== id) } }))
}

/** Stops the answer. Waiting messages stay until sent or removed, since the user may want to change course. */
export function stopChat(conversationId: string): void {
  if (state.queued[conversationId]?.length) setState((s) => ({ held: { ...s.held, [conversationId]: true } }))
  void window.api.stop(conversationId)
}

/** Sends the next waiting message if the chat is free. `force` also sends after a stop. */
export function sendQueued(conversationId: string, force = false): void {
  const next = state.queued[conversationId]?.[0]
  if (!next || starting.has(conversationId) || state.app?.busy.includes(conversationId)) return
  if (state.held[conversationId] && !force) return
  starting.add(conversationId)
  setState((s) => {
    const held = { ...s.held }
    delete held[conversationId]
    return { queued: { ...s.queued, [conversationId]: (s.queued[conversationId] ?? []).slice(1) }, held }
  })
  const { id: _id, ...rest } = next
  window.api
    .send({ conversationId, ...rest, variant: state.variants[conversationId] })
    .catch((e) => {
      // Not sent: it goes back to the front of the queue and waits for the user.
      setState((s) => ({ queued: { ...s.queued, [conversationId]: [next, ...(s.queued[conversationId] ?? [])] }, held: { ...s.held, [conversationId]: true } }))
      toast(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    })
    .finally(() => starting.delete(conversationId))
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
  let projects = app.projects ?? []
  let tasks = app.tasks ?? []
  let mcp = app.mcp
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
      case 'task':
        tasks = r.deleted ? tasks.filter((x) => x.id !== r.id) : upsert(tasks, r.data as ScheduledTask)
        break
      case 'project':
        projects = r.deleted ? projects.filter((x) => x.id !== r.id) : upsert(projects, r.data as Project).sort((a, b) => a.name.localeCompare(b.name))
        break
      case 'mcp':
        mcp = r.deleted ? mcp.filter((x) => x.id !== r.id) : upsert(mcp, r.data as McpServer).sort((a, b) => a.name.localeCompare(b.name))
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
  if (view.kind === 'project' && !projects.some((p) => p.id === (view as { projectId: string }).projectId)) view = { kind: 'chat' }
  setState({ app: { ...app, conversations, notes, prompts, projects, tasks, mcp, profile, usage }, messages, streaming, view })
}

export async function boot(): Promise<void> {
  const api = window.api
  api.on('records', applyRecords)
  api.on('stream', (m) => setState((s) => ({ streaming: { ...s.streaming, [m.id]: m } })))
  api.on('busy', ({ conversationId, busy }) => {
    if (busy) starting.delete(conversationId)
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
    if (!busy) {
      // An answer that finished out of sight waits with a dot in the sidebar.
      if (chatInView() !== conversationId) markUnread(conversationId, true)
      sendQueued(conversationId)
    }
  })
  document.addEventListener('visibilitychange', () => {
    const id = chatInView()
    if (id) markUnread(id, false)
  })
  api.on('route', ({ conversationId, decision }) => setState((s) => ({ routes: { ...s.routes, [conversationId]: decision } })))
  api.on('approval', ({ conversationId, messageId, request, settled }) =>
    setState((s) => {
      // An answer given on another device, or a request the assistant withdrew, removes the card here too.
      const others = (s.approvals[conversationId] ?? []).filter((a) => a.request.id !== request.id)
      return { approvals: { ...s.approvals, [conversationId]: settled ? others : [...others, { messageId, request }] } }
    })
  )
  api.on('denials', ({ conversationId, messageId, denials }) => setState((s) => ({ denials: { ...s.denials, [conversationId]: { messageId, denials } } })))
  api.on('providers', ({ providers, localModels }) => setState((s) => (s.app ? { app: { ...s.app, providers, localModels } } : {})))
  api.on('hub', (hub) => setState((s) => (s.app ? { app: { ...s.app, hub } } : {})))
  api.on('settings', (settings) => setState((s) => (s.app ? { app: { ...s.app, settings } } : {})))
  api.on('update', (update) => setState((s) => (s.app ? { app: { ...s.app, update } } : {})))
  api.on('remote', (remote) => setState((s) => (s.app ? { app: { ...s.app, remote } } : {})))
  api.on('web', (web) => setState((s) => ({ web: { ...s.web, [web.service]: web } })))
  api.on('webImport', (status) => setState((s) => (s.app ? { app: { ...s.app, webImport: { ...s.app.webImport, [status.service]: status } } } : {})))
  api.on('command', (command) => {
    if (command === 'new-chat') openChat(undefined)
    else if (command === 'search') setState({ dialog: { kind: 'search' } })
    else if (command === 'shortcuts') setState({ dialog: { kind: 'shortcuts' } })
    else setState({ view: { kind: 'settings' } })
  })
  api.on('open', (conversationId) => {
    if (state.app?.conversations.some((c) => c.id === conversationId)) openChat(conversationId)
  })

  const app = await api.state()
  setState({ app, draft: newDraft(app) })
  // Opened by clicking a notification while no window was showing.
  if (app.open && app.conversations.some((c) => c.id === app.open)) openChat(app.open)
}

export async function loadMessages(conversationId: string): Promise<void> {
  if (state.messages[conversationId]) return
  const list = await window.api.messages(conversationId)
  setState((s) => ({ messages: { ...s.messages, [conversationId]: sortMessages(list) } }))
}

export function openChat(conversationId: string | undefined, focusMessageId?: string): void {
  const app = state.app
  const patch: Partial<UiState> = { view: { kind: 'chat', conversationId, focusMessageId }, dialog: null, sideOpen: false }
  if (state.artifact && state.artifact.conversationId !== conversationId) patch.artifact = null
  if (!conversationId && app) patch.draft = newDraft(app)
  // Opening a chat shows its tab in the sidebar.
  const conv = conversationId ? app?.conversations.find((c) => c.id === conversationId) : undefined
  if (conv) patch.tab = kindOf(conv)
  setState(patch)
  if (conversationId) {
    markUnread(conversationId, false)
    void loadMessages(conversationId)
  }
}

/** Opens the chat above or below the open one, in the sidebar's order. */
export function stepChat(by: 1 | -1): void {
  const app = state.app
  if (!app) return
  const list = app.conversations.filter((c) => kindOf(c) === state.tab && !c.archived && chatShown(c, state.show)).sort((a, b) => b.updatedAt - a.updatedAt)
  if (!list.length) return
  const view = state.view
  const at = view.kind === 'chat' ? list.findIndex((c) => c.id === view.conversationId) : -1
  const next = at < 0 ? (by > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, at + by))
  openChat(list[next].id)
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
  const conv = await window.api.createConversation({ ...(d.effort ? { effort: d.effort } : {}), kind: d.kind, provider: d.provider, models: d.models, mode: d.mode, private: d.private || undefined, runOnHub: d.runOnHub || undefined, projectId: d.projectId || undefined })
  setState((s) => ({ messages: { ...s.messages, [conv.id]: s.messages[conv.id] ?? [] }, view: { kind: 'chat', conversationId: conv.id } }))
  return conv
}
