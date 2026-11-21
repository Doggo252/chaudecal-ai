// Brings the Claude Code and Codex sessions on this computer into the app as code
// chats: ones started in a terminal, in an editor, or in the Claude and ChatGPT
// desktop apps. Each becomes a chat in the Code tab, syncs to the user's other
// devices like any chat, and carries on the same session here when continued.
//
// Sessions the app started itself are skipped, since the app has them already. A
// session continued in the app is not read again, so nothing appears twice.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Conversation, Message, PlanStep, Project, ProviderId, ToolCall } from '@shared/types'
import { applyTaskTool, isTaskTool } from '@shared/taskList'
import { HANDOFF_OPENING, titleFromText } from '@shared/context'
import { claudeToolKind, describeTool, toolLabel } from './providers/claudeParser'
import type { Store } from './store'
import { ensureFolderProject } from './codeProjects'

type Json = Record<string, any>

export interface LocalMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  model?: string
  tools?: ToolCall[]
  /** The task list as this answer left it. */
  plan?: PlanStep[]
}

export interface LocalSession {
  tool: 'claude-code' | 'codex'
  sessionId: string
  cwd: string
  title: string
  createdAt: number
  updatedAt: number
  messages: LocalMessage[]
}

const parseLines = (text: string): Json[] =>
  text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as Json
      } catch {
        return undefined
      }
    })
    .filter((l): l is Json => !!l && typeof l === 'object')

const time = (v: unknown): number => {
  const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(t) ? t : 0
}

/** Text the person typed, without what the tool adds around it (reminders, command echoes, file contents). */
function typedText(raw: string): string {
  const command = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(raw)
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(raw)?.[1]?.trim()
    return `${command[1].startsWith('/') ? command[1] : `/${command[1]}`}${args ? ` ${args}` : ''}`
  }
  raw = raw.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
  if (/^\s*<(local-command-stdout|local-command-stderr|system-reminder|bash-stdout|bash-stderr)/.test(raw) || raw.startsWith('Caveat:')) return ''
  return raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

/** What a background task that finished reported, as a step: "Run the tests" completed. */
export function taskNotices(raw: string): ToolCall[] {
  const notes: ToolCall[] = []
  for (const m of raw.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const body = m[1]
    const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim() ?? ''
    const status = tag('status')
    const summary = tag('summary').replace(/^Background command /, '') || 'A background task finished'
    notes.push({ id: tag('task-id') || `task-${notes.length}`, name: 'Background task', summary, status: /fail|error|kill/i.test(status) ? 'error' : 'done', kind: 'other' })
  }
  return notes
}

