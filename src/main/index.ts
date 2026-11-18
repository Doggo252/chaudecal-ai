import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import type { Attachment, Blob, Conversation, HubStatus, LocalModel, MemoryNote, Message, Profile, ProviderId, ProviderStatus, SavedPrompt, Settings, UpdateInfo } from '@shared/types'
import { defaultSettings, MAX_IMAGE_BYTES, newId } from '@shared/types'
import { API_METHODS, type Api, type AppEvents, type AppState, type AttachResult, type DeepPartial, type HandoffInfo } from '@shared/ipc'
import { Store } from './store'
import { findBinary, loadShellPath, spawnCli } from './env'
import { ClaudeProvider } from './providers/claude'
import { CodexProvider } from './providers/codex'
import { LocalProvider } from './providers/local'
import type { Provider } from './providers/types'
import { HubServer, localAddresses } from './sync/hubServer'
import { HubClient } from './sync/hubClient'
import { announceHub, discoverHubs, shutdownDiscovery, stopAnnouncing } from './sync/discovery'
import { ChatEngine } from './chat'
import { Summarizer } from './summarizer'
import { WebTabs } from './webtabs'
import { makeAttachment } from './attachments'
import { applyStartAtLogin, hidesOnClose, showTray, startedHidden } from './background'
import { checkForUpdate } from './updates'

/** Set by the build on GitHub. Zero for a build made on a developer's machine. */
declare const __BUILD_NUMBER__: number

// Tests and side-by-side instances point the app at their own data folder.
const dataOverride = process.env.CHAUDECAL_USER_DATA
if (dataOverride) app.setPath('userData', dataOverride)
else if (!app.requestSingleInstanceLock()) app.quit()

let win: BrowserWindow | undefined
let store: Store
let settings: Settings
let engine: ChatEngine
let hubServer: HubServer
let hubClient: HubClient
let webTabs: WebTabs
let local: LocalProvider
let codex: CodexProvider
let claude: ClaudeProvider
let providers: Record<ProviderId, Provider>
let statuses: Partial<Record<ProviderId, ProviderStatus>> = {}
let localModels: LocalModel[] = []
let hubError = ''
let update: UpdateInfo | undefined
let quitting = false

