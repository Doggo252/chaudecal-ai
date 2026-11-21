import type { ModelInfo } from './models'
import type { FileDiff } from './diff'
import type { TaskSchedule } from './schedule'

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
  /** Brought in from the user's history on claude.ai or chatgpt.com. */
  source?: ConversationSource
  /** The project this chat belongs to. */
  projectId?: string
  /**
   * A regular chat lives on claude.ai or chatgpt.com: messages go through the
   * site, so it stays in step with the Claude and ChatGPT apps everywhere. A code
   * chat runs Claude Code or Codex on this computer and syncs between the
   * devices that run this app. Chats from the sites are regular chats.
   */
  kind?: ConversationKind
  /** How hard the model thinks before answering, as the tool names it (low, medium, high and so on). Empty means the model's own default. */
  effort?: string
  /** Brought in from a Claude Code or Codex session on one of the user's computers. */
  origin?: {
    tool: 'claude-code' | 'codex'
    sessionId: string
    device: string
    /** The name the tool gave it, as last read. A different title means it was renamed in the app. */
    toolTitle?: string
    /** The folder it ran in, on that device. */
    folder?: string
  }
}

export type ConversationKind = 'chat' | 'code'

/** Which kind a conversation is, for conversations saved before kinds existed. */
export function kindOf(c: Pick<Conversation, 'kind' | 'source'>): ConversationKind {
  return c.kind ?? (c.source ? 'chat' : 'code')
}

export interface ConversationSource {
  service: 'claude' | 'chatgpt'
  /** The chat's id on the site. */
  remoteId: string
  url: string
  /** When the site last changed the chat, as of the last import. Unchanged chats are not fetched again. */
  remoteUpdatedAt: number
  /** The title on the site at the last import. A title changed in the app is kept. */
  remoteTitle: string
  /** Which version of the app's reader brought it in. An older one means it is read again. */
  reader?: number
}

export interface ToolCall {
  id: string
  name: string
  /** Short human readable description, for example the command or the file path. */
  summary: string
  status: 'running' | 'done' | 'error' | 'denied'
  output?: string
  /** What sort of step it is, so steps of one sort can be shown together. */
  kind?: ToolKind
  /** For a file edit: what changed, file by file. */
  diff?: FileDiff[]
}

export type ToolKind = 'command' | 'read' | 'search' | 'edit' | 'web' | 'agent' | 'tool' | 'other'

/** One step of the assistant's own plan for the turn. */
export interface PlanStep {
  text: string
  status: 'pending' | 'active' | 'done'
  /** The tool's own number for the task, where it ticks tasks off by number. */
  id?: string
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
  /** The assistant's checklist for this reply, as it last stood. */
  plan?: PlanStep[]
  /** The user asked for research: a broad web search and a report with sources. */
  research?: boolean
  /** Pictures the assistant made in this reply. Their bytes are blob records, like attached images. */
  images?: Attachment[]
  /** In a regular chat: this turn was done on the user's computer, not on the website, so the site does not have it. */
  onComputer?: boolean
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
  /** For a PDF: how many pages it has. Its text is carried like a text file's. */
  pages?: number
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
/** The largest file that is read at all. PDFs can be this big; images have their own, smaller limit. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024
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
/** A prompt that runs by itself on a schedule, into its own chat. Synced; runs on one machine. */
export interface ScheduledTask {
  id: string
  title: string
  prompt: string
  provider: ProviderChoice
  schedule: TaskSchedule
  /** The device that runs it: a device id, or "hub" for whichever machine is the hub. */
  runOn: string
  enabled: boolean
  /** The chat its runs go into. Made on the first run. */
  conversationId?: string
  lastRun?: number
  nextRun?: number
  createdAt: number
  updatedAt: number
}

/** A project: its own instructions and files, given to every assistant in its chats. Synced. */
export interface Project {
  id: string
  name: string
  instructions: string
  /** Text files, PDFs included as their text. */
  files: Attachment[]
  createdAt: number
  updatedAt: number
  /** Chat projects hold regular chats and code projects hold code chats. They never mix. */
  kind?: ProjectKind
  /** A code project's folder, on the computer that made it. Code chats started in the project work there. */
  folder?: string
  /** Kept at the top of the sidebar. */
  pinned?: boolean
}

export type ProjectKind = ConversationKind

/** Which tab a project belongs in. Projects saved before kinds existed are chat projects, except folder projects. */
export function projectKindOf(p: Pick<Project, 'kind' | 'id'>): ProjectKind {
  return p.kind ?? (p.id.startsWith('code-') ? 'code' : 'chat')
}

/** The last part of a folder path, on any computer. */
export function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
}

/** The code project for folders of this name. The same project on a Mac and a PC lands in one project. */
export function folderProjectId(path: string): string {
  const slug = folderName(path)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug ? `code-folder-${slug}` : ''
}

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

export type RecordKind = 'conversation' | 'message' | 'note' | 'prompt' | 'profile' | 'usage' | 'blob' | 'mcp' | 'project' | 'task'

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

// ---------- Tool servers (MCP), synced ----------

/**
 * A tool server that speaks the Model Context Protocol. Claude and ChatGPT both use the same list.
 * The server is started (or called) by the machine that runs the assistant.
 */
