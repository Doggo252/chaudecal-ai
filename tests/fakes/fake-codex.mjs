#!/usr/bin/env node
// Stand-in for the Codex CLI, used by tests. `app-server` speaks the same
// newline-delimited JSON-RPC as the real one for the calls this app makes.

import { appendFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { connectMcp } from './mcp-client.mjs'

const args = process.argv.slice(2)
const log = process.env.FAKE_LOG
const record = (o) => log && appendFileSync(log, `${JSON.stringify({ tool: 'codex', ...o })}\n`)
record({ args })

if (args[0] === '--version') {
  console.log('codex-cli 9.9.9-fake')
  process.exit(0)
}
if (args[0] === 'login') {
  console.error('Logged in using ChatGPT')
  process.exit(0)
}
if (args[0] !== 'app-server') process.exit(2)

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const loggedIn = process.env.FAKE_CODEX_LOGGED_OUT !== '1'
const usedPercent = Number(process.env.FAKE_CODEX_USED ?? '12')
const limits = () => ({
  limitId: 'codex',
  primary: { usedPercent, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3 * 3600 },
  secondary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 4 * 86400 },
  planType: 'plus'
})
const threads = new Map()
const pendingApprovals = new Map()
let rpcId = 1000

/** Starts the tool servers a conversation was opened with, and reports each one's state like the real app server. */
function startMcp(threadId, thread, servers) {
  thread.mcp = {}
  thread.mcpConfig = servers ?? {}
  thread.remembered = new Set()
  thread.mcpReady = Promise.all(
    Object.entries(thread.mcpConfig).map(async ([name, server]) => {
      send({ method: 'mcpServer/startupStatus/updated', params: { threadId, name, status: 'starting', error: null, failureReason: null } })
      try {
        thread.mcp[name] = await connectMcp(server)
        send({ method: 'mcpServer/startupStatus/updated', params: { threadId, name, status: 'ready', error: null, failureReason: null } })
      } catch (e) {
        send({ method: 'mcpServer/startupStatus/updated', params: { threadId, name, status: 'failed', error: `MCP client for \`${name}\` failed to start: ${e.message}`, failureReason: null } })
      }
    })
  )
}

/** Uses a tool of the conversation's first tool server, asking first the way the real Codex does. */
async function useMcpTool(threadId, turnId, thread, tool) {
  const server = Object.keys(thread.mcp)[0]
  if (!server) return 'I have no tool server to use'
  const args = { text: tool === 'echo' ? 'hello' : 'milk' }
  const readOnly = tool === 'echo'
  const itemId = `exec-${randomUUID().slice(0, 8)}`
  const item = { type: 'mcpToolCall', id: itemId, server, tool, arguments: args, readOnlyHint: readOnly, result: null, error: null }
  send({ method: 'item/started', params: { threadId, turnId, item: { ...item, status: 'inProgress' } } })
  const fail = (message) => {
    send({ method: 'item/completed', params: { threadId, turnId, item: { ...item, status: 'failed', error: { message } } } })
    return 'I was not allowed to use the tool'
  }
  const trusted = thread.mcpConfig[server].default_tools_approval_mode === 'approve'
  if (!readOnly && !trusted && !thread.remembered.has(`${server}/${tool}`)) {
    if (thread.approvalPolicy === 'never') return fail('MCP tool call requires approval, but approval policy is never')
    const id = rpcId++
    const answer = await new Promise((resolve) => {
      pendingApprovals.set(id, resolve)
      send({
        method: 'mcpServer/elicitation/request',
        id,
        params: {
          threadId,
          turnId,
          serverName: server,
          mode: 'form',
          _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_name: tool, tool_description: 'Saves a note.', tool_params: args },
          message: `Allow the ${server} MCP server to run tool "${tool}"?`,
          requestedSchema: { type: 'object', properties: {} }
        }
      })
    })
    record({ mcpApproval: answer })
    send({ method: 'serverRequest/resolved', params: { threadId, requestId: id } })
    if (answer?.action !== 'accept') return fail('user rejected MCP tool call')
    if (answer._meta?.persist === 'session') thread.remembered.add(`${server}/${tool}`)
  }
  const said = await thread.mcp[server].call(tool, args)
  send({ method: 'item/completed', params: { threadId, turnId, item: { ...item, status: 'completed', result: { content: [{ type: 'text', text: said }] } } } })
  return `The ${server} tool answered: ${said}`
}

