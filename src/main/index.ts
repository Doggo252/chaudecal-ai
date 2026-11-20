import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, Notification, powerMonitor, shell, type MenuItemConstructorOptions } from 'electron'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import type { Attachment, Blob, Conversation, Project, ScheduledTask, HubStatus, LocalModel, McpServer, MemoryNote, Message, Profile, ProviderId, ProviderStatus, RunWireEvent, SavedPrompt, Settings, UpdateInfo } from '@shared/types'
import { defaultSettings, MAC_LOCAL_NETWORK_SETTINGS, MAX_FILE_BYTES, newId } from '@shared/types'
import { limitsFromClaudeUsageText } from '@shared/usage'
import { API_METHODS, type Api, type AppEvents, type AppState, type AttachResult, type DeepPartial, type HandoffInfo, type McpInput } from '@shared/ipc'
import { cleanMcpName, mcpProblem } from '@shared/mcp'
import { normalizeAccent, normalizeTextSize } from '@shared/theme'
import { Store } from './store'
import { findBinary, loadShellPath, spawnCli } from './env'
import { ClaudeProvider } from './providers/claude'
import { CodexProvider } from './providers/codex'
import { LocalProvider } from './providers/local'
import type { Provider } from './providers/types'
import { HubServer, localAddresses } from './sync/hubServer'
import { HubClient } from './sync/hubClient'
import { checkFolder, createRunHost, RemoteRuns } from './sync/remoteRuns'
import { announceHub, discoverHubs, shutdownDiscovery, stopAnnouncing } from './sync/discovery'
import { ChatEngine } from './chat'
import { Summarizer } from './summarizer'
import { siteOrigin, WebTabs } from './webtabs'
import { readAttachment } from './attachments'
import { normalizeMcpServer, testMcpServer } from './mcp'
import { needsRenewal, renew, signIn as mcpBrowserSignIn } from './mcpAuth'
import { guardFrames, previewPage, previewUrl, registerArtifactScheme, saveArtifact, servePreviews } from './artifacts'
import { artifactCsp } from '@shared/artifactPolicy'
import { WebImporter } from './webImport'
import { TaskRunner } from './tasks'
import { captureSource, captureSources, hideQuick, setQuickShortcut, toggleQuick } from './quick'
import { cleanSchedule, nextRun } from '@shared/schedule'
import { applyStartAtLogin, hidesOnClose, showTray, startedHidden } from './background'
import { checkForUpdate, RELEASE_DOWNLOADS } from './updates'
import { shouldRestartForUpdate, Updater } from './updater'
import { finishedNotice, questionNotice, shouldNotify, type Notice } from './notify'

/** Set by the build on GitHub. Zero for a build made on a developer's machine. */
declare const __BUILD_NUMBER__: number

// Tests and side-by-side instances point the app at their own data folder.
const dataOverride = process.env.CHAUDECAL_USER_DATA
if (dataOverride) app.setPath('userData', dataOverride)
else {
  // The app was called Chaudecal AI before. Its data folder keeps that name, so nothing is lost.
  const before = join(app.getPath('appData'), 'Chaudecal AI')
  if (existsSync(before)) app.setPath('userData', before)
  if (!app.requestSingleInstanceLock()) app.quit()
}
// Artifact previews are served under their own scheme, which has to be known before the app starts.
registerArtifactScheme()
if (process.env.CHAUDECAL_E2E_FAKE_MIC) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
}

let win: BrowserWindow | undefined
const PRELOAD = join(__dirname, '../preload/index.js')
let store: Store
let settings: Settings
let engine: ChatEngine
let hubServer: HubServer
let hubClient: HubClient
let remote: RemoteRuns
let webTabs: WebTabs
let webImporter: WebImporter
let tasks: TaskRunner
let local: LocalProvider
let codex: CodexProvider
let claude: ClaudeProvider
let providers: Record<ProviderId, Provider>
let statuses: Partial<Record<ProviderId, ProviderStatus>> = {}
let localModels: LocalModel[] = []
let hubError = ''
let updater: Updater
let quitting = false

/** Turn chosen, pasted or dropped files into attachments, storing image bytes as they come in. */
async function attach(files: { name: string; bytes: Buffer }[]): Promise<AttachResult> {
  const result: AttachResult = { attachments: [], errors: [] }
  for (const file of files) {
    const outcome = await readAttachment(file.name, file.bytes)
    if ('error' in outcome) {
      result.errors.push(outcome.error)
      continue
    }
    if (outcome.blob) store.put<Blob>('blob', outcome.blob.id, outcome.blob)
    result.attachments.push(outcome.attachment)
  }
  return result
}

function readFiles(paths: string[]): { files: { name: string; bytes: Buffer }[]; errors: string[] } {
  const files: { name: string; bytes: Buffer }[] = []
  const errors: string[] = []
  for (const path of paths) {
    try {
      // Nothing larger than this is ever useful, so do not read it into memory.
      if (statSync(path).size > MAX_FILE_BYTES) errors.push(`${basename(path)} is too large to attach.`)
      else files.push({ name: basename(path), bytes: readFileSync(path) })
    } catch {
      errors.push(`${basename(path)} could not be read.`)
    }
  }
  return { files, errors }
}

async function lookForUpdate(): Promise<void> {
  if (!settings.checkForUpdates) return
  // Tests never reach the network, unless they point the check at their own server.
  const override = process.env.CHAUDECAL_UPDATE_URL
  if (dataOverride && !override) return
  const build = Number(process.env.CHAUDECAL_BUILD_OVERRIDE ?? __BUILD_NUMBER__) || 0
  // A test's stand-in release page serves its downloads from the same place.
  const found = await checkForUpdate({ version: app.getVersion(), build }, override || undefined, override ? `${new URL(override).origin}/` : RELEASE_DOWNLOADS)
  if (found) updater.offer(found, settings.autoUpdate)
}