/** Turn chosen, pasted or dropped files into attachments, storing image bytes as they come in. */
function attach(files: { name: string; bytes: Buffer }[]): AttachResult {
  const result: AttachResult = { attachments: [], errors: [] }
  for (const file of files) {
    const outcome = makeAttachment(file.name, file.bytes)
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
      // Nothing larger than the biggest image is ever useful, so do not read it into memory.
      if (statSync(path).size > MAX_IMAGE_BYTES) errors.push(`${basename(path)} is too large to attach.`)
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
  const found = await checkForUpdate({ version: app.getVersion(), build }, override || undefined)
  if (found && found.build !== update?.build) {
    update = found
    send('update', found)
  }
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

let refreshing: Promise<void> | undefined
function refreshProviders(): Promise<void> {
  refreshing ??= (async () => {
    const [c, g, l] = await Promise.all([providers.claude.status(), providers.chatgpt.status(), providers.local.status()])
    statuses = { claude: c, chatgpt: g, local: l }
    localModels = await local.models()
    send('providers', { providers: statuses, localModels })
  })().finally(() => (refreshing = undefined))
  return refreshing
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
    profile: store.get<Profile>('profile', 'profile') ?? { id: 'profile', instructions: '', updatedAt: 0 },
    usage: engine.allUsage(),
    providers: statuses,
    localModels,
    hub: hubStatus(),
    busy: store.list<Conversation>('conversation').filter((c) => engine.isBusy(c.id)).map((c) => c.id),
    update
  }
}

const api: Omit<Api, 'on'> = {
  async state() {
    return appState()
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
    await engine.send(input)
  },
  async stop(conversationId) {
    engine.stop(conversationId)
  },
  async respondApproval(conversationId, messageId, approvalId, decision) {
    engine.respondApproval(conversationId, messageId, approvalId, decision)
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
    const result = attach(files)
    return { attachments: result.attachments, errors: [...errors, ...result.errors] }
  },
  async addAttachment(file) {
    if (typeof file?.base64 !== 'string' || file.base64.length > MAX_IMAGE_BYTES * 1.4) return { attachments: [], errors: ['That file is too large to attach.'] }
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
    store.kvSet('settings', settings)
    nativeTheme.themeSource = settings.theme
    send('settings', settings)
    const hubChanged = JSON.stringify(before.hub) !== JSON.stringify(settings.hub) || before.deviceName !== settings.deviceName
    if (hubChanged) await applyHub()
    if (before.startAtLogin !== settings.startAtLogin && !dataOverride) applyStartAtLogin(settings.startAtLogin)
    if (!before.checkForUpdates && settings.checkForUpdates) void lookForUpdate()
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
    return engine.workspace(conversationId)
  },
  async pickWorkspace(conversationId) {
    let chosen = process.env.CHAUDECAL_E2E_WORKSPACE ?? ''
    if (!chosen && win) {
      const res = await dialog.showOpenDialog(win, { title: 'Choose a folder for this conversation', properties: ['openDirectory', 'createDirectory'] })
      chosen = res.canceled ? '' : (res.filePaths[0] ?? '')
    }
    if (chosen) engine.setWorkspace(conversationId, chosen)
    return engine.workspace(conversationId)
  },
  async clearWorkspace(conversationId) {
    engine.setWorkspace(conversationId, '')
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
  async deletePrompt(id) {
    store.remove('prompt', id)
  },
  async saveProfile(instructions) {
    store.put('profile', 'profile', { id: 'profile', instructions, updatedAt: Date.now() } satisfies Profile)
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
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
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
    title: 'Chaudecal AI',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1b1a' : '#faf9f6',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 16, y: 16 } } : { titleBarOverlay: { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#e8e6e1' : '#3d3a35', height: 44 } }),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
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
  win.on('closed', () => {
    webTabs.dispose()
    win = undefined
  })
  // The window only ever shows this app. Links open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
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
  const dataDir = app.getPath('userData')
  mkdirSync(dataDir, { recursive: true })
  store = new Store(join(dataDir, 'chaudecal.db'))
  settings = loadSettings()
  nativeTheme.themeSource = settings.theme
  await loadShellPath()

  hubServer = new HubServer(store, () => settings, app.getVersion())
  hubClient = new HubClient(store, () => settings, () => send('hub', hubStatus()))
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
    {
      stream: (message) => send('stream', message),
      route: (conversationId, decision) => send('route', { conversationId, decision }),
      approval: (conversationId, messageId, request) => send('approval', { conversationId, messageId, request }),
      denials: (conversationId, messageId, denials) => send('denials', { conversationId, messageId, denials }),
      busy: (conversationId, busy) => send('busy', { conversationId, busy })
    },
    { context: join(dataDir, 'context'), scratch: join(dataDir, 'workspace'), attachments: join(dataDir, 'attachments') },
    summarizer
  )
  webTabs = new WebTabs(() => win, (state) => send('web', state))
  // Image bytes stay in the backend. The window asks for one when it needs to show it.
  store.onChange((records) => send('records', records.filter((r) => r.kind !== 'blob')))

  for (const name of API_METHODS) {
    ipcMain.handle(`api:${name}`, (_event, ...args: unknown[]) => (api[name] as (...a: unknown[]) => unknown)(...args))
  }

  buildMenu()
  startHidden = !dataOverride && startedHidden(process.argv, app.getLoginItemSettings().wasOpenedAtLogin)
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
  void lookForUpdate()
  setInterval(() => void lookForUpdate(), 6 * 60 * 60 * 1000)

  app.on('activate', showWindow)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
  codex?.dispose()
  hubClient?.stop()
  shutdownDiscovery()
  void hubServer?.stop()
})
