// ChatGPT, through the Codex CLI's app-server mode and the user's ChatGPT plan
// sign-in. One long-lived process serves every conversation. It speaks
// newline-delimited JSON-RPC on stdio and provides streaming text, approvals,
// the model list and the plan's 5-hour and weekly limit numbers.

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir } from 'node:os'
import { codexMcpConfig, mcpToolLabel } from '@shared/mcp'
import type { ApprovalDecision, LimitWindow, ProviderStatus, RunEvent, RunMode, Settings, ToolCall } from '@shared/types'
import { limitsFromCodex, type CodexRateLimitSnapshot } from '@shared/usage'
import { findBinary, lineReader, runCli, spawnCli } from '../env'
import { describeTool } from './claudeParser'
import type { Provider, RunHandle, RunRequest } from './types'
import { truncate } from './types'

type Json = Record<string, any>

const FALLBACK_BINARIES = [
  // The ChatGPT desktop app ships the CLI inside its bundle.
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex'
]

interface ActiveRun {
  threadId: string
  turnId?: string
  emit: (event: RunEvent) => void
  finish: () => void
  /** Approval requests waiting for the user, by the id shown in the UI. */
  approvals: Map<string, PendingApproval>
  sawText: boolean
  failed: boolean
  /**
   * Requests to run a command or change files outside the sandbox are refused without asking.
   * Set in the modes that normally never ask, when asking was only switched on for tool servers.
   */
  refuseSandbox: boolean
  /** Names of the tool servers this app added to the run. */
  mcp: string[]
}

interface PendingApproval {
  rpcId: number | string
  /** A tool server's tool, which is answered in a different shape than a command. */
  mcp?: { canRemember: boolean }
}

function sandboxFor(mode: RunMode): { sandbox: string; approvalPolicy: string } {
  switch (mode) {
    case 'chat':
    case 'plan':
      return { sandbox: 'read-only', approvalPolicy: 'never' }
    case 'edit':
      // Edits inside the folder are allowed, anything beyond that asks first.
      return { sandbox: 'workspace-write', approvalPolicy: 'on-request' }
    case 'auto':
      return { sandbox: 'workspace-write', approvalPolicy: 'never' }
  }
}

const CHAT_ONLY = 'This is a plain conversation. Answer directly from what you know and what the user tells you. Do not run commands or inspect files unless the user explicitly asks you to.'

export function codexItemToTool(item: Json): ToolCall | undefined {
  const status = (s: string | undefined): ToolCall['status'] =>
    s === 'failed' ? 'error' : s === 'declined' ? 'denied' : s === 'inProgress' || s === 'in_progress' ? 'running' : 'done'
  switch (item.type) {
    case 'commandExecution':
      return { id: item.id, name: 'Command', summary: String(item.command ?? '').slice(0, 200), status: status(item.status), output: item.aggregatedOutput ? truncate(item.aggregatedOutput) : undefined }
    case 'fileChange': {
      const paths = (item.changes ?? []).map((c: Json) => c.path).filter(Boolean)
      return { id: item.id, name: 'Edit', summary: paths.join(', ').slice(0, 200) || 'file changes', status: status(item.status) }
    }
    case 'mcpToolCall': {
      const refused = /rejected|requires approval/i.test(String(item.error?.message ?? ''))
      return {
        id: item.id,
        name: mcpToolLabel(String(item.server), String(item.tool)),
        summary: describeTool('', item.arguments),
        status: refused ? 'denied' : status(item.status),
        output: item.error?.message ? truncate(String(item.error.message)) : mcpResultText(item.result)
      }
    }
    case 'webSearch':
      return { id: item.id, name: 'Web search', summary: String(item.query ?? '').slice(0, 200), status: 'done' }
    case 'imageGeneration':
      return { id: item.id, name: 'Image', summary: 'generated an image', status: 'done' }
    default:
      return undefined
  }
}

function mcpResultText(result: Json | null | undefined): string | undefined {
  const text = (Array.isArray(result?.content) ? result!.content : [])
    .filter((c: Json) => c?.type === 'text' && typeof c.text === 'string')
    .map((c: Json) => c.text)
    .join('\n')
  return text ? truncate(text) : undefined
}