/** Something is running that a restart would cut short. */
function anythingRunning(): boolean {
  return store.list<Conversation>('conversation').some((c) => engine.isBusy(c.id) || remote.isBusy(c.id)) || webImporter.isRunning('claude') || webImporter.isRunning('chatgpt')
}

function windowShown(): boolean {
  return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()
}

/** Left by an update that restarted the app while its window was closed, so it comes back closed too. */
const startHiddenMarker = () => join(app.getPath('userData'), 'updates', 'start-hidden')

/** With automatic updates on, a downloaded update installs once the user has stepped away and nothing is running. */
function restartForUpdateWhenAway(): void {
  if (!settings.autoUpdate || !updater.ready) return
  if (!shouldRestartForUpdate({ ready: true, busy: anythingRunning(), idleSeconds: powerMonitor.getSystemIdleTime(), windowShown: windowShown() })) return
  if (!windowShown()) {
    try {
      writeFileSync(startHiddenMarker(), String(Date.now()))
    } catch {
      // It then simply comes back with its window open.
    }
  }
  void updater.apply()
}

let installingOnQuit = false

/** True when this conversation's assistants run on the hub and this machine is not the hub. */
function runsOnHub(conversationId: string): boolean {
  return !settings.hub.hostEnabled && !!store.get<Conversation>('conversation', conversationId)?.runOnHub
}

/** Progress of a run, shown in this window whether the run is here or on the hub. */
function showRunEvent(event: RunWireEvent): void {
  if (event.type === 'stream') send('stream', event.message)
  else if (event.type === 'busy') send('busy', { conversationId: event.conversationId, busy: event.busy })
  else if (event.type === 'route') send('route', { conversationId: event.conversationId, decision: event.decision })
  else if (event.type === 'approval') send('approval', { conversationId: event.conversationId, messageId: event.messageId, request: event.request, settled: event.settled })
  else send('denials', { conversationId: event.conversationId, messageId: event.messageId, denials: event.denials })
  announce(event)
}

// Tests record notifications in a file instead of showing them, and count as being in the background.
const notifyLog = process.env.CHAUDECAL_E2E_NOTIFY
/** Conversations whose current run was started from this device, with the newest reply they had before it. */
const startedHere = new Map<string, string | undefined>()
/** Notifications about questions that are still waiting, by request id, so they can be withdrawn. */
const asking = new Map<string, Notification>()
/** Shown notifications are kept until they are dismissed, or their click would be lost. */
const shown = new Set<Notification>()
let pendingOpen: string | undefined
/** Notifications since the window was last in front. Shown as the Dock badge. */
let unseen = 0

const lastReply = (conversationId: string): Message | undefined => store.messages(conversationId).findLast((m) => m.role === 'assistant')

function inBackground(): boolean {
  return !!notifyLog || !win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || !win.isFocused()
}

/** Speaks up about a run when the app is in the background: a reply has arrived, or a question is waiting. */
function announce(event: RunWireEvent): void {
  if (event.type !== 'busy' && event.type !== 'approval') return
  const id = event.conversationId
  if (event.type === 'approval' && event.settled) {
    asking.get(event.request.id)?.close()
    asking.delete(event.request.id)
    return
  }
  if (event.type === 'busy' && event.busy) return
  const kind = event.type === 'busy' ? 'finished' : 'question'
  const mine = startedHere.has(id)
  const before = startedHere.get(id)
  if (kind === 'finished') startedHere.delete(id)
  if (!shouldNotify({ enabled: settings.notifications, inBackground: inBackground(), startedHere: mine, kind, hub: settings.hub.hostEnabled, listeners: hubServer.listeners() })) return
  const conversation = store.get<Conversation>('conversation', id)
  if (event.type === 'approval') {
    const note = notify(id, questionNotice(conversation, event.request))
    if (note) asking.set(event.request.id, note)
    return
  }
  // Only a reply that this run produced is news. A run stopped before it wrote anything leaves the old one.
  const reply = lastReply(id)
  if (reply && reply.id !== before) notify(id, finishedNotice(conversation, reply))
}

function notify(conversationId: string, notice: Notice | undefined): Notification | undefined {
  if (!notice) return undefined
  if (notifyLog) {
    appendFileSync(notifyLog, `${JSON.stringify({ conversationId, ...notice })}\n`)
    return undefined
  }
  // The Dock badge (and on Windows a flashing taskbar button) still gets through if the system
  // refuses the notification itself, which macOS does when notifications are turned off for the app.
  unseen += 1
  app.setBadgeCount(unseen)
  if (process.platform === 'win32' && win && !win.isDestroyed()) win.flashFrame(true)
  if (!Notification.isSupported()) return undefined
  const note = new Notification({ title: notice.title, body: notice.body })
  shown.add(note)
  note.on('close', () => shown.delete(note))
  note.on('failed', () => shown.delete(note))
  note.on('click', () => {
    shown.delete(note)
    openConversation(conversationId)
  })
  note.show()
  return note
}

/** The window is being looked at again, so nothing is waiting to be noticed. */
function noticed(): void {
  unseen = 0
  app.setBadgeCount(0)
  if (win && !win.isDestroyed()) win.flashFrame(false)
}

function openConversation(conversationId: string): void {
  if (!win || win.isDestroyed()) {
    // The new window asks for its starting state, and finds the conversation to open there.
    pendingOpen = conversationId
    createWindow()
    return
  }
  showWindow()
  send('open', conversationId)
}

function showWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function send<K extends keyof AppEvents>(channel: K, payload: AppEvents[K]): void {
  if (win && !win.isDestroyed()) win.webContents.send(`event:${channel}`, payload)
  // A phone or browser showing the app gets the same events.
  hubServer?.broadcastApp(channel, payload)
}