/** One Claude Code session file (~/.claude/projects/<folder>/<session>.jsonl). */
export function parseClaudeSession(text: string): LocalSession | undefined {
  const lines = parseLines(text)
  let sessionId = ''
  let cwd = ''
  let title = ''
  const messages: LocalMessage[] = []
  let turn: LocalMessage | undefined
  let steps: PlanStep[] = []
  for (const l of lines) {
    if (l.type === 'custom-title' && typeof l.customTitle === 'string') title = l.customTitle
    if (l.type === 'summary' && typeof l.summary === 'string' && !title) title = l.summary
    if (l.type !== 'user' && l.type !== 'assistant') continue
    if (l.isSidechain || l.isMeta || l.isCompactSummary || l.isVisibleInTranscriptOnly) continue
    sessionId ||= String(l.sessionId ?? '')
    cwd ||= String(l.cwd ?? '')
    const at = time(l.timestamp)
    const content = l.message?.content
    if (l.type === 'user') {
      const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((c: Json) => c?.type === 'text').map((c: Json) => String(c.text ?? '')) : []
      const said = parts.map(typedText).filter(Boolean).join('\n\n')
      const images = Array.isArray(content) ? content.filter((c: Json) => c?.type === 'image').length : 0
      // A background task that finished: not something the person typed, so it shows as a step in the answer it led to.
      const notices = parts.flatMap(taskNotices)
      if (notices.length && !said && !images) {
        turn = { id: String(l.uuid), role: 'assistant', text: '', createdAt: at }
        messages.push(turn)
        ;(turn.tools ??= []).push(...notices)
        continue
      }
      if (!said && !images) continue
      turn = undefined
      messages.push({ id: String(l.uuid), role: 'user', text: [said, images ? `[${images === 1 ? 'An image' : `${images} images`}]` : ''].filter(Boolean).join('\n\n'), createdAt: at })
      continue
    }
    // An answer comes as several entries around tool calls. Here it is one message.
    if (!turn) {
      turn = { id: String(l.uuid), role: 'assistant', text: '', createdAt: at, ...(l.message?.model && l.message.model !== '<synthetic>' ? { model: String(l.message.model) } : {}) }
      messages.push(turn)
    } else if (!turn.model && l.message?.model && l.message.model !== '<synthetic>') turn.model = String(l.message.model)
    for (const c of Array.isArray(content) ? (content as Json[]) : []) {
      if (c?.type === 'text' && String(c.text ?? '').trim()) turn.text = turn.text ? `${turn.text}\n\n${String(c.text).trim()}` : String(c.text).trim()
      if (c?.type === 'tool_use') {
        const name = String(c.name ?? 'Tool')
        // The task list shows as a checklist on the answer, not as a step.
        if (isTaskTool(name)) {
          const next = applyTaskTool(steps, name, c.input)
          if (next) turn.plan = steps = next
          continue
        }
        ;(turn.tools ??= []).push({ id: String(c.id ?? `${turn.id}-${turn.tools?.length ?? 0}`), name: toolLabel(name), summary: describeTool(name, c.input) || name, status: 'done', kind: claudeToolKind(name) })
      }
    }
  }
  const kept = messages.filter((m) => m.role === 'user' || m.text || m.tools?.length || m.plan?.length)
  if (!sessionId || !kept.some((m) => m.role === 'user')) return undefined
  const first = kept.find((m) => m.role === 'user')!
  return {
    tool: 'claude-code',
    sessionId,
    cwd,
    title: title || titleFromText(first.text),
    createdAt: kept[0].createdAt,
    updatedAt: kept[kept.length - 1].createdAt,
    messages: kept
  }
}

/** Raised when the readers change, so every session is read again. */
const SESSION_READER = 3

/** The session's id, from its first lines. */
export function codexSessionId(text: string): string {
  for (const l of parseLines(text.slice(0, 20_000))) if (l.type === 'session_meta') return String(l.payload?.id ?? l.payload?.session_id ?? '')
  return ''
}

/** First messages of Codex's own helper sessions, which are not the person's chats. */
const HELPER_PROMPT = /^(The following is the Codex agent history|You are (a|an) (helpful )?(reviewer|approval|assessor))/i

