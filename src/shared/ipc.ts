// The contract between the window (renderer) and the app's backend (main).

import type {
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  Conversation,
  DiscoveredHub,
  HandoffVariant,
  HubStatus,
  LocalModel,
  MemoryNote,
  Message,
  PermissionDenial,
  Profile,
  ProviderChoice,
  ProviderId,
  ProviderStatus,
  ProviderUsage,
  RouteDecision,
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
  /** Extra permission rules the user just granted (Claude). */
  allow?: string[]
  /** Files to send with this message, as returned by pickAttachments or addAttachment. */
  attachments?: Attachment[]
}

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
  profile: Profile
  usage: Record<ProviderId, ProviderUsage>
  providers: Partial<Record<ProviderId, ProviderStatus>>
  localModels: LocalModel[]
  hub: HubStatus
  busy: string[]
  update?: UpdateInfo
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] }

/** Events pushed from the backend to the window. */
export interface AppEvents {
  records: SyncRecord[]
  stream: Message
  busy: { conversationId: string; busy: boolean }
  route: { conversationId: string; decision: RouteDecision }
  approval: { conversationId: string; messageId: string; request: ApprovalRequest }
  denials: { conversationId: string; messageId: string; denials: PermissionDenial[] }
  providers: { providers: Partial<Record<ProviderId, ProviderStatus>>; localModels: LocalModel[] }
  hub: HubStatus
  settings: Settings
  web: WebState
  update: UpdateInfo
  command: 'new-chat' | 'search' | 'settings'
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

  saveNote(note: { id?: string; text: string }): Promise<void>
  deleteNote(id: string): Promise<void>
  savePrompt(prompt: { id?: string; title: string; text: string }): Promise<void>
  deletePrompt(id: string): Promise<void>
  saveProfile(instructions: string): Promise<void>

  hubDiscover(): Promise<DiscoveredHub[]>
  hubNewToken(): Promise<string>
  hubSyncNow(): Promise<void>

  openExternal(url: string): Promise<void>
  openConfig(which: 'claude' | 'chatgpt'): Promise<void>

  webShow(service: WebService, bounds: { x: number; y: number; width: number; height: number }): Promise<void>
  webHide(): Promise<void>
  webNavigate(service: WebService, url: string): Promise<void>
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
  'saveNote',
  'deleteNote',
  'savePrompt',
  'deletePrompt',
  'saveProfile',
  'hubDiscover',
  'hubNewToken',
  'hubSyncNow',
  'openExternal',
  'openConfig',
  'webShow',
  'webHide',
  'webNavigate',
  'webAction',
  'webCapture'
] as const satisfies readonly Exclude<keyof Api, 'on'>[]

export const EVENT_CHANNELS = ['records', 'stream', 'busy', 'route', 'approval', 'denials', 'providers', 'hub', 'settings', 'web', 'update', 'command'] as const satisfies readonly (keyof AppEvents)[]
