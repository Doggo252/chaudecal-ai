// Client side of sync. Keeps a full local copy so the app works with the hub
// offline, then pushes local changes and pulls remote ones whenever the hub is
// reachable. A long-lived event stream tells it when there is something new.

import type { HubStatus, RunWireEvent, Settings, SyncRecord } from '@shared/types'
import type { Store } from '../store'
import type { HubLink } from '../providers/local'

export function normalizeHubUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '')
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`
  // A bare host name or address gets the default port.
  if (!/:\d+$/.test(url.replace(/^https?:\/\//i, ''))) url = `${url}:47600`
  return url
}

export class HubClient implements HubLink {
  private connected = false
  private detail = 'Not connected'
  private lastSyncAt?: number
  private running = false
  private syncing = false
  private again = false
  private retryTimer?: ReturnType<typeof setTimeout>
  private pushTimer?: ReturnType<typeof setTimeout>
  private stream?: AbortController
  private unsubscribe?: () => void
  private backoff = 2000
  /** Called with live progress of runs happening on the hub. */
  onRun?: (event: RunWireEvent) => void

  constructor(
    private store: Store,
    private settings: () => Settings,
    private onStatus: () => void
  ) {}

  private url(): string {
    return normalizeHubUrl(this.settings().hub.remoteUrl)
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.settings().hub.remoteToken}` }
  }

  current(): { url: string; token: string } | undefined {
    return this.connected ? { url: this.url(), token: this.settings().hub.remoteToken } : undefined
  }

  status(): HubStatus {
    return { role: this.running ? 'client' : 'off', connected: this.connected, url: this.url(), detail: this.detail, lastSyncAt: this.lastSyncAt, pending: this.store.dirtyCount() }
  }

  start(): void {
    if (this.running) return
    if (!this.url()) return
    this.running = true
    this.backoff = 2000
    this.unsubscribe = this.store.onChange((_records, origin) => {
      if (origin !== 'local') return
      clearTimeout(this.pushTimer)
      this.pushTimer = setTimeout(() => void this.sync(), 400)
      this.onStatus()
    })
    void this.connect()
  }

  stop(): void {
    this.running = false
    this.connected = false
    this.detail = 'Not connected'
    this.unsubscribe?.()
    this.unsubscribe = undefined
    clearTimeout(this.retryTimer)
    clearTimeout(this.pushTimer)
    this.stream?.abort()
    this.stream = undefined
    this.onStatus()
  }

  private setState(connected: boolean, detail: string): void {
    this.connected = connected
    this.detail = detail
    this.onStatus()
  }

  private retryLater(): void {
    if (!this.running) return
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => void this.connect(), this.backoff)
    this.backoff = Math.min(this.backoff * 2, 30000)
  }

  private async connect(): Promise<void> {
    if (!this.running) return
    const url = this.url()
    try {
      const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) })
      if (!health.ok) throw new Error(`The hub answered ${health.status}.`)
      const info = (await health.json()) as { app?: string; hubId?: string; name?: string }
      if (info.app !== 'chaudecal' || !info.hubId) throw new Error('That address is not a Chaude hub.')
      if (this.store.kvGet<string>('hubId') !== info.hubId) {
        // A hub this device has not synced with before: send everything, fetch everything.
        this.store.kvSet('hubId', info.hubId)
        this.store.kvSet('cursor', 0)
        this.store.markAllDirty()
      }
      await this.sync(true)
      this.backoff = 2000
      this.setState(true, `Connected to ${info.name ?? 'hub'}`)
      void this.listen()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const friendly = /401|unauthorized/i.test(message)
        ? 'The hub rejected the pairing code.'
        : /fetch failed|timeout|aborted|ECONN|ENOTFOUND|EHOST/i.test(message)
          ? 'Hub not reachable. Working offline, changes will sync when it is back.'
          : message
      this.setState(false, friendly)
      this.retryLater()
    }
  }

  /** Wait on the hub's event stream. Any event means there may be new records. */
  private async listen(): Promise<void> {
    this.stream?.abort()
    const controller = new AbortController()
    this.stream = controller
    try {
      const res = await fetch(`${this.url()}/api/sync/events`, { headers: this.headers(), signal: controller.signal })
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // Events are separated by a blank line. Keep whatever is still incomplete for the next read.
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''
        let newest = 0
        for (const block of blocks) {
          const data = /^data: (.*)$/m.exec(block)?.[1]
          if (data === undefined) continue
          if (/^event: run$/m.test(block)) {
            try {
              this.onRun?.(JSON.parse(data) as RunWireEvent)
            } catch {
              // A malformed progress event is dropped. The finished message still arrives through sync.
            }
          } else if (/^\d+$/.test(data)) newest = Math.max(newest, Number(data))
        }
        if (newest > (this.store.kvGet<number>('cursor') ?? 0)) void this.sync()
      }
      throw new Error('stream ended')
    } catch {
      if (controller.signal.aborted || !this.running) return
      this.setState(false, 'Hub not reachable. Working offline, changes will sync when it is back.')
      this.retryLater()
    }
  }

  /** Wait until everything changed here has reached the hub and the hub's changes have arrived. */
  async flush(timeoutMs = 20000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    let completed = false
    while (this.running && this.connected && Date.now() < deadline) {
      if (!this.syncing) {
        if (completed && !this.again && this.store.dirtyCount() === 0) return true
        await this.sync()
        completed = true
      } else {
        await new Promise((r) => setTimeout(r, 25))
      }
    }
    return false
  }

  /** An authenticated call to the hub. Throws with the hub's own explanation when it refuses. */
  async request<T>(path: string, body?: unknown, timeoutMs = 15000): Promise<T> {
    if (!this.connected) throw new Error('The hub is not reachable right now.')
    const res = await fetch(`${this.url()}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? this.headers() : { ...this.headers(), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) throw new Error(data.error || `The hub answered ${res.status}.`)
    return data as T
  }

  async syncNow(): Promise<void> {
    if (!this.running) return
    if (this.connected) await this.sync()
    else {
      clearTimeout(this.retryTimer)
      await this.connect()
    }
  }

  private async sync(throwOnError = false): Promise<void> {
    if (this.syncing) {
      this.again = true
      return
    }
    this.syncing = true
    try {
      const url = this.url()
      // Push local changes first so the hub's reply already reflects them.
      for (;;) {
        const batch = this.store.dirty()
        if (!batch.length) break
        const res = await fetch(`${url}/api/sync/push`, {
          method: 'POST',
          headers: { ...this.headers(), 'content-type': 'application/json' },
          body: JSON.stringify({ records: batch }),
          signal: AbortSignal.timeout(120000)
        })
        if (!res.ok) throw new Error(`push ${res.status} ${res.status === 401 ? 'unauthorized' : ''}`)
        this.store.markClean(batch)
      }
      for (;;) {
        const cursor = this.store.kvGet<number>('cursor') ?? 0
        const res = await fetch(`${url}/api/sync/pull?since=${cursor}`, { headers: this.headers(), signal: AbortSignal.timeout(120000) })
        if (!res.ok) throw new Error(`pull ${res.status} ${res.status === 401 ? 'unauthorized' : ''}`)
        const body = (await res.json()) as { records: SyncRecord[]; seq: number; more: boolean }
        this.store.applyRemote(body.records)
        const last = body.records.length ? Math.max(...body.records.map((r) => r.seq ?? 0)) : body.seq
        this.store.kvSet('cursor', body.more ? last : Math.max(last, body.seq))
        if (!body.more) break
      }
      this.lastSyncAt = Date.now()
      this.onStatus()
    } catch (e) {
      if (throwOnError) throw e
      // The event stream notices real disconnects. A failed sync is retried on the next change.
    } finally {
      this.syncing = false
      if (this.again) {
        this.again = false
        void this.sync()
      }
    }
  }
}
