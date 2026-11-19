// Tool servers (MCP): reading what the user typed, and turning the shared list
// into the form each assistant's command line tool expects. Pure.

import type { McpServer } from './types'

/** The fields of a server that the user fills in. */
export type McpDraft = Pick<McpServer, 'name' | 'kind' | 'command' | 'args' | 'env' | 'url' | 'headers'>

const NAME = /^[A-Za-z0-9_-]{1,40}$/

/** Turns free text into a name the assistants accept: "My GitHub!" becomes "my-github". */
export function cleanMcpName(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/** Splits a command line the way a shell would, without running one. Quotes group words. */
export function splitCommandLine(text: string): string[] {
  const out: string[] = []
  let word = ''
  let has = false
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = ''
      else if (c === '\\' && quote === '"' && (text[i + 1] === '"' || text[i + 1] === '\\')) word += text[++i]
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (/\s/.test(c)) {
      if (has || word) out.push(word)
      word = ''
      has = false
    } else {
      word += c
    }
  }
  if (has || word) out.push(word)
  return out
}

/** The reverse of splitCommandLine, for showing a saved command in a text box. */
export function joinCommandLine(parts: string[]): string {
  return parts.map((p) => (p === '' || /[\s"']/.test(p) ? `"${p.replace(/(["\\])/g, '\\$1')}"` : p)).join(' ')
}

/**
 * Reads "NAME=value" lines (environment variables) or "Name: value" lines (headers).
 * Blank lines and lines without a separator are skipped.
 */
export function parsePairs(text: string, separator: '=' | ':'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const at = line.indexOf(separator)
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if (separator === '=' && /^(".*"|'.*')$/.test(value)) value = value.slice(1, -1)
    if (key) out[key] = value
  }
  return out
}

export function formatPairs(pairs: Record<string, string>, separator: '=' | ':'): string {
  return Object.entries(pairs)
    .map(([k, v]) => (separator === '=' ? `${k}=${v}` : `${k}: ${v}`))
    .join('\n')
}

const strings = (o: unknown): Record<string, string> => {
  const out: Record<string, string> = {}
  if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
  return out
}

function draftFrom(name: string, raw: unknown): McpDraft | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const url = typeof o.url === 'string' ? o.url : typeof o.serverUrl === 'string' ? o.serverUrl : ''
  if (url) return { name: cleanMcpName(name), kind: 'url', command: '', args: [], env: {}, url, headers: strings(o.headers ?? o.http_headers) }
  if (typeof o.command !== 'string' || !o.command.trim()) return undefined
  const args = Array.isArray(o.args) ? o.args.filter((a) => typeof a === 'string' || typeof a === 'number').map(String) : []
  return { name: cleanMcpName(name), kind: 'command', command: o.command.trim(), args, env: strings(o.env), url: '', headers: {} }
}

/**
 * Reads the JSON that tool server instructions usually give:
 * {"mcpServers": {"name": {"command": "npx", "args": [...], "env": {...}}}}.
 * The inner object alone, and a single server without a name, are accepted too.
 */
export function parseMcpJson(text: string): { servers: McpDraft[]; error?: string } {
  const trimmed = text.trim().replace(/,\s*$/, '')
  let json: unknown
  try {
    json = JSON.parse(trimmed)
  } catch {
    try {
      // A piece copied from inside a larger file: "name": { ... }
      json = JSON.parse(`{${trimmed}}`)
    } catch {
      return { servers: [], error: 'That is not valid JSON.' }
    }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { servers: [], error: 'That is not a server definition.' }
  const o = json as Record<string, unknown>
  const single = draftFrom('', o)
  if (single) return { servers: [single] }
  const group = (o.mcpServers ?? o.mcp_servers ?? o.servers ?? o) as Record<string, unknown>
  const servers = Object.entries(group && typeof group === 'object' ? group : {})
    .map(([name, raw]) => draftFrom(name, raw))
    .filter((d): d is McpDraft => !!d)
  return servers.length ? { servers } : { servers: [], error: 'No server with a command or a URL was found in that JSON.' }
}

/** Why a server cannot be saved, or undefined when it is fine. */
export function mcpProblem(draft: McpDraft, others: { name: string }[]): string | undefined {
  if (!draft.name) return 'Give the server a name.'
  if (!NAME.test(draft.name)) return 'The name can only have letters, digits, "-" and "_".'
  if (others.some((o) => o.name.toLowerCase() === draft.name.toLowerCase())) return `There is already a server called "${draft.name}".`
  if (draft.kind === 'command') {
    if (!draft.command.trim()) return 'Type the command that starts the server.'
  } else {
    let url: URL | undefined
    try {
      url = new URL(draft.url)
    } catch {
      url = undefined
    }
    if (!url || !/^https?:$/.test(url.protocol)) return 'The address must start with http:// or https://.'
  }
  return undefined
}

/** The servers this device should use. */
export function activeMcpServers(servers: McpServer[], deviceId: string): McpServer[] {
  return servers.filter((s) => s.enabled && !s.offOn.includes(deviceId)).sort((a, b) => a.name.localeCompare(b.name))
}

const NPM_SHIMS = /^(npx|npm|pnpm|pnpx|yarn|bunx)$/i

/**
 * The command as it has to be started on one machine: "~" becomes the home folder,
 * and on Windows the npm launchers, which are scripts, go through cmd.
 */
export function platformCommand(server: Pick<McpServer, 'command' | 'args'>, platform: string, home: string): { command: string; args: string[] } {
  const sep = platform === 'win32' ? '\\' : '/'
  const expand = (p: string) => (p === '~' ? home : /^~[\\/]/.test(p) ? `${home}${sep}${p.slice(2)}` : p)
  const command = expand(server.command.trim())
  const args = server.args.map(expand)
  if (platform === 'win32' && NPM_SHIMS.test(command)) return { command: 'cmd', args: ['/c', command, ...args] }
  return { command, args }
}

/** The file Claude Code reads with --mcp-config. */
export function claudeMcpConfig(servers: McpServer[], platform: string, home: string): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {}
  for (const s of servers) {
    mcpServers[s.name] = s.kind === 'url' ? { type: 'http', url: s.url, headers: s.headers } : { type: 'stdio', ...platformCommand(s, platform, home), env: s.env }
  }
  return { mcpServers }
}

/** Permission rules that let Claude use every tool of the trusted servers without asking. */
export function claudeMcpAllow(servers: McpServer[]): string[] {
  return servers.filter((s) => s.trusted).map((s) => `mcp__${s.name}`)
}

/** The `mcp_servers` table Codex takes as a configuration override. */
export function codexMcpConfig(servers: McpServer[], platform: string, home: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const s of servers) {
    const trust = s.trusted ? { default_tools_approval_mode: 'approve' } : {}
    out[s.name] = s.kind === 'url' ? { url: s.url, http_headers: s.headers, ...trust } : { ...platformCommand(s, platform, home), env: s.env, ...trust }
  }
  return out
}

/** Splits Claude's tool name for a server tool ("mcp__github__list_issues"). Undefined for other tools. */
export function mcpToolParts(name: string): { server: string; tool: string } | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? { server: m[1], tool: m[2] } : undefined
}

/** How a server tool is named in the chat, the same for every assistant. */
export function mcpToolLabel(server: string, tool: string): string {
  return `${server}: ${tool}`
}

/** One line that says what a server is, for lists. */
export function describeMcpServer(server: Pick<McpServer, 'kind' | 'command' | 'args' | 'url'>): string {
  return server.kind === 'url' ? server.url : joinCommandLine([server.command, ...server.args])
}
