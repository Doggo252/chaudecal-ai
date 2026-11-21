// Local database. Everything that syncs is a record: {kind, id, updatedAt,
// deviceId, deleted, data}. Two machines merge by keeping the newer copy of each
// record, and messages are separate records, so chats written on both machines
// combine instead of overwriting each other.

import { DatabaseSync } from 'node:sqlite'
import type { Blob, Conversation, Message, RecordKind, SyncRecord } from '@shared/types'
import type { SearchHit } from '@shared/ipc'
import { listArtifacts, type ArtifactEntry } from '@shared/artifacts'

type Row = {
  kind: string
  id: string
  updated_at: number
  device_id: string
  deleted: number
  data: string
  dirty: number
  seq: number
}

function toRecord(row: Row): SyncRecord {
  return {
    kind: row.kind as RecordKind,
    id: row.id,
    updatedAt: row.updated_at,
    deviceId: row.device_id,
    deleted: row.deleted === 1,
    data: JSON.parse(row.data),
    seq: row.seq || undefined
  }
}

const MAX_BATCH_BYTES = 24 * 1024 * 1024

/** True when `incoming` should replace `existing`. Ties break on device id so both sides agree. */
export function isNewer(incoming: { updatedAt: number; deviceId: string }, existing: { updatedAt: number; deviceId: string }): boolean {
  if (incoming.updatedAt !== existing.updatedAt) return incoming.updatedAt > existing.updatedAt
  return incoming.deviceId > existing.deviceId
}

