#!/usr/bin/env node
// Stand-in for the Codex CLI, used by tests. `app-server` speaks the same
// newline-delimited JSON-RPC as the real one for the calls this app makes.

import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

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

async function runTurn(threadId, text) {
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
      pendingApprovals.set(id, resolve)
      send({ method: 'item/commandExecution/requestApproval', id, params: { threadId, turnId, itemId, command: 'npm install', reason: 'Needs network access', startedAtMs: Date.now() } })
    })
    record({ approval: decision })
    send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'commandExecution', id: itemId, command: 'npm install', status: decision === 'decline' ? 'declined' : 'completed', aggregatedOutput: decision === 'decline' ? '' : 'added 3 packages', exitCode: 0 } } })
  }

  const lastLine = text.trim().split('\n').filter(Boolean).pop() ?? ''
  const notes = []
  if (text.includes('<context_file>')) notes.push('I received the context file')
  if (text.includes('<conversation_since_your_last_reply>')) notes.push('I was caught up on what happened in between')
  if (thread.resumed) notes.push('I resumed my earlier session')
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
    pendingApprovals.get(id)?.(msg.result?.decision)
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
      threads.set(threadId, { developerInstructions: params.developerInstructions, resumed: false })
      return reply({ thread: { id: threadId }, model: params.model ?? 'gpt-fake-large' })
    }
    case 'thread/resume': {
      threads.set(params.threadId, { developerInstructions: params.developerInstructions, resumed: true })
      return reply({ thread: { id: params.threadId }, model: params.model ?? 'gpt-fake-large' })
    }
    case 'turn/start': {
      const text = (params.input ?? []).map((i) => i.text ?? '').join('\n')
      reply({ turn: { id: 'pending', status: 'inProgress' } })
      void runTurn(params.threadId, text)
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