/** Reads Codex's question about a tool server's tool. Undefined when the request is some other kind of form. */
export function readMcpAsk(params: Json): { tool: string; summary: string; reason?: string; canRemember: boolean } | undefined {
  const meta = params?._meta
  if (meta?.codex_approval_kind !== 'mcp_tool_call' || typeof meta.tool_name !== 'string') return undefined
  const tool = mcpToolLabel(String(params.serverName ?? 'tool server'), meta.tool_name)
  return {
    tool,
    summary: describeTool('', meta.tool_params && typeof meta.tool_params === 'object' ? meta.tool_params : {}) || tool,
    reason: typeof meta.tool_description === 'string' && meta.tool_description.trim() ? meta.tool_description.trim().slice(0, 300) : undefined,
    canRemember: Array.isArray(meta.persist) && meta.persist.includes('session')
  }
}

export function codexErrorCode(info: unknown): 'auth' | 'rate_limit' | 'unknown' {
  if (info === 'usageLimitExceeded' || info === 'rateLimitExceeded') return 'rate_limit'
  if (info === 'unauthorized') return 'auth'
  return 'unknown'
}

export class CodexProvider implements Provider {
  private child?: ChildProcessWithoutNullStreams
  /** Path of the binary the running process was started from. */
  private childBin = ''
  private starting?: Promise<void>
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private runs = new Map<string, ActiveRun>()
  private modelCache: string[] = []
  private defaultModel = ''
  /** Tool servers that failed to start before their run was registered, by thread id. */
  private earlyMcpFailures = new Map<string, { name: string; error: string }[]>()
  /** The list of tool servers changed, so the process should be replaced once it is idle. */
  private stale = false
  /** Runs that have been asked for but whose conversation is not open yet. */
  private opening = 0

  constructor(
    private settings: () => Settings,
    private appVersion: string,
    /** Limits can change outside any run, so they are reported here too. */
    private onLimits: (limits: { fiveHour?: Partial<LimitWindow>; weekly?: Partial<LimitWindow> }) => void
  ) {}

  private bin(): string | undefined {
    return findBinary('codex', this.settings().chatgpt.cliPath, FALLBACK_BINARIES)
  }

  /**
   * Start afresh the next time Codex is needed. A conversation that is already open in the
   * running process would otherwise keep the tool servers it was opened with.
   */
  restartWhenIdle(): void {
    if (!this.child) return
    if (this.runs.size || this.opening) this.stale = true
    else this.dispose()
  }

  dispose(): void {
    this.stale = false
    const child = this.child
    this.child = undefined
    this.abandon('Codex was restarted.')
    child?.kill()
  }

  /** Fail everything that was waiting on a process that is gone. */
  private abandon(why: string): void {
    for (const p of this.pending.values()) p.reject(new Error(why))
    this.pending.clear()
    for (const run of [...this.runs.values()]) {
      if (!run.failed) run.emit({ type: 'error', code: 'unknown', message: why })
      run.finish()
    }
  }

  // ----- JSON-RPC plumbing -----

