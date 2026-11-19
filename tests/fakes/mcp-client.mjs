// What the stand-in assistants use to reach a tool server, the way the real
// command line tools do: start the program (or call the address), say hello,
// and call one tool.

import { spawn } from 'node:child_process'

/**
 * Connects to a tool server. `server` is either {command, args, env} or {url, headers}.
 * Resolves with {call(tool, args), close()}, or rejects when the server cannot be reached.
 */
export function connectMcp(server, timeoutMs = 5000) {
  return server.url ? connectUrl(server, timeoutMs) : connectCommand(server, timeoutMs)
}

function textOf(result) {
  return (result?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

const hello = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-assistant', version: '1.0.0' } } }

function connectCommand(server, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...(server.env ?? {}) }, stdio: ['pipe', 'pipe', 'ignore'] })
    const waiting = new Map()
    let nextId = 2
    let buffer = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('timed out'))
    }, timeoutMs)
    const request = (message) =>
      new Promise((res, rej) => {
        waiting.set(message.id, { res, rej })
        child.stdin.write(`${JSON.stringify(message)}\n`)
      })
    child.on('error', (e) => reject(e))
    child.on('close', () => {
      clearTimeout(timer)
      reject(new Error('the server stopped'))
      for (const w of waiting.values()) w.rej(new Error('the server stopped'))
    })
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        const w = waiting.get(msg.id)
        if (!w) continue
        waiting.delete(msg.id)
        if (msg.error) w.rej(new Error(msg.error.message))
        else w.res(msg.result)
      }
    })
    request(hello).then(() => {
      clearTimeout(timer)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      resolve({
        call: async (tool, args) => textOf(await request({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: tool, arguments: args } })),
        close: () => child.kill()
      })
    }, reject)
  })
}

async function connectUrl(server, timeoutMs) {
  let nextId = 2
  const post = async (message) => {
    const res = await fetch(server.url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { ...(server.headers ?? server.http_headers ?? {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(message)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (message.id === undefined) return undefined
    const body = await res.text()
    const json = (res.headers.get('content-type') ?? '').includes('event-stream') ? body.split('\n').find((l) => l.startsWith('data:')).slice(5) : body
    const msg = JSON.parse(json)
    if (msg.error) throw new Error(msg.error.message)
    return msg.result
  }
  await post(hello)
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return {
    call: async (tool, args) => textOf(await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: tool, arguments: args } })),
    close: () => {}
  }
}
