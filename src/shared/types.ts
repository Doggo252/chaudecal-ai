// Types shared by the main process, the renderer and the hub.

export type ProviderId = 'claude' | 'chatgpt' | 'local'
export type ProviderChoice = ProviderId | 'auto'

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  local: 'Local AI'
}

/**
 * What the assistant may do on this machine.
 * chat: answer only, no tools.
 * plan: may read files in the workspace folder, changes nothing.
 * edit: may read and edit files in the workspace folder.
 * auto: may also run commands without asking.
 */
export type RunMode = 'chat' | 'plan' | 'edit' | 'auto'

export type HandoffVariant = 'summary' | 'full'

export interface ConversationSummary {
  text: string
  /** Last message covered by the summary. */
  uptoMessageId: string
  updatedAt: number
  /** Which engine wrote it: a local model, or the built-in extractive fallback. */
  source: 'local' | 'extractive'
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  provider: ProviderChoice
  /** Chosen model per provider. Empty string means the provider's own default. */
  models: Partial<Record<ProviderId, string>>
  mode: RunMode
  pinned?: boolean
  /** Keep this conversation on local AI only. */
  private?: boolean
  /** Run this conversation's assistants on the hub machine, whichever device the message is typed on. */
  runOnHub?: boolean
  summary?: ConversationSummary
}

export interface ToolCall {
  id: string
  name: string
  /** Short human readable description, for example the command or the file path. */
  summary: string
  status: 'running' | 'done' | 'error' | 'denied'
  output?: string
}

export interface MessageUsage {
  inputTokens: number
  outputTokens: number
}

export interface Message {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'note'
  text: string
  createdAt: number
  deviceId: string
  provider?: ProviderId
  model?: string
  thinking?: string
  tools?: ToolCall[]
  status: 'complete' | 'streaming' | 'error' | 'stopped'
  error?: { code: ErrorCode; message: string }
  usage?: MessageUsage
  /** Messages answering the same prompt in compare mode share a group id. */
  variantGroup?: string
  /** In a variant group, only the selected answer is part of the conversation. */
  selected?: boolean
  /** Files the user attached to this message. */
  attachments?: Attachment[]
}

/**
 * A file attached to a message. Text files carry their content, so it travels
 * with the conversation. Images are stored as a separate blob record with the
 * same id.
 */
export interface Attachment {
  id: string
  name: string
  mime: string
  size: number
  kind: 'image' | 'text'
  text?: string
}

/** The bytes of an image attachment. Synced like any other record. */
export interface Blob {
  id: string
  name: string
  mime: string
  base64: string
}

export const MAX_ATTACHMENTS = 8
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_TEXT_CHARS = 200_000

export type ErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'not_installed'
  | 'unreachable'
  | 'aborted'
  | 'unknown'

export interface MemoryNote {
  id: string
  text: string
  createdAt: number
  updatedAt: number
}

export interface SavedPrompt {
  id: string
  title: string
  text: string
  createdAt: number
  updatedAt: number
}

/** Personal instructions applied to every provider. Single record with id "profile". */
export interface Profile {
  id: 'profile'
  instructions: string
  updatedAt: number
}

// ---------- Usage ----------

export type LimitStatus = 'ok' | 'warning' | 'exhausted' | 'unknown'

export interface LimitWindow {
  /** 0 to 100 when the provider reports a number. */
  usedPct?: number
  status: LimitStatus
  /** Epoch milliseconds. */
  resetsAt?: number
}

export interface ProviderUsage {
  id: ProviderId
  provider: ProviderId
  fiveHour: LimitWindow
  weekly: LimitWindow
  /** Tokens this app has seen the provider use in the current 5-hour window. */
  tokensInWindow: number
  windowStartedAt: number
  updatedAt: number
}

// ---------- Sync records ----------

export type RecordKind = 'conversation' | 'message' | 'note' | 'prompt' | 'profile' | 'usage' | 'blob'

export interface SyncRecord<T = unknown> {
  kind: RecordKind
  id: string
  updatedAt: number
  deviceId: string
  deleted: boolean
  data: T
  /** Assigned by the hub. Missing on records that have not reached the hub yet. */
  seq?: number
}

// ---------- Settings (per machine, not synced) ----------

export interface LocalEndpoint {
  id: string
  name: string
  /** Base URL of an OpenAI compatible server, for example http://127.0.0.1:11434/v1 */
  baseUrl: string
  enabled: boolean
}

export interface Settings {
  deviceName: string
  theme: 'system' | 'light' | 'dark'
  /** Context budget for the running context file, in tokens. */
  contextBudgetTokens: number
  /** Percent of a limit used at which the app offers to switch. */
  warnThresholdPct: number
  defaultProvider: ProviderChoice
  defaultMode: RunMode
  /** contextTokens is the model window the plan gives you. The app never sends more than this. */
  claude: { cliPath: string; models: string[]; defaultModel: string; contextTokens: number }
  chatgpt: { cliPath: string; models: string[]; defaultModel: string; contextTokens: number }
  local: {
    /** Runtimes on this machine. On the hub these are shared with other devices. */
    endpoints: LocalEndpoint[]
    defaultModel: string
    /** Context window to assume for local models, in tokens. */
    contextTokens: number
    /** Use a local model to keep conversation summaries up to date. */
    summarize: boolean
  }
  hub: {
    /** This machine is the hub: it stores the master copy and shares its local AI. */
    hostEnabled: boolean
    port: number
    /** Secret that other devices need in order to connect. Generated on the hub. */
    token: string
    /** Address of the hub when this machine is a client, for example http://my-pc:47600 */
    remoteUrl: string
    remoteToken: string
    /** On the hub: paired devices may run Claude and ChatGPT here, including file edits and commands. */
    allowRemoteRuns: boolean
  }
  /** On a client: new conversations run on the hub when it allows that. */
  runOnHubByDefault: boolean
  routing: { preferLocalForShort: boolean }
  /** When a provider hits its limit mid-conversation, carry on with another one without asking. */
  autoFailover: boolean
  /** On the hub, closing the window keeps the app running in the background. */
  keepRunningInBackground: boolean
  startAtLogin: boolean
  checkForUpdates: boolean
  /** Show a system notification when a reply is ready or an assistant is waiting for an answer. */
  notifications: boolean
}

