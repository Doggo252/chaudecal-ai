// The app in a phone or browser, served by the hub at /app. The desktop window
// talks to the app through a bridge Electron gives it; here the same calls go to
// the hub over the network with the pairing code, and the hub's events arrive as
// an event stream. A few things work the browser's way instead: picking files,
// saving files, opening links and showing artifact previews.

import { API_METHODS, type Api, type AppEvents, type AttachResult } from '@shared/ipc'
import { ARTIFACT_SCHEME } from '@shared/artifactPolicy'

const CODE_KEY = 'chaude-pairing-code'

/** Running in a browser rather than the desktop app. */
export function isWeb(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { __CHAUDE_WEB__?: boolean }).__CHAUDE_WEB__
}

export function savedCode(): string | null {
  return localStorage.getItem(CODE_KEY)
}

export function forgetCode(): void {
  localStorage.removeItem(CODE_KEY)
}

/** Checks a pairing code with the hub, and keeps it when it works. */
export async function tryCode(code: string): Promise<boolean> {
  const res = await fetch('api/state', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${code.trim()}` }, body: '{"args":[]}' })
  if (!res.ok) return false
  localStorage.setItem(CODE_KEY, code.trim())
  return true
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function encode(value: unknown): unknown {
  return value instanceof Uint8Array ? { __bytes: toBase64(value) } : value
}

function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = () => resolve([...(input.files ?? [])])
    input.click()
  })
}

/** Installs the browser version of the bridge as `window.api`. */
export function installWebApi(code: string): void {
  const call = async (method: string, args: unknown[]): Promise<unknown> => {
    const res = await fetch(`api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${code}` }, body: JSON.stringify({ args: args.map(encode) }) })
    if (res.status === 401) {
      forgetCode()
      location.reload()
      throw new Error('The pairing code is no longer valid.')
    }
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string }
    if (!res.ok) throw new Error(body.error ?? `The hub answered ${res.status}.`)
    return body.result ?? undefined
  }

  const api: Record<string, unknown> = {}
  for (const name of API_METHODS) api[name] = (...args: unknown[]) => call(name, args)

  // The browser's own ways of doing what the desktop app does on its machine.
  api.openExternal = async (url: string) => void window.open(url, '_blank', 'noopener')
  api.saveArtifact = async (name: string, content: string) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }))
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    return name
  }
  api.pickAttachments = async (): Promise<AttachResult> => {
    const out: AttachResult = { attachments: [], errors: [] }
    for (const file of await pickFiles()) {
      const res = (await call('addAttachment', [{ name: file.name, base64: toBase64(new Uint8Array(await file.arrayBuffer())) }])) as AttachResult
      out.attachments.push(...res.attachments)
      out.errors.push(...res.errors)
    }
    return out
  }
  api.artifactView = async (html: string) => {
    const url = String(await call('artifactView', [html]))
    return url.startsWith(`${ARTIFACT_SCHEME}://view/`) ? `preview/${url.slice(`${ARTIFACT_SCHEME}://view/`.length)}` : url
  }
  api.updateSettings = async () => {
    throw new Error('Settings belong to each machine. Change them on the hub machine itself.')
  }
  api.captureSources = async () => []

  // The hub's events, over one stream. After a lost connection the page starts afresh, so nothing is missed.
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  let source: EventSource | undefined
  let dropped = false
  const connect = () => {
    source = new EventSource(`events?code=${encodeURIComponent(code)}`)
    source.onopen = () => {
      if (dropped) location.reload()
    }
    source.onerror = () => {
      dropped = true
    }
    for (const [channel, set] of listeners) source.addEventListener(channel, (e) => set.forEach((l) => l(JSON.parse((e as MessageEvent).data))))
  }
  api.on = <K extends keyof AppEvents>(channel: K, listener: (payload: AppEvents[K]) => void) => {
    let set = listeners.get(channel)
    if (!set) {
      set = new Set()
      listeners.set(channel, set)
      source?.addEventListener(channel, (e) => set!.forEach((l) => l(JSON.parse((e as MessageEvent).data))))
    }
    set.add(listener as (payload: unknown) => void)
    return () => set!.delete(listener as (payload: unknown) => void)
  }
  ;(window as unknown as { __CHAUDE_WEB__: boolean }).__CHAUDE_WEB__ = true
  window.api = api as unknown as Api
  // Listeners added during start-up are attached when the stream opens.
  queueMicrotask(connect)
}
