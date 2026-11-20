// The contract between the window (renderer) and the app's backend (main).

import type {
  Project,
  ScheduledTask,
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  Conversation,
  DiscoveredHub,
  FolderListing,
  HandoffVariant,
  HubStatus,
  LocalModel,
  McpServer,
  McpTestResult,
  MemoryNote,
  Message,
  PermissionDenial,
  Profile,
  ProviderChoice,
  ProviderId,
  ProviderStatus,
  ProviderUsage,
  RouteDecision,
  RemoteInfo,
  SavedPrompt,
  Settings,
  SyncRecord,
  UpdateInfo
} from './types'

export interface SendInput {
  conversationId: string
  text: string
  /** Use this provider for the turn instead of the conversation's setting. */
  provider?: ProviderId
  /** Which context file to send when the provider has to be caught up from scratch. */
  variant?: HandoffVariant
  /** Ask several providers the same thing and show the answers side by side. */
  compare?: ProviderId[]
  /** Answer the last user message again instead of adding a new one. */
  retry?: boolean
  /** Change this earlier question of the user's to `text`, drop everything after it, and answer it again. */
  edit?: string
  /** Extra permission rules the user just granted (Claude). */
  allow?: string[]
  /** Files to send with this message, as returned by pickAttachments or addAttachment. */
  attachments?: Attachment[]
}

/** A tool server as the settings page sends it. Without an id it is a new one. */
export type McpInput = Pick<McpServer, 'name' | 'kind' | 'command' | 'args' | 'env' | 'url' | 'headers'> & Partial<Pick<McpServer, 'id' | 'enabled' | 'trusted' | 'offOn'>>

export interface AttachResult {
  attachments: Attachment[]
  /** One line per file that could not be attached. */
  errors: string[]
}

export interface SearchHit {
  conversationId: string
  messageId?: string
  title: string
  snippet: string
  createdAt: number
}

export interface HandoffInfo {
  variant: HandoffVariant
  tokens: number
  totalMessages: number
  verbatimMessages: number
  condensed: boolean
  text: string
  /** Where the summary came from, when the variant has one. */
  summarySource?: 'local' | 'extractive'
}

export type WebService = 'claude' | 'chatgpt'

/** How bringing in chats from one of the websites is going, on this machine. */
export interface WebImportStatus {
  service: WebService
  state: 'idle' | 'running' | 'done' | 'signed-out' | 'error'
  /** While running: chats looked at so far, and how many the site has. */
  done?: number
  of?: number
  /** Chats added or updated by the last run. */
  changed?: number
  /** Chats from this site in the app. */
  count: number
  /** When the last run finished. */
  lastRun?: number
  message?: string
}

export interface WebState {
  service: WebService
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

export interface AppState {
  deviceId: string
  platform: string
  version: string
  settings: Settings
  conversations: Conversation[]
  notes: MemoryNote[]
  prompts: SavedPrompt[]
  /** Tool servers (MCP) that Claude and ChatGPT share. */
  mcp: McpServer[]
  projects: Project[]
  tasks: ScheduledTask[]
  profile: Profile
  usage: Record<ProviderId, ProviderUsage>
  providers: Partial<Record<ProviderId, ProviderStatus>>
  localModels: LocalModel[]
  hub: HubStatus
  busy: string[]
  update?: UpdateInfo
  /** Present on a client that is connected to a hub. */
  remote?: RemoteInfo
  /** A conversation to show straight away, because its notification was clicked while no window was open. */
  open?: string
  webImport: Record<WebService, WebImportStatus>
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] }

/** Events pushed from the backend to the window. */
export interface AppEvents {
  records: SyncRecord[]
  stream: Message
  busy: { conversationId: string; busy: boolean }
  route: { conversationId: string; decision: RouteDecision }
  approval: { conversationId: string; messageId: string; request: ApprovalRequest; settled?: boolean }
  denials: { conversationId: string; messageId: string; denials: PermissionDenial[] }
  providers: { providers: Partial<Record<ProviderId, ProviderStatus>>; localModels: LocalModel[] }
  hub: HubStatus
  settings: Settings
  web: WebState
  update: UpdateInfo
  remote: RemoteInfo | undefined
  command: 'new-chat' | 'search' | 'settings' | 'quick-focus'
  /** Show this conversation. Sent when its notification is clicked. */
  open: string
  webImport: WebImportStatus
}

