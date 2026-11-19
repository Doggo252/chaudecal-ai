#!/usr/bin/env node
// Stand-in for the Claude Code CLI, used by tests. It speaks the same
// stream-json format as the real CLI so the app can be exercised without a
// subscription. Behaviour is steered by FAKE_* environment variables and by
// markers in the prompt.

import { appendFileSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { connectMcp } from './mcp-client.mjs'

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

// With --permission-prompt-tool stdio the CLI asks for permission during the turn: it writes a
// control_request on stdout and reads the control_response from stdin, which therefore stays open.
const live = arg('--permission-prompt-tool') === 'stdio'
if (live && process.env.FAKE_CLAUDE_NO_LIVE === '1') {
  process.stderr.write("error: unknown option '--permission-prompt-tool'\n")
  process.exit(1)
}

const queue = []
const waiters = []
let inputEnded = false
let pending = ''
const push = (line) => (waiters.length ? waiters.shift()(line) : queue.push(line))
process.stdin.on('data', (d) => {
  pending += d
  let i
  while ((i = pending.indexOf('\n')) >= 0) {
    push(pending.slice(0, i))
    pending = pending.slice(i + 1)
  }
})
process.stdin.on('end', () => {
  inputEnded = true
  for (const w of waiters.splice(0)) w(undefined)
})
/** The next line of input, or undefined once the input has been closed. */
const nextLine = () => (queue.length ? Promise.resolve(queue.shift()) : inputEnded ? Promise.resolve(undefined) : new Promise((r) => waiters.push(r)))

let prompt = ''
if (live) {
  prompt = (await nextLine()) ?? ''
} else {
  for (let line = await nextLine(); line !== undefined; line = await nextLine()) prompt += `${line}\n`
  prompt += pending
}

// With --input-format stream-json the turn arrives as one JSON message that can carry images.
let imageCount = 0
if (arg('--input-format') === 'stream-json') {
  const content = JSON.parse(prompt.trim().split('\n')[0]).message.content
  imageCount = content.filter((c) => c.type === 'image' && c.source?.type === 'base64' && c.source.data).length
  prompt = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  if (log) appendFileSync(log, `${JSON.stringify({ tool: 'claude', images: imageCount })}\n`)
}

const sessionId = arg('--resume') ?? randomUUID()
const model = arg('--model') ?? 'claude-fake-1'
const systemFile = arg('--append-system-prompt-file')
const system = systemFile ? readFileSync(systemFile, 'utf8') : ''
const base = { session_id: sessionId, uuid: randomUUID() }

// Tool servers given with --mcp-config are started before the turn, like the real CLI does.
const mcpFile = arg('--mcp-config')
const mcpConfig = mcpFile ? (JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers ?? {}) : {}
const mcp = {}
for (const [name, server] of Object.entries(mcpConfig)) {
  try {
    mcp[name] = await connectMcp(server)
  } catch {
    // Reported as failed below.
  }
}
if (log && mcpFile) appendFileSync(log, `${JSON.stringify({ tool: 'claude', mcp: mcpConfig })}\n`)
const mcp_servers = Object.keys(mcpConfig).map((name) => ({ name, status: mcp[name] ? 'connected' : 'failed' }))

out({ type: 'system', subtype: 'init', ...base, model, cwd: process.cwd(), permissionMode: arg('--permission-mode') ?? 'default', mcp_servers })

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
if (imageCount) notes.push(`I can see ${imageCount} ${imageCount === 1 ? 'image' : 'images'}`)
if (prompt.includes('<attached_file')) notes.push('I read the attached file')
// A PDF arrives as text with a marker at the start of each page.
const pdfPages = (prompt.match(/\[Page \d+\]\n/g) ?? []).length
if (pdfPages) notes.push(`I read a PDF of ${pdfPages} ${pdfPages === 1 ? 'page' : 'pages'}`)
if (system.includes('standing instructions')) notes.push('I have your standing instructions')
const utilization = Number(process.env.FAKE_CLAUDE_UTILIZATION ?? '0.2')
out({
  type: 'rate_limit_event',
  ...base,
  rate_limit_info: { status: utilization >= 0.8 ? 'allowed_warning' : 'allowed', rateLimitType: 'five_hour', utilization, resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600 }
})

const stream = (event) => out({ type: 'stream_event', ...base, parent_tool_use_id: null, event })
stream({ type: 'message_start' })

/** Ends the turn. Like the real CLI, a live run only exits once its input has been closed. */
async function end(result) {
  for (const client of Object.values(mcp)) client.close()
  out(result)
  if (live) while ((await nextLine()) !== undefined);
  process.exit(result.is_error ? 1 : 0)
}

const toolUse = (id, name, input) => out({ type: 'assistant', ...base, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const toolResult = (id, content, isError = false) =>
  out({ type: 'user', ...base, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } })
const newToolId = () => `toolu_${randomUUID().slice(0, 8)}`

/** Asks the app whether a tool may be used, and waits for its answer. */
async function ask(toolName, input, toolUseId, extra = {}) {
  const id = randomUUID()
  out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: toolName, display_name: toolName, input, tool_use_id: toolUseId, ...extra } })
  if (prompt.includes('[cancel]')) {
    // Settled without the app, the way one of the user's own hooks would.
    await sleep(40)
    out({ type: 'control_cancel_request', request_id: id })
    return { behavior: 'allow', updatedInput: input }
  }
  for (;;) {
    const line = await nextLine()
    if (line === undefined) process.exit(1)
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.type !== 'control_response' || msg.response?.request_id !== id) continue
    const answer = msg.response.subtype === 'success' ? msg.response.response : { behavior: 'deny', message: String(msg.response.error) }
    if (log) appendFileSync(log, `${JSON.stringify({ tool: 'claude', permission: { toolName, ...answer } })}\n`)
    return answer
  }
}

