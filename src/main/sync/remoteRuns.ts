// Running assistants on the hub from another device. The Mac sends the message
// to the hub, the hub's own Claude Code and Codex do the work in a folder on
// the hub, and the result comes back through sync. Long tasks keep going while
// the laptop sleeps.
//
// This lets a paired device run commands on the hub machine, so it is off until
// the hub's owner turns it on.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { ApprovalDecision, Attachment, FolderEntry, FolderListing, ProviderId, ProviderStatus, RemoteInfo, RunWireEvent, Settings } from '@shared/types'
import type { SendInput } from '@shared/ipc'
import type { HubClient } from './hubClient'

const PROVIDERS: ProviderId[] = ['claude', 'chatgpt', 'local']
const isProvider = (v: unknown): v is ProviderId => PROVIDERS.includes(v as ProviderId)

/** Rebuild a send request that arrived over the network from known fields only. */
export function cleanSendInput(body: unknown): SendInput | undefined {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.conversationId !== 'string' || !b.conversationId) return undefined
  const input: SendInput = { conversationId: b.conversationId, text: typeof b.text === 'string' ? b.text : '' }
  if (isProvider(b.provider)) input.provider = b.provider
  if (b.variant === 'summary' || b.variant === 'full') input.variant = b.variant
  if (Array.isArray(b.compare)) input.compare = b.compare.filter(isProvider)
  if (b.retry === true) input.retry = true
  if (typeof b.edit === 'string' && b.edit) input.edit = b.edit
  if (Array.isArray(b.allow)) input.allow = b.allow.filter((r): r is string => typeof r === 'string').slice(0, 50)
  if (Array.isArray(b.attachments)) input.attachments = b.attachments as Attachment[]
  return input
}

/** Check a folder path typed on another device. An empty path clears the folder. */
export function checkFolder(path: string): { path: string; error?: string } {
  const trimmed = path.trim()
  if (!trimmed) return { path: '' }
  if (!isAbsolute(trimmed)) return { path: '', error: 'Give the full path of the folder, for example C:\\Users\\you\\project.' }
  try {
    if (!existsSync(trimmed) || !statSync(trimmed).isDirectory()) return { path: '', error: 'That folder does not exist on the machine that will run this.' }
  } catch {
    return { path: '', error: 'That folder could not be opened.' }
  }
  return { path: trimmed }
}

/** The most folders sent for one listing. */
export const MAX_FOLDERS = 500

const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The home folder, the usual folders inside it, and on Windows the drives. */
export function folderPlaces(home = homedir(), platform: string = process.platform): FolderEntry[] {
  const places: FolderEntry[] = [{ name: 'Home', path: home }]
  for (const name of ['Desktop', 'Documents', 'Downloads']) {
    const path = join(home, name)
    if (existsSync(path)) places.push({ name, path })
  }
  if (platform === 'win32') {
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      if (existsSync(`${letter}:\\`)) places.push({ name: `${letter}:`, path: `${letter}:\\` })
    }
  } else {
    places.push({ name: 'Computer', path: '/' })
  }
  return places
}

/**
 * Lists the folders inside a folder on this machine, for a device that is choosing where an
 * assistant should work. Only names of folders are given out, never files or their contents.
 * Without a path it lists the home folder.
 */
export function listFolders(path: string | undefined, home = homedir(), platform: string = process.platform): FolderListing {
  const places = folderPlaces(home, platform)
  const target = (path ?? '').trim() || home
  const failed = (error: string): FolderListing => ({ path: '', folders: [], places, error })
  if (!isAbsolute(target)) return failed('Give the full path of the folder, for example C:\\Users\\you\\project.')
  if (!isFolder(target)) return failed('That folder does not exist on the machine that will run this.')
  let names: string[]
  try {
    names = readdirSync(target, { withFileTypes: true })
      // Hidden and system folders are left out. A link counts when it leads to a folder.
      .filter((e) => !e.name.startsWith('.') && !e.name.startsWith('$') && (e.isDirectory() || (e.isSymbolicLink() && isFolder(join(target, e.name)))))
      .map((e) => e.name)
  } catch {
    return failed('That folder could not be opened.')
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))
  const parent = dirname(target)
  return {
    path: target,
    parent: parent !== target ? parent : undefined,
    folders: names.slice(0, MAX_FOLDERS).map((name) => ({ name, path: join(target, name) })),
    places,
    truncated: names.length > MAX_FOLDERS || undefined
  }
}

/** What the hub server needs in order to run assistants for other devices. */
export interface RunHost {
  enabled(): boolean
  info(): RemoteInfo
  send(input: SendInput): Promise<void>
  stop(conversationId: string): void
  respondApproval(conversationId: string, messageId: string, approvalId: string, decision: ApprovalDecision): void
  getWorkspace(conversationId: string): string
  setWorkspace(conversationId: string, path: string): { path: string; error?: string }
  listFolders(path?: string): FolderListing
}

/** The parts of the conversation engine a run host needs. */
export interface RunEngine {
  send(input: SendInput): Promise<void>
  stop(conversationId: string): void
  respondApproval(conversationId: string, messageId: string, approvalId: string, decision: ApprovalDecision): void
  workspace(conversationId: string): string
  setWorkspace(conversationId: string, path: string): void
}

