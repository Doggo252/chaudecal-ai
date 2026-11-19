// What claude.ai and chatgpt.com send for a user's chats, and how it becomes the
// app's conversations. Neither site documents this. The shapes follow what
// maintained open-source exporters read as of November 2026, and every reader
// here skips what it does not understand instead of failing. Pure.

import type { Attachment } from './types'

export type Site = 'claude' | 'chatgpt'

export interface RemoteSummary {
  remoteId: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface ImportedMessage {
  remoteId: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  model?: string
  attachments?: Attachment[]
}

export interface ImportedChat extends RemoteSummary {
  service: Site
  url: string
  messages: ImportedMessage[]
}

export interface SiteSession {
  headers: Record<string, string>
  org?: string
}

type Json = Record<string, unknown>
export type Fetch = (path: string, headers?: Record<string, string>) => Promise<unknown>

export interface SiteApi {
  /** Finds the signed-in account. Undefined when nobody is signed in. */
  open(fetch: Fetch): Promise<SiteSession | undefined>
  /** Every chat the account has, in any order. */
  list(fetch: (path: string) => Promise<unknown>, session: SiteSession, pause: () => Promise<void>): Promise<RemoteSummary[]>
  chatPath(session: SiteSession, remoteId: string): string
  readChat(json: unknown, summary: RemoteSummary, origin: string): ImportedChat
}

export function conversationIdFor(service: Site, remoteId: string): string {
  return `web-${service}-${remoteId}`
}

export function messageIdFor(service: Site, remoteId: string): string {
  return `web-${service}-m-${remoteId}`
}

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** A time as milliseconds, from unix seconds, milliseconds or an ISO string. Zero when unknown. */
export function toMillis(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : Math.round(v)
  if (typeof v === 'string' && v) {
    const n = Number(v)
    if (Number.isFinite(n)) return toMillis(n)
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : 0
  }
  return 0
}

/** A fence that the content cannot close by accident. */
function fenceFor(content: string): string {
  const longest = Math.max(0, ...(content.match(/`{3,}/g) ?? []).map((m) => m.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/** An artifact written the way this app finds them: a fenced block with a title. */
export function artifactBlock(language: string, title: string, content: string): string {
  const fence = fenceFor(content)
  const safeTitle = title.replace(/"/g, "'").replace(/\s+/g, ' ').trim() || 'Artifact'
  return `${fence}${language || 'text'} title="${safeTitle}"\n${content.replace(/\n$/, '')}\n${fence}`
}

// ---------- ChatGPT ----------

/** Removes the private-use markers ChatGPT puts around citations, and the older bracket form. */
export function cleanChatgptText(text: string): string {
  return text
    .replace(/[^]*/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/[-]/g, '')
}

function chatgptText(content: Json): string {
  const type = str(content.content_type)
  if (type === 'text' || type === 'multimodal_text') {
    return arr(content.parts)
      .map((p) => {
        if (typeof p === 'string') return p
        const part = obj(p)
        const kind = str(part.content_type)
        if (kind === 'audio_transcription') return str(part.text)
        if (kind === 'image_asset_pointer') return '[Image]'
        return ''
      })
      .filter(Boolean)
      .join('\n\n')
  }
  if (type === 'code' && content.text) return `\`\`\`${str(content.language) || ''}\n${str(content.text)}\n\`\`\``
  return ''
}

const CHATGPT_SKIP = new Set(['thoughts', 'reasoning_recap', 'user_editable_context', 'model_editable_context', 'tether_quote', 'tether_browsing_display', 'tether_browsing_code', 'execution_output', 'system_error'])

/** The messages on the branch the user last saw, oldest first. */
export function chatgptMessages(json: unknown): ImportedMessage[] {
  const chat = obj(json)
  const mapping = obj(chat.mapping)
  let node = str(chat.current_node)
  if (!mapping[node]) node = Object.keys(mapping).find((k) => !arr(obj(mapping[k]).children).length) ?? ''
  const path: Json[] = []
  const seen = new Set<string>()
  while (node && mapping[node] && !seen.has(node)) {
    seen.add(node)
    const entry = obj(mapping[node])
    path.push(entry)
    node = str(entry.parent)
  }
  path.reverse()
  const out: ImportedMessage[] = []
  for (const entry of path) {
    const m = obj(entry.message)
    const role = str(obj(m.author).role)
    if (role !== 'user' && role !== 'assistant') continue
    const meta = obj(m.metadata)
    const content = obj(m.content)
    if (meta.is_visually_hidden_from_conversation || meta.is_thinking_preamble_message) continue
    if (role === 'assistant' && str(m.recipient) && str(m.recipient) !== 'all') continue
    if (CHATGPT_SKIP.has(str(content.content_type))) continue
    let text = cleanChatgptText(chatgptText(content)).trim()
    if (!text) text = str(obj(meta.model_dil_v2).fallbackMarkdown).trim()
    const names = arr(meta.attachments)
      .map((a) => str(obj(a).name))
      .filter(Boolean)
    if (names.length) text = [text, names.map((n) => `[Attached: ${n}]`).join('\n')].filter(Boolean).join('\n\n')
    if (!text) continue
    const message: ImportedMessage = { remoteId: str(m.id) || str(entry.id), role, text, createdAt: toMillis(m.create_time) }
    const model = str(meta.model_slug)
    if (model) message.model = model
    // One answer can arrive as several messages around tool calls. Here it is one.
    const prev = out[out.length - 1]
    if (prev && prev.role === 'assistant' && role === 'assistant') {
      prev.text = `${prev.text}\n\n${text}`
      prev.model ??= message.model
      continue
    }
    out.push(message)
  }
  return out
}

function chatgptSummary(item: unknown): RemoteSummary | undefined {
  const it = obj(item)
  const remoteId = str(it.id)
  if (!remoteId || it.is_temporary_chat) return undefined
  return { remoteId, title: str(it.title) || 'Untitled', createdAt: toMillis(it.create_time), updatedAt: toMillis(it.update_time) || toMillis(it.create_time) }
}

const PAGE = 50
/** Stops a list that never ends, for example if the site ignores the page number. */
const MAX_PAGES = 400

export const chatgpt: SiteApi = {
  async open(fetch) {
    const token = str(obj(await fetch('/api/auth/session')).accessToken)
    return token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
  },
  async list(fetch, _session, pause) {
    const out: RemoteSummary[] = []
    const seen = new Set<string>()
    const take = (items: unknown[]) => {
      let fresh = 0
      for (const item of items) {
        const s = chatgptSummary(item)
        if (s && !seen.has(s.remoteId)) {
          seen.add(s.remoteId)
          out.push(s)
          fresh++
        }
      }
      return fresh
    }
    // Ordinary chats, then archived ones, page by page until a page brings nothing new.
    for (const archived of [false, true]) {
      for (let page = 0; page < MAX_PAGES; page++) {
        const items = arr(obj(await fetch(`/backend-api/conversations?offset=${page * PAGE}&limit=${PAGE}&order=updated${archived ? '&is_archived=true' : ''}`)).items)
        if (!items.length || !take(items)) break
        await pause()
      }
    }
    // Chats inside projects are not in the main list.
    try {
      const sidebar = obj(await fetch('/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0&cursor='))
      const projects = arr(sidebar.items)
        .map((i) => str(obj(obj(obj(i).gizmo).gizmo).id))
        .filter(Boolean)
      for (const project of projects) {
        let cursor = '0'
        for (let page = 0; page < MAX_PAGES && cursor; page++) {
          const res = obj(await fetch(`/backend-api/gizmos/${encodeURIComponent(project)}/conversations?cursor=${encodeURIComponent(cursor)}&limit=${PAGE}`))
          const items = arr(res.items)
          if (!items.length || !take(items)) break
          cursor = res.cursor === null || res.cursor === undefined ? '' : String(res.cursor)
          await pause()
        }
      }
    } catch (e) {
      // Projects are a bonus. Only a lost sign-in stops the run.
      if (!(e instanceof Error && e.name === 'SignedOut')) return out
      throw e
    }
    return out
  },
  chatPath(_session, remoteId) {
    return `/backend-api/conversation/${encodeURIComponent(remoteId)}`
  },
  readChat(json, summary, origin) {
    const chat = obj(json)
    return {
      ...summary,
      title: str(chat.title) || summary.title,
      createdAt: summary.createdAt || toMillis(chat.create_time),
      service: 'chatgpt',
      url: `${origin}/c/${summary.remoteId}`,
      messages: chatgptMessages(json)
    }
  }
}

// ---------- Claude ----------

const ARTIFACT_LANG: Record<string, string> = {
  'application/vnd.ant.react': 'jsx',
  'text/html': 'html',
  'image/svg+xml': 'svg',
  'application/vnd.ant.mermaid': 'mermaid',
  'text/markdown': 'markdown'
}

const EXT_LANG: Record<string, string> = {
  html: 'html',
  htm: 'html',
  jsx: 'jsx',
  tsx: 'tsx',
  svg: 'svg',
  md: 'markdown',
  mmd: 'mermaid',
  mermaid: 'mermaid',
  py: 'python',
  js: 'javascript',
  ts: 'typescript',
  css: 'css',
  json: 'json',
  sh: 'bash',
  sql: 'sql',
  csv: 'csv',
  txt: 'text'
}

/** Artifacts so far in one chat, by their id or file path, so an update can be applied to the last version. */
type ArtifactMemory = Map<string, { language: string; title: string; content: string }>

function replaceOnce(text: string, from: string, to: string): string {
  const at = from ? text.indexOf(from) : -1
  return at < 0 ? text : text.slice(0, at) + to + text.slice(at + from.length)
}

/** Turns one of Claude's tool calls that makes or changes an artifact into an artifact block. */
function claudeArtifact(name: string, input: Json, memory: ArtifactMemory): string {
  if (name === 'artifacts') {
    const id = str(input.id)
    const command = str(input.command)
    const prior = memory.get(id)
    const type = str(input.type)
    const language = type === 'application/vnd.ant.code' ? str(input.language) || 'text' : (ARTIFACT_LANG[type] ?? prior?.language ?? 'text')
    const title = str(input.title) || prior?.title || 'Artifact'
    const content = command === 'update' ? replaceOnce(prior?.content ?? '', str(input.old_str), str(input.new_str)) : str(input.content)
    if (!content) return ''
    memory.set(id, { language, title, content })
    return artifactBlock(language, title, content)
  }
  if (name === 'create_file' || name === 'str_replace') {
    const path = str(input.path)
    const file = path.split('/').pop() ?? path
    const prior = memory.get(path)
    const content = name === 'create_file' ? str(input.file_text) : replaceOnce(prior?.content ?? '', str(input.old_str), str(input.new_str))
    if (!content || (name === 'str_replace' && !prior)) return ''
    const language = EXT_LANG[(file.split('.').pop() ?? '').toLowerCase()] ?? 'text'
    memory.set(path, { language, title: file, content })
    return artifactBlock(language, file, content)
  }
  if (/show_widget$/.test(name) && input.widget_code) return artifactBlock('html', str(input.title) || 'Widget', str(input.widget_code))
  return ''
}

/** The messages on the branch the user last saw, oldest first. */
export function claudeMessages(json: unknown, conversationRemoteId = ''): ImportedMessage[] {
  const chat = obj(json)
  const all = arr(chat.chat_messages).map(obj)
  const byId = new Map(all.map((m) => [str(m.uuid), m]))
  let ordered: Json[] = []
  const leaf = str(chat.current_leaf_message_uuid)
  if (leaf && byId.has(leaf)) {
    const seen = new Set<string>()
    for (let id = leaf; id && byId.has(id) && !seen.has(id); id = str(byId.get(id)!.parent_message_uuid)) {
      seen.add(id)
      ordered.push(byId.get(id)!)
    }
    ordered.reverse()
  } else {
    ordered = [...all].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
  }
  const memory: ArtifactMemory = new Map()
  const out: ImportedMessage[] = []
  for (const m of ordered) {
    const sender = str(m.sender)
    const role = sender === 'human' ? 'user' : sender === 'assistant' ? 'assistant' : undefined
    if (!role) continue
    const parts: string[] = []
    const blocks = arr(m.content).map(obj)
    for (const b of blocks) {
      const type = str(b.type)
      if (type === 'text') parts.push(str(b.text))
      else if (type === 'tool_use') parts.push(claudeArtifact(str(b.name), obj(b.input), memory))
    }
    if (!blocks.length) parts.push(str(m.text))
    const attachments: Attachment[] = []
    arr(m.attachments).forEach((a, i) => {
      const att = obj(a)
      const text = str(att.extracted_content)
      const name = str(att.file_name) || `attachment-${i + 1}.txt`
      if (text) attachments.push({ id: `web-claude-a-${str(m.uuid) || conversationRemoteId}-${i}`, name, mime: 'text/plain', size: Number(att.file_size) || text.length, kind: 'text', text: text.slice(0, 200_000) })
      else parts.push(`[Attached: ${name}]`)
    })
    for (const f of arr(m.files).concat(arr(m.files_v2))) {
      const name = str(obj(f).file_name)
      if (name) parts.push(`[Attached: ${name}]`)
    }
    const text = parts
      .map((p) => p.trim())
      .filter(Boolean)
      .join('\n\n')
    if (!text && !attachments.length) continue
    const message: ImportedMessage = { remoteId: str(m.uuid), role, text, createdAt: toMillis(m.created_at) }
    if (attachments.length) message.attachments = attachments
    out.push(message)
  }
  return out
}

const EMPTY_LEAF = /^0{8}-0{4}-0{4}-0{4}-0{12}$/

function claudeSummary(item: unknown): RemoteSummary | undefined {
  const it = obj(item)
  const remoteId = str(it.uuid)
  if (!remoteId) return undefined
  // A chat with no messages yet has no leaf.
  if ('current_leaf_message_uuid' in it && (!it.current_leaf_message_uuid || EMPTY_LEAF.test(str(it.current_leaf_message_uuid)))) return undefined
  return { remoteId, title: str(it.name) || 'Untitled', createdAt: toMillis(it.created_at), updatedAt: toMillis(it.updated_at) || toMillis(it.created_at) }
}

export const claude: SiteApi = {
  async open(fetch) {
    const orgs = arr(await fetch('/api/organizations')).map(obj)
    const chat = orgs.filter((o) => arr(o.capabilities).includes('chat'))
    const org = str((chat[0] ?? orgs[0])?.uuid)
    return org ? { headers: {}, org } : undefined
  },
  async list(fetch, session, pause) {
    const base = `/api/organizations/${encodeURIComponent(session.org ?? '')}`
    const out: RemoteSummary[] = []
    const seen = new Set<string>()
    const take = (items: unknown[]) => {
      let fresh = 0
      for (const item of items) {
        const it = obj(item)
        if (seen.has(str(it.uuid))) continue
        seen.add(str(it.uuid))
        fresh++
        const s = claudeSummary(item)
        if (s) out.push(s)
      }
      return fresh
    }
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = obj(await fetch(`${base}/chat_conversations_v2?limit=${PAGE}&offset=${page * PAGE}`))
        const items = arr(res.data)
        if (!items.length || !take(items) || res.has_more === false) break
        await pause()
      }
      return out
    } catch (e) {
      // The older list, all in one answer.
      if ((e as { status?: number }).status !== 404) throw e
    }
    take(arr(await fetch(`${base}/chat_conversations`)))
    return out
  },
  chatPath(session, remoteId) {
    return `/api/organizations/${encodeURIComponent(session.org ?? '')}/chat_conversations/${encodeURIComponent(remoteId)}?tree=True&rendering_mode=messages&render_all_tools=true`
  },
  readChat(json, summary, origin) {
    const chat = obj(json)
    return {
      ...summary,
      title: str(chat.name) || summary.title,
      service: 'claude',
      url: `${origin}/chat/${summary.remoteId}`,
      messages: claudeMessages(json, summary.remoteId)
    }
  }
}

export const siteApi: Record<Site, SiteApi> = { claude, chatgpt }
