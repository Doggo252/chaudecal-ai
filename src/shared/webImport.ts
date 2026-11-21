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
  /** The site's project the chat is in, if any. */
  projectId?: string
}

/** A project on the site: its instructions and the files kept in it. */
export interface RemoteProject {
  remoteId: string
  name: string
  instructions: string
  files: { name: string; text: string }[]
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
  /** The account's projects, with their instructions and files, all pages of them. `found` hears how many so far. */
  projects?(fetch: (path: string) => Promise<unknown>, session: SiteSession, pause: () => Promise<void>, found?: (n: number) => void): Promise<RemoteProject[]>
}

export function conversationIdFor(service: Site, remoteId: string): string {
  return `web-${service}-${remoteId}`
}

export function messageIdFor(service: Site, remoteId: string): string {
  return `web-${service}-m-${remoteId}`
}

export function projectIdFor(service: Site, remoteId: string): string {
  return `web-${service}-p-${remoteId}`
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

/**
 * ChatGPT wraps rich pieces of an answer in private-use markers:
 * \ue200kind\ue202data\ue201. An "entity" is a named place, hotel, person or thing
 * that ChatGPT shows as a link: its name stays. Citations, image groups, maps and
 * product cards have nothing to show here, so they go. The older 【citation】 form goes too.
 */
export function cleanChatgptText(text: string): string {
  return text
    .replace(/\ue200([^\ue201]*)\ue201/g, (_all, inner: string) => {
      const [kind, ...rest] = inner.split('\ue202')
      if (kind === 'entity') {
        try {
          const parts = JSON.parse(rest.join('\ue202')) as unknown
          if (Array.isArray(parts) && typeof parts[1] === 'string') return parts[1]
        } catch {
          // Not readable: dropped like the rest.
        }
      }
      return ''
    })
    .replace(/\u3010[^\u3011]*\u3011/g, '')
    .replace(/[\ue200-\ue2ff]/g, '')
}

/** Raised when the way chats are read changes, so chats already brought in are read again. */
export const READER_VERSION: Record<Site, number> = { claude: 1, chatgpt: 2 }

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
  const gizmo = str(it.gizmo_id)
  return {
    remoteId,
    title: str(it.title) || 'Untitled',
    createdAt: toMillis(it.create_time),
    updatedAt: toMillis(it.update_time) || toMillis(it.create_time),
    // Projects are gizmos whose ids start with g-p-. Other gizmos are custom GPTs.
    ...(gizmo.startsWith('g-p-') ? { projectId: gizmo } : {})
  }
}

const PAGE = 50
/** Stops a list that never ends, for example if the site ignores the page number. */
const MAX_PAGES = 400
/** Projects asked for at a time on claude.ai. */
const PROJECT_PAGE = 200

export /** Every ChatGPT project, following the sidebar's pages until a page brings nothing new. */
async function chatgptProjects(fetch: (path: string) => Promise<unknown>, pause: () => Promise<void>, found?: (n: number) => void): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let cursor = ''
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = obj(await fetch(`/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0&cursor=${encodeURIComponent(cursor)}`))
    let fresh = 0
    for (const item of arr(res.items)) {
      const g = obj(obj(obj(item).gizmo).gizmo)
      const id = str(g.id)
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(g)
      fresh++
    }
    found?.(out.length)
    cursor = res.cursor === null || res.cursor === undefined ? '' : String(res.cursor)
    if (!fresh || !cursor) break
    await pause()
  }
  return out
}

