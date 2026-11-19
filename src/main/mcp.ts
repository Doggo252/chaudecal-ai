// Tool servers (MCP) on this machine: the saved list, and a small client that
// connects to one server and asks which tools it has. The client is only used
// by the "Test" button. During a chat the assistants' own tools talk to the servers.

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { platformCommand } from '@shared/mcp'
import type { McpServer, McpTestResult, McpTool } from '@shared/types'
import { cliEnv, lineReader } from './env'

type Json = Record<string, any>

const PROTOCOL = '2025-06-18'
const MAX_TOOLS = 500

/** Makes a stored record safe to use: older or hand-edited records may miss fields. */
export function normalizeMcpServer(raw: Partial<McpServer> & { id: string }): McpServer {
  const pairs = (o: unknown): Record<string, string> => {
    const out: Record<string, string> = {}
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v
    return out
  }
  return {
    id: raw.id,
    name: String(raw.name ?? ''),
    kind: raw.kind === 'url' ? 'url' : 'command',
    command: String(raw.command ?? ''),
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env: pairs(raw.env),
    url: String(raw.url ?? ''),
    headers: pairs(raw.headers),
    enabled: raw.enabled !== false,
    trusted: raw.trusted === true,
    offOn: Array.isArray(raw.offOn) ? raw.offOn.map(String) : [],
    createdAt: Number(raw.createdAt) || 0
  }
}

function readTools(result: Json | undefined): McpTool[] {
  return (Array.isArray(result?.tools) ? result!.tools : [])
    .filter((t: Json) => typeof t?.name === 'string')
    .map((t: Json) => ({ name: t.name, description: String(t.description ?? '').split('\n')[0].slice(0, 200), readOnly: t.annotations?.readOnlyHint === true }))
}

const initialize = (version: string) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'chaudecal-ai', title: 'Chaudecal AI', version } }
})

function testCommand(server: McpServer, version: string, timeoutMs: number): Promise<McpTestResult> {
  return new Promise((resolve) => {
    const { command, args } = platformCommand(server, process.platform, homedir())
    let settled = false
    let stderr = ''
    let serverName: string | undefined
    const tools: McpTool[] = []
    const finish = (result: McpTestResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(result)
    }
    const fail = (error: string) => finish({ ok: false, tools: [], error })
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { cwd: homedir(), env: { ...cliEnv(), ...server.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ ok: false, tools: [], error: `Could not start "${command}": ${e instanceof Error ? e.message : String(e)}` })
      return
    }
    const timer = setTimeout(() => fail(`The server did not answer within ${Math.round(timeoutMs / 1000)} seconds.${stderr.trim() ? ` It said: ${lastLines(stderr)}` : ''}`), timeoutMs)
    const send = (message: Json) => child.stdin?.write(`${JSON.stringify(message)}\n`)
    child.on('error', (e: NodeJS.ErrnoException) => fail(e.code === 'ENOENT' ? `"${command}" was not found on this device.` : `Could not start "${command}": ${e.message}`))
    child.on('close', (code) => fail(`The server stopped before it answered${code ? ` (exit code ${code})` : ''}.${stderr.trim() ? ` It said: ${lastLines(stderr)}` : ''}`))
    child.stdin?.on('error', () => {})
    child.stderr?.on('data', (d) => (stderr = (stderr + d).slice(-2000)))
    child.stdout?.on(
      'data',
      lineReader((line) => {
        let msg: Json
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (msg.id === 1) {
          if (msg.error) return fail(`The server refused the connection: ${msg.error.message ?? 'unknown error'}`)
          serverName = msg.result?.serverInfo?.title || msg.result?.serverInfo?.name
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        } else if (typeof msg.id === 'number' && msg.id >= 2 && msg.method === undefined) {
          if (msg.error) return fail(`The server could not list its tools: ${msg.error.message ?? 'unknown error'}`)
          tools.push(...readTools(msg.result))
          const next = msg.result?.nextCursor
          if (typeof next === 'string' && next && tools.length < MAX_TOOLS) send({ jsonrpc: '2.0', id: msg.id + 1, method: 'tools/list', params: { cursor: next } })
          else finish({ ok: true, serverName, tools })
        } else if (msg.id !== undefined && msg.method) {
          // A request from the server (for example roots/list). This client offers nothing.
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not supported.' } })
        }
      })
    )
    send(initialize(version))
  })
}

function lastLines(text: string): string {
  return text.trim().split('\n').slice(-3).join(' ').slice(0, 300)
}

/** Reads one JSON-RPC answer from an HTTP response that is either JSON or an event stream. */
async function readAnswer(res: Response, id: number): Promise<Json | undefined> {
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('text/event-stream')) {
    const body = (await res.json()) as Json | Json[]
    return (Array.isArray(body) ? body : [body]).find((m) => m?.id === id)
  }
  const reader = res.body?.getReader()
  if (!reader) return undefined
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let end: number
      while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '')
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n')
        if (!data) continue
        try {
          const msg = JSON.parse(data) as Json
          if (msg?.id === id) return msg
        } catch {
          // Not a message for us.
        }
      }
      if (done) return undefined
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

/** A problem that is already worded for the user. */
class Told extends Error {}

async function testUrl(server: McpServer, version: string, timeoutMs: number): Promise<McpTestResult> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  const extra: Record<string, string> = {}
  const post = async (message: Json): Promise<Json | undefined> => {
    const res = await fetch(server.url, {
      method: 'POST',
      signal: abort.signal,
      headers: { ...server.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra },
      body: JSON.stringify(message)
    })
    const session = res.headers.get('mcp-session-id')
    if (session) extra['mcp-session-id'] = session
    if (res.status === 401 || res.status === 403) {
      throw new Told(`The server refused the sign-in (HTTP ${res.status}). Check the token in the headers. Servers that sign in through a browser page are not supported yet.`)
    }
    if (!res.ok) throw new Told(`The address did not answer as a tool server (HTTP ${res.status}).`)
    if (message.id === undefined) {
      res.body?.cancel().catch(() => {})
      return undefined
    }
    let answer: Json | undefined
    try {
      answer = await readAnswer(res, message.id)
    } catch (e) {
      if (abort.signal.aborted) throw e
      answer = undefined
    }
    if (!answer) throw new Told('The address answered, but not as a tool server.')
    if (answer.error) throw new Told(`The server reported: ${answer.error.message ?? 'unknown error'}`)
    return answer.result as Json
  }
  try {
    const init = await post(initialize(version))
    extra['mcp-protocol-version'] = String(init?.protocolVersion ?? PROTOCOL)
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const tools: McpTool[] = []
    let cursor: string | undefined
    for (let id = 2; id < 12; id++) {
      const page = await post({ jsonrpc: '2.0', id, method: 'tools/list', params: cursor ? { cursor } : {} })
      tools.push(...readTools(page))
      cursor = typeof page?.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined
      if (!cursor || tools.length >= MAX_TOOLS) break
    }
    return { ok: true, serverName: init?.serverInfo?.title || init?.serverInfo?.name, tools }
  } catch (e) {
    const error = abort.signal.aborted ? `The server did not answer within ${Math.round(timeoutMs / 1000)} seconds.` : e instanceof Told ? e.message : 'Could not reach that address from this device.'
    return { ok: false, tools: [], error }
  } finally {
    clearTimeout(timer)
  }
}

/** Connects to a server from this device and lists its tools. Never throws. */
export function testMcpServer(server: McpServer, version: string, timeoutMs = 30000): Promise<McpTestResult> {
  return server.kind === 'url' ? testUrl(server, version, timeoutMs) : testCommand(server, version, timeoutMs)
}
