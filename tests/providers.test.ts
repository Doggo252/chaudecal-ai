import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunEvent } from '@shared/types'
import { ClaudeProvider } from '../src/main/providers/claude'
import { createClaudeParser, describeTool, readPermissionAsk, ruleFor, sessionRule } from '../src/main/providers/claudeParser'
import { CodexProvider, codexErrorCode, codexItemToTool } from '../src/main/providers/codex'
import { canRunFakes, tempDir, testSettings, until } from './helpers'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
  delete process.env.FAKE_CLAUDE_LOGGED_OUT
  delete process.env.FAKE_CLAUDE_UTILIZATION
  delete process.env.FAKE_CLAUDE_NO_LIVE
  delete process.env.FAKE_LOG
})

function collect() {
  const events: RunEvent[] = []
  const text = () => events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')
  return { events, emit: (e: RunEvent) => void events.push(e), text }
}

describe('Claude stream parser', () => {
  it('does not repeat text that already arrived as deltas', () => {
    const c = collect()
    const p = createClaudeParser(c.emit)
    p.line(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-x' }))
    p.line(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } }))
    p.line(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } }))
    p.line(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }))
    expect(c.text()).toBe('Hello')
    expect(c.events[0]).toEqual({ type: 'session', sessionId: 's1' })
    expect(c.events[1]).toEqual({ type: 'model', model: 'claude-x' })
  })

  it('uses the full message when no deltas were sent, and separates blocks', () => {
    const c = collect()
    const p = createClaudeParser(c.emit)
    p.line(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'First.' }] } }))
    p.line(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Second.' }] } }))
    expect(c.text()).toBe('First.\n\nSecond.')
  })

  it('tracks a tool call from start to result', () => {
    const c = collect()
    const p = createClaudeParser(c.emit)
    p.line(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }] } }))
    p.line(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.txt' }] }] } }))
    const tools = c.events.filter((e) => e.type === 'tool').map((e) => (e as Extract<RunEvent, { type: 'tool' }>).tool)
    expect(tools[0]).toMatchObject({ id: 't1', name: 'Bash', summary: 'ls -la', status: 'running' })
    expect(tools[1]).toMatchObject({ status: 'done', output: 'a.txt' })
  })

  it('reads a permission question and describes it for the card', () => {
    const ask = (tool: string, input: object, extra: object = {}) =>
      readPermissionAsk({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: 't1', ...extra } })
    expect(ask('Bash', { command: 'npm test' }, { description: 'Run the tests' })).toMatchObject({
      id: 'r1',
      toolName: 'Bash',
      toolUseId: 't1',
      input: { command: 'npm test' },
      request: { id: 'r1', kind: 'command', summary: 'npm test', reason: 'Run the tests', tool: 'Bash' }
    })
    expect(ask('Write', { file_path: '/etc/hosts' }, { decision_reason: 'Path is outside the working folder', description: 'ignored' })?.request).toMatchObject({
      kind: 'file',
      summary: '/etc/hosts',
      reason: 'Path is outside the working folder'
    })
    expect(ask('mcp__notes__search', { query: 'cats' }, { display_name: 'Search notes' })?.request).toMatchObject({ kind: 'other', summary: 'cats', tool: 'Search notes' })
    expect(ask('Skill', {})?.request).toMatchObject({ kind: 'other', summary: 'Skill', reason: undefined })
    // Other kinds of request are not permission questions.
    expect(readPermissionAsk({ type: 'control_request', request_id: 'r2', request: { subtype: 'hook_callback' } })).toBeUndefined()
    expect(readPermissionAsk({ type: 'control_request', request: { subtype: 'can_use_tool', tool_name: 'Bash' } })).toBeUndefined()
  })

  it('remembers a narrow rule for the rest of a chat, or none', () => {
    expect(sessionRule('Bash', { command: 'npm test' })).toBe('Bash(npm test)')
    // Too involved to match exactly: remembering "all of Bash" would be far more than was allowed.
    expect(sessionRule('Bash', { command: 'rm -rf build && npm run build' })).toBeUndefined()
    expect(sessionRule('Edit', { file_path: '/tmp/a.txt' })).toBe('Edit')
  })

  it('keeps a declined action out of the list offered after the turn', () => {
    const c = collect()
    const p = createClaudeParser(c.emit)
    p.line(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }, { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } }] } }))
    p.refuse('t1')
    p.line(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'The user declined.' }] } }))
    expect(p.ended()).toBe(false)
    p.line(JSON.stringify({ type: 'result', is_error: false, permission_denials: [{ tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test' } }, { tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'ls' } }] }))
    expect(p.ended()).toBe(true)
    expect(c.events).toContainEqual({ type: 'denials', denials: [{ toolName: 'Bash', summary: 'ls', rule: 'Bash(ls)' }] })
    const t1 = c.events.filter((e): e is Extract<RunEvent, { type: 'tool' }> => e.type === 'tool' && e.tool.id === 't1').map((e) => e.tool.status)
    expect(t1).toEqual(['running', 'denied', 'denied', 'denied'])
  })

  it('reports limits, usage and denied actions from the final result', () => {
    const c = collect()
    const p = createClaudeParser(c.emit)
    p.line(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9, resetsAt: 100 } }))
    p.line(JSON.stringify({ type: 'result', is_error: false, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 }, permission_denials: [{ tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'npm test' } }] }))
    expect(c.events).toContainEqual({ type: 'limits', fiveHour: { status: 'warning', usedPct: 90, resetsAt: 100_000 } })
    expect(c.events).toContainEqual({ type: 'usage', usage: { inputTokens: 100, outputTokens: 5 } })
    expect(c.events).toContainEqual({ type: 'denials', denials: [{ toolName: 'Bash', summary: 'npm test', rule: 'Bash(npm test)' }] })
  })

  it('turns sign-in and limit failures into clear errors, once', () => {
    const c = collect()
    const p = createClaudeParser(c.emit)
    p.line(JSON.stringify({ type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Failed to authenticate.' }] } }))
    p.line(JSON.stringify({ type: 'result', is_error: true, api_error_status: 401, result: 'Failed to authenticate.' }))
    const errors = c.events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'auth' })
    expect(c.text()).toBe('')
    expect(p.sawError()).toBe(true)
  })

  it('ignores lines that are not JSON and subagent chatter', () => {
    const c = collect()
    const p = createClaudeParser(c.emit)
    p.line('not json at all')
    p.line(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'sub', message: { content: [{ type: 'text', text: 'inner' }] } }))
    expect(c.events).toEqual([])
  })

  it('describes tools and builds narrow permission rules', () => {
    expect(describeTool('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(describeTool('Odd', {})).toBe('')
    expect(ruleFor('Bash', { command: 'npm test' })).toBe('Bash(npm test)')
    // Anything with shell syntax falls back to the whole tool rather than a rule that might not match.
    expect(ruleFor('Bash', { command: 'rm -rf "$HOME"' })).toBe('Bash')
    expect(ruleFor('Edit', { file_path: 'x' })).toBe('Edit')
  })
})