const chatgpt: SiteApi = {
  async open(fetch) {
    const token = str(obj(await fetch('/api/auth/session')).accessToken)
    return token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
  },
  async list(fetch, _session, pause) {
    const out: RemoteSummary[] = []
    const seen = new Set<string>()
    const take = (items: unknown[], project?: string) => {
      let fresh = 0
      for (const item of items) {
        const s = chatgptSummary(item)
        if (s && !seen.has(s.remoteId)) {
          seen.add(s.remoteId)
          out.push(project ? { ...s, projectId: project } : s)
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
      const projects = (await chatgptProjects(fetch, pause)).map((g) => str(g.id))
      for (const project of projects) {
        let cursor = '0'
        for (let page = 0; page < MAX_PAGES && cursor; page++) {
          const res = obj(await fetch(`/backend-api/gizmos/${encodeURIComponent(project)}/conversations?cursor=${encodeURIComponent(cursor)}&limit=${PAGE}`))
          const items = arr(res.items)
          if (!items.length || !take(items, project)) break
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
  async projects(fetch, _session, pause, found) {
    // ChatGPT keeps a project's name and instructions with it. Its files cannot be read back.
    const out: RemoteProject[] = []
    for (const g of await chatgptProjects(fetch, pause, found)) {
      const id = str(g.id)
      const display = obj(g.display)
      out.push({
        remoteId: id,
        name: str(display.name) || str(g.name) || 'Project',
        instructions: str(g.instructions),
        files: [],
        createdAt: toMillis(g.created_at),
        updatedAt: toMillis(g.updated_at) || toMillis(g.created_at)
      })
    }
    return out
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
  const project = str(it.project_uuid) || str(obj(it.project).uuid)
  return { remoteId, title: str(it.name) || 'Untitled', createdAt: toMillis(it.created_at), updatedAt: toMillis(it.updated_at) || toMillis(it.created_at), ...(project ? { projectId: project } : {}) }
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
  async projects(fetch, session, pause, found) {
    const base = `/api/organizations/${encodeURIComponent(session.org ?? '')}/projects`
    // Page by page, until a short page or one that brings nothing new (a site that
    // ignores the offset gives the same page again). Archived projects come too.
    const items: Record<string, unknown>[] = []
    const seen = new Set<string>()
    for (let page = 0; page < MAX_PAGES; page++) {
      const listed = await fetch(`${base}?include_harmony_projects=true&limit=${PROJECT_PAGE}&offset=${page * PROJECT_PAGE}`)
      const got = (Array.isArray(listed) ? listed : arr(obj(listed).data)).map(obj)
      let fresh = 0
      for (const p of got) {
        const id = str(p.uuid)
        if (!id || seen.has(id)) continue
        seen.add(id)
        items.push(p)
        fresh++
      }
      found?.(items.length)
      if (!fresh || got.length < PROJECT_PAGE) break
      await pause()
    }
    const out: RemoteProject[] = []
    for (const p of items) {
      const id = str(p.uuid)
      // The instructions and files come with the project's own page of data.
      let instructions = str(p.prompt_template)
      let files: { name: string; text: string }[] = []
      try {
        if (!instructions) instructions = str(obj(await fetch(`${base}/${encodeURIComponent(id)}`)).prompt_template)
        files = arr(await fetch(`${base}/${encodeURIComponent(id)}/docs`))
          .map(obj)
          .map((d) => ({ name: str(d.file_name) || 'document.txt', text: str(d.content).slice(0, 200_000) }))
          .filter((d) => d.text)
      } catch (e) {
        if (e instanceof Error && e.name === 'SignedOut') throw e
      }
      out.push({ remoteId: id, name: str(p.name) || 'Project', instructions, files, createdAt: toMillis(p.created_at), updatedAt: toMillis(p.updated_at) || toMillis(p.created_at) })
      await pause()
    }
    return out
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

/** A chat's name and times, from the chat itself rather than from the list of chats. */
export function summaryFromChat(service: Site, json: unknown, remoteId: string): RemoteSummary {
  const c = obj(json)
  if (service === 'claude') {
    const project = str(c.project_uuid) || str(obj(c.project).uuid)
    return { remoteId, title: str(c.name) || 'Untitled', createdAt: toMillis(c.created_at), updatedAt: toMillis(c.updated_at) || toMillis(c.created_at), ...(project ? { projectId: project } : {}) }
  }
  const gizmo = str(c.gizmo_id)
  return { remoteId, title: str(c.title) || 'Untitled', createdAt: toMillis(c.create_time), updatedAt: toMillis(c.update_time) || toMillis(c.create_time), ...(gizmo.startsWith('g-p-') ? { projectId: gizmo } : {}) }
}
