// Client side of sync. Keeps a full local copy so the app works with the hub
// offline, then pushes local changes and pulls remote ones whenever the hub is
// reachable. A long-lived event stream tells it when there is something new.

import type { HubStatus, Settings, SyncRecord } from '@shared/types'
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
      if (info.app !== 'chaudecal' || !info.hubId) throw new Error('That address is not a Chaudecal hub.')
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
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        const seqs = [...text.matchAll(/^data: (\d+)/gm)].map((m) => Number(m[1]))
        if (seqs.length && Math.max(...seqs) > (this.store.kvGet<number>('cursor') ?? 0)) void this.sync()
      }
      throw new Error('stream ended')
    } catch {
      if (controller.signal.aborted || !this.running) return
      this.setState(false, 'Hub not reachable. Working offline, changes will sync when it is back.')
      this.retryLater()
    }
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
