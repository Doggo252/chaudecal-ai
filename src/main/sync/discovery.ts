// Finding the hub on the home network without typing an address.
// The hub announces itself over mDNS (Bonjour). Away from home this does not
// work, which is what the manual address (a Tailscale name) is for.

import { Bonjour, type Service } from 'bonjour-service'
import type { DiscoveredHub } from '@shared/types'

const TYPE = 'chaudecal'
let bonjour: Bonjour | undefined
let published: Service | undefined

function instance(): Bonjour {
  bonjour ??= new Bonjour()
  return bonjour
}

export function announceHub(name: string, port: number): void {
  stopAnnouncing()
  try {
    published = instance().publish({ name: `Chaudecal hub (${name})`, type: TYPE, port })
    published.on('error', () => {})
  } catch {
    // Discovery is a convenience. The hub still works by address.
  }
}

export function stopAnnouncing(): void {
  try {
    published?.stop?.()
  } catch {
    // ignore
  }
  published = undefined
}

export function discoverHubs(timeoutMs = 2500): Promise<DiscoveredHub[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredHub>()
    let browser: ReturnType<Bonjour['find']> | undefined
    try {
      browser = instance().find({ type: TYPE }, (service) => {
        const address = (service.addresses ?? []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? service.host
        if (!address) return
        const url = `http://${address}:${service.port}`
        found.set(url, { name: service.name, url })
      })
    } catch {
      resolve([])
      return
    }
    setTimeout(() => {
      try {
        browser?.stop()
      } catch {
        // ignore
      }
      resolve([...found.values()])
    }, timeoutMs)
  })
}

export function shutdownDiscovery(): void {
  stopAnnouncing()
  try {
    bonjour?.destroy()
  } catch {
    // ignore
  }
  bonjour = undefined
}