export const DEFAULT_HUB_PORT = 47600

export function defaultSettings(deviceName: string): Settings {
  return {
    deviceName,
    theme: 'system',
    contextBudgetTokens: 400_000,
    warnThresholdPct: 80,
    defaultProvider: 'auto',
    defaultMode: 'chat',
    claude: { cliPath: '', models: ['opus', 'sonnet', 'haiku'], defaultModel: '', contextTokens: 200_000 },
    chatgpt: { cliPath: '', models: [], defaultModel: '', contextTokens: 400_000 },
    local: {
      endpoints: [
        { id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true },
        { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', enabled: true }
      ],
      defaultModel: '',
      contextTokens: 16_000,
      summarize: true
    },
    hub: { hostEnabled: false, port: DEFAULT_HUB_PORT, token: '', remoteUrl: '', remoteToken: '', allowRemoteRuns: false },
    runOnHubByDefault: false,
    routing: { preferLocalForShort: false },
    autoFailover: false,
    keepRunningInBackground: true,
    startAtLogin: false,
    checkForUpdates: true,
    notifications: true
  }
}

// ---------- Provider status ----------

export interface ProviderStatus {
  provider: ProviderId
  /** The CLI or runtime was found. */
  installed: boolean
  /** Signed in (CLIs) or reachable (local). */
  ready: boolean
  detail: string
  version?: string
  models: string[]
}

export interface LocalModel {
  /** Model id as the runtime names it. */
  id: string
  endpointId: string
  endpointName: string
  /** 'direct' when the runtime is on this machine, 'hub' when it is reached through the hub. */
  via: 'direct' | 'hub'
}

export interface HubStatus {
  role: 'host' | 'client' | 'off'
  connected: boolean
  url: string
  detail: string
  lastSyncAt?: number
  pending: number
  /** Addresses other devices can use, shown on the hub. */
  addresses?: string[]
}

/** A newer build published on GitHub. */
export interface UpdateInfo {
  version: string
  build: number
  url: string
}

/** What a client knows about running assistants on its hub. */
export interface RemoteInfo {
  /** The hub allows paired devices to run assistants on it. */
  enabled: boolean
  deviceName: string
  platform: string
  providers: Partial<Record<ProviderId, ProviderStatus>>
  /** Conversations the hub is answering right now. */
  busy: string[]
}

/** Live progress of a run on the hub, sent to connected devices. */
export type RunWireEvent =
  | { type: 'stream'; message: Message }
  | { type: 'busy'; conversationId: string; busy: boolean }
  | { type: 'route'; conversationId: string; decision: RouteDecision }
  | { type: 'approval'; conversationId: string; messageId: string; request: ApprovalRequest; settled?: boolean }
  | { type: 'denials'; conversationId: string; messageId: string; denials: PermissionDenial[] }

export interface DiscoveredHub {
  name: string
  url: string
}

// ---------- Streaming events from a provider run ----------

export type RunEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool'; tool: ToolCall }
  | { type: 'session'; sessionId: string }
  | { type: 'model'; model: string }
  | { type: 'usage'; usage: MessageUsage }
  | { type: 'limits'; fiveHour?: Partial<LimitWindow>; weekly?: Partial<LimitWindow> }
  /** With `settled`, the request no longer needs an answer and its card should go away. */
  | { type: 'approval'; request: ApprovalRequest; settled?: boolean }
  /** The user allowed these rules for the rest of the conversation. */
  | { type: 'grant'; rules: string[] }
  | { type: 'denials'; denials: PermissionDenial[] }
  | { type: 'error'; code: ErrorCode; message: string }
  | { type: 'done' }

/** The assistant is waiting for the user to allow an action before it continues. */
export interface ApprovalRequest {
  id: string
  kind: 'command' | 'file' | 'other'
  summary: string
  reason?: string
  /** Name of the tool, shown when the request is neither a command nor a file change. */
  tool?: string
  /** Which assistant is asking. Filled in by the chat engine. */
  provider?: ProviderId
}

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline'

/** A tool the assistant tried to use but was not allowed to. */
export interface PermissionDenial {
  toolName: string
  summary: string
  /** Rule that would allow it, in the provider's own syntax. */
  rule: string
}

export interface RouteDecision {
  provider: ProviderId
  reason: string
}

export function newId(): string {
  // Sortable enough for display, unique enough across two machines.
  const rand = Array.from({ length: 10 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
  return `${Date.now().toString(36)}-${rand}`
}