/** What the person typed to Codex. Its editor extensions wrap the request in context (files mentioned, open tabs) with the request last. */
export function codexTyped(raw: string): string {
  const t = raw.trim()
  if (/^</.test(t) || t.startsWith('# AGENTS.md')) return ''
  const request = /(^|\n)#+ My request for Codex:?\s*\n([\s\S]*)$/.exec(t)
  if (request) return request[2].trim()
  // Only context, with no request in it.
  if (/^# (Files mentioned by the user|Context from my IDE setup)/.test(t)) return ''
  return t
}

/** One Codex session file (~/.codex/sessions/<year>/<month>/<day>/rollout-<time>-<id>.jsonl). */
export function parseCodexSession(text: string): LocalSession | undefined {
  const lines = parseLines(text)
  let sessionId = ''
  let cwd = ''
  const messages: LocalMessage[] = []
  let turn: LocalMessage | undefined
  let steps: PlanStep[] = []
  let model = ''
  let n = 0
  for (const l of lines) {
    const p = (l.payload ?? {}) as Json
    const at = time(l.timestamp)
    if (l.type === 'session_meta') {
      // A session started by another session (a subagent, a reviewer) is part of that one, not a chat of its own.
      if (p.source && typeof p.source === 'object' && ('subagent' in p.source || 'sub_agent' in p.source)) return undefined
      sessionId ||= String(p.id ?? p.session_id ?? '')
      cwd ||= String(p.cwd ?? '')
      continue
    }
    if (l.type === 'turn_context' && typeof p.model === 'string') model = p.model
    if (l.type !== 'response_item') continue
    n++
    if (p.type === 'message' && p.role === 'user') {
      // Codex puts its own context in as user messages, wrapped in tags.
      const said = (Array.isArray(p.content) ? p.content : [])
        .filter((c: Json) => c?.type === 'input_text')
        .map((c: Json) => codexTyped(String(c.text ?? '')))
        .filter(Boolean)
        .join('\n\n')
        .trim()
      if (!said) continue
      // Codex's own helpers (the reviewer that checks a request, for one) run as sessions of their own. They are not the person's.
      if (!messages.length && HELPER_PROMPT.test(said)) return undefined
      turn = undefined
      messages.push({ id: `${sessionId}-${n}`, role: 'user', text: said, createdAt: at })
      continue
    }
    const ensure = () => {
      if (!turn) {
        turn = { id: `${sessionId}-${n}`, role: 'assistant', text: '', createdAt: at, ...(model ? { model } : {}) }
        messages.push(turn)
      }
      return turn
    }
    if (p.type === 'message' && p.role === 'assistant') {
      const said = (Array.isArray(p.content) ? p.content : [])
        .filter((c: Json) => c?.type === 'output_text')
        .map((c: Json) => String(c.text ?? ''))
        .join('\n\n')
        .trim()
      if (said) {
        const t = ensure()
        t.text = t.text ? `${t.text}\n\n${said}` : said
      }
    }
    if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      let input: Json = {}
      try {
        input = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : (p.arguments ?? p.action ?? {})
      } catch {
        input = { input: String(p.input ?? p.arguments ?? '') }
      }
      const command = Array.isArray(input.command) ? input.command.join(' ') : input.command ?? input.cmd
      const t = ensure()
      if (isTaskTool(String(p.name ?? ''))) {
        const next = applyTaskTool(steps, String(p.name), input)
        if (next) t.plan = steps = next
        continue
      }
      ;(t.tools ??= []).push({
        id: String(p.call_id ?? p.id ?? `${t.id}-${t.tools?.length ?? 0}`),
        name: command ? 'Command' : String(p.name ?? 'Tool'),
        summary: String(command ?? describeTool(String(p.name ?? ''), input) ?? '').split('\n')[0].slice(0, 200) || String(p.name ?? 'Tool'),
        status: 'done',
        kind: command ? 'command' : /apply_patch|edit|write/i.test(String(p.name ?? '')) ? 'edit' : 'tool'
      })
    }
  }
  const kept = messages.filter((m) => m.role === 'user' || m.text || m.tools?.length || m.plan?.length)
  if (!sessionId || !kept.some((m) => m.role === 'user')) return undefined
  const first = kept.find((m) => m.role === 'user')!
  return { tool: 'codex', sessionId, cwd, title: titleFromText(first.text), createdAt: kept[0].createdAt, updatedAt: kept[kept.length - 1].createdAt, messages: kept }
}

/** Every session file under a folder, newest first, at most a few levels down. */
/**
 * A folder the app or its tests made for themselves, on any computer: a test's
 * throwaway folder, or the "workspace" folder in the app's data folder where code
 * chats run when no folder was picked.
 */