/** A search snippet without Markdown marks, so it reads like the message does on screen. */
export function plainSnippet(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/\*\*|__|`{1,3}/g, '')
    .replace(/\\([\\`*_{}\[\]()#+\-.!:|>~])/g, '$1')
    .replace(/(^|\s)[-*>]\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export class Store {
  private db: DatabaseSync
  private listeners = new Set<(records: SyncRecord[], origin: 'local' | 'remote') => void>()
  /** When true this machine is the hub and numbers every change itself. */
  isHub = false
  readonly deviceId: string

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists records(
        kind text not null, id text not null, updated_at integer not null, device_id text not null,
        deleted integer not null default 0, data text not null, dirty integer not null default 0,
        seq integer not null default 0, conv_id text,
        primary key(kind, id)
      );
      create index if not exists records_seq on records(seq);
      create index if not exists records_conv on records(conv_id, kind);
      create index if not exists records_dirty on records(dirty);
      create table if not exists kv(key text primary key, value text not null);
      create virtual table if not exists msg_fts using fts5(id unindexed, conv_id unindexed, body);
    `)
    let id = this.kvGet<string>('deviceId')
    if (!id) {
      id = `dev-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
      this.kvSet('deviceId', id)
    }
    this.deviceId = id
  }

  close(): void {
    this.db.close()
  }

  onChange(listener: (records: SyncRecord[], origin: 'local' | 'remote') => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(records: SyncRecord[], origin: 'local' | 'remote'): void {
    if (!records.length) return
    for (const l of this.listeners) l(records, origin)
  }

  // ----- key/value (this machine only, never synced) -----

  kvGet<T>(key: string): T | undefined {
    const row = this.db.prepare('select value from kv where key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : undefined
  }

  kvSet(key: string, value: unknown): void {
    this.db.prepare('insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value').run(key, JSON.stringify(value))
  }

  kvDelete(key: string): void {
    this.db.prepare('delete from kv where key = ?').run(key)
  }

  /** Every entry whose key starts with the prefix. */
  kvEntries<T>(prefix: string): [string, T][] {
    const rows = this.db.prepare("select key, value from kv where key like ? escape '\\'").all(`${prefix.replace(/[\\%_]/g, '\\$&')}%`) as { key: string; value: string }[]
    return rows.map((r) => [r.key, JSON.parse(r.value) as T])
  }

  kvDeletePrefix(prefix: string): void {
    this.db.prepare("delete from kv where key like ? escape '\\'").run(`${prefix.replace(/[\\%_]/g, '\\$&')}%`)
  }

  // ----- sequence numbers (hub) -----

  latestSeq(): number {
    return this.kvGet<number>('seq') ?? 0
  }

  private nextSeq(): number {
    const seq = this.latestSeq() + 1
    this.kvSet('seq', seq)
    return seq
  }

  /** Called when this machine becomes the hub: give every record a place in the change log. */
  numberAll(): void {
    const rows = this.db.prepare('select kind, id from records where seq = 0 order by updated_at').all() as { kind: string; id: string }[]
    const stmt = this.db.prepare('update records set seq = ?, dirty = 0 where kind = ? and id = ?')
    for (const r of rows) stmt.run(this.nextSeq(), r.kind, r.id)
  }

  // ----- records -----

  private write(record: SyncRecord, dirty: boolean, seq: number): void {
    const convId = record.kind === 'message' ? (record.data as Message).conversationId : null
    this.db
      .prepare(
        `insert into records(kind, id, updated_at, device_id, deleted, data, dirty, seq, conv_id) values(?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(kind, id) do update set updated_at = excluded.updated_at, device_id = excluded.device_id, deleted = excluded.deleted,
           data = excluded.data, dirty = excluded.dirty, seq = excluded.seq, conv_id = excluded.conv_id`
      )
      .run(record.kind, record.id, record.updatedAt, record.deviceId, record.deleted ? 1 : 0, JSON.stringify(record.data), dirty ? 1 : 0, seq, convId)
    if (record.kind === 'message') this.indexMessage(record as SyncRecord<Message>)
  }

  private indexMessage(record: SyncRecord<Message>): void {
    this.db.prepare('delete from msg_fts where id = ?').run(record.id)
    const m = record.data
    if (record.deleted || m.role === 'note' || !m.text) return
    this.db.prepare('insert into msg_fts(id, conv_id, body) values(?, ?, ?)').run(record.id, m.conversationId, m.text)
  }

  /** Save a change made on this machine. */
  put<T>(kind: RecordKind, id: string, data: T, opts: { deleted?: boolean; silent?: boolean } = {}): SyncRecord<T> {
    const existing = this.getRaw(kind, id)
    // Never go backwards in time relative to what is stored, or the change would lose to itself.
    const updatedAt = Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1)
    const record: SyncRecord<T> = { kind, id, updatedAt, deviceId: this.deviceId, deleted: opts.deleted ?? false, data }
    const seq = this.isHub ? this.nextSeq() : (existing?.seq ?? 0)
    if (this.isHub) record.seq = seq
    this.write(record, !this.isHub, seq)
    if (!opts.silent) this.emit([record], 'local')
    return record
  }

  /** Several changes at once, in one transaction, announced together. Each item is skipped when its data is unchanged. */
  putMany(items: { kind: RecordKind; id: string; data: unknown }[]): number {
    const written: SyncRecord[] = []
    this.db.exec('begin')
    try {
      for (const item of items) {
        const existing = this.getRaw(item.kind, item.id)
        if (existing && !existing.deleted && JSON.stringify(existing.data) === JSON.stringify(item.data)) continue
        written.push(this.put(item.kind, item.id, item.data, { silent: true }))
      }
      this.db.exec('commit')
    } catch (e) {
      this.db.exec('rollback')
      throw e
    }
    this.emit(written, 'local')
    return written.length
  }

  /** The record was deleted, here or on another device. */
  isDeleted(kind: RecordKind, id: string): boolean {
    return !!this.getRaw(kind, id)?.deleted
  }

  remove(kind: RecordKind, id: string): void {
    const existing = this.getRaw(kind, id)
    if (!existing) return
    // A deleted record stays so the deletion syncs, but an image loses its bytes and a tool server its tokens.
    const data = kind === 'blob' ? { ...(existing.data as Blob), base64: '' } : kind === 'mcp' ? { ...(existing.data as object), env: {}, headers: {}, oauth: undefined } : existing.data
    this.put(kind, id, data, { deleted: true })
  }

  private getRaw(kind: RecordKind, id: string): SyncRecord | undefined {
    const row = this.db.prepare('select * from records where kind = ? and id = ?').get(kind, id) as Row | undefined
    return row ? toRecord(row) : undefined
  }

  get<T>(kind: RecordKind, id: string): T | undefined {
    const r = this.getRaw(kind, id)
    return r && !r.deleted ? (r.data as T) : undefined
  }

  list<T>(kind: RecordKind): T[] {
    const rows = this.db.prepare('select * from records where kind = ? and deleted = 0').all(kind) as Row[]
    return rows.map((r) => JSON.parse(r.data) as T)
  }

  messages(conversationId: string): Message[] {
    const rows = this.db.prepare("select data from records where kind = 'message' and conv_id = ? and deleted = 0").all(conversationId) as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as Message).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  /** Every artifact in every chat, for the Artifacts page. Only messages with a fenced block are read. */
  artifacts(): ArtifactEntry[] {
    const rows = this.db.prepare("select data from records where kind = 'message' and deleted = 0 and (data like '%```%' or data like '%~~~%')").all() as { data: string }[]
    const messages = rows.map((r) => JSON.parse(r.data) as Message)
    return listArtifacts(this.list<Conversation>('conversation'), messages)
  }

  deleteConversation(id: string): void {
    const messages = this.messages(id)
    const elsewhere = this.db.prepare("select count(*) as n from records where kind = 'message' and deleted = 0 and conv_id != ? and data like ?")
    for (const m of messages) {
      for (const a of [...(m.attachments ?? []), ...(m.images ?? [])]) {
        if (a.kind !== 'image') continue
        // A branch of this conversation may still show the same image.
        const used = (elsewhere.get(id, `%"id":"${a.id}"%`) as { n: number }).n
        if (!used) this.remove('blob', a.id)
      }
    }
    for (const m of messages) this.remove('message', m.id)
    this.remove('conversation', id)
    this.kvDeletePrefix(`session:${id}:`)
    this.kvDelete(`cwd:${id}`)
    this.kvDelete(`grants:${id}`)
  }

  // ----- sync -----

  /** Merge records that came from another machine. Returns the ones that changed anything here. */
  applyRemote(incoming: SyncRecord[]): SyncRecord[] {
    const applied: SyncRecord[] = []
    for (const rec of incoming) {
      const existing = this.getRaw(rec.kind, rec.id)
      if (existing && !isNewer(rec, existing)) continue
      const seq = this.isHub ? this.nextSeq() : (rec.seq ?? 0)
      const stored = { ...rec, seq: seq || undefined }
      this.write(stored, false, seq)
      applied.push(stored)
    }
    this.emit(applied, 'remote')
    return applied
  }

  /** Changes made here that the hub has not seen. */
  dirty(limit = 400): SyncRecord[] {
    return this.page(this.db.prepare('select * from records where dirty = 1 order by updated_at limit ?').iterate(limit) as Iterable<Row>)
  }

  /** One batch for the wire. Image attachments are large, so a batch is capped by size as well as by count. */
  private page(rows: Iterable<Row>): SyncRecord[] {
    const out: SyncRecord[] = []
    let bytes = 0
    for (const row of rows) {
      out.push(toRecord(row))
      bytes += row.data.length
      if (bytes > MAX_BATCH_BYTES) break
    }
    return out
  }

  dirtyCount(): number {
    return (this.db.prepare('select count(*) as n from records where dirty = 1').get() as { n: number }).n
  }

  /** Mark records as delivered, unless they changed again while the push was in flight. */
  markClean(pushed: SyncRecord[]): void {
    const stmt = this.db.prepare('update records set dirty = 0 where kind = ? and id = ? and updated_at = ?')
    for (const r of pushed) stmt.run(r.kind, r.id, r.updatedAt)
  }

  markAllDirty(): void {
    this.db.exec('update records set dirty = 1')
  }

  /**
   * Forgets every chat, project and note on this machine, with what was deleted and
   * what was already imported, so the next import brings everything back. Settings,
   * the link to the hub and the device's name stay.
   */
  wipe(): void {
    const keep = ['deviceId', 'settings', 'hubId', 'seq', 'erasedAt']
    this.db.exec('begin')
    try {
      this.db.exec('delete from records; delete from msg_fts;')
      this.db.prepare(`delete from kv where key not in (${keep.map(() => '?').join(', ')})`).run(...keep)
      this.db.exec('commit')
    } catch (e) {
      this.db.exec('rollback')
      throw e
    }
    this.kvSet('cursor', 0)
  }

  /** Hub side: everything that changed after a sequence number. */
  since(seq: number, limit = 500): SyncRecord[] {
    return this.page(this.db.prepare('select * from records where seq > ? order by seq limit ?').iterate(seq, limit) as Iterable<Row>)
  }

  // ----- search -----

  search(query: string, limit = 40): SearchHit[] {
    const terms = query
      .split(/\s+/)
      .map((t) => t.replace(/["*]/g, '').trim())
      .filter(Boolean)
    if (!terms.length) return []
    const hits: SearchHit[] = []
    const seen = new Set<string>()
    const convs = new Map(this.list<Conversation>('conversation').map((c) => [c.id, c]))

    const needle = terms.join(' ').toLowerCase()
    const titled = new Set<string>()
    for (const c of convs.values()) if (c.title.toLowerCase().includes(needle)) titled.add(c.id)

    const match = terms.map((t) => `"${t}"*`).join(' ')
    let rows: { id: string; conv_id: string; snip: string }[] = []
    try {
      rows = this.db
        .prepare("select id, conv_id, snippet(msg_fts, 2, '[[', ']]', ' … ', 14) as snip from msg_fts where msg_fts match ? order by rank limit ?")
        .all(match, 2000) as typeof rows
    } catch {
      rows = []
    }
    // One result per chat: its best matching message, and how many others match.
    const byChat = new Map<string, SearchHit>()
    for (const r of rows) {
      const conv = convs.get(r.conv_id)
      if (!conv) continue
      const hit = byChat.get(r.conv_id)
      if (hit) {
        hit.matches = (hit.matches ?? 1) + 1
        continue
      }
      const msg = this.get<Message>('message', r.id)
      byChat.set(r.conv_id, { conversationId: r.conv_id, messageId: r.id, title: conv.title, snippet: plainSnippet(r.snip), createdAt: msg?.createdAt ?? conv.updatedAt, matches: 1, ...(conv.source ? { source: conv.source.service } : {}) })
    }
    // Chats whose title matches come first, then the rest in order of how well they match.
    for (const id of titled) {
      const conv = convs.get(id)!
      hits.push(byChat.get(id) ?? { conversationId: id, title: conv.title, snippet: '', createdAt: conv.updatedAt, ...(conv.source ? { source: conv.source.service } : {}) })
      seen.add(id)
    }
    for (const hit of byChat.values()) if (!seen.has(hit.conversationId)) hits.push(hit)
    return hits.slice(0, limit)
  }
}
