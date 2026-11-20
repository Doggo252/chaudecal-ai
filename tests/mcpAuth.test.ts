import { afterEach, describe, expect, it } from 'vitest'
import type { McpServer } from '@shared/types'
import { claudeMcpConfig, codexMcpConfig, mcpHeaders } from '@shared/mcp'
import { discover, needsRenewal, readChallenge, renew, signIn } from '../src/main/mcpAuth'
import { testMcpServer } from '../src/main/mcp'
import { startOAuthMcp } from './fakes/fake-oauth-mcp.mjs'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})
async function fake(expiresIn?: number) {
  const s = await startOAuthMcp({ expiresIn })
  cleanup.push(s.close)
  return s
}
/** Stands in for the browser: follows the sign-in page as if the user clicked Allow. */
const browser = async (address: string) => void (await fetch(address))
const server = (url: string, extra: Partial<McpServer> = {}): McpServer => ({ id: 's1', name: 'notes', kind: 'url', command: '', args: [], env: {}, url, headers: {}, enabled: true, trusted: false, offOn: [], createdAt: 1, ...extra })

describe('signing in to a hosted tool server', () => {
  it('reads where the sign-in lives from the 401 answer', () => {
    expect(readChallenge('Bearer realm="OAuth", resource_metadata="https://x.test/.well-known/oauth-protected-resource/mcp", scope="read write"')).toEqual({ resourceMetadata: 'https://x.test/.well-known/oauth-protected-resource/mcp', scope: 'read write' })
    expect(readChallenge(null)).toEqual({})
  })

  it('finds the sign-in, registers, signs in through the browser with PKCE, and gets a token that works', async () => {
    const s = await fake()
    const d = await discover(s.url)
    expect(d).toMatchObject({ resource: s.url, authorizationEndpoint: `${s.origin}/authorize`, registrationEndpoint: `${s.origin}/register`, scope: 'read' })
    const before = await testMcpServer(server(s.url), '1.0.0', 5000)
    expect(before).toMatchObject({ ok: false })
    expect(before.error).toMatch(/Sign in/)
    const oauth = await signIn(s.url, browser)
    expect(oauth).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1', clientId: 'client-1', resource: s.url })
    expect(oauth.expiresAt).toBeGreaterThan(Date.now())
    const after = await testMcpServer(server(s.url, { oauth }), '1.0.0', 5000)
    expect(after).toMatchObject({ ok: true, tools: [{ name: 'whoami', readOnly: true }] })
  })

  it('renews a sign-in that is about to run out', async () => {
    const s = await fake(60)
    const oauth = await signIn(s.url, browser)
    expect(needsRenewal(oauth)).toBe(true)
    expect(needsRenewal({ ...oauth, expiresAt: Date.now() + 3600_000 })).toBe(false)
    const fresh = await renew(oauth)
    expect(fresh).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', clientId: oauth.clientId })
    await expect(renew(oauth)).rejects.toThrow(/not accepted/)
  })

  it('says plainly when a server cannot be signed in to this way', async () => {
    await expect(discover('http://127.0.0.1:1/mcp')).rejects.toThrow(/could not be reached/)
  })

  it('gives the sign-in to both assistants with the other headers', () => {
    const s = server('https://x.test/mcp', { headers: { 'X-Team': 'a' }, oauth: { accessToken: 'tok', tokenEndpoint: 't', clientId: 'c', resource: 'r' } })
    expect(mcpHeaders(s)).toEqual({ 'X-Team': 'a', Authorization: 'Bearer tok' })
    expect(claudeMcpConfig([s], 'darwin', '/h').mcpServers.notes).toMatchObject({ type: 'http', headers: { Authorization: 'Bearer tok' } })
    expect(codexMcpConfig([s], 'darwin', '/h').notes).toMatchObject({ http_headers: { Authorization: 'Bearer tok' } })
  })
})