export function appOwnFolder(cwd: string): boolean {
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  if (parts.some((p) => /^chaudecal-test-/i.test(p))) return true
  // A Claude Code session's own scratch folder, where a helper tried the app's tools out.
  const helper = parts.findIndex((p) => /^claude-\d+$/.test(p))
  if (helper >= 0 && parts.indexOf('scratchpad', helper) > helper) return true
  // The end-to-end check's app folders, but not the pretend home folder it makes, whose projects stand for the user's own.
  return parts.some((p, i) => /^(chaudecal[ -]ai|chaudecal-e2e-(?!home-).+)$/i.test(p) && /^(workspace|tmp)$/i.test(parts[i + 1] ?? ''))
}

function sessionFiles(root: string, depth: number): string[] {
  const out: string[] = []
  const walk = (dir: string, left: number) => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const path = join(dir, e.name)
      if (e.isDirectory() && left > 0 && e.name !== 'subagents') walk(path, left - 1)
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path)
    }
  }
  walk(root, depth)
  return out
}

export interface LocalSessionsOptions {
  home: string
  /** The app's own data folder. Sessions the app started there are skipped. */
  appData: string
  deviceName: string
}

export class LocalSessions {
  constructor(
    private store: Store,
    private options: LocalSessionsOptions,
    private setWorkspace: (conversationId: string, path: string) => void,
    private workspaceOf: (conversationId: string) => string
  ) {}

  /** Sessions the app started itself, in its own data folder, or that its tests started in a throwaway folder. */
  private ours(cwd: string): boolean {
    if (!cwd) return false
    const data = resolve(this.options.appData) + sep
    return (resolve(cwd) + sep).startsWith(data) || appOwnFolder(cwd)
  }

  /**
   * Takes out chats an earlier version brought in from the app's own sessions:
   * its tests and the folder it runs code chats in. Covers every computer's, so
   * one pass cleans up all of them. A chat carried on in the app stays. Runs
   * once for each widening of what counts as the app's own folder.
   */
  tidy(): number {
    if (this.store.kvGet<boolean>('localsessions:tidy2')) return 0
    let n = 0
    for (const c of this.store.list<Conversation>('conversation')) {
      if (!c.origin?.tool || !c.origin.folder) continue
      if ((c.origin.device === this.options.deviceName && this.ours(c.origin.folder)) || appOwnFolder(c.origin.folder)) {
        if (this.forget(c.id)) n++
      }
    }
    // The folder projects those chats made, once nothing is left in them.
    const left = this.store.list<Conversation>('conversation')
    for (const p of this.store.list<Project>('project')) {
      if (p.kind !== 'code' || !p.folder || !appOwnFolder(p.folder) || left.some((c) => c.projectId === p.id)) continue
      this.store.remove('project', p.id)
      n++
    }
    this.store.kvSet('localsessions:tidy2', true)
    return n
  }

  /** Codex keeps the names given to its chats apart from the chats, in one file. */
  private codexNames(): Map<string, string> {
    const names = new Map<string, string>()
    try {
      for (const l of parseLines(readFileSync(join(this.options.home, '.codex', 'session_index.jsonl'), 'utf8'))) {
        if (typeof l.id === 'string' && typeof l.thread_name === 'string' && l.thread_name.trim()) names.set(l.id, l.thread_name.trim())
      }
    } catch {
      // No Codex here, or no names yet.
    }
    return names
  }