describe('Codex helpers', () => {
  it('maps items to tool cards', () => {
    expect(codexItemToTool({ type: 'commandExecution', id: 'i', command: 'ls', status: 'completed', aggregatedOutput: 'x' })).toMatchObject({ name: 'Command', summary: 'ls', status: 'done', output: 'x' })
    expect(codexItemToTool({ type: 'fileChange', id: 'i', changes: [{ path: 'a.ts' }, { path: 'b.ts' }], status: 'failed' })).toMatchObject({ name: 'Edit', summary: 'a.ts, b.ts', status: 'error' })
    expect(codexItemToTool({ type: 'commandExecution', id: 'i', command: 'x', status: 'declined' })?.status).toBe('denied')
    expect(codexItemToTool({ type: 'agentMessage', id: 'i' })).toBeUndefined()
  })
  it('classifies errors', () => {
    expect(codexErrorCode('usageLimitExceeded')).toBe('rate_limit')
    expect(codexErrorCode('unauthorized')).toBe('auth')
    expect(codexErrorCode({ httpConnectionFailed: { httpStatusCode: 500 } })).toBe('unknown')
  })
})

describe.skipIf(!canRunFakes)('Claude provider against a stand-in CLI', () => {
  it('reports sign-in state', async () => {
    const settings = testSettings()
    const claude = new ClaudeProvider(() => settings, join(tempDir(), 'tmp'))
    expect(await claude.status()).toMatchObject({ installed: true, ready: true, detail: 'Signed in (Pro plan)' })
    process.env.FAKE_CLAUDE_LOGGED_OUT = '1'
    expect(await claude.status()).toMatchObject({ installed: true, ready: false })
    settings.claude.cliPath = '/nowhere/claude'
    expect(await claude.status()).toMatchObject({ installed: false, ready: false })
  })

  it('streams a reply, passes instructions and resumes a session', async () => {
    const settings = testSettings()
    const claude = new ClaudeProvider(() => settings, join(tempDir(), 'tmp'))
    const first = collect()
    await claude.run({ prompt: 'hello there', system: "The user's standing instructions:\nBe brief.", model: 'sonnet', mode: 'chat', cwd: tempDir() }, first.emit).done
    expect(first.text()).toBe('Claude here. You said: "hello there". I have your standing instructions.')
    const session = first.events.find((e) => e.type === 'session') as { sessionId: string }
    expect(first.events).toContainEqual({ type: 'model', model: 'sonnet' })
    expect(first.events[first.events.length - 1]).toEqual({ type: 'done' })

    const second = collect()
    await claude.run({ prompt: 'again', system: '', model: '', mode: 'edit', cwd: tempDir(), sessionId: session.sessionId }, second.emit).done
    expect(second.text()).toContain('I resumed my earlier session')
    expect((second.events.find((e) => e.type === 'session') as { sessionId: string }).sessionId).toBe(session.sessionId)
  })

  /** Starts a run that will ask for permission, and waits for the question. */
  async function asking(prompt: string, mode: 'plan' | 'edit' = 'edit') {
    const dir = tempDir()
    const log = join(dir, 'fake.log')
    process.env.FAKE_LOG = log
    const settings = testSettings()
    const claude = new ClaudeProvider(() => settings, join(dir, 'tmp'))
    const c = collect()
    const handle = claude.run({ prompt, system: '', model: '', mode, cwd: dir }, c.emit)
    const asks = () => c.events.filter((e): e is Extract<RunEvent, { type: 'approval' }> => e.type === 'approval')
    const tools = () => c.events.filter((e): e is Extract<RunEvent, { type: 'tool' }> => e.type === 'tool').map((e) => e.tool)
    const answers = () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((l) => l.permission)
        .map((l) => l.permission)
    return { c, handle, asks, tools, answers, claude, dir }
  }

  it('asks during the turn and carries on when allowed', async () => {
    const { c, handle, asks, tools, answers } = await asking('run the tests [deny]')
    await until(() => asks().length === 1, 5000, 'the question')
    expect(asks()[0].request).toMatchObject({ kind: 'command', summary: 'npm test', reason: 'Run the test suite', tool: 'Bash' })
    // Nothing has run yet: the turn is waiting for the answer.
    expect(tools().at(-1)).toMatchObject({ name: 'Bash', status: 'running' })
    handle.respondApproval!(asks()[0].request.id, 'accept')
    await handle.done
    expect(c.text()).toContain('I ran the tests')
    expect(tools().at(-1)).toMatchObject({ status: 'done', output: 'All tests passed' })
    expect(c.events.some((e) => e.type === 'denials' || e.type === 'grant' || e.type === 'error')).toBe(false)
    expect(answers()).toEqual([expect.objectContaining({ toolName: 'Bash', behavior: 'allow', updatedInput: { command: 'npm test' } })])
    expect(c.events.at(-1)).toEqual({ type: 'done' })
  })

  it('tells Claude when the user declines, and does not offer the action again afterwards', async () => {
    const { c, handle, asks, tools, answers } = await asking('run the tests [deny]')
    await until(() => asks().length === 1, 5000, 'the question')
    handle.respondApproval!(asks()[0].request.id, 'decline')
    await handle.done
    expect(c.text()).toBe('I need permission to run the tests.')
    expect(tools().at(-1)).toMatchObject({ name: 'Bash', status: 'denied' })
    // The stand-in lists the call as blocked, as the real CLI does, but the user already answered.
    expect(c.events.some((e) => e.type === 'denials')).toBe(false)
    expect(answers()[0]).toMatchObject({ behavior: 'deny' })
    expect(answers()[0].message).toMatch(/declined/)
  })

  it('asks once when the user allows something for the rest of the chat', async () => {
    const { c, handle, asks, answers } = await asking('run the tests [deny] [twice]')
    await until(() => asks().length === 1, 5000, 'the question')
    handle.respondApproval!(asks()[0].request.id, 'acceptForSession')
    await handle.done
    expect(c.text()).toContain('I ran them a second time')
    // The second, identical request was answered without another card.
    expect(asks()).toHaveLength(1)
    expect(answers().map((a) => a.behavior)).toEqual(['allow', 'allow'])
    expect(c.events).toContainEqual({ type: 'grant', rules: ['Bash(npm test)'] })
  })

  it('asks again each time when the user allows only once', async () => {
    const { handle, asks, c } = await asking('run the tests [deny] [twice]')
    await until(() => asks().length === 1, 5000, 'the first question')
    handle.respondApproval!(asks()[0].request.id, 'accept')
    await until(() => asks().length === 2, 5000, 'the second question')
    handle.respondApproval!(asks()[1].request.id, 'accept')
    await handle.done
    expect(c.text()).toContain('I ran them a second time')
  })

  it('withdraws a question that Claude Code settled by itself', async () => {
    const { c, handle, asks } = await asking('run the tests [deny] [cancel]')
    await handle.done
    expect(asks().map((a) => !!a.settled)).toEqual([false, true])
    expect(asks()[1].request.id).toBe(asks()[0].request.id)
    expect(c.text()).toContain('I ran the tests')
  })

  it('answers a request to leave plan mode itself, so the plan arrives as a reply', async () => {
    const { c, handle, asks, answers } = await asking('plan the change [plan]', 'plan')
    await handle.done
    expect(asks()).toHaveLength(0)
    expect(c.text()).toContain('Here is the plan as text')
    expect(c.events.some((e) => e.type === 'denials')).toBe(false)
    expect(answers()[0]).toMatchObject({ toolName: 'ExitPlanMode', behavior: 'deny' })
  })

  it('stops while a question is waiting', async () => {
    const { c, handle, asks } = await asking('run the tests [deny]')
    await until(() => asks().length === 1, 5000, 'the question')
    handle.stop()
    await handle.done
    expect(c.events).toContainEqual({ type: 'error', code: 'aborted', message: 'Stopped.' })
  })

  it('falls back to asking after the turn when the CLI is too old to ask during it', async () => {
    process.env.FAKE_CLAUDE_NO_LIVE = '1'
    const dir = tempDir()
    const log = join(dir, 'fake.log')
    process.env.FAKE_LOG = log
    const settings = testSettings()
    const claude = new ClaudeProvider(() => settings, join(dir, 'tmp'))
    const denied = collect()
    await claude.run({ prompt: 'run the tests [deny]', system: '', model: '', mode: 'edit', cwd: dir }, denied.emit).done
    const d = denied.events.find((e) => e.type === 'denials') as Extract<RunEvent, { type: 'denials' }>
    expect(d.denials).toEqual([{ toolName: 'Bash', summary: 'npm test', rule: 'Bash(npm test)' }])
    expect(denied.events.some((e) => e.type === 'approval' || e.type === 'error')).toBe(false)

    const allowed = collect()
    await claude.run({ prompt: 'run the tests [deny]', system: '', model: '', mode: 'edit', cwd: dir, allow: d.denials.map((x) => x.rule) }, allowed.emit).done
    expect(allowed.events.some((e) => e.type === 'denials')).toBe(false)
    expect(allowed.text()).toContain('Claude here.')

    // Tried once with the option, then without, and it was not tried again for the next turn.
    const starts = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => Array.isArray(l.args) && l.args.includes('-p'))
      .map((l) => l.args.includes('--permission-prompt-tool'))
    expect(starts).toEqual([true, false, false])
  })

  it('does not ask during one-off runs, which nobody is watching', async () => {
    const settings = testSettings()
    const claude = new ClaudeProvider(() => settings, join(tempDir(), 'tmp'))
    const c = collect()
    await claude.run({ prompt: 'run the tests [deny]', system: '', model: '', mode: 'edit', cwd: tempDir(), ephemeral: true }, c.emit).done
    expect(c.events.some((e) => e.type === 'approval')).toBe(false)
    expect(c.events.some((e) => e.type === 'denials')).toBe(true)
  })

  it('reports a missing CLI and an expired sign-in as errors', async () => {
    const settings = testSettings()
    const claude = new ClaudeProvider(() => settings, join(tempDir(), 'tmp'))
    process.env.FAKE_CLAUDE_LOGGED_OUT = '1'
    const auth = collect()
    await claude.run({ prompt: 'x', system: '', model: '', mode: 'chat', cwd: tempDir() }, auth.emit).done
    expect(auth.events.filter((e) => e.type === 'error')).toEqual([expect.objectContaining({ code: 'auth' })])

    settings.claude.cliPath = '/nowhere/claude'
    const missing = collect()
    await claude.run({ prompt: 'x', system: '', model: '', mode: 'chat', cwd: tempDir() }, missing.emit).done
    expect(missing.events).toEqual([expect.objectContaining({ type: 'error', code: 'not_installed' }), { type: 'done' }])
  })
})

