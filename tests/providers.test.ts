import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { RunEvent } from '@shared/types'
import { ClaudeProvider } from '../src/main/providers/claude'
import { createClaudeParser, describeTool, ruleFor } from '../src/main/providers/claudeParser'
import { CodexProvider, codexErrorCode, codexItemToTool } from '../src/main/providers/codex'
import { canRunFakes, tempDir, testSettings } from './helpers'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
  delete process.env.FAKE_CLAUDE_LOGGED_OUT
  delete process.env.FAKE_CLAUDE_UTILIZATION
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

  it('surfaces a denied action, then runs it once allowed', async () => {
    const settings = testSettings()
    const claude = new ClaudeProvider(() => settings, join(tempDir(), 'tmp'))
    const denied = collect()
    await claude.run({ prompt: 'run the tests [deny]', system: '', model: '', mode: 'edit', cwd: tempDir() }, denied.emit).done
    const d = denied.events.find((e) => e.type === 'denials') as Extract<RunEvent, { type: 'denials' }>
    expect(d.denials).toEqual([{ toolName: 'Bash', summary: 'npm test', rule: 'Bash(npm test)' }])

    const allowed = collect()
    await claude.run({ prompt: 'run the tests [deny]', system: '', model: '', mode: 'edit', cwd: tempDir(), allow: d.denials.map((x) => x.rule) }, allowed.emit).done
    expect(allowed.events.some((e) => e.type === 'denials')).toBe(false)
    expect(allowed.text()).toContain('Claude here.')
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
