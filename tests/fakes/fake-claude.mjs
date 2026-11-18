#!/usr/bin/env node
// Stand-in for the Claude Code CLI, used by tests. It speaks the same
// stream-json format as the real CLI so the app can be exercised without a
// subscription. Behaviour is steered by FAKE_* environment variables and by
// markers in the prompt.

import { appendFileSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const log = process.env.FAKE_LOG
if (log) appendFileSync(log, `${JSON.stringify({ tool: 'claude', args })}\n`)

if (args[0] === '--version') {
  console.log('9.9.9 (Fake Claude Code)')
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'status') {
  const loggedIn = process.env.FAKE_CLAUDE_LOGGED_OUT !== '1'
  console.log(JSON.stringify({ loggedIn, authMethod: 'claude.ai', subscriptionType: 'pro' }))
  process.exit(loggedIn ? 0 : 1)
}

const arg = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let prompt = ''
for await (const chunk of process.stdin) prompt += chunk

const sessionId = arg('--resume') ?? randomUUID()
const model = arg('--model') ?? 'claude-fake-1'
const systemFile = arg('--append-system-prompt-file')
const system = systemFile ? readFileSync(systemFile, 'utf8') : ''
const base = { session_id: sessionId, uuid: randomUUID() }

out({ type: 'system', subtype: 'init', ...base, model, cwd: process.cwd(), permissionMode: arg('--permission-mode') ?? 'default' })

if (process.env.FAKE_CLAUDE_LOGGED_OUT === '1') {
  out({ type: 'assistant', ...base, error: 'authentication_failed', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Failed to authenticate.' }] } })
  out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'Failed to authenticate.', ...base })
  process.exit(1)
}
if (process.env.FAKE_CLAUDE_LIMIT === '1' || prompt.includes('[limit]')) {
  out({ type: 'rate_limit_event', ...base, rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 } })
  out({ type: 'assistant', ...base, error: 'rate_limit', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'You have hit your usage limit.' }] } })
  out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'You have hit your usage limit.', ...base })
  process.exit(1)
}

const lastLine = prompt.trim().split('\n').filter(Boolean).pop() ?? ''
const notes = []
if (prompt.includes('<context_file>')) notes.push('I received the context file')
if (prompt.includes('<conversation_since_your_last_reply>')) notes.push('I was caught up on what happened in between')
if (arg('--resume')) notes.push('I resumed my earlier session')
if (system.includes('standing instructions')) notes.push('I have your standing instructions')
const reply = `Claude here. You said: "${lastLine}".${notes.length ? ` ${notes.join('. ')}.` : ''}`

const utilization = Number(process.env.FAKE_CLAUDE_UTILIZATION ?? '0.2')
out({
  type: 'rate_limit_event',
  ...base,
  rate_limit_info: { status: utilization >= 0.8 ? 'allowed_warning' : 'allowed', rateLimitType: 'five_hour', utilization, resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600 }
})

const stream = (event) => out({ type: 'stream_event', ...base, parent_tool_use_id: null, event })
stream({ type: 'message_start' })

const wantsTool = prompt.includes('[tool]') || prompt.includes('[deny]')
if (wantsTool) {
  const toolId = `toolu_${randomUUID().slice(0, 8)}`
  const command = prompt.includes('[deny]') ? 'npm test' : 'ls'
  out({ type: 'assistant', ...base, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command } }] } })
  await sleep(30)
  const allowed = (arg('--allowedTools') ?? '').includes('Bash')
  if (prompt.includes('[deny]') && !allowed) {
    out({ type: 'user', ...base, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, is_error: true, content: 'Permission denied' }] } })
    stream({ type: 'content_block_start', content_block: { type: 'text' } })
    stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'I need permission to run the tests.' } })
    out({ type: 'assistant', ...base, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'I need permission to run the tests.' }] } })
    out({ type: 'result', subtype: 'success', is_error: false, result: 'I need permission to run the tests.', usage: { input_tokens: 40, output_tokens: 12 }, permission_denials: [{ tool_name: 'Bash', tool_use_id: toolId, tool_input: { command } }], ...base })
    process.exit(0)
  }
  out({ type: 'user', ...base, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'file-a.txt\nfile-b.txt' }] } })
}

stream({ type: 'content_block_start', content_block: { type: 'text' } })
const delay = Number(process.env.FAKE_DELAY_MS ?? '8')
for (const word of reply.split(/(?<= )/)) {
  stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: word } })
  await sleep(delay)
}
out({ type: 'assistant', ...base, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } })
out({ type: 'result', subtype: 'success', is_error: false, result: reply, usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: Math.ceil(reply.length / 4) }, permission_denials: [], ...base })