export function createRunHost(engine: RunEngine, settings: () => Settings, statuses: () => Partial<Record<ProviderId, ProviderStatus>>, busy: () => string[]): RunHost {
  return {
    enabled: () => settings().hub.hostEnabled && settings().hub.allowRemoteRuns,
    info: () => ({ enabled: settings().hub.hostEnabled && settings().hub.allowRemoteRuns, deviceName: settings().deviceName, platform: process.platform, providers: statuses(), busy: busy() }),
    send: (input) => engine.send(input),
    stop: (conversationId) => engine.stop(conversationId),
    respondApproval: (conversationId, messageId, approvalId, decision) => {
      if (decision === 'accept' || decision === 'acceptForSession' || decision === 'decline') engine.respondApproval(conversationId, messageId, approvalId, decision)
    },
    getWorkspace: (conversationId) => engine.workspace(conversationId),
    setWorkspace: (conversationId, path) => {
      const checked = checkFolder(path)
      if (!checked.error) engine.setWorkspace(conversationId, checked.path)
      return checked.error ? { path: engine.workspace(conversationId), error: checked.error } : checked
    },
    // Tests give the hub a home folder of their own, so nothing personal is listed or photographed.
    listFolders: (path) => listFolders(path, process.env.CHAUDECAL_E2E_HOME || homedir())
  }
}

/** The client side: sends work to the hub and follows its progress. */
export class RemoteRuns {
  private latest?: RemoteInfo
  private busy = new Set<string>()

  constructor(
    private hub: HubClient,
    private emit: (event: RunWireEvent) => void,
    private onInfo: (info: RemoteInfo | undefined) => void
  ) {
    hub.onRun = (event) => this.handle(event)
  }

  info(): RemoteInfo | undefined {
    return this.latest
  }

  isBusy(conversationId: string): boolean {
    return this.busy.has(conversationId)
  }

  busyIds(): string[] {
    return [...this.busy]
  }

  private handle(event: RunWireEvent): void {
    if (event.type === 'busy' && !event.busy) {
      // Fetch the finished reply first. Only then is the run over as far as this device is concerned,
      // so the live copy is never dropped before the saved one is here.
      void this.hub.flush(8000).finally(() => {
        this.busy.delete(event.conversationId)
        this.emit(event)
      })
      return
    }
    if (event.type === 'busy') this.busy.add(event.conversationId)
    this.emit(event)
  }

  /** Ask the hub what it allows and what it is doing. Called on connect and from time to time. */
  async refresh(): Promise<void> {
    let info: RemoteInfo | undefined
    try {
      info = this.hub.current() ? await this.hub.request<RemoteInfo>('/api/run/info', undefined, 6000) : undefined
    } catch {
      info = undefined
    }
    // Runs may have started or ended while this device was not listening.
    const now = new Set(info?.enabled ? info.busy : [])
    for (const id of [...this.busy]) {
      if (now.has(id)) continue
      this.busy.delete(id)
      this.emit({ type: 'busy', conversationId: id, busy: false })
    }
    for (const id of now) {
      if (this.busy.has(id)) continue
      this.busy.add(id)
      this.emit({ type: 'busy', conversationId: id, busy: true })
    }
    const changed = JSON.stringify(info) !== JSON.stringify(this.latest)
    this.latest = info
    if (changed) this.onInfo(info)
  }

  /** True when a conversation marked to run on the hub can actually do so right now. */
  available(): boolean {
    return !!this.hub.current() && !!this.latest?.enabled
  }

  async send(input: SendInput): Promise<void> {
    if (!this.hub.current()) throw new Error('The hub is not reachable, so this cannot run there right now. Use "Runs on" in the message box to continue on this computer.')
    // The hub needs the conversation, earlier messages and any attached images before it can answer.
    await this.hub.flush()
    // Marked busy before asking, so a very quick reply cannot finish before this device knows it started.
    const alreadyRunning = this.busy.has(input.conversationId)
    if (!alreadyRunning) {
      this.busy.add(input.conversationId)
      this.emit({ type: 'busy', conversationId: input.conversationId, busy: true })
    }
    try {
      await this.hub.request('/api/run/send', input, 30000)
    } catch (e) {
      // A refusal because an earlier run is still going must not make that run look finished.
      if (!alreadyRunning) {
        this.busy.delete(input.conversationId)
        this.emit({ type: 'busy', conversationId: input.conversationId, busy: false })
      }
      throw e
    }
  }

  stop(conversationId: string): void {
    void this.hub.request('/api/run/stop', { conversationId }).catch(() => {})
  }

  respondApproval(conversationId: string, messageId: string, approvalId: string, decision: ApprovalDecision): void {
    void this.hub.request('/api/run/approval', { conversationId, messageId, approvalId, decision }).catch(() => {})
  }

  async getWorkspace(conversationId: string): Promise<string> {
    try {
      return (await this.hub.request<{ path: string }>('/api/run/workspace', { conversationId })).path
    } catch {
      return ''
    }
  }

  async setWorkspace(conversationId: string, path: string): Promise<{ path: string; error?: string }> {
    try {
      return await this.hub.request<{ path: string; error?: string }>('/api/run/workspace', { conversationId, path })
    } catch (e) {
      return { path: '', error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** The folders inside a folder on the hub. Without a path, the hub's home folder. */
  async listFolders(path?: string): Promise<FolderListing> {
    try {
      return await this.hub.request<FolderListing>('/api/run/folders', { path: path ?? '' }, 15000)
    } catch (e) {
      return { path: '', folders: [], places: [], error: e instanceof Error ? e.message : String(e) }
    }
  }
}
