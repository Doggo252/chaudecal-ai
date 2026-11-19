#!/usr/bin/env node
// A small MCP server for tests. It speaks the stdio transport by default, and
// streamable HTTP when started with "--http <port>".
//
// Tools:
//   echo(text)      read only, answers with the same text
//   add_note(text)  appends the text to the file named by FAKE_MCP_LOG
//
// Environment:
//   FAKE_MCP_LOG     file that add_note writes to
//   FAKE_MCP_SECRET  when set, echo adds it to its answer (shows that values reach the server)
//   FAKE_MCP_TOKEN   in HTTP mode, the bearer token every request must carry
//   FAKE_MCP_BROKEN  exit at once, like a server that cannot start

import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

if (process.env.FAKE_MCP_BROKEN) {
  process.stderr.write('fake-mcp: cannot start\n')
  process.exit(1)
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Answers with the text it was given.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'add_note',
    description: 'Saves a note.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: false, destructiveHint: false }
  }
]

function answer(msg) {
  const { id, method, params } = msg
  if (id === undefined || id === null) return undefined
  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1.0.0' } } }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
    case 'tools/call': {
      const text = String(params?.arguments?.text ?? '')
      if (params?.name === 'echo') {
        const secret = process.env.FAKE_MCP_SECRET ? ` (secret ${process.env.FAKE_MCP_SECRET})` : ''
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo: ${text}${secret}` }] } }
      }
      if (params?.name === 'add_note') {
        if (process.env.FAKE_MCP_LOG) appendFileSync(process.env.FAKE_MCP_LOG, `${text}\n`)
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'saved' }] } }
      }
      return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `unknown tool ${params?.name}` }] } }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
  }
}

const httpAt = process.argv.indexOf('--http')
if (httpAt >= 0) {
  const port = Number(process.argv[httpAt + 1] ?? 0)
  const server = createServer((req, res) => {
    const token = process.env.FAKE_MCP_TOKEN
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'www-authenticate': 'Bearer' }).end('unauthorized')
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let msg
      try {
        msg = JSON.parse(body)
      } catch {
        res.writeHead(400).end('bad json')
        return
      }
      const reply = answer(msg)
      if (!reply) {
        res.writeHead(202).end()
        return
      }
      // tools/list answers as an event stream, the rest as plain JSON, so clients are tested on both.
      if (msg.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'fake-session' })
        res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`)
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fake-session' })
        res.end(JSON.stringify(reply))
      }
    })
  })
  server.listen(port, '127.0.0.1', () => process.stdout.write(`listening ${server.address().port}\n`))
} else {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      try {
        const reply = answer(JSON.parse(line))
        if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`)
      } catch {
        // Not JSON: ignore, like a real server would.
      }
    }
  })
  process.stdin.on('end', () => process.exit(0))
}