/**
 * Calls a phone or browser may not make: they would act on this machine's own
 * screen (file dialogs, its browser, the quick ask box, screen capture), change
 * how this machine is set up, or replace the pairing code.
 */
const NOT_FROM_BROWSER = new Set([
  'pickAttachments',
  'revealContext',
  'copyContext',
  'updateSettings',
  'providerLogin',
  'pickWorkspace',
  'saveArtifact',
  'hubDiscover',
  'hubNewToken',
  'hubSyncNow',
  'openExternal',
  'applyUpdate',
  'toggleQuick',
  'quickAsk',
  'hideQuick',
  'captureSources',
  'captureSource',
  'openConfig',
  'webSignedIn',
  'webSignIn',
  'webSignOut',
  'webShow',
  'webHide',
  'webNavigate',
  'webAction',
  'webCapture'
])

/** Turns bytes that a browser sent as base64 back into bytes. */
function revive(value: unknown): unknown {
  if (value && typeof value === 'object' && typeof (value as { __bytes?: unknown }).__bytes === 'string') return new Uint8Array(Buffer.from((value as { __bytes: string }).__bytes, 'base64'))
  return value
}

function merge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined || patch === null) return base
  if (Array.isArray(patch) || typeof patch !== 'object' || typeof base !== 'object' || base === null) return patch as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue
    out[k] = merge((base as Record<string, unknown>)[k], v as never)
  }
  return out as T
}

function loadSettings(): Settings {
  const defaults = defaultSettings(hostname().replace(/\.local$/, ''))
  let loaded = merge(defaults, store.kvGet<DeepPartial<Settings>>('settings'))
  // Tests start the app with their own settings so that no real service is contacted.
  const seed = process.env.CHAUDECAL_SETTINGS_JSON
  if (seed) {
    try {
      loaded = merge(loaded, JSON.parse(seed) as DeepPartial<Settings>)
    } catch {
      // An unreadable seed is ignored.
    }
  }
  loaded.accent = normalizeAccent(loaded.accent)
  loaded.textSize = normalizeTextSize(loaded.textSize)
  return loaded
}

function hubStatus(): HubStatus {
  if (settings.hub.hostEnabled) {
    const running = hubServer.running
    return {
      role: 'host',
      connected: running,
      url: `http://localhost:${hubServer.port || settings.hub.port}`,
      detail: running ? 'This machine is the hub' : hubError || 'Starting',
      pending: 0,
      addresses: running ? localAddresses(hubServer.port) : []
    }
  }
  return hubClient.status()
}

async function applyHub(): Promise<void> {
  hubError = ''
  if (settings.hub.hostEnabled) {
    hubClient.stop()
    if (!settings.hub.token) {
      settings = merge(settings, { hub: { token: randomBytes(9).toString('base64url') } })
      store.kvSet('settings', settings)
      send('settings', settings)
    }
    if (hubServer.running && hubServer.port !== settings.hub.port) await hubServer.stop()
    try {
      await hubServer.start()
      announceHub(settings.deviceName, hubServer.port)
    } catch (e) {
      hubError = e instanceof Error && /EADDRINUSE/.test(e.message) ? `Port ${settings.hub.port} is already in use.` : String(e)
    }
  } else {
    stopAnnouncing()
    if (hubServer.running) await hubServer.stop()
    hubClient.stop()
    if (settings.hub.remoteUrl.trim()) hubClient.start()
  }
  send('hub', hubStatus())
}

let checkingClaudeUsage = false
let lastClaudeUsage = 0
/** Claude's plan usage, read with its /usage command (no model call). Not more than once a minute. */
async function refreshClaudeUsage(): Promise<void> {
  if (checkingClaudeUsage || Date.now() - lastClaudeUsage < 60_000 || dataOverride) return
  if (!statuses.claude?.ready) return
  checkingClaudeUsage = true
  lastClaudeUsage = Date.now()
  try {
    const text = await claude.usage()
    const limits = text ? limitsFromClaudeUsageText(text, Date.now()) : {}
    if (limits.fiveHour || limits.weekly) engine.recordLimits('claude', limits)
  } finally {
    checkingClaudeUsage = false
  }
}

let refreshing: Promise<void> | undefined
function refreshProviders(): Promise<void> {
  refreshing ??= (async () => {
    const [c, g, l] = await Promise.all([providers.claude.status(), providers.chatgpt.status(), providers.local.status(), remote.refresh()])
    statuses = { claude: c, chatgpt: g, local: l }
    localModels = await local.models()
    send('providers', { providers: statuses, localModels })
  })().finally(() => (refreshing = undefined))
  return refreshing
}