const denials = []
const say = async (text) => {
  stream({ type: 'content_block_start', content_block: { type: 'text' } })
  stream({ type: 'content_block_delta', delta: { type: 'text_delta', text } })
  out({ type: 'assistant', ...base, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } })
}

if (prompt.includes('[plan]')) {
  // Plan mode ends with a request to leave it, which only Claude Code's own window can show.
  const toolId = newToolId()
  const input = { plan: '1. Read the code\n2. Change it' }
  toolUse(toolId, 'ExitPlanMode', input)
  const answer = live ? await ask('ExitPlanMode', input, toolId) : { behavior: 'deny', message: 'Permission denied' }
  if (answer.behavior === 'allow') {
    toolResult(toolId, 'Plan approved')
    notes.push('I left plan mode')
  } else {
    toolResult(toolId, answer.message, true)
    denials.push({ tool_name: 'ExitPlanMode', tool_use_id: toolId, tool_input: input })
    notes.push(/as your answer/.test(answer.message) ? 'Here is the plan as text' : 'I could not show the plan')
  }
}

if (prompt.includes('[tool]') || prompt.includes('[deny]')) {
  const command = prompt.includes('[deny]') ? 'npm test' : 'ls'
  const allowed = !prompt.includes('[deny]') || (arg('--allowedTools') ?? '').includes('Bash')
  const rounds = prompt.includes('[twice]') ? 2 : 1
  for (let round = 0; round < rounds; round++) {
    const toolId = newToolId()
    toolUse(toolId, 'Bash', { command })
    await sleep(30)
    const answer = allowed ? { behavior: 'allow' } : live ? await ask('Bash', { command }, toolId, { description: 'Run the test suite' }) : { behavior: 'deny', message: 'Permission denied' }
    if (answer.behavior !== 'allow') {
      toolResult(toolId, answer.message, true)
      denials.push({ tool_name: 'Bash', tool_use_id: toolId, tool_input: { command } })
      await say('I need permission to run the tests.')
      await end({ type: 'result', subtype: 'success', is_error: false, result: 'I need permission to run the tests.', usage: { input_tokens: 40, output_tokens: 12 }, permission_denials: denials, ...base })
    }
    toolResult(toolId, command === 'ls' ? 'file-a.txt\nfile-b.txt' : 'All tests passed')
    if (!allowed) notes.push(round ? 'I ran them a second time' : 'I ran the tests')
  }
}

// "[mcp]" saves a note with the first tool server, "[mcp-echo]" uses its read-only tool.
// Claude Code asks before either one unless a permission rule covers the tool.
if (prompt.includes('[mcp]') || prompt.includes('[mcp-echo]')) {
  const name = Object.keys(mcp)[0]
  if (!name) notes.push('I have no tool server to use')
  else {
    const tool = prompt.includes('[mcp-echo]') ? 'echo' : 'add_note'
    const toolName = `mcp__${name}__${tool}`
    const input = { text: tool === 'echo' ? 'hello' : 'milk' }
    const rules = (arg('--allowedTools') ?? '').split(',')
    const allowed = rules.includes(`mcp__${name}`) || rules.includes(toolName)
    const rounds = prompt.includes('[twice]') ? 2 : 1
    for (let round = 0; round < rounds; round++) {
      const toolId = newToolId()
      toolUse(toolId, toolName, input)
      const answer = allowed ? { behavior: 'allow' } : live ? await ask(toolName, input, toolId) : { behavior: 'deny', message: 'Permission denied' }
      if (answer.behavior !== 'allow') {
        toolResult(toolId, answer.message, true)
        denials.push({ tool_name: toolName, tool_use_id: toolId, tool_input: input })
        notes.push('I was not allowed to use the tool')
        break
      }
      const said = await mcp[name].call(tool, input)
      toolResult(toolId, said)
      notes.push(`The ${name} tool answered: ${said}`)
    }
  }
}

const reply = `Claude here. You said: "${lastLine}".${notes.length ? ` ${notes.join('. ')}.` : ''}`

stream({ type: 'content_block_start', content_block: { type: 'text' } })
const delay = Number(process.env.FAKE_DELAY_MS ?? '8')
for (const word of reply.split(/(?<= )/)) {
  stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: word } })
  await sleep(delay)
}
out({ type: 'assistant', ...base, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } })
await end({ type: 'result', subtype: 'success', is_error: false, result: reply, usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: Math.ceil(reply.length / 4) }, permission_denials: denials, ...base })
