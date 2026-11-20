import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { McpServer, Message, ProviderId, ProviderStatus, RunEvent } from '@shared/types'
import {
  activeMcpServers,
  claudeMcpAllow,
  claudeMcpConfig,
  cleanMcpName,
  codexMcpConfig,
  describeMcpServer,
  formatPairs,
  joinCommandLine,
  mcpProblem,
  mcpToolParts,
  parseMcpJson,
  parsePairs,
  platformCommand,
  splitCommandLine
} from '@shared/mcp'
import { normalizeMcpServer, testMcpServer } from '../src/main/mcp'
import { Store } from '../src/main/store'
import { ChatEngine } from '../src/main/chat'
import { Summarizer } from '../src/main/summarizer'
import { ClaudeProvider } from '../src/main/providers/claude'
import { readPermissionAsk, createClaudeParser } from '../src/main/providers/claudeParser'
import { CodexProvider, codexItemToTool, readMcpAsk } from '../src/main/providers/codex'
import { LocalProvider } from '../src/main/providers/local'
import { canRunFakes, tempDir, testSettings, until } from './helpers'

const FAKE_MCP = resolve(import.meta.dirname, 'fakes/fake-mcp.mjs')

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
  delete process.env.FAKE_LOG
})

/** A tool server entry that starts the stand-in server. Notes it saves go to `notes`. */
function server(patch: Partial<McpServer> = {}, notes?: string): McpServer {
  return normalizeMcpServer({
    id: patch.name ?? 'notes',
    name: 'notes',
    kind: 'command',
    command: process.execPath,
    args: [FAKE_MCP],
    env: { FAKE_MCP_SECRET: 'tulip', ...(notes ? { FAKE_MCP_LOG: notes } : {}) },
    ...patch
  })
}

function collect() {
  const events: RunEvent[] = []
  const text = () => events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')
  const asks = () => events.filter((e): e is Extract<RunEvent, { type: 'approval' }> => e.type === 'approval' && !e.settled)
  const tools = () => events.filter((e): e is Extract<RunEvent, { type: 'tool' }> => e.type === 'tool').map((e) => e.tool)
  return { events, emit: (e: RunEvent) => void events.push(e), text, asks, tools }
}

const logged = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

