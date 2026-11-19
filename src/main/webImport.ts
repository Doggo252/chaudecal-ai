// Brings the user's chats from claude.ai and chatgpt.com into the app, through
// the sign-ins in the app's own website tabs. Requests run inside the site's page
// (see WebTabs.request), so they carry the same sign-in as the page itself.
//
// Each imported chat and message gets an id made from its id on the site, so two
// devices that both import never make duplicates. A later run only fetches chats
// the site changed since. A chat deleted in the app stays deleted, and a title
// changed in the app is kept.

import type { Conversation, Message } from '@shared/types'
import type { WebImportStatus, WebService } from '@shared/ipc'
import { conversationIdFor, messageIdFor, siteApi, type ImportedChat, type RemoteSummary } from '@shared/webImport'
import type { Store } from './store'

export type Requester = (service: WebService, path: string, headers?: Record<string, string>) => Promise<{ status: number; body: string }>

export class SignedOut extends Error {
  name = 'SignedOut'
}
class SiteError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export interface ImporterOptions {
  /** Pause between fetching two chats, to go easy on the site. */
  pauseMs: number
  /** Wait after the site says to slow down, before trying again. */
  backoffMs: number
  /** Where each site's pages are, for the links back to the original chats. */
  origin: (service: WebService) => string
}

