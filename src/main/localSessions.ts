// Brings the Claude Code and Codex sessions on this computer into the app as code
// chats: ones started in a terminal, in an editor, or in the Claude and ChatGPT
// desktop apps. Each becomes a chat in the Code tab, syncs to the user's other
// devices like any chat, and carries on the same session here when continued.
//
// Sessions the app started itself are skipped, since the app has them already. A
// session continued in the app is not read again, so nothing appears twice.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Conversation, Message, ProviderId, ToolCall } from '@shared/types'
import { titleFromText } from '@shared/context'
import { claudeToolKind, describeTool, toolLabel } from './providers/claudeParser'
import type { Store } from './store'

type Json = Record<string, any>

export interface LocalMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  model?: string
  tools?: ToolCall[]
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
  if (/^\s*<(local-command-stdout|local-command-stderr|system-reminder|bash-stdout|bash-stderr)/.test(raw) || raw.startsWith('Caveat:')) return ''
  return raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

/** One Claude Code session file (~/.claude/projects/<folder>/<session>.jsonl). */
export function parseClaudeSession(text: string): LocalSession | undefined {
  const lines = parseLines(text)
  let sessionId = ''
  let cwd = ''
  let title = ''
  const messages: LocalMessage[] = []
  let turn: LocalMessage | undefined
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
      if (!said && !images) continue
      turn = undefined
      messages.push({ id: String(l.uuid), role: 'user', text: [said, images ? `[${images === 1 ? 'An image' : `${images} images`}]` : ''].filter(Boolean).join('\n\n'), createdAt: at })
      continue
    }
    // An answer comes as several entries around tool calls. Here it is one message.
    if (!turn) {
      turn = { id: String(l.uuid), role: 'assistant', text: '', createdAt: at, ...(l.message?.model && l.message.model !== '<synthetic>' ? { model: String(l.message.model) } : {}) }
      messages.push(turn)
    }
    for (const c of Array.isArray(content) ? (content as Json[]) : []) {
      if (c?.type === 'text' && String(c.text ?? '').trim()) turn.text = turn.text ? `${turn.text}\n\n${String(c.text).trim()}` : String(c.text).trim()
      if (c?.type === 'tool_use') {
        const name = String(c.name ?? 'Tool')
        ;(turn.tools ??= []).push({ id: String(c.id ?? `${turn.id}-${turn.tools?.length ?? 0}`), name: toolLabel(name), summary: describeTool(name, c.input) || name, status: 'done', kind: claudeToolKind(name) })
      }
    }
  }
  const kept = messages.filter((m) => m.role === 'user' || m.text || m.tools?.length)
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

/** One Codex session file (~/.codex/sessions/<year>/<month>/<day>/rollout-<time>-<id>.jsonl). */
export function parseCodexSession(text: string): LocalSession | undefined {
  const lines = parseLines(text)
  let sessionId = ''
  let cwd = ''
  const messages: LocalMessage[] = []
  let turn: LocalMessage | undefined
  let model = ''
  let n = 0
  for (const l of lines) {
    const p = (l.payload ?? {}) as Json
    const at = time(l.timestamp)
    if (l.type === 'session_meta') {
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
        .map((c: Json) => String(c.text ?? ''))
        .filter((t: string) => !/^\s*</.test(t) && !t.startsWith('# AGENTS.md'))
        .join('\n\n')
        .trim()
      if (!said) continue
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
      ;(t.tools ??= []).push({
        id: String(p.call_id ?? p.id ?? `${t.id}-${t.tools?.length ?? 0}`),
        name: command ? 'Command' : String(p.name ?? 'Tool'),
        summary: String(command ?? describeTool(String(p.name ?? ''), input) ?? '').split('\n')[0].slice(0, 200) || String(p.name ?? 'Tool'),
        status: 'done',
        kind: command ? 'command' : /apply_patch|edit|write/i.test(String(p.name ?? '')) ? 'edit' : 'tool'
      })
    }
  }
  const kept = messages.filter((m) => m.role === 'user' || m.text || m.tools?.length)
  if (!sessionId || !kept.some((m) => m.role === 'user')) return undefined
  const first = kept.find((m) => m.role === 'user')!
  return { tool: 'codex', sessionId, cwd, title: titleFromText(first.text), createdAt: kept[0].createdAt, updatedAt: kept[kept.length - 1].createdAt, messages: kept }
}

/** Every session file under a folder, newest first, at most a few levels down. */
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

  private ours(cwd: string): boolean {
    if (!cwd) return false
    const data = resolve(this.options.appData) + sep
    return (resolve(cwd) + sep).startsWith(data)
  }

  /** Looks for new and changed sessions. Gives back how many chats changed. */
  scan(): number {
    const files = [
      ...sessionFiles(join(this.options.home, '.claude', 'projects'), 1).map((path) => ({ path, tool: 'claude-code' as const })),
      ...sessionFiles(join(this.options.home, '.codex', 'sessions'), 4).map((path) => ({ path, tool: 'codex' as const }))
    ]
    let changed = 0
    for (const f of files) {
      let st: { mtimeMs: number; size: number }
      try {
        st = statSync(f.path)
      } catch {
        continue
      }
      const key = `localsession:${f.path}`
      const seen = this.store.kvGet<{ mtimeMs: number; size: number }>(key)
      if (seen && seen.mtimeMs === st.mtimeMs && seen.size === st.size) continue
      try {
        const text = readFileSync(f.path, 'utf8')
        const session = f.tool === 'claude-code' ? parseClaudeSession(text) : parseCodexSession(text)
        if (session && !this.ours(session.cwd) && this.save(session)) changed++
      } catch {
        // A file being written right now is read next time.
        continue
      }
      this.store.kvSet(key, { mtimeMs: st.mtimeMs, size: st.size })
    }
    return changed
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
    // Continued in this app: the app's copy is the one that counts from here on.
    if (before.some((m) => !m.id.startsWith(prefix))) return false
    const conv: Conversation = existing
      ? { ...existing, updatedAt: Math.max(existing.updatedAt, session.updatedAt) }
      : {
          id,
          title: session.title,
          createdAt: session.createdAt || Date.now(),
          updatedAt: session.updatedAt || Date.now(),
          provider,
          models: {},
          mode: session.cwd ? 'edit' : 'chat',
          kind: 'code',
          origin: { tool: session.tool, sessionId: session.sessionId, device: this.options.deviceName }
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
        ...(m.tools?.length ? { tools: m.tools } : {})
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