function mcpServers(): McpServer[] {
  return store
    .list<Partial<McpServer> & { id: string }>('mcp')
    .map(normalizeMcpServer)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** A tool server built from what the settings page sent, on top of the saved one if there is one. */
function mcpFromInput(input: McpInput): McpServer {
  const existing = input.id ? mcpServers().find((m) => m.id === input.id) : undefined
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  return normalizeMcpServer({
    id: existing?.id ?? newId(),
    name: cleanMcpName(text(input.name)),
    kind: input.kind,
    command: text(input.command),
    args: Array.isArray(input.args) ? input.args.filter((a) => typeof a === 'string') : [],
    env: input.kind === 'command' ? input.env : {},
    url: text(input.url),
    headers: input.kind === 'url' ? input.headers : {},
    enabled: input.enabled ?? existing?.enabled ?? true,
    trusted: input.trusted ?? existing?.trusted ?? false,
    offOn: input.offOn ?? existing?.offOn ?? [],
    createdAt: existing?.createdAt ?? Date.now(),
    // A sign-in belongs to the address it was made for.
    oauth: existing && existing.url === text(input.url) ? existing.oauth : undefined
  })
}

function appState(): AppState {
  return {
    deviceId: store.deviceId,
    platform: process.platform,
    version: app.getVersion(),
    settings,
    conversations: store.list<Conversation>('conversation'),
    notes: store.list<MemoryNote>('note'),
    prompts: store.list<SavedPrompt>('prompt'),
    projects: store.list<Project>('project').sort((a, b) => a.name.localeCompare(b.name)),
    tasks: store.list<ScheduledTask>('task').sort((a, b) => a.createdAt - b.createdAt),
    mcp: mcpServers(),
    profile: store.get<Profile>('profile', 'profile') ?? { id: 'profile', instructions: '', updatedAt: 0 },
    usage: engine.allUsage(),
    providers: statuses,
    localModels,
    hub: hubStatus(),
    busy: store.list<Conversation>('conversation').filter((c) => engine.isBusy(c.id) || remote.isBusy(c.id)).map((c) => c.id),
    update: updater.info,
    remote: settings.hub.hostEnabled ? undefined : remote.info(),
    webImport: { claude: webImporter.status('claude'), chatgpt: webImporter.status('chatgpt') }
  }
}

/** Renews browser sign-ins to tool servers that are about to run out, so a reply never meets an expired one. */
async function freshMcpSignIns(): Promise<void> {
  for (const server of store.list<McpServer>('mcp')) {
    if (!needsRenewal(server.oauth)) continue
    try {
      const oauth = await renew(server.oauth!)
      const latest = store.get<McpServer>('mcp', server.id)
      if (latest) store.put('mcp', server.id, { ...latest, oauth })
    } catch {
      // The test button and the reply will say that the sign-in needs doing again.
    }
  }
}

/** How often chats are brought in from the websites, for the sites where that is switched on. */
const WEB_IMPORT_EVERY = 30 * 60 * 1000

function importFromWebs(): void {
  for (const service of ['claude', 'chatgpt'] as const) if (settings.webImport?.[service]) void webImporter.run(service)
}

const api: Omit<Api, 'on'> = {
  async state() {
    const open = pendingOpen
    pendingOpen = undefined
    return { ...appState(), open }
  },
  async messages(conversationId) {
    return store.messages(conversationId)
  },
  async createConversation(partial) {
    return engine.createConversation(partial)
  },
  async updateConversation(id, patch) {
    engine.updateConversation(id, patch)
  },
  async deleteConversation(id) {
    engine.stop(id)
    store.deleteConversation(id)
  },
  async send(input) {
    await freshMcpSignIns()
    // Remember that this device asked, so it is the one that announces the reply.
    startedHere.set(input.conversationId, lastReply(input.conversationId)?.id)
    try {
      if (runsOnHub(input.conversationId)) await remote.send(input)
      else await engine.send(input)
    } catch (e) {
      // Refused before it started. A run that is already going keeps its own entry.
      if (!engine.isBusy(input.conversationId) && !remote.isBusy(input.conversationId)) startedHere.delete(input.conversationId)
      throw e
    }
  },
  async stop(conversationId) {
    if (remote.isBusy(conversationId)) remote.stop(conversationId)
    else engine.stop(conversationId)
  },
  async respondApproval(conversationId, messageId, approvalId, decision) {
    if (remote.isBusy(conversationId)) remote.respondApproval(conversationId, messageId, approvalId, decision)
    else engine.respondApproval(conversationId, messageId, approvalId, decision)
  },
  async selectVariant(messageId) {
    engine.selectVariant(messageId)
  },
  async branchConversation(conversationId, messageId) {
    return engine.branch(conversationId, messageId)
  },
  async pickAttachments() {
    let paths = (process.env.CHAUDECAL_E2E_ATTACH ?? '').split(delimiter).filter(Boolean)
    if (!paths.length && win) {
      const res = await dialog.showOpenDialog(win, { title: 'Attach files', properties: ['openFile', 'multiSelections'] })
      paths = res.canceled ? [] : res.filePaths
    }
    const { files, errors } = readFiles(paths)
    const result = await attach(files)
    return { attachments: result.attachments, errors: [...errors, ...result.errors] }
  },
  async addAttachment(file) {
    if (typeof file?.base64 !== 'string' || file.base64.length > MAX_FILE_BYTES * 1.4) return { attachments: [], errors: ['That file is too large to attach.'] }
    return attach([{ name: String(file.name || 'pasted'), bytes: Buffer.from(file.base64, 'base64') }])
  },
  async attachmentUrl(id) {
    const blob = store.get<Blob>('blob', id)
    return blob?.base64 ? `data:${blob.mime};base64,${blob.base64}` : undefined
  },
  async discardAttachment(id) {
    // Only an image that no message uses is thrown away.
    const used = store.list<Message>('message').some((m) => (m.attachments ?? []).some((a: Attachment) => a.id === id))
    if (!used) store.remove('blob', id)
  },
  async switchProvider(conversationId, to) {
    engine.switchProvider(conversationId, to)
  },
  async handoffPreview(conversationId, variant, target) {
    const h = engine.handoff(conversationId, variant, target)
    if (!h) return undefined
    const conv = store.get<Conversation>('conversation', conversationId)
    const info: HandoffInfo = { ...h, summarySource: variant === 'summary' && h.condensed ? (conv?.summary?.source ?? 'extractive') : undefined }
    return info
  },
  async revealContext(conversationId) {
    engine.writeContextFiles(conversationId)
    await shell.openPath(engine.contextDir(conversationId))
  },
  async copyContext(conversationId, variant) {
    const h = engine.handoff(conversationId, variant)
    if (h) clipboard.writeText(h.text)
  },
  async search(query) {
    return store.search(query)
  },
  async updateSettings(patch) {
    const before = settings
    settings = merge(settings, patch)
    settings.accent = normalizeAccent(settings.accent)
    settings.textSize = normalizeTextSize(settings.textSize)
    store.kvSet('settings', settings)
    nativeTheme.themeSource = settings.theme
    send('settings', settings)
    const hubChanged = JSON.stringify(before.hub) !== JSON.stringify(settings.hub) || before.deviceName !== settings.deviceName
    if (hubChanged) await applyHub()
    if (before.startAtLogin !== settings.startAtLogin && !dataOverride) applyStartAtLogin(settings.startAtLogin)
    if (!before.checkForUpdates && settings.checkForUpdates) void lookForUpdate()
    if (before.quickAsk !== settings.quickAsk) setQuickShortcut(settings.quickAsk, PRELOAD)
    if (!before.autoUpdate && settings.autoUpdate && updater.info?.canInstall && updater.info.state === 'available') void updater.download().catch(() => {})
    for (const service of ['claude', 'chatgpt'] as const) if (!before.webImport?.[service] && settings.webImport?.[service]) void webImporter.run(service)
    const providersChanged = JSON.stringify([before.claude, before.chatgpt, before.local]) !== JSON.stringify([settings.claude, settings.chatgpt, settings.local])
    if (providersChanged || hubChanged) void refreshProviders()
    return settings
  },
  async refreshProviders() {
    await refreshProviders()
  },
  async providerLogin(provider) {
    const bin =
      provider === 'claude'
        ? findBinary('claude', settings.claude.cliPath)
        : findBinary('codex', settings.chatgpt.cliPath, ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'])
    if (!bin) return { ok: false, detail: 'The command line tool is not installed on this machine.' }
    const args = provider === 'claude' ? ['auth', 'login'] : ['login']
    // The CLI opens the browser for sign-in and exits when it completes.
    const code = await new Promise<number>((resolve) => {
      const child = spawnCli(bin, args, homedir())
      const timer = setTimeout(() => child.kill(), 5 * 60 * 1000)
      child.stdout.on('data', () => {})
      child.stderr.on('data', () => {})
      child.on('error', () => resolve(-1))
      child.on('close', (c) => {
        clearTimeout(timer)
        resolve(c ?? -1)
      })
    })
    if (provider === 'chatgpt') codex.dispose()
    else if (code === 0) claude.clearAuthFailure()
    await refreshProviders()
    const ready = !!statuses[provider]?.ready
    return { ok: ready, detail: ready ? 'Signed in.' : `Sign-in did not finish (exit ${code}). You can also run "${provider === 'claude' ? 'claude auth login' : 'codex login'}" in a terminal.` }
  },
  async getWorkspace(conversationId) {
    return runsOnHub(conversationId) ? remote.getWorkspace(conversationId) : engine.workspace(conversationId)
  },
  async setWorkspacePath(conversationId, path) {
    if (runsOnHub(conversationId)) return remote.setWorkspace(conversationId, path)
    const checked = checkFolder(path)
    if (checked.error) return { path: engine.workspace(conversationId), error: checked.error }
    engine.setWorkspace(conversationId, checked.path)
    return checked
  },
  async browseHubFolders(path) {
    return remote.listFolders(path)
  },
  async pickWorkspace(conversationId) {
    // A folder on the hub is chosen in the message box, not with this machine's own folder dialog.
    if (runsOnHub(conversationId)) return remote.getWorkspace(conversationId)
    let chosen = process.env.CHAUDECAL_E2E_WORKSPACE ?? ''
    if (!chosen && win) {
      const res = await dialog.showOpenDialog(win, { title: 'Choose a folder for this conversation', properties: ['openDirectory', 'createDirectory'] })
      chosen = res.canceled ? '' : (res.filePaths[0] ?? '')
    }
    if (chosen) engine.setWorkspace(conversationId, chosen)
    return engine.workspace(conversationId)
  },
  async clearWorkspace(conversationId) {
    if (runsOnHub(conversationId)) await remote.setWorkspace(conversationId, '')
    else engine.setWorkspace(conversationId, '')
  },
  async saveNote(note) {
    const now = Date.now()
    const existing = note.id ? store.get<MemoryNote>('note', note.id) : undefined
    const id = note.id ?? newId()
    store.put('note', id, { id, text: note.text, createdAt: existing?.createdAt ?? now, updatedAt: now } satisfies MemoryNote)
  },
  async deleteNote(id) {
    store.remove('note', id)
  },
  async savePrompt(prompt) {
    const now = Date.now()
    const existing = prompt.id ? store.get<SavedPrompt>('prompt', prompt.id) : undefined
    const id = prompt.id ?? newId()
    store.put('prompt', id, { id, title: prompt.title, text: prompt.text, createdAt: existing?.createdAt ?? now, updatedAt: now } satisfies SavedPrompt)
  },
  async saveProject(input) {
    const now = Date.now()
    const id = typeof input.id === 'string' && input.id ? input.id : newId()
    const existing = store.get<Project>('project', id)
    // Only the parts given change, so two quick edits never undo each other.
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) || 'Untitled project' : (existing?.name ?? 'New project')
    const instructions = typeof input.instructions === 'string' ? input.instructions.slice(0, 100_000) : (existing?.instructions ?? '')
    // Only text travels with a project. Pictures belong in a chat.
    const files = Array.isArray(input.files) ? input.files.filter((f) => f && f.kind === 'text' && typeof f.text === 'string').slice(0, 50) : (existing?.files ?? [])
    store.put('project', id, { id, name, instructions, files, createdAt: existing?.createdAt ?? now, updatedAt: now } satisfies Project)
    return id
  },
  async deleteProject(id) {
    for (const c of store.list<Conversation>('conversation')) if (c.projectId === id) engine.updateConversation(c.id, { projectId: undefined })
    store.remove('project', id)
  },
  async saveTask(input) {
    const now = Date.now()
    const id = typeof input.id === 'string' && input.id ? input.id : newId()
    const existing = store.get<ScheduledTask>('task', id)
    const schedule = input.schedule ? cleanSchedule(input.schedule) : (existing?.schedule ?? cleanSchedule(undefined))
    const providers = ['auto', 'claude', 'chatgpt', 'local']
    const task: ScheduledTask = {
      id,
      title: typeof input.title === 'string' ? input.title.trim().slice(0, 120) || 'Scheduled task' : (existing?.title ?? 'Scheduled task'),
      prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 20_000) : (existing?.prompt ?? ''),
      provider: typeof input.provider === 'string' && providers.includes(input.provider) ? input.provider : (existing?.provider ?? 'auto'),
      schedule,
      runOn: typeof input.runOn === 'string' && input.runOn ? input.runOn : (existing?.runOn ?? store.deviceId),
      enabled: typeof input.enabled === 'boolean' ? input.enabled : (existing?.enabled ?? true),
      conversationId: existing?.conversationId,
      lastRun: existing?.lastRun,
      // A changed schedule counts from now.
      nextRun: input.schedule || !existing ? nextRun(schedule, now) : existing.nextRun,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    if (task.enabled && task.nextRun === undefined) task.nextRun = nextRun(schedule, now)
    store.put('task', id, task)
    return id
  },
  async deleteTask(id) {
    store.remove('task', id)
  },
  async runTaskNow(id) {
    const task = store.get<ScheduledTask>('task', id)
    if (!task) return undefined
    await tasks.run(task)
    return store.get<ScheduledTask>('task', id)?.conversationId
  },
  async deletePrompt(id) {
    store.remove('prompt', id)
  },
  async saveProfile(instructions) {
    store.put('profile', 'profile', { id: 'profile', instructions, updatedAt: Date.now() } satisfies Profile)
  },
  async saveMcpServer(input) {
    const server = mcpFromInput(input)
    const problem = mcpProblem(
      server,
      mcpServers().filter((m) => m.id !== server.id)
    )
    if (problem) return { error: problem }
    store.put('mcp', server.id, server)
    return { id: server.id }
  },
  async mcpSignIn(id) {
    const server = mcpServers().find((m) => m.id === id)
    if (!server || server.kind !== 'url') return { error: 'Only a server with a web address can be signed in to.' }
    try {
      // Tests follow the sign-in page themselves instead of opening a browser.
      const open = process.env.CHAUDECAL_E2E_FETCH_SIGNIN ? async (address: string) => void (await fetch(address)) : (address: string) => shell.openExternal(address)
      const oauth = await mcpBrowserSignIn(server.url, open)
      const latest = store.get<McpServer>('mcp', id)
      if (latest) store.put('mcp', id, { ...latest, oauth })
      return {}
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  },
  async mcpSignOut(id) {
    const latest = store.get<McpServer>('mcp', id)
    if (latest?.oauth) store.put('mcp', id, { ...latest, oauth: undefined })
  },
  async deleteMcpServer(id) {
    store.remove('mcp', id)
  },
  async testMcpServer(input) {
    const server = mcpFromInput(input)
    const problem = mcpProblem(server, [])
    if (problem) return { ok: false, tools: [], error: problem }
    return testMcpServer(server, app.getVersion())
  },
  async addMessage(conversationId, text) {
    return engine.addUserMessage(String(conversationId), String(text ?? '')).id
  },
  async artifactView(html) {
    return previewUrl(html)
  },
  async saveArtifact(name, content) {
    return saveArtifact(win, name, content)
  },
  async hubDiscover() {
    return discoverHubs()
  },
  async hubNewToken() {
    const token = randomBytes(9).toString('base64url')
    await api.updateSettings({ hub: { token } })
    return token
  },
  async hubSyncNow() {
    await hubClient.syncNow()
    send('hub', hubStatus())
  },
  async openExternal(url) {
    // A test app writes the address down instead of opening the real browser.
    if (dataOverride) {
      appendFileSync(join(app.getPath('userData'), 'opened.log'), `${url}\n`)
      return
    }
    if (/^https?:\/\//i.test(url) || (process.platform === 'darwin' && url === MAC_LOCAL_NETWORK_SETTINGS)) await shell.openExternal(url)
  },
  async openConfig(which) {
    const dir = join(homedir(), which === 'claude' ? '.claude' : '.codex')
    const file = join(dir, which === 'claude' ? 'settings.json' : 'config.toml')
    await shell.openPath(existsSync(file) ? file : dir)
  },
  async webShow(service, bounds) {
    webTabs.show(service, bounds)
  },
  async webHide() {
    webTabs.hide()
  },
  async webNavigate(service, url) {
    webTabs.navigate(service, url)
  },
  async toggleQuick() {
    toggleQuick(PRELOAD)
  },
  async hideQuick() {
    hideQuick()
  },
  async quickAsk(text) {
    const question = String(text ?? '').trim()
    hideQuick()
    if (!question) return undefined
    const conv = engine.createConversation({})
    showWindow()
    send('open', conv.id)
    void api.send({ conversationId: conv.id, text: question }).catch(() => {})
    return conv.id
  },
  async captureSources() {
    return captureSources()
  },
  async captureSource(id) {
    const png = await captureSource(String(id), win ? [win] : [])
    if (!png) return { attachments: [], errors: ['The screen could not be captured. On a Mac, allow Chaude under System Settings, Privacy & Security, Screen Recording, then open it again.'] }
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')
    return attach([{ name: `Screenshot ${stamp}.png`, bytes: png }])
  },
  async transcribe(audio, mime) {
    const base = settings.local.speechUrl.trim().replace(/\/+$/, '')
    if (!base) return { error: 'No speech-to-text server is set up. Add one under Settings, Local AI.' }
    if (!(audio instanceof Uint8Array) || audio.length > 25 * 1024 * 1024) return { error: 'That recording is too long.' }
    try {
      const form = new FormData()
      const type = typeof mime === 'string' && /^audio\/[\w.+-]+(;.*)?$/.test(mime) ? mime : 'audio/webm'
      form.append('model', 'whisper-1')
      form.append('file', new Blob([new Uint8Array(audio)], { type }), type.includes('ogg') ? 'speech.ogg' : type.includes('mp4') ? 'speech.m4a' : 'speech.webm')
      const res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) })
      if (!res.ok) return { error: `The speech-to-text server answered ${res.status}.` }
      const body = (await res.json()) as { text?: unknown }
      return typeof body.text === 'string' ? { text: body.text.trim() } : { error: 'The speech-to-text server sent no text.' }
    } catch (e) {
      return { error: `The speech-to-text server could not be reached: ${e instanceof Error ? e.message : String(e)}` }
    }
  },
  async applyUpdate() {
    return updater.apply()
  },
  async webSignedIn(service) {
    return webTabs.signedIn(service)
  },
  async webSignIn(service) {
    const ok = await webTabs.signIn(service)
    // Signing in is the moment to bring the chats in, when the user has asked for that.
    if (ok && settings.webImport?.[service]) void webImporter.run(service)
    return ok
  },
  async webSignOut(service) {
    await webTabs.signOut(service)
  },
  async webImport(service) {
    if (service !== 'claude' && service !== 'chatgpt') throw new Error('Unknown site.')
    return webImporter.run(service)
  },
  async webAction(service, action) {
    webTabs.action(service, action)
  },
  async webCapture(service) {
    try {
      const page = await webTabs.capture(service)
      if (!page.turns.length) return { error: 'No conversation was found on that page. Open a chat first.' }
      const provider: ProviderId = service === 'claude' ? 'claude' : 'chatgpt'
      const title = page.title.replace(/\s*[-|]\s*(Claude|ChatGPT)\s*$/i, '').trim() || 'Imported chat'
      const conv = engine.createConversation({ title: `${title} (from web)`, provider })
      const base = Date.now()
      page.turns.forEach((t, i) => {
        const m: Message = { id: newId(), conversationId: conv.id, role: t.role, text: t.text, createdAt: base + i, deviceId: store.deviceId, status: 'complete', provider: t.role === 'assistant' ? provider : undefined }
        store.put('message', m.id, m)
      })
      engine.writeContextFiles(conv.id)
      return { conversationId: conv.id }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('command', 'settings') },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => send('command', 'new-chat') },
        { label: 'Search Chats', accelerator: 'CmdOrCtrl+K', click: () => send('command', 'search') },
        ...(isMac ? [] : [{ label: 'Settings', accelerator: 'Ctrl+,', click: () => send('command', 'settings') }]),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Started by the system at sign-in: stay in the background until asked for. */
let startHidden = false

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: 'Chaude',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1b1a' : '#faf9f6',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 16, y: 16 } } : { titleBarOverlay: { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#e8e6e1' : '#3d3a35', height: 44 } }),
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  win.once('ready-to-show', () => {
    if (!startHidden) win?.show()
    startHidden = false
  })
  win.on('close', (e) => {
    if (!hidesOnClose({ platform: process.platform, hosting: settings.hub.hostEnabled, keepRunning: settings.keepRunningInBackground, quitting })) return
    // This machine is the hub: keep serving the other devices from the tray.
    e.preventDefault()
    win?.hide()
  })
  win.on('focus', noticed)
  win.on('closed', () => {
    webTabs.dispose()
    win = undefined
  })
  // The window only ever shows this app. Links open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  guardFrames(win.webContents)
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    e.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.on('second-instance', () => {
  if (app.isReady()) showWindow()
})

app.whenReady().then(async () => {
  // Windows only shows notifications from an app that names itself the way its installer did.
  if (process.platform === 'win32') app.setAppUserModelId('com.doggo252.chaudecal')
  const dataDir = app.getPath('userData')
  mkdirSync(dataDir, { recursive: true })
  store = new Store(join(dataDir, 'chaudecal.db'))
  servePreviews()
  settings = loadSettings()
  nativeTheme.themeSource = settings.theme
  await loadShellPath()

  hubServer = new HubServer(
    store,
    () => settings,
    app.getVersion(),
    createRunHost(
      {
        send: async (input) => {
          await freshMcpSignIns()
          return engine.send(input)
        },
        stop: (id) => engine.stop(id),
        respondApproval: (c, m, a, d) => engine.respondApproval(c, m, a, d),
        workspace: (id) => engine.workspace(id),
        setWorkspace: (id, path) => engine.setWorkspace(id, path)
      },
      () => settings,
      () => statuses,
      () => store.list<Conversation>('conversation').filter((c) => engine.isBusy(c.id)).map((c) => c.id)
    ),
    {
      enabled: () => settings.hub.hostEnabled && settings.hub.webApp,
      staticDir: () => join(__dirname, '../renderer'),
      async call(method, args) {
        if (!(API_METHODS as readonly string[]).includes(method) || NOT_FROM_BROWSER.has(method)) throw new Error('That cannot be done from a browser. Do it on the hub machine itself.')
        return (api as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args.map(revive))
      },
      preview: (id) => previewPage(id),
      previewCsp: () => artifactCsp()
    }
  )
  let wasConnected = false
  hubClient = new HubClient(store, () => settings, () => {
    send('hub', hubStatus())
    // Each time the hub comes into reach, ask again what it allows and what it is running.
    const connected = !!hubClient.current()
    if (connected !== wasConnected) {
      wasConnected = connected
      void remote.refresh()
    }
  })
  remote = new RemoteRuns(hubClient, showRunEvent, (info) => send('remote', settings.hub.hostEnabled ? undefined : info))
  local = new LocalProvider(() => settings, hubClient)
  codex = new CodexProvider(() => settings, app.getVersion(), (limits) => engine?.recordLimits('chatgpt', limits))
  claude = new ClaudeProvider(() => settings, join(dataDir, 'tmp'), () => void refreshProviders())
  providers = { claude, chatgpt: codex, local }
  const summarizer = new Summarizer(store, () => settings, local)
  engine = new ChatEngine(
    store,
    () => settings,
    providers,
    () => statuses,
    // Every run is shown in this window, and on the hub it is also sent to the other devices.
    (() => {
      const both = (event: RunWireEvent) => {
        showRunEvent(event)
        hubServer.broadcastRun(event)
      }
      return {
        stream: (message) => both({ type: 'stream', message }),
        route: (conversationId, decision) => both({ type: 'route', conversationId, decision }),
        approval: (conversationId, messageId, request, settled) => both({ type: 'approval', conversationId, messageId, request, settled }),
        denials: (conversationId, messageId, denials) => both({ type: 'denials', conversationId, messageId, denials }),
        busy: (conversationId, busy) => {
          both({ type: 'busy', conversationId, busy })
          // After a Claude answer, its usage has moved.
          if (!busy && store.get<Conversation>('conversation', conversationId)?.provider !== 'chatgpt') setTimeout(() => void refreshClaudeUsage(), 3000)
        }
      }
    })(),
    { context: join(dataDir, 'context'), scratch: join(dataDir, 'workspace'), attachments: join(dataDir, 'attachments') },
    summarizer
  )
  webTabs = new WebTabs(() => win, (state) => send('web', state))
  updater = new Updater({
    dir: join(app.getPath('userData'), 'updates'),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    exePath: app.getPath('exe'),
    quit: () => {
      quitting = true
      app.quit()
    },
    onChange: (info) => send('update', info)
  })
  webImporter = new WebImporter(store, (service, path, headers) => webTabs.request(service, path, headers), (status) => send('webImport', status), { pauseMs: 300, backoffMs: 20000, origin: siteOrigin })
  // Image bytes stay in the backend. The window asks for one when it needs to show it.
  store.onChange((records) => send('records', records.filter((r) => r.kind !== 'blob')))
  // Codex keeps open conversations in one process, with the tool servers they were opened with.
  store.onChange((records) => {
    if (records.some((r) => r.kind === 'mcp')) codex.restartWhenIdle()
  })

  for (const name of API_METHODS) {
    ipcMain.handle(`api:${name}`, (_event, ...args: unknown[]) => (api[name] as (...a: unknown[]) => unknown)(...args))
  }

  buildMenu()
  startHidden = !dataOverride && startedHidden(process.argv, app.getLoginItemSettings().wasOpenedAtLogin)
  // Restarted by an update while its window was closed: stay in the background.
  try {
    const marker = startHiddenMarker()
    if (existsSync(marker)) {
      if (Date.now() - statSync(marker).mtimeMs < 15 * 60 * 1000) startHidden = true
      rmSync(marker, { force: true })
    }
  } catch {
    // Not worth failing the start over.
  }
  createWindow()
  showTray({
    open: showWindow,
    quit: () => app.quit(),
    status: () => (settings.hub.hostEnabled ? (hubServer.running ? 'Hub is running' : 'Hub is not running') : hubClient.status().connected ? 'Connected to the hub' : 'Not connected to a hub')
  })
  await applyHub()
  void refreshProviders()
  // Local runtimes come and go, and limits reset on their own schedule.
  setInterval(() => void refreshProviders(), 60_000)
  // Claude's usage percentages, every ten minutes.
  setTimeout(() => void refreshClaudeUsage(), 20_000)
  setInterval(() => void refreshClaudeUsage(), 10 * 60_000)
  // New versions are looked for every hour, and when the computer wakes up.
  void lookForUpdate()
  setInterval(() => void lookForUpdate(), 60 * 60 * 1000)
  powerMonitor.on('resume', () => setTimeout(() => void lookForUpdate(), 30_000))
  setInterval(restartForUpdateWhenAway, 60_000)
  tasks = new TaskRunner(
    store,
    {
      createConversation: (p) => engine.createConversation(p),
      // A task's run counts as started on this machine, so its answer is announced like any other.
      send: async (input) => {
        startedHere.set(input.conversationId, lastReply(input.conversationId)?.id)
        await freshMcpSignIns()
        return engine.send(input)
      },
      isBusy: (id) => engine.isBusy(id)
    },
    () => settings.hub.hostEnabled
  )
  // Scheduled tasks are checked every half minute. One missed while the app was closed runs once now.
  setInterval(() => void tasks.tick(), 30_000)
  // The quick ask shortcut. Tests leave the keyboard alone.
  if (!dataOverride) setQuickShortcut(settings.quickAsk, PRELOAD)
  setTimeout(() => void tasks.tick(), 5_000)
  // Bringing in chats from the websites waits a little, so starting up stays quick.
  setTimeout(importFromWebs, process.env.CHAUDECAL_USER_DATA ? 3_600_000 : 90_000)
  setInterval(importFromWebs, WEB_IMPORT_EVERY)

  app.on('activate', showWindow)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  // A downloaded update installs as the app quits, and the app stays closed.
  if (!installingOnQuit && !quitting && settings?.autoUpdate && updater?.ready) {
    installingOnQuit = true
    event.preventDefault()
    void updater.apply(false).then((r) => {
      if (r.error) app.quit()
    })
    return
  }
  quitting = true
  codex?.dispose()
  hubClient?.stop()
  shutdownDiscovery()
  void hubServer?.stop()
})
