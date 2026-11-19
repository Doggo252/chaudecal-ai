// The hub. Runs inside the app on the machine that is switched to host mode
// (normally the Windows PC). It keeps the master copy of all synced records and
// shares that machine's local AI runtimes with the other devices.
//
// It listens on the local network only. Reaching it from elsewhere is expected
// to go through Tailscale, which encrypts the connection. Every request except
// the health check needs the hub token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { cpus, hostname, networkInterfaces, totalmem } from 'node:os'
import type { RunWireEvent, Settings, SyncRecord } from '@shared/types'
import type { Store } from '../store'
import { cleanSendInput, type RunHost } from './remoteRuns'
import { directModels } from '../providers/local'

const MAX_BODY = 64 * 1024 * 1024
const STREAM_INTERVAL_MS = 120

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

export function localAddresses(port: number): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      out.push(`http://${a.address}:${port}`)
    }
  }
  // Tailscale addresses are in 100.64.0.0/10. List them last, labelled by the caller.
  return out.sort((a, b) => Number(/\/\/100\./.test(a)) - Number(/\/\/100\./.test(b)))
}

export class HubServer {
  private server?: Server
  private subscribers = new Set<ServerResponse>()
  private unsubscribe?: () => void
  port = 0

  constructor(
    private store: Store,
    private settings: () => Settings,
    private appVersion: string,
    /** Lets paired devices run assistants on this machine. Absent in setups that only sync. */
    private runs?: RunHost
  ) {}

  private pendingStream = new Map<string, { conversationId: string; timer?: ReturnType<typeof setTimeout>; sentAt: number; latest?: RunWireEvent }>()

  /** Send live progress of a run to every connected device. */
  /** How many devices are connected and listening right now. */
  listeners(): number {
    return this.subscribers.size
  }

  broadcastRun(event: RunWireEvent): void {
    if (!this.subscribers.size || !this.runs?.enabled()) return
    const write = (e: RunWireEvent) => {
      const block = `event: run\ndata: ${JSON.stringify(e)}\n\n`
      for (const s of this.subscribers) s.write(block)
    }
    if (event.type !== 'stream') {
      // Once a run has ended, nothing held back for its messages may arrive after the ending.
      if (event.type === 'busy' && !event.busy) this.forgetStreams(event.conversationId)
      write(event)
      return
    }
    // A streaming reply changes many times a second and each update carries the whole text so far.
    const id = event.message.id
    const slot = this.pendingStream.get(id) ?? { conversationId: event.message.conversationId, sentAt: 0 }
    this.pendingStream.set(id, slot)
    const wait = STREAM_INTERVAL_MS - (Date.now() - slot.sentAt)
    if (wait <= 0) {
      slot.sentAt = Date.now()
      write(event)
      return
    }
    slot.latest = event
    slot.timer ??= setTimeout(() => {
      slot.timer = undefined
      slot.sentAt = Date.now()
      if (slot.latest) write(slot.latest)
      slot.latest = undefined
    }, wait)
  }

  private forgetStreams(conversationId: string): void {
    for (const [id, slot] of this.pendingStream) {
      if (slot.conversationId !== conversationId) continue
      clearTimeout(slot.timer)
      this.pendingStream.delete(id)
    }
  }

  get running(): boolean {
    return !!this.server
  }

  hubId(): string {
    return this.store.deviceId
  }