  private send(message: Json): void {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private request<T = any>(method: string, params: Json = {}, timeoutMs = 30000): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex did not answer ${method} in time.`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      this.send({ method, id, params })
    })
  }

  private ensureStarted(): Promise<void> {
    const bin = this.bin()
    // The configured tool changed: the old process must not keep answering.
    if (this.child && bin !== this.childBin && !this.runs.size) this.dispose()
    if (this.child) return Promise.resolve()
    if (this.starting) return this.starting
    if (!bin) return Promise.reject(new Error('The Codex CLI is not installed on this machine.'))
    this.starting = (async () => {
      const child = spawnCli(bin, ['app-server'], homedir())
      this.child = child
      this.childBin = bin
      child.stdout.on('data', lineReader((line) => this.onLine(line)))
      child.stderr.on('data', () => {})
      child.stdin.on('error', () => {})
      const gone = (why: string) => {
        if (this.child !== child) return
        this.child = undefined
        this.abandon(why)
      }
      child.on('error', (e) => gone(`Could not start Codex: ${e.message}`))
      child.on('close', () => gone('Codex stopped unexpectedly.'))
      await this.request('initialize', {
        clientInfo: { name: 'chaudecal-ai', title: 'Chaudecal AI', version: this.appVersion },
        capabilities: { experimentalApi: false, requestAttestation: false }
      })
      this.send({ method: 'initialized', params: {} })
    })().finally(() => (this.starting = undefined))
    return this.starting
  }

  private onLine(line: string): void {
    let msg: Json
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    const hasId = msg.id !== undefined && msg.id !== null
    if (hasId && msg.method === undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message ?? 'Codex request failed.'))
      else p.resolve(msg.result)
      return
    }
    if (hasId) this.onServerRequest(msg.id, msg.method, msg.params ?? {})
    else if (msg.method) this.onNotification(msg.method, msg.params ?? {})
  }

  private onServerRequest(id: number | string, method: string, params: Json): void {
    const run = this.runs.get(params.threadId)
    const isCommand = method === 'item/commandExecution/requestApproval'
    const isFile = method === 'item/fileChange/requestApproval'
    if (method === 'mcpServer/elicitation/request') {
      const ask = run ? readMcpAsk(params) : undefined
      if (!run || !ask) {
        // A form from a tool server, which this app cannot show.
        this.send({ id, result: { action: 'decline', content: null } })
        return
      }
      const key = `mcp-${id}`
      run.approvals.set(key, { rpcId: id, mcp: { canRemember: ask.canRemember } })
      run.emit({ type: 'approval', request: { id: key, kind: 'other', tool: ask.tool, summary: ask.summary, reason: ask.reason } })
      return
    }
    if (!run || run.refuseSandbox || (!isCommand && !isFile)) {
      // Anything this app cannot show is declined so the turn never hangs.
      if (isCommand || isFile || method === 'item/permissions/requestApproval') this.send({ id, result: { decision: 'decline' } })
      else this.send({ id, error: { code: -32601, message: 'Not supported by this client.' } })
      return
    }
    const key = String(params.approvalId ?? params.itemId ?? id)
    run.approvals.set(key, { rpcId: id })
    run.emit({
      type: 'approval',
      request: {
        id: key,
        kind: isCommand ? 'command' : 'file',
        summary: isCommand ? String(params.command ?? 'Run a command') : 'Change files outside the allowed folder',
        reason: params.reason ?? undefined
      }
    })
  }

  private onNotification(method: string, params: Json): void {
    if (method === 'account/rateLimits/updated') {
      this.onLimits(limitsFromCodex((params.rateLimits ?? {}) as CodexRateLimitSnapshot))
      return
    }
    const run = this.runs.get(params.threadId)
    if (method === 'mcpServer/startupStatus/updated') {
      if (params.status !== 'failed' || typeof params.name !== 'string' || typeof params.threadId !== 'string') return
      const failure = { name: params.name, error: String(params.error ?? '') }
      if (run) this.reportMcpFailure(run, failure)
      else {
        // The conversation is still being opened. Kept until its run is known.
        if (this.earlyMcpFailures.size > 50) this.earlyMcpFailures.clear()
        this.earlyMcpFailures.set(params.threadId, [...(this.earlyMcpFailures.get(params.threadId) ?? []), failure])
      }
      return
    }
    if (!run) return
    switch (method) {
      case 'serverRequest/resolved': {
        // Codex settled a question itself, for example because the turn was stopped.
        for (const [key, pending] of run.approvals) {
          if (pending.rpcId !== params.requestId) continue
          run.approvals.delete(key)
          run.emit({ type: 'approval', request: { id: key, kind: 'other', summary: '' }, settled: true })
        }
        return
      }
      case 'turn/started':
        run.turnId = params.turn?.id ?? run.turnId
        return
      case 'item/agentMessage/delta':
        if (params.delta) {
          run.sawText = true
          run.emit({ type: 'text', delta: params.delta })
        }
        return
      case 'item/reasoning/summaryTextDelta':
        if (params.delta) run.emit({ type: 'thinking', delta: params.delta })
        return
      case 'item/started':
      case 'item/completed': {
        const item = params.item ?? {}
        if (item.type === 'agentMessage') {
          // Separate consecutive messages. If no deltas arrived, the full text is used.
          if (method === 'item/started' && run.sawText) run.emit({ type: 'text', delta: '\n\n' })
          if (method === 'item/completed' && !run.sawText && item.text) {
            run.sawText = true
            run.emit({ type: 'text', delta: item.text })
          }
          return
        }
        const tool = codexItemToTool(item)
        if (tool) run.emit({ type: 'tool', tool: method === 'item/started' ? { ...tool, status: 'running' } : tool })
        return
      }
      case 'thread/tokenUsage/updated': {
        const last = params.tokenUsage?.last
        if (last) run.emit({ type: 'usage', usage: { inputTokens: last.inputTokens ?? 0, outputTokens: last.outputTokens ?? 0 } })
        return
      }
      case 'error': {
        if (params.willRetry) return
        this.failRun(run, params.error ?? {})
        return
      }
      case 'turn/completed': {
        const turn = params.turn ?? {}
        if (turn.status === 'failed') this.failRun(run, turn.error ?? {})
        else if (turn.status === 'interrupted' && !run.failed) {
          run.failed = true
          run.emit({ type: 'error', code: 'aborted', message: 'Stopped.' })
        }
        run.finish()
        return
      }
    }
  }

  /** Says in the chat that one of the app's tool servers did not come up. Codex's own servers are not this app's business. */
  private reportMcpFailure(run: ActiveRun, failure: { name: string; error: string }): void {
    if (!run.mcp.includes(failure.name)) return
    const why = failure.error.trim().split('\n')[0].slice(0, 160)
    run.emit({ type: 'tool', tool: { id: `mcp-${failure.name}`, name: failure.name, summary: `This tool server could not be started or reached on this device.${why ? ` ${why}` : ''}`, status: 'error' } })
  }

  private failRun(run: ActiveRun, error: Json): void {
    if (run.failed) return
    run.failed = true
    const code = codexErrorCode(error.codexErrorInfo)
    const message = code === 'auth' ? 'ChatGPT is not signed in on this machine. Sign in again from Settings.' : String(error.message ?? 'ChatGPT reported an error.')
    run.emit({ type: 'error', code, message })
  }

  // ----- Provider interface -----

  async status(): Promise<ProviderStatus> {
    const configured = this.settings().chatgpt.models
    const bin = this.bin()
    if (!bin) {
      return { provider: 'chatgpt', installed: false, ready: false, detail: 'The Codex CLI is not installed. Install the ChatGPT desktop app or run "npm install -g @openai/codex", then sign in.', models: configured }
    }
    const ver = await runCli(bin, ['--version'])
    const version = ver.stdout.trim().split('\n')[0] || undefined
    try {
      await this.ensureStarted()
      const account = await this.request<Json>('account/read', {})
      if (!account.account) {
        return { provider: 'chatgpt', installed: true, ready: false, detail: 'Not signed in. Run "codex login" in a terminal.', version, models: configured }
      }
      const plan = account.account.type === 'chatgpt' ? `${String(account.account.planType ?? '').replace(/^./, (c: string) => c.toUpperCase())} plan` : 'API key'
      await this.refreshModels()
      this.refreshLimits().catch(() => {})
      return { provider: 'chatgpt', installed: true, ready: true, detail: `Signed in (${plan})`, version, models: [...new Set([...this.modelCache, ...configured])] }
    } catch (e) {
      return { provider: 'chatgpt', installed: true, ready: false, detail: e instanceof Error ? e.message : String(e), version, models: configured }
    }
  }

  private async refreshModels(): Promise<void> {
    try {
      const res = await this.request<Json>('model/list', {})
      const visible = (res.data ?? []).filter((m: Json) => !m.hidden)
      this.modelCache = visible.map((m: Json) => m.model ?? m.id)
      this.defaultModel = visible.find((m: Json) => m.isDefault)?.model ?? this.modelCache[0] ?? ''
    } catch {
      // Keep whatever was known before.
    }
  }

  async refreshLimits(): Promise<void> {
    await this.ensureStarted()
    const res = await this.request<Json>('account/rateLimits/read', {})
    if (res?.rateLimits) this.onLimits(limitsFromCodex(res.rateLimits as CodexRateLimitSnapshot))
  }

  run(request: RunRequest, emit: (event: RunEvent) => void): RunHandle {
    let run: ActiveRun | undefined
    let stopRequested = false
    let resolveDone!: () => void
    const done = new Promise<void>((r) => (resolveDone = r))
    let finished = false
    // Until the conversation is open this run is in no list, but the process is still in use.
    this.opening++
    let counted = true
    const opened = () => {
      if (counted) this.opening--
      counted = false
    }
    const finish = () => {
      if (finished) return
      finished = true
      opened()
      if (run) this.runs.delete(run.threadId)
      emit({ type: 'done' })
      resolveDone()
      if (this.stale && !this.runs.size && !this.opening) this.dispose()
      else this.refreshLimits().catch(() => {})
    }

    ;(async () => {
      await this.ensureStarted()
      const base = sandboxFor(request.mode)
      const mcp = request.mcp ?? []
      // A tool that changes something asks first, unless its server is trusted. Codex can only ask
      // when asking is switched on, so it is switched on here and everything else is still refused.
      const askForTools = base.approvalPolicy === 'never' && mcp.some((m) => !m.trusted)
      const sandbox = base.sandbox
      const approvalPolicy = askForTools ? 'on-request' : base.approvalPolicy
      const developerInstructions = [request.mode === 'chat' ? CHAT_ONLY : '', request.system].filter((s) => s.trim()).join('\n\n') || null
      const config = mcp.length ? { mcp_servers: codexMcpConfig(mcp, process.platform, homedir()) } : null
      const common = { model: request.model || null, cwd: request.cwd, approvalPolicy, sandbox, developerInstructions, config }
      const started = request.sessionId
        ? await this.request<Json>('thread/resume', { threadId: request.sessionId, excludeTurns: true, ...common })
        : await this.request<Json>('thread/start', { ...common, ephemeral: request.ephemeral ?? false })
      const threadId: string = started.thread.id
      emit({ type: 'session', sessionId: threadId })
      emit({ type: 'model', model: started.model ?? request.model ?? this.defaultModel })
      run = { threadId, emit, finish, approvals: new Map(), sawText: false, failed: false, refuseSandbox: askForTools, mcp: mcp.map((m) => m.name) }
      this.runs.set(threadId, run)
      opened()
      for (const failure of this.earlyMcpFailures.get(threadId) ?? []) this.reportMcpFailure(run, failure)
      this.earlyMcpFailures.delete(threadId)
      if (stopRequested) {
        emit({ type: 'error', code: 'aborted', message: 'Stopped.' })
        finish()
        return
      }
      const input = [{ type: 'text', text: request.prompt, text_elements: [] }, ...(request.images ?? []).map((i) => ({ type: 'localImage', path: i.path }))]
      // The mode is repeated here because a conversation that is already open in the process
      // keeps the settings it was opened with, whatever thread/resume is given.
      const sandboxPolicy = { type: sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' }
      const turn = await this.request<Json>('turn/start', { threadId, input, approvalPolicy, sandboxPolicy })
      run.turnId = turn.turn?.id ?? run.turnId
      if (stopRequested && run.turnId) this.request('turn/interrupt', { threadId, turnId: run.turnId }).catch(() => finish())
    })().catch((e) => {
      const message = e instanceof Error ? e.message : String(e)
      const missing = /not installed/i.test(message)
      emit({ type: 'error', code: missing ? 'not_installed' : 'unknown', message })
      finish()
    })

    return {
      done,
      stop: () => {
        stopRequested = true
        if (run?.turnId) this.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }).catch(() => finish())
      },
      respondApproval: (id: string, decision: ApprovalDecision) => {
        const pending = run?.approvals.get(id)
        if (!pending) return
        run!.approvals.delete(id)
        if (!pending.mcp) {
          this.send({ id: pending.rpcId, result: { decision } })
        } else if (decision === 'decline') {
          this.send({ id: pending.rpcId, result: { action: 'decline', content: null } })
        } else {
          const remember = decision === 'acceptForSession' && pending.mcp.canRemember
          this.send({ id: pending.rpcId, result: { action: 'accept', content: null, ...(remember ? { _meta: { persist: 'session' } } : {}) } })
        }
      }
    }
  }
}