describe('tool server settings', () => {
  it('splits a command line like a shell would, and puts it back together', () => {
    expect(splitCommandLine('npx -y @modelcontextprotocol/server-filesystem ~/Documents')).toEqual(['npx', '-y', '@modelcontextprotocol/server-filesystem', '~/Documents'])
    expect(splitCommandLine('  node "C:\\Program Files\\srv\\index.js"  --name \'my notes\' ""')).toEqual(['node', 'C:\\Program Files\\srv\\index.js', '--name', 'my notes', ''])
    expect(splitCommandLine('say "a \\"quoted\\" word"')).toEqual(['say', 'a "quoted" word'])
    expect(splitCommandLine('   ')).toEqual([])
    const parts = ['node', '/Users/me/My Tools/server.js', '--title', 'a "b"', '']
    expect(splitCommandLine(joinCommandLine(parts))).toEqual(parts)
  })

  it('reads environment variables and headers, one per line', () => {
    expect(parsePairs('GITHUB_TOKEN=abc=def\n\n  DEBUG = "1" \nnot a pair\n=x', '=')).toEqual({ GITHUB_TOKEN: 'abc=def', DEBUG: '1' })
    expect(parsePairs('Authorization: Bearer abc:def\nX-Team:  blue', ':')).toEqual({ Authorization: 'Bearer abc:def', 'X-Team': 'blue' })
    expect(formatPairs({ A: '1', B: 'two words' }, '=')).toBe('A=1\nB=two words')
    expect(parsePairs(formatPairs({ Authorization: 'Bearer x' }, ':'), ':')).toEqual({ Authorization: 'Bearer x' })
  })

  it('reads the JSON that tool server instructions give, in its usual shapes', () => {
    const full = parseMcpJson('{"mcpServers": {"GitHub": {"command": "npx", "args": ["-y", "server-github"], "env": {"TOKEN": "t"}}, "docs": {"type": "http", "url": "https://docs.example/mcp", "headers": {"Authorization": "Bearer k"}}}}')
    expect(full.error).toBeUndefined()
    expect(full.servers).toEqual([
      { name: 'github', kind: 'command', command: 'npx', args: ['-y', 'server-github'], env: { TOKEN: 't' }, url: '', headers: {} },
      { name: 'docs', kind: 'url', command: '', args: [], env: {}, url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer k' } }
    ])
    // Only the inner part, as copied from inside a larger file.
    expect(parseMcpJson('"notes": { "command": "uvx", "args": ["notes-mcp"] },').servers).toMatchObject([{ name: 'notes', command: 'uvx', args: ['notes-mcp'] }])
    // One server with no name.
    expect(parseMcpJson('{"command": "node", "args": ["s.js"]}').servers).toMatchObject([{ name: '', command: 'node' }])
    expect(parseMcpJson('not json').error).toBe('That is not valid JSON.')
    expect(parseMcpJson('{"mcpServers": {"x": {"type": "stdio"}}}').error).toMatch(/No server/)
  })

  it('says what is wrong with a server before it is saved', () => {
    const ok = { name: 'notes', kind: 'command' as const, command: 'node', args: [], env: {}, url: '', headers: {} }
    expect(mcpProblem(ok, [])).toBeUndefined()
    expect(mcpProblem({ ...ok, name: '' }, [])).toMatch(/name/)
    expect(mcpProblem({ ...ok, name: 'my notes' }, [])).toMatch(/letters/)
    expect(mcpProblem(ok, [{ name: 'Notes' }])).toMatch(/already/)
    expect(mcpProblem({ ...ok, command: ' ' }, [])).toMatch(/command/)
    expect(mcpProblem({ ...ok, kind: 'url', url: 'example.com/mcp' }, [])).toMatch(/http/)
    expect(mcpProblem({ ...ok, kind: 'url', url: 'https://example.com/mcp' }, [])).toBeUndefined()
    expect(cleanMcpName('  My GitHub! ')).toBe('my-github')
  })

  it('uses only the servers that are switched on for this device', () => {
    const list = [server({ id: 'b', name: 'beta' }), server({ id: 'a', name: 'alpha', offOn: ['pc'] }), server({ id: 'c', name: 'gamma', enabled: false })]
    expect(activeMcpServers(list, 'mac').map((s) => s.name)).toEqual(['alpha', 'beta'])
    expect(activeMcpServers(list, 'pc').map((s) => s.name)).toEqual(['beta'])
  })

  it('adapts a command to the machine it runs on', () => {
    expect(platformCommand({ command: 'npx', args: ['-y', 'srv', '~/Documents', '~'] }, 'darwin', '/Users/me')).toEqual({ command: 'npx', args: ['-y', 'srv', '/Users/me/Documents', '/Users/me'] })
    // On Windows the npm launchers are scripts, which have to go through cmd.
    expect(platformCommand({ command: 'npx', args: ['-y', 'srv', '~\\Documents'] }, 'win32', 'C:\\Users\\me')).toEqual({ command: 'cmd', args: ['/c', 'npx', '-y', 'srv', 'C:\\Users\\me\\Documents'] })
    expect(platformCommand({ command: 'uvx', args: ['srv'] }, 'win32', 'C:\\Users\\me')).toEqual({ command: 'uvx', args: ['srv'] })
  })

  it('writes the list in the form each assistant expects', () => {
    const list = [
      server({ name: 'notes', command: 'node', args: ['s.js'], env: { KEY: 'v' }, trusted: true }),
      server({ name: 'docs', kind: 'url', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer k' }, env: {} })
    ]
    expect(claudeMcpConfig(list, 'darwin', '/Users/me')).toEqual({
      mcpServers: { notes: { type: 'stdio', command: 'node', args: ['s.js'], env: { KEY: 'v' } }, docs: { type: 'http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer k' } } }
    })
    expect(claudeMcpAllow(list)).toEqual(['mcp__notes'])
    expect(codexMcpConfig(list, 'darwin', '/Users/me')).toEqual({
      notes: { command: 'node', args: ['s.js'], env: { KEY: 'v' }, default_tools_approval_mode: 'approve' },
      docs: { url: 'https://docs.example/mcp', http_headers: { Authorization: 'Bearer k' } }
    })
    expect(describeMcpServer(list[0])).toBe('node s.js')
    expect(describeMcpServer(list[1])).toBe('https://docs.example/mcp')
  })

  it('names a server tool the same way for both assistants', () => {
    expect(mcpToolParts('mcp__git_hub__list__issues')).toEqual({ server: 'git_hub', tool: 'list__issues' })
    expect(mcpToolParts('Bash')).toBeUndefined()
    const ask = readPermissionAsk({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'mcp__notes__add_note', display_name: 'mcp__notes__add_note', input: { text: 'milk' }, tool_use_id: 't1' } })
    expect(ask?.request).toMatchObject({ kind: 'other', tool: 'notes: add_note', summary: 'text: milk' })
    expect(readMcpAsk({ serverName: 'notes', _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_name: 'add_note', tool_description: 'Saves a note.', tool_params: { text: 'milk' } } })).toEqual({
      tool: 'notes: add_note',
      summary: 'text: milk',
      reason: 'Saves a note.',
      canRemember: true
    })
    // A real form from a tool server is not a permission question.
    expect(readMcpAsk({ serverName: 'notes', message: 'Your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } })).toBeUndefined()
    expect(codexItemToTool({ type: 'mcpToolCall', id: 'i', server: 'notes', tool: 'echo', arguments: { text: 'hi' }, status: 'completed', result: { content: [{ type: 'text', text: 'echo: hi' }] } })).toMatchObject({
      name: 'notes: echo',
      status: 'done',
      output: 'echo: hi'
    })
    expect(codexItemToTool({ type: 'mcpToolCall', id: 'i', server: 'notes', tool: 'add_note', arguments: {}, status: 'failed', error: { message: 'user rejected MCP tool call' } })?.status).toBe('denied')
  })

  it('reports a tool server of its own that Claude Code could not start, and no others', () => {
    const c = collect()
    const p = createClaudeParser(c.emit, ['notes', 'docs'])
    p.line(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', mcp_servers: [{ name: 'notes', status: 'failed' }, { name: 'docs', status: 'connected' }, { name: 'someone-elses', status: 'failed' }] }))
    expect(c.tools()).toEqual([{ id: 'mcp-notes', name: 'notes', summary: 'This tool server could not be started or reached on this device.', status: 'error' }])
  })

  it('forgets the tokens of a server that is removed', () => {
    const store = new Store(join(tempDir(), 'app.db'))
    const s = server({ name: 'docs', kind: 'url', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer secret' } })
    store.put('mcp', s.id, s)
    store.remove('mcp', s.id)
    const kept = store.dirty().find((r) => r.kind === 'mcp')
    expect(kept).toMatchObject({ deleted: true, data: { env: {}, headers: {} } })
    expect(JSON.stringify(kept)).not.toContain('secret')
    expect(JSON.stringify(kept)).not.toContain('tulip')
    expect(store.list('mcp')).toEqual([])
  })
})

describe.skipIf(!canRunFakes)('testing a tool server from the app', () => {
  it('connects to a program and lists its tools', async () => {
    const result = await testMcpServer(server(), '0.0.0-test')
    expect(result).toEqual({
      ok: true,
      serverName: 'fake-mcp',
      tools: [
        { name: 'echo', description: 'Answers with the text it was given.', readOnly: true },
        { name: 'add_note', description: 'Saves a note.', readOnly: false }
      ]
    })
  })

  it('says why a program could not be used', async () => {
    const broken = await testMcpServer(server({ env: { FAKE_MCP_BROKEN: '1' } }), '0.0.0-test')
    expect(broken.ok).toBe(false)
    expect(broken.error).toMatch(/stopped before it answered \(exit code 1\).*cannot start/)
    const missing = await testMcpServer(server({ command: 'no-such-program-xyz', args: [] }), '0.0.0-test')
    expect(missing).toMatchObject({ ok: false, error: '"no-such-program-xyz" was not found on this device.' })
    // Something that runs but is not a tool server.
    const silent = await testMcpServer(server({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'] }), '0.0.0-test', 400)
    expect(silent).toMatchObject({ ok: false })
    expect(silent.error).toMatch(/did not answer within/)
  })

  /** Starts the stand-in server on a free port and gives its address. */
  async function overHttp(token?: string): Promise<string> {
    const child = spawn(process.execPath, [FAKE_MCP, '--http', '0'], { env: { ...process.env, ...(token ? { FAKE_MCP_TOKEN: token } : {}) }, stdio: ['ignore', 'pipe', 'inherit'] })
    cleanup.push(() => child.kill())
    const port = await new Promise<string>((res) => child.stdout.once('data', (d) => res(String(d).trim().split(' ')[1])))
    return `http://127.0.0.1:${port}/mcp`
  }

  it('connects to a web address, with a token when the server wants one', async () => {
    const url = await overHttp('s3cret')
    const good = await testMcpServer(server({ kind: 'url', url, headers: { Authorization: 'Bearer s3cret' } }), '0.0.0-test')
    expect(good).toMatchObject({ ok: true, serverName: 'fake-mcp' })
    expect(good.tools.map((t) => t.name)).toEqual(['echo', 'add_note'])
    const refused = await testMcpServer(server({ kind: 'url', url, headers: { Authorization: 'Bearer wrong' } }), '0.0.0-test')
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/asks for a sign-in \(HTTP 401\)/)
  })

  it('says when an address cannot be reached or is not a tool server', async () => {
    const nowhere = await testMcpServer(server({ kind: 'url', url: 'http://127.0.0.1:9/mcp' }), '0.0.0-test')
    expect(nowhere).toMatchObject({ ok: false, error: 'Could not reach that address from this device.' })
  })
})

describe.skipIf(!canRunFakes)('Claude with tool servers', () => {
  function start(prompt: string, mcp: McpServer[], opts: { mode?: 'chat' | 'edit'; allow?: string[] } = {}) {
    const dir = tempDir()
    const log = join(dir, 'fake.log')
    process.env.FAKE_LOG = log
    const settings = testSettings()
    const claude = new ClaudeProvider(() => settings, join(dir, 'tmp'))
    const c = collect()
    const handle = claude.run({ prompt, system: '', model: '', mode: opts.mode ?? 'chat', cwd: dir, mcp, allow: opts.allow }, c.emit)
    return { c, handle, log, dir }
  }

  it('asks before a tool is used, then uses it', async () => {
    const notes = join(tempDir(), 'notes.txt')
    const { c, handle, log, dir } = start('remember milk [mcp]', [server({}, notes)])
    await until(() => c.asks().length === 1, 5000, 'the question')
    expect(c.asks()[0].request).toMatchObject({ kind: 'other', tool: 'notes: add_note', summary: 'text: milk' })
    expect(existsSync(notes)).toBe(false)
    handle.respondApproval!(c.asks()[0].request.id, 'accept')
    await handle.done
    expect(c.text()).toContain('The notes tool answered: saved')
    expect(readFileSync(notes, 'utf8')).toBe('milk\n')
    expect(c.tools().at(-1)).toMatchObject({ name: 'notes: add_note', status: 'done', output: 'saved' })
    // The CLI was given the server in a file, which is gone once the turn is over.
    const given = logged(log).find((l) => l.mcp)
    expect(given.mcp.notes).toMatchObject({ type: 'stdio', command: process.execPath, args: [FAKE_MCP], env: { FAKE_MCP_SECRET: 'tulip' } })
    const args: string[] = logged(log).find((l) => l.args?.includes('--mcp-config')).args
    expect(args[args.indexOf('--mcp-config') + 2]).toMatch(/^--/)
    expect(readdirSync(join(dir, 'tmp')).filter((f) => f.startsWith('mcp-'))).toEqual([])
  })

  it('passes the settings a server needs, and keeps tools available in a plain chat', async () => {
    const { c, handle } = start('say hello [mcp-echo]', [server()], { mode: 'chat' })
    await until(() => c.asks().length === 1, 5000, 'the question')
    handle.respondApproval!(c.asks()[0].request.id, 'accept')
    await handle.done
    expect(c.text()).toContain('The notes tool answered: echo: hello (secret tulip)')
  })

  it('does not ask for a server that is trusted', async () => {
    const notes = join(tempDir(), 'notes.txt')
    const { c, handle, log } = start('remember milk [mcp]', [server({ trusted: true }, notes)])
    await handle.done
    expect(c.asks()).toEqual([])
    expect(readFileSync(notes, 'utf8')).toBe('milk\n')
    const args: string[] = logged(log).find((l) => l.args?.includes('--allowedTools')).args
    expect(args[args.indexOf('--allowedTools') + 1].split(',')).toContain('mcp__notes')
  })

  it('remembers a tool that was allowed for the rest of the chat', async () => {
    const notes = join(tempDir(), 'notes.txt')
    const { c, handle } = start('remember milk [mcp] [twice]', [server({}, notes)])
    await until(() => c.asks().length === 1, 5000, 'the question')
    handle.respondApproval!(c.asks()[0].request.id, 'acceptForSession')
    await handle.done
    expect(c.asks()).toHaveLength(1)
    expect(c.events).toContainEqual({ type: 'grant', rules: ['mcp__notes__add_note'] })
    expect(readFileSync(notes, 'utf8')).toBe('milk\nmilk\n')
    // The next turn starts with that permission, so it is not asked again.
    const again = start('remember milk [mcp]', [server({}, notes)], { allow: ['mcp__notes__add_note'] })
    await again.handle.done
    expect(again.c.asks()).toEqual([])
  })

  it('leaves the tool unused when the user says no', async () => {
    const notes = join(tempDir(), 'notes.txt')
    const { c, handle } = start('remember milk [mcp]', [server({}, notes)])
    await until(() => c.asks().length === 1, 5000, 'the question')
    handle.respondApproval!(c.asks()[0].request.id, 'decline')
    await handle.done
    expect(existsSync(notes)).toBe(false)
    expect(c.text()).toContain('I was not allowed to use the tool')
    expect(c.tools().at(-1)).toMatchObject({ name: 'notes: add_note', status: 'denied' })
  })

  it('says in the chat when a server could not start, and carries on', async () => {
    const { c, handle } = start('hello', [server({ env: { FAKE_MCP_BROKEN: '1' } })])
    await handle.done
    expect(c.tools()).toContainEqual({ id: 'mcp-notes', name: 'notes', summary: 'This tool server could not be started or reached on this device.', status: 'error' })
    expect(c.text()).toContain('Claude here. You said: "hello".')
  })
})

describe.skipIf(!canRunFakes)('ChatGPT with tool servers', () => {
  function make() {
    const dir = tempDir()
    const log = join(dir, 'fake.log')
    process.env.FAKE_LOG = log
    const settings = testSettings()
    const codex = new CodexProvider(() => settings, '0.0.0-test', () => {})
    cleanup.push(() => codex.dispose())
    const start = (prompt: string, mcp: McpServer[], mode: 'chat' | 'edit' | 'auto' = 'chat', sessionId?: string) => {
      const c = collect()
      const handle = codex.run({ prompt, system: '', model: '', mode, cwd: dir, mcp, sessionId }, c.emit)
      return { c, handle }
    }
    const opened = () => logged(log).filter((l) => l.method === 'thread/start' || l.method === 'thread/resume')
    return { codex, start, log, opened }
  }

  it('asks before a tool that changes something, also in a plain chat', async () => {
    const notes = join(tempDir(), 'notes.txt')
    const { start, opened, log } = make()
    const { c, handle } = start('remember milk [mcp]', [server({}, notes)])
    await until(() => c.asks().length === 1, 5000, 'the question')
    expect(c.asks()[0].request).toMatchObject({ kind: 'other', tool: 'notes: add_note', summary: 'text: milk', reason: 'Saves a note.' })
    expect(existsSync(notes)).toBe(false)
    handle.respondApproval!(c.asks()[0].request.id, 'accept')
    await handle.done
    expect(c.text()).toContain('The notes tool answered: saved')
    expect(readFileSync(notes, 'utf8')).toBe('milk\n')
    expect(c.tools().at(-1)).toMatchObject({ name: 'notes: add_note', status: 'done', output: 'saved' })
    // A chat normally never asks. Asking is switched on because the server is not trusted.
    expect(opened()[0].params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'on-request', config: { mcp_servers: { notes: { command: process.execPath, args: [FAKE_MCP], env: { FAKE_MCP_SECRET: 'tulip' } } } } })
    expect(logged(log).find((l) => l.mcpApproval).mcpApproval).toEqual({ action: 'accept', content: null })
  })

  it('repeats the mode with every turn, since an open conversation keeps the one it was opened with', async () => {
    const { start, log } = make()
    const first = start('hello', [server()], 'chat')
    await first.handle.done
    const session = first.c.events.find((e) => e.type === 'session') as { sessionId: string }
    await start('now edit', [server({ trusted: true })], 'auto', session.sessionId).handle.done
    const turns = logged(log).filter((l) => l.method === 'turn/start').map((l) => ({ approvalPolicy: l.params.approvalPolicy, sandboxPolicy: l.params.sandboxPolicy }))
    expect(turns).toEqual([
      { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } },
      { approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite' } }
    ])
  })

  it('uses a read-only tool without asking', async () => {
    const { start } = make()
    const { c, handle } = start('say hello [mcp-echo]', [server()])
    await handle.done
    expect(c.asks()).toEqual([])
    expect(c.text()).toContain('The notes tool answered: echo: hello (secret tulip)')
  })

  it('does not ask for a server that is trusted, and leaves asking switched off', async () => {
    const notes = join(tempDir(), 'notes.txt')
    const { start, opened } = make()
    const { c, handle } = start('remember milk [mcp]', [server({ trusted: true }, notes)])
    await handle.done
    expect(c.asks()).toEqual([])
    expect(readFileSync(notes, 'utf8')).toBe('milk\n')
    expect(opened()[0].params).toMatchObject({ approvalPolicy: 'never', config: { mcp_servers: { notes: { default_tools_approval_mode: 'approve' } } } })
  })

  it('remembers a tool that was allowed for the rest of the chat', async () => {
    const notes = join(tempDir(), 'notes.txt')
    const { start, log } = make()
    const { c, handle } = start('remember milk [mcp] [twice]', [server({}, notes)])
    await until(() => c.asks().length === 1, 5000, 'the question')
    handle.respondApproval!(c.asks()[0].request.id, 'acceptForSession')
    await handle.done
    expect(c.asks()).toHaveLength(1)
    expect(readFileSync(notes, 'utf8')).toBe('milk\nmilk\n')
    expect(logged(log).find((l) => l.mcpApproval).mcpApproval).toEqual({ action: 'accept', content: null, _meta: { persist: 'session' } })
  })

  it('leaves the tool unused when the user says no', async () => {
    const notes = join(tempDir(), 'notes.txt')
    const { start } = make()
    const { c, handle } = start('remember milk [mcp]', [server({}, notes)])
    await until(() => c.asks().length === 1, 5000, 'the question')
    handle.respondApproval!(c.asks()[0].request.id, 'decline')
    await handle.done
    expect(existsSync(notes)).toBe(false)
    expect(c.tools().at(-1)).toMatchObject({ name: 'notes: add_note', status: 'denied' })
    expect(c.text()).toContain('I was not allowed to use the tool')
  })

  it('still refuses commands in a plain chat, where asking is only on for the tools', async () => {
    const { start, log } = make()
    const { c, handle } = start('install it [approve]', [server()])
    await handle.done
    expect(c.asks()).toEqual([])
    expect(logged(log).find((l) => 'approval' in l).approval).toBe('decline')
    expect(c.tools().at(-1)).toMatchObject({ name: 'Command', status: 'denied' })
  })

  it('sends no tool settings when there are no servers', async () => {
    const { start, opened } = make()
    await start('hello', []).handle.done
    expect(opened()[0].params).toMatchObject({ approvalPolicy: 'never', config: null })
  })

  it('says in the chat when a server could not start, and carries on', async () => {
    const { start } = make()
    const { c, handle } = start('hello', [server({ env: { FAKE_MCP_BROKEN: '1' } })])
    await handle.done
    expect(c.tools()).toHaveLength(1)
    expect(c.tools()[0]).toMatchObject({ id: 'mcp-notes', name: 'notes', status: 'error' })
    expect(c.tools()[0].summary).toMatch(/could not be started or reached on this device/)
    expect(c.text()).toContain('ChatGPT here. You said: "hello".')
  })

  it('starts afresh after the list of servers changes, once nothing is running', async () => {
    const { codex, start, log } = make()
    const first = start('hello', [])
    codex.restartWhenIdle()
    // A run is in progress, so the process is left alone until it ends.
    await first.handle.done
    expect(first.c.text()).toContain('ChatGPT here.')
    await start('hello again', [server()]).handle.done
    expect(logged(log).filter((l) => l.method === 'initialize')).toHaveLength(2)
  })
})

describe.skipIf(!canRunFakes)('tool servers in a conversation', () => {
  function setup() {
    const dir = tempDir()
    const log = join(dir, 'fake.log')
    process.env.FAKE_LOG = log
    const store = new Store(join(dir, 'app.db'))
    const settings = testSettings()
    const local = new LocalProvider(() => settings, { current: () => undefined })
    const codex = new CodexProvider(() => settings, '0.0.0-test', () => {})
    cleanup.push(() => codex.dispose())
    const ready = (provider: ProviderId): ProviderStatus => ({ provider, installed: true, ready: true, detail: '', models: [] })
    const engine = new ChatEngine(
      store,
      () => settings,
      { claude: new ClaudeProvider(() => settings, join(dir, 'tmp')), chatgpt: codex, local },
      () => ({ claude: ready('claude'), chatgpt: ready('chatgpt'), local: ready('local') }),
      {
        stream: () => {},
        route: () => {},
        approval: (conversationId, messageId, request, settled) => {
          if (!settled) engine.respondApproval(conversationId, messageId, request.id, 'accept')
        },
        denials: () => {},
        busy: () => {}
      },
      { context: join(dir, 'context'), scratch: join(dir, 'workspace'), attachments: join(dir, 'attachments') },
      new Summarizer(store, () => settings, local)
    )
    const last = (id: string): Message => store.messages(id).filter((m) => m.role === 'assistant').at(-1)!
    return { store, engine, last, log }
  }

  it('gives both assistants the same servers, except the ones switched off on this device', async () => {
    const { store, engine, last, log } = setup()
    const notes = join(tempDir(), 'notes.txt')
    const on = server({ id: 'a', name: 'notes' }, notes)
    const off = server({ id: 'b', name: 'elsewhere', offOn: [store.deviceId] })
    store.put('mcp', on.id, on)
    store.put('mcp', off.id, off)
    expect(engine.mcpServers().map((s) => s.name)).toEqual(['notes'])

    const conv = engine.createConversation({ provider: 'claude' })
    await engine.send({ conversationId: conv.id, text: 'remember milk [mcp]' })
    expect(last(conv.id)).toMatchObject({ provider: 'claude', status: 'complete' })
    expect(last(conv.id).text).toContain('The notes tool answered: saved')
    expect(last(conv.id).tools?.at(-1)).toMatchObject({ name: 'notes: add_note', status: 'done' })

    engine.switchProvider(conv.id, 'chatgpt')
    await engine.send({ conversationId: conv.id, text: 'and again [mcp]' })
    expect(last(conv.id)).toMatchObject({ provider: 'chatgpt', status: 'complete' })
    expect(last(conv.id).text).toContain('The notes tool answered: saved')
    expect(readFileSync(notes, 'utf8')).toBe('milk\nmilk\n')

    const lines = logged(log)
    expect(Object.keys(lines.find((l) => l.tool === 'claude' && l.mcp).mcp)).toEqual(['notes'])
    expect(Object.keys(lines.find((l) => l.method === 'thread/start').params.config.mcp_servers)).toEqual(['notes'])
  })
})