describe.skipIf(!canRunFakes)('ChatGPT provider against a stand-in app-server', () => {
  function make() {
    const settings = testSettings()
    const limits: unknown[] = []
    const codex = new CodexProvider(() => settings, '0.0.0-test', (l) => limits.push(l))
    cleanup.push(() => codex.dispose())
    return { settings, codex, limits }
  }

  it('reports sign-in, visible models and plan limits', async () => {
    const { codex, limits } = make()
    const st = await codex.status()
    expect(st).toMatchObject({ installed: true, ready: true, detail: 'Signed in (Plus plan)' })
    expect(st.models).toEqual(['gpt-fake-large', 'gpt-fake-small'])
    await codex.refreshLimits()
    expect(limits[limits.length - 1]).toMatchObject({ fiveHour: { usedPct: 12 }, weekly: { usedPct: 31 } })
  })

  it('streams a reply and resumes the same thread', async () => {
    const { codex } = make()
    const first = collect()
    await codex.run({ prompt: 'hello', system: "The user's standing instructions:\nBe brief.", model: '', mode: 'chat', cwd: tempDir() }, first.emit).done
    expect(first.text()).toBe('ChatGPT here. You said: "hello". I have your standing instructions.')
    expect(first.events.some((e) => e.type === 'usage')).toBe(true)
    const session = first.events.find((e) => e.type === 'session') as { sessionId: string }

    const second = collect()
    await codex.run({ prompt: 'again', system: '', model: '', mode: 'chat', cwd: tempDir(), sessionId: session.sessionId }, second.emit).done
    expect(second.text()).toContain('I resumed my earlier session')
  })

  it('asks before a command and continues after the answer', async () => {
    const { codex } = make()
    const c = collect()
    let handle: ReturnType<CodexProvider['run']>
    const emit = (e: RunEvent) => {
      c.emit(e)
      if (e.type === 'approval') handle.respondApproval?.(e.request.id, 'accept')
    }
    handle = codex.run({ prompt: 'install it [approve]', system: '', model: '', mode: 'edit', cwd: tempDir() }, emit)
    await handle.done
    const approval = c.events.find((e) => e.type === 'approval') as Extract<RunEvent, { type: 'approval' }>
    expect(approval.request).toMatchObject({ kind: 'command', summary: 'npm install', reason: 'Needs network access' })
    const tool = c.events.filter((e) => e.type === 'tool').pop() as Extract<RunEvent, { type: 'tool' }>
    expect(tool.tool).toMatchObject({ name: 'Command', status: 'done', output: 'added 3 packages' })
    expect(c.text()).toContain('ChatGPT here.')
  })

  it('reports a used-up limit as a limit error', async () => {
    const { codex } = make()
    const c = collect()
    await codex.run({ prompt: 'anything [limit]', system: '', model: '', mode: 'chat', cwd: tempDir() }, c.emit).done
    expect(c.events.filter((e) => e.type === 'error')).toEqual([expect.objectContaining({ code: 'rate_limit' })])
    expect(c.events[c.events.length - 1]).toEqual({ type: 'done' })
  })

  it('stops a reply part way', async () => {
    process.env.FAKE_DELAY_MS = '40'
    const { codex } = make()
    const c = collect()
    const handle = codex.run({ prompt: 'a fairly long message so that there is time to stop it', system: '', model: '', mode: 'chat', cwd: tempDir() }, (e) => {
      c.emit(e)
      if (e.type === 'text' && c.events.filter((x) => x.type === 'text').length === 2) handle.stop()
    })
    await handle.done
    delete process.env.FAKE_DELAY_MS
    expect(c.events).toContainEqual(expect.objectContaining({ type: 'error', code: 'aborted' }))
    expect(c.text().length).toBeLessThan('ChatGPT here. You said: "a fairly long message so that there is time to stop it".'.length)
  })
})

describe.skipIf(!canRunFakes)('ChatGPT provider restarts when its tool changes', () => {
  it('stops using the old process as soon as a different CLI is configured', async () => {
    const settings = testSettings()
    const codex = new CodexProvider(() => settings, '0.0.0-test', () => {})
    cleanup.push(() => codex.dispose())
    expect((await codex.status()).ready).toBe(true)
    settings.chatgpt.cliPath = '/nowhere/codex'
    expect(await codex.status()).toMatchObject({ installed: false, ready: false })
    const c = collect()
    await codex.run({ prompt: 'hi', system: '', model: '', mode: 'chat', cwd: tempDir() }, c.emit).done
    expect(c.events).toEqual([expect.objectContaining({ type: 'error', code: 'not_installed' }), { type: 'done' }])
  })
})