/** A browser sign-in to a hosted tool server: the token, and what is needed to renew it. */
export interface McpOAuth {
  accessToken: string
  refreshToken?: string
  /** When the token runs out, if the server said. */
  expiresAt?: number
  tokenEndpoint: string
  clientId: string
  clientSecret?: string
  resource: string
  scope?: string
}

export interface McpServer {
  id: string
  /** Short name the assistants see, for example "github". Letters, digits, "_" and "-". */
  name: string
  /** 'command': a program started on the machine. 'url': a server reached over HTTP. */
  kind: 'command' | 'url'
  command: string
  args: string[]
  /** Environment variables for a command. */
  env: Record<string, string>
  url: string
  /** Request headers for a URL, for example Authorization. */
  headers: Record<string, string>
  enabled: boolean
  /** Its tools run without asking first. */
  trusted: boolean
  /** Ids of the devices on which this server is switched off. */
  offOn: string[]
  createdAt: number
  /** A sign-in made through the browser, for a hosted server that asks for one. Synced like the headers. */
  oauth?: McpOAuth
}

export interface McpTool {
  name: string
  description: string
  /** The server says this tool only reads. */
  readOnly: boolean
}

/** What came back when the app tried to reach a tool server itself. */
export interface McpTestResult {
  ok: boolean
  /** What the server calls itself. */
  serverName?: string
  tools: McpTool[]
  error?: string
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
  /** The accent color: 'default', the id of a preset such as 'blue', or a color written #rrggbb. */
  accent: string
  /** How large the text is drawn. */
  textSize: 'small' | 'default' | 'large' | 'larger'
  /** Ask the assistants to put pages, components, diagrams and documents in artifacts, which open in a side panel. */
  artifacts: boolean
  /** In code chats, ask the assistant for the smallest change that fully does the job (Ponytail), to use less of the plan's limits. */
  ponytail: boolean
  /** Keep bringing in chats from claude.ai and chatgpt.com, through the sign-ins in the website tabs on this machine. */
  webImport: { claude: boolean; chatgpt: boolean }
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
    /** A speech-to-text server on this machine or the network that speaks the OpenAI transcription API, for dictation. Empty when there is none. */
    speechUrl: string
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
    /** On the hub: the app can be used from a phone or a browser at this machine's address, /app. */
    webApp: boolean
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
  /** Download a newer version in the background, ready to install with one click. */
  autoUpdate: boolean
  /** Option+Space (Alt+Space on Windows) opens a small box to ask something from anywhere. */
  quickAsk: boolean
  /** Bring the Claude Code and Codex sessions on this computer into the Code tab. */
  localSessions: boolean
  /** Show a system notification when a reply is ready or an assistant is waiting for an answer. */
  notifications: boolean
}

export const DEFAULT_HUB_PORT = 47600

export function defaultSettings(deviceName: string): Settings {
  return {
    deviceName,
    theme: 'system',
    accent: 'default',
    textSize: 'default',
    artifacts: true,
    ponytail: true,
    webImport: { claude: false, chatgpt: false },
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
      summarize: true,
      speechUrl: ''
    },
    hub: { hostEnabled: false, port: DEFAULT_HUB_PORT, token: '', remoteUrl: '', remoteToken: '', allowRemoteRuns: false, webApp: false },
    runOnHubByDefault: false,
    routing: { preferLocalForShort: false },
    autoFailover: false,
    keepRunningInBackground: true,
    startAtLogin: false,
    checkForUpdates: true,
    autoUpdate: true,
    quickAsk: true,
    localSessions: true,
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
  /** The plan's models with names, descriptions and thinking levels, as the tool reports them. */
  catalog?: ModelInfo[]
  /** The tool's own commands, like /usage or /compact. */
  commands?: { name: string; description: string }[]
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
  /** On a Mac client: macOS is keeping the app off the home network (Local Network privacy). */
  blocked?: 'local-network'
}

/** The page of the Mac's System Settings where an app is let onto the home network. */
export const MAC_LOCAL_NETWORK_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork'

/** A newer build published on GitHub. */
export interface UpdateInfo {
  version: string
  build: number
  /** The release page. */
  url: string
  /** The release's files. */
  assets?: ReleaseAsset[]
  /** Set once this machine knows what it can do with the update. */
  state?: 'available' | 'downloading' | 'ready' | 'error'
  /** This machine can download and install it by itself. Otherwise the release page is opened. */
  canInstall?: boolean
  /** While downloading, from 0 to 1. */
  progress?: number
  message?: string
}

export interface ReleaseAsset {
  name: string
  url: string
  size: number
  /** For example "sha256:...", as GitHub reports it. */
  digest?: string
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

/** One folder in a listing of the hub's folders. */
export interface FolderEntry {
  name: string
  path: string
}

/** The folders inside one folder on the hub, for choosing a working folder from another device. */
export interface FolderListing {
  /** The folder that was listed. Empty when it could not be. */
  path: string
  /** The folder above it. Absent at the top. */
  parent?: string
  folders: FolderEntry[]
  /** Starting points: the home folder, the usual folders inside it, and the drives. */
  places: FolderEntry[]
  /** There were more folders than are listed. */
  truncated?: boolean
  error?: string
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
  | { type: 'plan'; steps: PlanStep[] }
  /** A picture the assistant made, as base64. */
  | { type: 'image'; base64: string; mime: string; prompt?: string }
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