export interface Api {
  state(): Promise<AppState>
  messages(conversationId: string): Promise<Message[]>
  createConversation(partial?: Partial<Conversation>): Promise<Conversation>
  updateConversation(id: string, patch: Partial<Conversation>): Promise<void>
  deleteConversation(id: string): Promise<void>

  send(input: SendInput): Promise<void>
  stop(conversationId: string): Promise<void>
  respondApproval(conversationId: string, messageId: string, approvalId: string, decision: ApprovalDecision): Promise<void>
  selectVariant(messageId: string): Promise<void>
  /** Copy the conversation up to and including a message into a new one. */
  branchConversation(conversationId: string, messageId: string): Promise<Conversation | undefined>

  /** Let the user choose files to attach. */
  pickAttachments(): Promise<AttachResult>
  /** Attach a pasted or dropped file. */
  addAttachment(file: { name: string; base64: string }): Promise<AttachResult>
  /** An image attachment as a data URL, for display. */
  attachmentUrl(id: string): Promise<string | undefined>
  /** Forget an attachment that was added but never sent. */
  discardAttachment(id: string): Promise<void>

  switchProvider(conversationId: string, to: ProviderChoice): Promise<void>

  handoffPreview(conversationId: string, variant: HandoffVariant, target?: ProviderId): Promise<HandoffInfo | undefined>
  revealContext(conversationId: string): Promise<void>
  copyContext(conversationId: string, variant: HandoffVariant): Promise<void>

  search(query: string): Promise<SearchHit[]>

  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>
  refreshProviders(): Promise<void>
  providerLogin(provider: 'claude' | 'chatgpt'): Promise<{ ok: boolean; detail: string }>

  getWorkspace(conversationId: string): Promise<string>
  pickWorkspace(conversationId: string): Promise<string>
  clearWorkspace(conversationId: string): Promise<void>
  /** Set the working folder by typing its path. Used for conversations that run on the hub. */
  setWorkspacePath(conversationId: string, path: string): Promise<{ path: string; error?: string }>
  /** The folders inside a folder on the hub, for choosing one from this device. Without a path, the hub's home folder. */
  browseHubFolders(path?: string): Promise<FolderListing>

  saveNote(note: { id?: string; text: string }): Promise<void>
  deleteNote(id: string): Promise<void>
  savePrompt(prompt: { id?: string; title: string; text: string }): Promise<void>
  /** Adds a project, or changes only the given parts of one. Gives back its id. */
  saveProject(project: { id?: string; name?: string; instructions?: string; files?: Attachment[] }): Promise<string>
  /** Deletes a project. Its chats stay, outside any project. */
  deleteProject(id: string): Promise<void>
  /** Adds a scheduled task, or changes the given parts of one. Gives back its id. */
  saveTask(task: Partial<Pick<ScheduledTask, 'id' | 'title' | 'prompt' | 'provider' | 'schedule' | 'runOn' | 'enabled'>>): Promise<string>
  deleteTask(id: string): Promise<void>
  /** Runs a task now. Gives back the chat it ran in. */
  runTaskNow(id: string): Promise<string | undefined>
  deletePrompt(id: string): Promise<void>
  saveProfile(instructions: string): Promise<void>

  /** Add or change a tool server. Gives back why it could not be saved, if so. */
  saveMcpServer(server: McpInput): Promise<{ id?: string; error?: string }>
  deleteMcpServer(id: string): Promise<void>
  /** Connect to a tool server from this device and list its tools. */
  testMcpServer(server: McpInput): Promise<McpTestResult>
  /** Signs in to a hosted tool server through the browser. */
  mcpSignIn(id: string): Promise<{ error?: string }>
  mcpSignOut(id: string): Promise<void>

