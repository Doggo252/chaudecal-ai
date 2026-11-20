// A stand-in for a hosted tool server that signs in through the browser, like
// Notion's or Linear's: it answers 401 with where its sign-in lives, lets an app
// register itself, "approves" at once on the authorize page (as if the user had
// clicked Allow), checks PKCE when it hands out the token, and renews tokens.

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

export function startOAuthMcp({ expiresIn = 3600 } = {}) {
  const state = { clients: new Map(), codes: new Map(), tokens: new Set(), refresh: new Map(), issued: 0, calls: [] }
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`
    const url = new URL(req.url, origin)
    let raw = ''
    for await (const c of req) raw += c
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(body))
    }
    state.calls.push(`${req.method} ${url.pathname}`)

    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['read'] })
    if (url.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, code_challenge_methods_supported: ['S256'] })
    if (url.pathname === '/register' && req.method === 'POST') {
      const body = JSON.parse(raw)
      const id = `client-${state.clients.size + 1}`
      state.clients.set(id, body.redirect_uris?.[0])
      return json(201, { client_id: id })
    }
    if (url.pathname === '/authorize') {
      const p = url.searchParams
      const redirect = state.clients.get(p.get('client_id'))
      if (!redirect || redirect !== p.get('redirect_uri') || p.get('code_challenge_method') !== 'S256' || p.get('resource') !== `${origin}/mcp`) return json(400, { error: 'invalid_request' })
      const code = `code-${state.codes.size + 1}`
      state.codes.set(code, { challenge: p.get('code_challenge'), client: p.get('client_id') })
      res.writeHead(302, { location: `${redirect}?code=${code}&state=${encodeURIComponent(p.get('state'))}` })
      return res.end()
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(raw)
      const issue = () => {
        state.issued++
        const access = `access-${state.issued}`
        const refresh = `refresh-${state.issued}`
        state.tokens.add(access)
        state.refresh.set(refresh, form.get('client_id'))
        return json(200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: expiresIn })
      }
      if (form.get('grant_type') === 'authorization_code') {
        const saved = state.codes.get(form.get('code'))
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
        if (!saved || saved.challenge !== challenge || saved.client !== form.get('client_id')) return json(400, { error: 'invalid_grant' })
        state.codes.delete(form.get('code'))
        return issue()
      }
      if (form.get('grant_type') === 'refresh_token' && state.refresh.get(form.get('refresh_token')) === form.get('client_id')) {
        state.refresh.delete(form.get('refresh_token'))
        return issue()
      }
      return json(400, { error: 'invalid_grant' })
    }
    if (url.pathname === '/mcp') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      if (!state.tokens.has(token)) return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer realm="OAuth", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="read"` })
      const msg = JSON.parse(raw || '{}')
      if (msg.id === undefined) {
        res.writeHead(202)
        return res.end()
      }
      const result =
        msg.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'signed-in-notes', version: '1.0.0' } }
          : msg.method === 'tools/list'
            ? { tools: [{ name: 'whoami', description: 'Says who is signed in', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
            : { content: [{ type: 'text', text: 'You are signed in as the test user.' }] }
      return json(200, { jsonrpc: '2.0', id: msg.id, result }, { 'mcp-session-id': 'session-1' })
    }
    json(404, { error: 'not found' })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${server.address().port}`
      resolve({ url: `${origin}/mcp`, origin, state, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}