async function runTurn(threadId, text, imageCount = 0) {
  const turnId = randomUUID()
  const thread = threads.get(threadId)
  send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } })

  if (process.env.FAKE_CODEX_LIMIT === '1' || text.includes('[limit]')) {
    const error = { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null }
    send({ method: 'error', params: { error, willRetry: false, threadId, turnId } })
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'failed', error } } })
    return
  }

  if (text.includes('[approve]')) {
    const itemId = `item_${randomUUID().slice(0, 6)}`
    const id = rpcId++
    const decision = await new Promise((resolve) => {
      pendingApprovals.set(id, (result) => resolve(result?.decision))
      send({ method: 'item/commandExecution/requestApproval', id, params: { threadId, turnId, itemId, command: 'npm install', reason: 'Needs network access', startedAtMs: Date.now() } })
    })
    record({ approval: decision })
    send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'commandExecution', id: itemId, command: 'npm install', status: decision === 'decline' ? 'declined' : 'completed', aggregatedOutput: decision === 'decline' ? '' : 'added 3 packages', exitCode: 0 } } })
  }

  const lastLine = text.trim().split('\n').filter(Boolean).pop() ?? ''
  const notes = []
  await thread.mcpReady
  // "[mcp]" saves a note with the first tool server, "[mcp-echo]" uses its read-only tool.
  if (text.includes('[mcp]') || text.includes('[mcp-echo]')) {
    const rounds = text.includes('[twice]') ? 2 : 1
    for (let round = 0; round < rounds; round++) {
      const note = await useMcpTool(threadId, turnId, thread, text.includes('[mcp-echo]') ? 'echo' : 'add_note')
      notes.push(note)
      if (/not allowed|no tool server/.test(note)) break
    }
  }
  // "[image]" makes a picture, the way Codex reports one when image generation is on.
  if (lastLine.includes('[image]')) {
    if (!thread.config?.features?.image_generation) notes.push('Image generation is off')
    else {
      const item = { type: 'imageGeneration', id: `ig-${randomUUID().slice(0, 6)}`, revisedPrompt: 'A small red square', transparentBackground: false, failure: null }
      send({ method: 'item/started', params: { threadId, turnId, item: { ...item, status: 'in_progress', result: '' } } })
      send({ method: 'item/completed', params: { threadId, turnId, item: { ...item, status: 'completed', result: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAANUlEQVR4nO3NMQEAMAjEwKdq8K8HMZUQFracgKSmO5feaT0OFhwgB8gBcoAcIAfIAXKAHIR8xN0BbKPsVwsAAAAASUVORK5CYII=' } } })
      notes.push('Here is your picture')
    }
  }
  // "[work]" works through a small task: a plan, a file change and a command.
  if (lastLine.includes('[work]')) {
    const plan = (done) => send({ method: 'turn/plan/updated', params: { threadId, turnId, explanation: null, plan: [
      { step: 'Update the readme', status: done > 0 ? 'completed' : 'inProgress' },
      { step: 'Run the tests', status: done > 1 ? 'completed' : done === 1 ? 'inProgress' : 'pending' }
    ] } })
    plan(0)
    const change = { type: 'fileChange', id: `fc-${randomUUID().slice(0, 6)}`, changes: [{ path: 'README.md', kind: { type: 'update', move_path: null }, diff: '@@ -1,2 +1,3 @@\n # Title\n-Old line\n+New line\n+Another line\n' }] }
    send({ method: 'item/started', params: { threadId, turnId, item: { ...change, status: 'inProgress' } } })
    send({ method: 'item/completed', params: { threadId, turnId, item: { ...change, status: 'completed' } } })
    plan(1)
    const cmd = { type: 'commandExecution', id: `cmd-${randomUUID().slice(0, 6)}`, command: 'npm test', aggregatedOutput: 'ok', exitCode: 0 }
    send({ method: 'item/started', params: { threadId, turnId, item: { ...cmd, status: 'inProgress' } } })
    send({ method: 'item/completed', params: { threadId, turnId, item: { ...cmd, status: 'completed' } } })
    plan(2)
    notes.push('The work is done')
  }
  if (text.includes('<context_file>')) notes.push('I received the context file')
  if (text.includes('<conversation_since_your_last_reply>')) notes.push('I was caught up on what happened in between')
  if (thread.resumed) notes.push('I resumed my earlier session')
  if (imageCount) notes.push(`I can see ${imageCount} ${imageCount === 1 ? 'image' : 'images'}`)
  if (text.includes('<attached_file')) notes.push('I read the attached file')
  // A PDF arrives as text with a marker at the start of each page.
  const pdfPages = (text.match(/\[Page \d+\]\n/g) ?? []).length
  if (pdfPages) notes.push(`I read a PDF of ${pdfPages} ${pdfPages === 1 ? 'page' : 'pages'}`)
  if ((thread.developerInstructions ?? '').includes('standing instructions')) notes.push('I have your standing instructions')
  const reply = `ChatGPT here. You said: "${lastLine}".${notes.length ? ` ${notes.join('. ')}.` : ''}`

  const itemId = `item_${randomUUID().slice(0, 6)}`
  send({ method: 'item/started', params: { threadId, turnId, item: { type: 'agentMessage', id: itemId, text: '' } } })
  const delay = Number(process.env.FAKE_DELAY_MS ?? '8')
  for (const word of reply.split(/(?<= )/)) {
    send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId, delta: word } })
    await sleep(delay)
    if (thread.interrupted) {
      thread.interrupted = false
      send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'interrupted', error: null } } })
      return
    }
  }
  send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: itemId, text: reply } } })
  send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { last: { inputTokens: Math.ceil(text.length / 4), outputTokens: Math.ceil(reply.length / 4), totalTokens: 0 }, total: {} } } })
  send({ method: 'account/rateLimits/updated', params: { rateLimits: limits() } })
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', error: null } } })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params = {} } = msg
  if (method === undefined && id !== undefined) {
    pendingApprovals.get(id)?.(msg.result)
    pendingApprovals.delete(id)
    return
  }
  record({ method, params: { ...params, input: undefined } })
  const reply = (result) => send({ id, result })
  switch (method) {
    case 'initialize':
      return reply({ userAgent: 'fake-codex', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' })
    case 'initialized':
      return
    case 'account/read':
      return reply({ account: loggedIn ? { type: 'chatgpt', email: 'user@example.com', planType: 'plus', workspaceName: null } : null, requiresOpenaiAuth: true })
    case 'model/list':
      return reply({
        data: [
          { id: 'gpt-fake-large', model: 'gpt-fake-large', displayName: 'Fake Large', hidden: false, isDefault: true },
          { id: 'gpt-fake-small', model: 'gpt-fake-small', displayName: 'Fake Small', hidden: false, isDefault: false },
          { id: 'internal', model: 'internal', displayName: 'Internal', hidden: true, isDefault: false }
        ],
        nextCursor: null
      })
    case 'account/rateLimits/read':
      return reply({ rateLimits: limits(), rateLimitsByLimitId: null })
    case 'thread/start': {
      const threadId = randomUUID()
      const thread = { developerInstructions: params.developerInstructions, approvalPolicy: params.approvalPolicy, resumed: false }
      threads.set(threadId, thread)
      reply({ thread: { id: threadId }, model: params.model ?? 'gpt-fake-large' })
      thread.config = params.config ?? {}
      startMcp(threadId, thread, params.config?.mcp_servers)
      return
    }
    case 'thread/resume': {
      const thread = { developerInstructions: params.developerInstructions, approvalPolicy: params.approvalPolicy, resumed: true }
      for (const client of Object.values(threads.get(params.threadId)?.mcp ?? {})) client.close()
      threads.set(params.threadId, thread)
      reply({ thread: { id: params.threadId }, model: params.model ?? 'gpt-fake-large' })
      thread.config = params.config ?? {}
      startMcp(params.threadId, thread, params.config?.mcp_servers)
      return
    }
    case 'turn/start': {
      const text = (params.input ?? []).map((i) => i.text ?? '').join('\n')
      const images = (params.input ?? []).filter((i) => i.type === 'localImage' && existsSync(i.path)).length
      record({ images })
      reply({ turn: { id: 'pending', status: 'inProgress' } })
      void runTurn(params.threadId, text, images)
      return
    }
    case 'turn/interrupt': {
      const t = threads.get(params.threadId)
      if (t) t.interrupted = true
      return reply({})
    }
    default:
      return send({ id, error: { code: -32601, message: `Unknown method ${method}` } })
  }
})