const ORIGINS = { claude: 'https://claude.ai', chatgpt: 'https://chatgpt.com' }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class WebImporter {
  private running = new Map<WebService, Promise<WebImportStatus>>()
  private last = new Map<WebService, WebImportStatus>()

  constructor(
    private store: Store,
    private request: Requester,
    private onStatus: (status: WebImportStatus) => void,
    private options: ImporterOptions = { pauseMs: 300, backoffMs: 20000, origin: (s) => ORIGINS[s] }
  ) {}

  /** How many chats from this site the app has. */
  private count(service: WebService): number {
    return this.store.list<Conversation>('conversation').filter((c) => c.source?.service === service).length
  }

  status(service: WebService): WebImportStatus {
    const saved = this.last.get(service) ?? this.store.kvGet<WebImportStatus>(`webimport:${service}`)
    return { ...(saved ?? { service, state: 'idle' }), service, count: this.count(service) }
  }

  isRunning(service: WebService): boolean {
    return this.running.has(service)
  }

  private report(status: WebImportStatus): WebImportStatus {
    this.last.set(status.service, status)
    if (status.state !== 'running') this.store.kvSet(`webimport:${status.service}`, status)
    this.onStatus(status)
    return status
  }

  /** Brings in what changed on the site. A second call while one is running waits for that one. */
  run(service: WebService): Promise<WebImportStatus> {
    const busy = this.running.get(service)
    if (busy) return busy
    const job = this.go(service).finally(() => this.running.delete(service))
    this.running.set(service, job)
    return job
  }

  private async get(service: WebService, path: string, headers: Record<string, string> = {}): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.request(service, path, headers)
      if (res.status === 200) {
        try {
          return JSON.parse(res.body) as unknown
        } catch {
          throw new SiteError(res.status, 'The site answered with something other than data. It may be asking to check that you are human: open its tab, then try again.')
        }
      }
      if (res.status === 429 && attempt < 3) {
        await sleep(this.options.backoffMs * (attempt + 1))
        continue
      }
      if (res.status === 401 || res.status === 403 || res.status === 0) throw new SignedOut()
      throw new SiteError(res.status, `The site answered ${res.status}.`)
    }
  }

  private async go(service: WebService): Promise<WebImportStatus> {
    const api = siteApi[service]
    const started: WebImportStatus = { service, state: 'running', count: this.count(service), done: 0, changed: 0 }
    this.report(started)
    let changed = 0
    let done = 0
    let of: number | undefined
    try {
      const session = await api.open((path, headers) => this.get(service, path, headers))
      if (!session) throw new SignedOut()
      const fetch = (path: string) => this.get(service, path, session.headers)

      // Newest first, so the chats that matter most arrive first.
      const all: RemoteSummary[] = await api.list(fetch, session, () => sleep(this.options.pauseMs))
      const seen = new Set<string>()
      const summaries = all.filter((s) => !seen.has(s.remoteId) && seen.add(s.remoteId)).sort((a, b) => b.updatedAt - a.updatedAt)
      of = summaries.length
      this.report({ ...started, of })

      let lastReport = 0
      for (const summary of summaries) {
        done++
        const id = conversationIdFor(service, summary.remoteId)
        const existing = this.store.get<Conversation>('conversation', id)
        const deleted = this.store.isDeleted('conversation', id)
        if (!deleted && !(existing && existing.source?.remoteUpdatedAt === summary.updatedAt)) {
          const chat = api.readChat(await fetch(api.chatPath(session, summary.remoteId)), summary, this.options.origin(service))
          if (chat.messages.length && this.save(chat)) changed++
          await sleep(this.options.pauseMs)
        }
        if (Date.now() - lastReport > 400 || done === summaries.length) {
          lastReport = Date.now()
          this.report({ service, state: 'running', done, of, changed, count: this.count(service) })
        }
      }
      return this.report({ service, state: 'done', changed, count: this.count(service), lastRun: Date.now(), done, of })
    } catch (e) {
      const signedOut = e instanceof SignedOut
      const site = service === 'claude' ? 'claude.ai' : 'chatgpt.com'
      return this.report({
        service,
        state: signedOut ? 'signed-out' : 'error',
        changed,
        done,
        of,
        count: this.count(service),
        lastRun: Date.now(),
        message: signedOut ? `Not signed in to ${site} in the app. Open the ${site} tab in the sidebar, sign in, then try again.` : e instanceof Error ? e.message : String(e)
      })
    }
  }

  /** Writes one chat. Gives back whether anything changed. */
  save(chat: ImportedChat): boolean {
    const id = conversationIdFor(chat.service, chat.remoteId)
    if (this.store.isDeleted('conversation', id)) return false
    const existing = this.store.get<Conversation>('conversation', id)
    // A title the user changed in the app wins over the site's.
    const renamed = existing && existing.source && existing.title !== existing.source.remoteTitle
    const title = renamed ? existing.title : chat.title
    const source = { service: chat.service, remoteId: chat.remoteId, url: chat.url, remoteUpdatedAt: chat.updatedAt, remoteTitle: chat.title }
    const conv: Conversation = existing
      ? { ...existing, title, source, updatedAt: Math.max(existing.updatedAt, chat.updatedAt) }
      : { id, title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, provider: chat.service, models: {}, mode: 'chat', source }

    const before = new Map(this.store.messages(id).map((m) => [m.id, m]))
    const items: { kind: 'conversation' | 'message'; id: string; data: unknown }[] = [{ kind: 'conversation', id, data: conv }]
    const kept = new Set<string>()
    let at = 0
    for (const m of chat.messages) {
      const mid = messageIdFor(chat.service, m.remoteId)
      kept.add(mid)
      // Strictly increasing times keep the order of the site, even where it gives none.
      at = Math.max(at + 1, m.createdAt || chat.createdAt)
      const old = before.get(mid)
      const message: Message = {
        id: mid,
        conversationId: id,
        role: m.role,
        text: m.text,
        createdAt: at,
        deviceId: old?.deviceId ?? this.store.deviceId,
        status: 'complete',
        ...(m.role === 'assistant' ? { provider: chat.service } : {}),
        ...(m.model ? { model: m.model } : {}),
        ...(m.attachments?.length ? { attachments: m.attachments } : {})
      }
      items.push({ kind: 'message', id: mid, data: message })
    }
    const written = this.store.putMany(items)
    // Messages that are no longer on the site's chat (an edited question starts a new branch there) go.
    let removed = 0
    const prefix = messageIdFor(chat.service, '')
    for (const old of before.values()) {
      if (old.id.startsWith(prefix) && !kept.has(old.id)) {
        this.store.remove('message', old.id)
        removed++
      }
    }
    return written > 0 || removed > 0
  }
}