  /** Looks for new and changed sessions. Gives back how many chats changed. */
  scan(): number {
    const names = this.codexNames()
    const files = [
      ...sessionFiles(join(this.options.home, '.claude', 'projects'), 1).map((path) => ({ path, tool: 'claude-code' as const })),
      ...sessionFiles(join(this.options.home, '.codex', 'sessions'), 4).map((path) => ({ path, tool: 'codex' as const }))
    ]
    const claimed = this.claimedSessions()
    let changed = 0
    // A chat carried on here may have gone on in a new session since it was last looked at.
    for (const [sessionId, tool] of claimed) if (this.forget(`local-${tool}-${sessionId}`)) changed++
    for (const f of files) {
      let st: { mtimeMs: number; size: number }
      try {
        st = statSync(f.path)
      } catch {
        continue
      }
      const key = `localsession:${f.path}`
      const seen = this.store.kvGet<{ mtimeMs: number; size: number; reader?: number }>(key)
      if (seen && seen.mtimeMs === st.mtimeMs && seen.size === st.size && (seen.reader ?? 1) >= SESSION_READER) continue
      try {
        const text = readFileSync(f.path, 'utf8')
        const session = f.tool === 'claude-code' ? parseClaudeSession(text) : parseCodexSession(text)
        if (session && f.tool === 'codex' && names.has(session.sessionId)) session.title = names.get(session.sessionId)!
        if (session && (this.ours(session.cwd) || this.appSession(session, claimed))) {
          // The app's own session, perhaps brought in by an earlier version.
          if (this.forget(`local-${f.tool === 'claude-code' ? 'claude' : 'codex'}-${session.sessionId}`)) changed++
        } else if (session && this.save(session)) changed++
        // A helper session an older version brought in as a chat goes again.
        if (!session && f.tool === 'codex' && this.forget(`local-codex-${codexSessionId(text)}`)) changed++
      } catch {
        // A file being written right now is read next time.
        continue
      }
      this.store.kvSet(key, { mtimeMs: st.mtimeMs, size: st.size, reader: SESSION_READER })
    }
    // A Codex chat renamed without anything else changing.
    for (const [sessionId, name] of names) if (this.retitle(`local-codex-${sessionId}`, name)) changed++
    return changed
  }

  /**
   * Sessions the app runs for its own chats, by session: when a chat goes on in a
   * new session (after a sign-in problem, say), that session is the chat's, not another chat.
   */
  private claimedSessions(): Map<string, 'claude' | 'codex'> {
    const out = new Map<string, 'claude' | 'codex'>()
    for (const [key, state] of this.store.kvEntries<{ sessionId?: string }>('session:')) {
      const m = /^session:(.+):(claude|chatgpt)$/.exec(key)
      const sessionId = state?.sessionId
      if (!m || !sessionId) continue
      const tool = m[2] === 'claude' ? 'claude' : 'codex'
      if (m[1] !== `local-${tool}-${sessionId}`) out.set(sessionId, tool)
    }
    return out
  }

  /** A session the app started: one a chat here runs on, or one that opens with the app's context file. */
  private appSession(session: LocalSession, claimed: Map<string, string>): boolean {
    if (claimed.has(session.sessionId)) return true
    return !!session.messages.find((m) => m.role === 'user')?.text.trimStart().startsWith(HANDOFF_OPENING)
  }

  /** Removes a chat brought in from a session, unless it was carried on in this app. */
  private forget(id: string): boolean {
    if (id === 'local-codex-' || !this.store.get('conversation', id)) return false
    const prefix = id.startsWith('local-claude-') ? 'local-claude-m-' : 'local-codex-m-'
    if (this.store.messages(id).some((m) => !m.id.startsWith(prefix))) return false
    this.store.deleteConversation(id)
    return true
  }

  /** Follows a new name from the tool, unless the chat was renamed in this app. */
  private retitle(id: string, title: string): boolean {
    const conv = this.store.get<Conversation>('conversation', id)
    if (!conv?.origin || conv.origin.device !== this.options.deviceName) return false
    const toolTitle = conv.origin.toolTitle
    if (toolTitle === title) return false
    const renamedHere = toolTitle !== undefined && conv.title !== toolTitle
    this.store.put('conversation', id, { ...conv, title: renamedHere ? conv.title : title, origin: { ...conv.origin, toolTitle: title } })
    return true
  }

  /** The code project for a session's folder: one per folder name, so the same project on two computers is one project. */
  private folderProject(cwd: string): string | undefined {
    if (!cwd || resolve(cwd) === resolve(this.options.home) || resolve(cwd) === resolve(sep)) return undefined
    return ensureFolderProject(this.store, cwd)
  }