  async start(): Promise<void> {
    if (this.server) return
    const port = this.settings().hub.port
    this.store.isHub = true
    this.store.numberAll()
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) })
        else res.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '0.0.0.0', () => resolve())
    })
    this.server = server
    const addr = server.address()
    this.port = typeof addr === 'object' && addr ? addr.port : port
    this.unsubscribe = this.store.onChange(() => this.notify())
  }

  async stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    for (const s of this.subscribers) s.end()
    this.subscribers.clear()
    const server = this.server
    this.server = undefined
    this.store.isHub = false
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  private notify(): void {
    const line = `data: ${this.store.latestSeq()}\n\n`
    for (const s of this.subscribers) s.write(line)
  }

  private authorized(req: IncomingMessage): boolean {
    const token = this.settings().hub.token
    if (!token) return false
    const header = req.headers.authorization ?? ''
    const given = header.startsWith('Bearer ') ? header.slice(7) : ''
    const a = Buffer.from(given)
    const b = Buffer.from(token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://hub')
    const path = url.pathname

    if (path === '/api/health') {
      json(res, 200, { app: 'chaudecal', hubId: this.hubId(), name: this.settings().deviceName || hostname(), version: this.appVersion })
      return
    }
    if (!this.authorized(req)) {
      json(res, 401, { error: 'unauthorized' })
      return
    }

    if (path === '/api/sync/pull' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0) || 0
      const records = this.store.since(since)
      const latest = this.store.latestSeq()
      const last = records[records.length - 1]?.seq ?? latest
      json(res, 200, { records, seq: latest, more: last < latest })
      return
    }
    if (path === '/api/sync/push' && req.method === 'POST') {
      const body = await readBody(req)
      const records: SyncRecord[] = Array.isArray(body.records) ? body.records : []
      const applied = this.store.applyRemote(records.filter((r) => r && typeof r.kind === 'string' && typeof r.id === 'string'))
      json(res, 200, { seq: this.store.latestSeq(), accepted: applied.length })
      return
    }
    if (path === '/api/sync/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(`data: ${this.store.latestSeq()}\n\n`)
      this.subscribers.add(res)
      const beat = setInterval(() => res.write(': keep-alive\n\n'), 20000)
      req.on('close', () => {
        clearInterval(beat)
        this.subscribers.delete(res)
      })
      return
    }

    if (path === '/api/local/models' && req.method === 'GET') {
      json(res, 200, { models: await directModels(this.settings()) })
      return
    }
    if (path === '/api/local/info' && req.method === 'GET') {
      const cpu = cpus()[0]?.model ?? 'unknown'
      json(res, 200, { platform: process.platform, cpu, memoryGb: Math.round(totalmem() / 1024 ** 3), endpoints: this.settings().local.endpoints.filter((e) => e.enabled).map((e) => e.name) })
      return
    }
    if (path === '/api/local/chat' && req.method === 'POST') {
      const body = await readBody(req)
      const endpoint = this.settings().local.endpoints.find((e) => e.enabled && e.id === body.endpointId)
      if (!endpoint) {
        json(res, 404, { error: 'That runtime is not available on the hub.' })
        return
      }
      const { endpointId: _drop, ...payload } = body
      const controller = new AbortController()
      res.on('close', () => controller.abort())
      const upstream = await fetch(`${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      })
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'text/event-stream', 'cache-control': 'no-cache' })
      if (!upstream.body) {
        res.end()
        return
      }
      const reader = upstream.body.getReader()
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          res.write(value)
        }
      } catch {
        // The client went away or the runtime stopped. Nothing more to send.
      }
      res.end()
      return
    }

    if (path.startsWith('/api/run/')) {
      await this.handleRun(path, req, res)
      return
    }

    json(res, 404, { error: 'not found' })
  }

  private async handleRun(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const runs = this.runs
    if (path === '/api/run/info' && req.method === 'GET') {
      json(res, 200, runs ? runs.info() : { enabled: false, deviceName: this.settings().deviceName, platform: process.platform, providers: {}, busy: [] })
      return
    }
    if (!runs?.enabled()) {
      json(res, 403, { error: 'Running assistants on the hub is turned off. Turn it on under Settings, Sync and hub, on the hub machine.' })
      return
    }
    if (req.method !== 'POST') {
      json(res, 404, { error: 'not found' })
      return
    }
    const body = await readBody(req)
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId : ''

    if (path === '/api/run/send') {
      const input = cleanSendInput(body)
      if (!input) {
        json(res, 400, { error: 'That request could not be understood.' })
        return
      }
      // The reply itself arrives through sync and the event stream. Only an immediate refusal is reported here.
      const run = runs.send(input)
      const early = await Promise.race([run.then(() => undefined, (e: unknown) => e), new Promise<undefined>((r) => setTimeout(() => r(undefined), 120))])
      run.catch(() => {})
      if (early) json(res, 409, { error: early instanceof Error ? early.message : String(early) })
      else json(res, 200, { ok: true })
      return
    }
    if (path === '/api/run/stop') {
      runs.stop(conversationId)
      json(res, 200, { ok: true })
      return
    }
    if (path === '/api/run/approval') {
      runs.respondApproval(conversationId, String(body.messageId ?? ''), String(body.approvalId ?? ''), body.decision)
      json(res, 200, { ok: true })
      return
    }
    if (path === '/api/run/workspace') {
      // Without a path this reads the folder. With one (even empty, to clear it) it sets the folder.
      json(res, 200, typeof body.path === 'string' ? runs.setWorkspace(conversationId, body.path) : { path: runs.getWorkspace(conversationId) })
      return
    }
    json(res, 404, { error: 'not found' })
  }
}
