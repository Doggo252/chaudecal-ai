// Signing in to a hosted tool server through the browser, the way the MCP
// specification describes: the server says where its sign-in lives, the app
// registers itself there, the user approves in their browser, and the app keeps
// the token (and renews it before it runs out). Servers that do not let an app
// register itself (GitHub, for example) take a token typed in by hand instead.

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { McpOAuth } from '@shared/types'

export class SignInProblem extends Error {}

interface Discovery {
  resource: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  scope?: string
}

const TIMEOUT = 10000

async function getJson(url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) })
    if (!res.ok) return undefined
    return (await res.json()) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Reads `resource_metadata` and `scope` from a WWW-Authenticate header. */
export function readChallenge(header: string | null): { resourceMetadata?: string; scope?: string } {
  if (!header) return {}
  const value = (name: string) => new RegExp(`${name}="([^"]*)"`, 'i').exec(header)?.[1]
  return { resourceMetadata: value('resource_metadata'), scope: value('scope') }
}

/** The places an authorization server's details may be, with any path of the issuer kept (RFC 8414). */
function metadataUrls(issuer: string): string[] {
  const u = new URL(issuer)
  const path = u.pathname.replace(/\/$/, '')
  const base = `${u.protocol}//${u.host}`
  return path && path !== '/'
    ? [`${base}/.well-known/oauth-authorization-server${path}`, `${base}/.well-known/openid-configuration${path}`, `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`]
    : [`${base}/.well-known/oauth-authorization-server`, `${base}/.well-known/openid-configuration`]
}

/** Finds where a tool server's sign-in lives. */
export async function discover(url: string): Promise<Discovery> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'chaude', version: '1' } } }),
      signal: AbortSignal.timeout(TIMEOUT)
    })
  } catch {
    throw new SignInProblem('The server could not be reached.')
  }
  if (res.status !== 401) throw new SignInProblem(res.ok ? 'This server does not ask for a sign-in. It works as it is.' : `The server answered ${res.status}, not with a sign-in request.`)
  const challenge = readChallenge(res.headers.get('www-authenticate'))
  const origin = new URL(url).origin
  const path = new URL(url).pathname.replace(/\/$/, '')
  const resourceMeta = (challenge.resourceMetadata && (await getJson(challenge.resourceMetadata))) || (await getJson(`${origin}/.well-known/oauth-protected-resource${path}`)) || (await getJson(`${origin}/.well-known/oauth-protected-resource`))
  const servers = Array.isArray(resourceMeta?.authorization_servers) ? (resourceMeta!.authorization_servers as string[]) : []
  const issuer = servers[0] ?? origin
  let meta: Record<string, unknown> | undefined
  for (const candidate of metadataUrls(issuer)) {
    meta = await getJson(candidate)
    if (meta?.authorization_endpoint) break
  }
  if (!meta?.authorization_endpoint || !meta.token_endpoint) throw new SignInProblem('The server asks for a sign-in but does not say where. Use a token in the headers instead.')
  const scopes = Array.isArray(resourceMeta?.scopes_supported) ? (resourceMeta!.scopes_supported as string[]).join(' ') : undefined
  return {
    resource: typeof resourceMeta?.resource === 'string' ? resourceMeta.resource : url,
    authorizationEndpoint: String(meta.authorization_endpoint),
    tokenEndpoint: String(meta.token_endpoint),
    registrationEndpoint: typeof meta.registration_endpoint === 'string' ? meta.registration_endpoint : undefined,
    scope: challenge.scope || scopes
  }
}

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function tokenRequest(endpoint: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TIMEOUT)
  })
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = Object.fromEntries(new URLSearchParams(text))
  }
  if (!res.ok || typeof body.access_token !== 'string') throw new SignInProblem(`The sign-in was not accepted${typeof body.error === 'string' ? ` (${body.error})` : ''}.`)
  return body
}

