import { describe, expect, it } from 'vitest'
import { localNetworkBlocked, onHomeNetwork } from '../src/main/sync/hubClient'

const unreachable = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect EHOSTUNREACH 192.168.4.103:47600'), { code: 'EHOSTUNREACH' }) })

describe('home network addresses', () => {
  it('knows private addresses and machine names', () => {
    expect(onHomeNetwork('http://192.168.4.103:47600')).toBe(true)
    expect(onHomeNetwork('http://10.0.0.5:47600')).toBe(true)
    expect(onHomeNetwork('http://172.20.1.1:47600')).toBe(true)
    expect(onHomeNetwork('http://my-pc:47600')).toBe(true)
    expect(onHomeNetwork('http://my-pc.local:47600')).toBe(true)
  })
  it('leaves out Tailscale and the internet', () => {
    expect(onHomeNetwork('http://100.101.2.3:47600')).toBe(false)
    expect(onHomeNetwork('http://my-pc.tail1234.ts.net:47600')).toBe(false)
    expect(onHomeNetwork('http://172.32.0.1:47600')).toBe(false)
    expect(onHomeNetwork('http://localhost:47600')).toBe(false)
  })
})

describe('macOS keeping the app off the home network', () => {
  it('is spotted from an unreachable home address on a Mac', () => {
    expect(localNetworkBlocked(unreachable(), 'http://192.168.4.103:47600', 'darwin')).toBe(true)
  })
  it('is not blamed on Windows, for Tailscale, or for other failures', () => {
    expect(localNetworkBlocked(unreachable(), 'http://192.168.4.103:47600', 'win32')).toBe(false)
    expect(localNetworkBlocked(unreachable(), 'http://100.101.2.3:47600', 'darwin')).toBe(false)
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    expect(localNetworkBlocked(refused, 'http://192.168.4.103:47600', 'darwin')).toBe(false)
  })
})