  /** Puts code chats brought in by earlier versions in their folder's project, once. */
  sortIntoFolders(): number {
    if (this.store.kvGet<boolean>('localsessions:folders')) return 0
    let n = 0
    for (const c of this.store.list<Conversation>('conversation')) {
      if (!c.origin || c.projectId || c.origin.device !== this.options.deviceName) continue
      const cwd = c.origin.folder || this.workspaceOf(c.id)
      const projectId = cwd ? this.folderProject(cwd) : undefined
      if (projectId) {
        this.store.put('conversation', c.id, { ...c, projectId, origin: { ...c.origin, folder: cwd } })
        n++
      }
    }
    this.store.kvSet('localsessions:folders', true)
    return n
  }

  /** Writes one session as a code chat. Gives back whether anything changed. */
  save(session: LocalSession): boolean {
    const short = session.tool === 'claude-code' ? 'claude' : 'codex'
    const id = `local-${short}-${session.sessionId}`
    const prefix = `local-${short}-m-`
    if (this.store.isDeleted('conversation', id)) return false
    const provider: ProviderId = session.tool === 'claude-code' ? 'claude' : 'chatgpt'
    const existing = this.store.get<Conversation>('conversation', id)
    const before = existing ? this.store.messages(id) : []
    // Continued in this app: the app's copy is the one that counts from here on. A new name still comes through.
    if (before.some((m) => !m.id.startsWith(prefix))) return this.retitle(id, session.title)
    // Follows the name the tool gives it, unless it was renamed here.
    const toolTitle = existing?.origin?.toolTitle
    const renamedHere = !!existing && toolTitle !== undefined && existing.title !== toolTitle
    const projectId = existing ? undefined : this.folderProject(session.cwd)
    const conv: Conversation = existing
      ? {
          ...existing,
          title: renamedHere ? existing.title : session.title,
          updatedAt: Math.max(existing.updatedAt, session.updatedAt),
          ...(existing.origin ? { origin: { ...existing.origin, toolTitle: session.title, ...(session.cwd ? { folder: session.cwd } : {}) } } : {})
        }
      : {
          ...(projectId ? { projectId } : {}),
          id,
          title: session.title,
          createdAt: session.createdAt || Date.now(),
          updatedAt: session.updatedAt || Date.now(),
          provider,
          models: {},
          mode: session.cwd ? 'edit' : 'chat',
          kind: 'code',
          origin: { tool: session.tool, sessionId: session.sessionId, device: this.options.deviceName, toolTitle: session.title, ...(session.cwd ? { folder: session.cwd } : {}) }
        }
    const items: { kind: 'conversation' | 'message'; id: string; data: unknown }[] = [{ kind: 'conversation', id, data: conv }]
    const kept = new Set<string>()
    let at = 0
    for (const m of session.messages) {
      const mid = `${prefix}${m.id}`
      kept.add(mid)
      at = Math.max(at + 1, m.createdAt || conv.createdAt)
      const message: Message = {
        id: mid,
        conversationId: id,
        role: m.role,
        text: m.text,
        createdAt: at,
        deviceId: this.store.deviceId,
        status: 'complete',
        ...(m.role === 'assistant' ? { provider } : {}),
        ...(m.model ? { model: m.model } : {}),
        ...(m.tools?.length ? { tools: m.tools } : {}),
        ...(m.plan?.length ? { plan: m.plan } : {})
      }
      items.push({ kind: 'message', id: mid, data: message })
    }
    const written = this.store.putMany(items)
    for (const old of before) if (!kept.has(old.id)) this.store.remove('message', old.id)
    // Carrying on here continues the very same session, in its folder.
    if (session.cwd && !this.workspaceOf(id)) this.setWorkspace(id, session.cwd)
    const last = session.messages[session.messages.length - 1]
    if (last) this.store.kvSet(`session:${id}:${provider}`, { sessionId: session.sessionId, syncedMessageId: `${prefix}${last.id}` })
    return written > 0
  }
}