  /** Keeps a preview page for an artifact and gives back the address its frame loads. */
  artifactView(html: string): Promise<string>
  /** Saves an artifact to a file the user picks. Gives back the path, or an empty string when cancelled. */
  saveArtifact(name: string, content: string): Promise<string>

  hubDiscover(): Promise<DiscoveredHub[]>
  hubNewToken(): Promise<string>
  hubSyncNow(): Promise<void>

  openExternal(url: string): Promise<void>
  /** Opens or closes the quick ask box. */
  toggleQuick(): Promise<void>
  /** From the quick ask box: starts a chat with this question, and shows it in the main window. */
  quickAsk(text: string): Promise<string | undefined>
  hideQuick(): Promise<void>
  /** Screens and windows that can be captured. */
  captureSources(): Promise<{ id: string; name: string; kind: 'screen' | 'window'; thumb: string }[]>
  /** Captures one of them and attaches the picture. */
  captureSource(id: string): Promise<AttachResult>
  /** Turns recorded speech into text with the speech-to-text server in the settings. */
  transcribe(audio: Uint8Array, mime: string): Promise<{ text?: string; error?: string }>
  /** Downloads the newer version if needed, installs it, and restarts into it. */
  applyUpdate(): Promise<{ error?: string }>
  openConfig(which: 'claude' | 'chatgpt'): Promise<void>

  webShow(service: WebService, bounds: { x: number; y: number; width: number; height: number }): Promise<void>
  webHide(): Promise<void>
  webNavigate(service: WebService, url: string): Promise<void>
  /** Bring in this site's chats now, through its website tab's sign-in. */
  webImport(service: WebService): Promise<WebImportStatus>
  webAction(service: WebService, action: 'back' | 'forward' | 'reload' | 'home'): Promise<void>
  /** Copy the chat currently open in a web tab into a new conversation in this app. */
  webCapture(service: WebService): Promise<{ conversationId?: string; error?: string }>

  on<K extends keyof AppEvents>(channel: K, listener: (payload: AppEvents[K]) => void): () => void
}

export const API_METHODS = [
  'state',
  'messages',
  'createConversation',
  'updateConversation',
  'deleteConversation',
  'send',
  'stop',
  'respondApproval',
  'selectVariant',
  'branchConversation',
  'pickAttachments',
  'addAttachment',
  'attachmentUrl',
  'discardAttachment',
  'switchProvider',
  'handoffPreview',
  'revealContext',
  'copyContext',
  'search',
  'updateSettings',
  'refreshProviders',
  'providerLogin',
  'getWorkspace',
  'pickWorkspace',
  'clearWorkspace',
  'setWorkspacePath',
  'browseHubFolders',
  'saveNote',
  'deleteNote',
  'savePrompt',
  'saveProject',
  'deleteProject',
  'saveTask',
  'deleteTask',
  'runTaskNow',
  'deletePrompt',
  'saveProfile',
  'saveMcpServer',
  'deleteMcpServer',
  'testMcpServer',
  'mcpSignIn',
  'mcpSignOut',
  'artifactView',
  'saveArtifact',
  'hubDiscover',
  'hubNewToken',
  'hubSyncNow',
  'openExternal',
  'applyUpdate',
  'transcribe',
  'toggleQuick',
  'quickAsk',
  'hideQuick',
  'captureSources',
  'captureSource',
  'openConfig',
  'webShow',
  'webHide',
  'webNavigate',
  'webImport',
  'webAction',
  'webCapture'
] as const satisfies readonly Exclude<keyof Api, 'on'>[]

export const EVENT_CHANNELS = ['records', 'stream', 'busy', 'route', 'approval', 'denials', 'providers', 'hub', 'settings', 'web', 'update', 'remote', 'command', 'open', 'webImport'] as const satisfies readonly (keyof AppEvents)[]