function stateFrom(body: Record<string, unknown>, d: { tokenEndpoint: string; clientId: string; clientSecret?: string; resource: string; scope?: string }, previous?: McpOAuth): McpOAuth {
  const expiresIn = Number(body.expires_in)
  return {
    accessToken: String(body.access_token),
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : previous?.refreshToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    tokenEndpoint: d.tokenEndpoint,
    clientId: d.clientId,
    ...(d.clientSecret ? { clientSecret: d.clientSecret } : {}),
    resource: d.resource,
    ...(d.scope ? { scope: d.scope } : {})
  }
}

const DONE_PAGE = (ok: boolean, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>Chaude</title><body style="font:16px system-ui;max-width:460px;margin:20vh auto;text-align:center;color:#2a2825"><h2>${ok ? 'Signed in' : 'Not signed in'}</h2><p>${text}</p></body>`

/**
 * Signs in to the tool server at `url`. `open` shows the sign-in page to the user,
 * normally in their browser. Resolves once they have approved, or fails after five minutes.
 */
export async function signIn(url: string, open: (address: string) => Promise<void>, timeoutMs = 5 * 60 * 1000): Promise<McpOAuth> {
  const d = await discover(url)
  if (!d.registrationEndpoint) throw new SignInProblem('This server does not let apps sign in by themselves. Create a token on its website and add it to the headers instead, as "Authorization: Bearer your-token".')

  // The browser comes back to this machine only, to a port opened just for this sign-in.
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const redirect = `http://127.0.0.1:${port}/callback`
  try {
    const reg = await fetch(d.registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_name: 'Chaude', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(d.scope ? { scope: d.scope } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT)
    })
    const client = (await reg.json().catch(() => ({}))) as { client_id?: string; client_secret?: string }
    if (!reg.ok || !client.client_id) throw new SignInProblem('The server did not let Chaude register for a sign-in.')

    const verifier = b64url(randomBytes(32))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    const state = b64url(randomBytes(16))
    const address = new URL(d.authorizationEndpoint)
    const params: Record<string, string> = { response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state, resource: d.resource }
    if (d.scope) params.scope = d.scope
    for (const [k, v] of Object.entries(params)) address.searchParams.set(k, v)

    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new SignInProblem('The sign-in was not finished within five minutes.')), timeoutMs)
      server.on('request', (req, res) => {
        const back = new URL(req.url ?? '/', redirect)
        if (back.pathname !== '/callback') {
          res.writeHead(404).end()
          return
        }
        const error = back.searchParams.get('error')
        const ok = !error && back.searchParams.get('state') === state && !!back.searchParams.get('code')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DONE_PAGE(ok, ok ? 'You can close this tab and go back to Chaude.' : 'The sign-in was cancelled or did not match. Try again from Chaude.'))
        clearTimeout(timer)
        if (ok) resolve(back.searchParams.get('code')!)
        else reject(new SignInProblem(error === 'access_denied' ? 'The sign-in was declined.' : 'The sign-in did not finish.'))
      })
      open(address.toString()).catch((e) => {
        clearTimeout(timer)
        reject(e)
      })
    })

    const form: Record<string, string> = { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: d.resource }
    if (client.client_secret) form.client_secret = client.client_secret
    const body = await tokenRequest(d.tokenEndpoint, form)
    return stateFrom(body, { tokenEndpoint: d.tokenEndpoint, clientId: client.client_id, clientSecret: client.client_secret, resource: d.resource, scope: d.scope })
  } finally {
    server.close()
  }
}

/** A sign-in that runs out within this long is renewed. */
export const RENEW_BEFORE = 10 * 60 * 1000

export function needsRenewal(oauth: McpOAuth | undefined, now = Date.now()): boolean {
  return !!oauth?.refreshToken && !!oauth.expiresAt && oauth.expiresAt - now < RENEW_BEFORE
}

/** Renews a sign-in with its refresh token. */
export async function renew(oauth: McpOAuth): Promise<McpOAuth> {
  if (!oauth.refreshToken) throw new SignInProblem('This sign-in cannot be renewed. Sign in again.')
  const form: Record<string, string> = { grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: oauth.clientId, resource: oauth.resource }
  if (oauth.clientSecret) form.client_secret = oauth.clientSecret
  const body = await tokenRequest(oauth.tokenEndpoint, form)
  return stateFrom(body, oauth, oauth)
}
