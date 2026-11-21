// Claude, through the user's own installed Claude Code CLI and its subscription
// sign-in. Because it is the real CLI, the user's Claude Code settings, plugins,
// MCP servers, skills and CLAUDE.md files all apply here without extra work.

import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { claudeMcpAllow, claudeMcpConfig } from '@shared/mcp'
import type { ApprovalDecision, ProviderStatus, RunEvent, Settings } from '@shared/types'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { compareVersions, desktopClaudeCopies, findBinary, lineReader, runCli, spawnCli } from '../env'
import { createClaudeParser, readPermissionAsk, sessionRule, type ClaudeParser, type PermissionAsk } from './claudeParser'
import type { Provider, RunHandle, RunRequest } from './types'
import { claudeCatalog, type ModelInfo } from '@shared/models'

/** Tools that only make sense in Claude Code's own window. Claude is told what to do instead. */
const ANSWERED_HERE: Record<string, string> = {
  ExitPlanMode: 'This app shows plans as ordinary replies. Write the full plan as your answer. The user will switch to Edit mode when they want it carried out.',
  AskUserQuestion: 'Questions cannot be shown as a form here. Ask in your reply and the user will answer in their next message.'
}

const DECLINED = 'The user declined this action. Do not try it again unless they ask for it. Carry on without it, or ask what they would like instead.'

/** How long the CLI gets to exit after its turn has ended. */
const EXIT_GRACE_MS = 5000

export class ClaudeProvider implements Provider {
  /** The CLI can report itself signed in while its token has in fact expired. A failed run is the proof. */
  private authFailed = false
  /** Set when the installed CLI turned out not to support questions during a turn. */
  private liveUnsupported = false

  constructor(
    private settings: () => Settings,
    private tmpDir: string,
    private onAuthChange: () => void = () => {}
  ) {
    mkdirSync(tmpDir, { recursive: true })
  }

  /** Whether this Claude Code can give a session a name, which older versions cannot. */
  private canName = false

  /** The newest Claude Code found by the last status check. */
  private chosen?: string
  private versions = new Map<string, { mtime: number; version?: string }>()

  private bin(): string | undefined {
    const override = this.settings().claude.cliPath
    if (!override.trim() && this.chosen && existsSync(this.chosen)) return this.chosen
    return findBinary('claude', override, [join(homedir(), '.claude', 'local', 'claude')])
  }

  private async versionOf(bin: string): Promise<string | undefined> {
    let mtime = 0
    try {
      mtime = statSync(bin).mtimeMs
    } catch {
      return undefined
    }
    const known = this.versions.get(bin)
    if (known && known.mtime === mtime) return known.version
    const res = await runCli(bin, ['--version'])
    const version = /(\d+\.\d+\.\d+)/.exec(res.stdout)?.[1]
    this.versions.set(bin, { mtime, version })
    return version
  }

  /**
   * Use the newest Claude Code on this machine: the one on the PATH, or the copy the
   * Claude desktop app keeps, which it updates on its own. An older Claude Code only
   * knows older models. A path set in Settings is always used as it is.
   */
  private async pickBin(): Promise<string | undefined> {
    this.chosen = undefined
    if (this.settings().claude.cliPath.trim()) return this.bin()
    const candidates = [this.bin(), ...desktopClaudeCopies().slice(0, 2)].filter((p): p is string => !!p)
    let best: { path: string; version: string } | undefined
    for (const path of candidates) {
      const version = await this.versionOf(path)
      if (version && (!best || compareVersions(version, best.version) > 0)) best = { path, version }
    }
    this.chosen = best?.path ?? candidates[0]
    return this.chosen
  }

  async status(): Promise<ProviderStatus> {
    const models = this.settings().claude.models
    const bin = await this.pickBin()
    if (!bin) {
      return { provider: 'claude', installed: false, ready: false, detail: 'Claude Code is not installed. Install it from claude.com/claude-code, then sign in.', models }
    }
    const [ver, auth, help] = await Promise.all([runCli(bin, ['--version']), runCli(bin, ['auth', 'status']), runCli(bin, ['--help'])])
    const version = ver.stdout.trim().split('\n')[0] || undefined
    this.canName = /--name\b/.test(help.stdout)
    let ready = false
    let detail = 'Not signed in. Run "claude auth login" in a terminal.'
    try {
      const info = JSON.parse(auth.stdout)
      if (info.loggedIn && this.authFailed) {
        detail = 'Your Claude sign-in has expired. Sign in again.'
      } else if (info.loggedIn) {
        ready = true
        const plan = info.subscriptionType ? `${String(info.subscriptionType).replace(/^./, (c: string) => c.toUpperCase())} plan` : 'API key'
        detail = `Signed in (${plan})`
      }
    } catch {
      if (auth.code === 0 && /logged in/i.test(auth.stdout + auth.stderr)) {
        ready = true
        detail = 'Signed in'
      }
    }
    const catalog = ready ? await this.catalog() : undefined
    return { provider: 'claude', installed: true, ready, detail, version, models, ...(catalog?.models.length ? { catalog: catalog.models, commands: catalog.commands } : {}) }
  }

  /** The plan's usage, from Claude Code's /usage command. It answers from the account without a model call. */
  async usage(): Promise<string | undefined> {
    const bin = this.bin()
    if (!bin) return undefined
    const res = await runCli(bin, ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'], 30_000)
    try {
      const result = (JSON.parse(res.stdout) as { result?: unknown }).result
      return typeof result === 'string' ? result : undefined
    } catch {
      return undefined
    }
  }

  private catalogCache?: { at: number; bin: string; models: ModelInfo[]; commands: { name: string; description: string }[] }

  /**
   * The plan's models and Claude Code's commands, from the answer Claude Code gives
   * when a session starts. Nothing is sent to the model and no session is saved.
   * Kept for an hour.
   */
  async catalog(): Promise<{ models: ModelInfo[]; commands: { name: string; description: string }[] } | undefined> {
    const bin = this.bin()
    if (!bin) return undefined
    // A different Claude Code may know different models.
    if (this.catalogCache && this.catalogCache.bin !== bin) this.catalogCache = undefined
    if (this.catalogCache && Date.now() - this.catalogCache.at < 3600_000) return this.catalogCache
    const found = await new Promise<{ models: ModelInfo[]; commands: { name: string; description: string }[] } | undefined>((resolveFound) => {
      let proc: ChildProcessWithoutNullStreams
      try {
        proc = spawnCli(bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'], this.tmpDir)
      } catch {
        resolveFound(undefined)
        return
      }
      const timer = setTimeout(() => finish(undefined), 30_000)
      function finish(value: { models: ModelInfo[]; commands: { name: string; description: string }[] } | undefined) {
        clearTimeout(timer)
        proc.kill()
        resolveFound(value)
      }
      proc.on('error', () => finish(undefined))
      proc.on('exit', () => finish(undefined))
      proc.stderr.on('data', () => {})
      proc.stdout.on(
        'data',
        lineReader((line) => {
        let msg: { type?: string; response?: { response?: Record<string, unknown> } & Record<string, unknown> }
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (msg.type !== 'control_response') return
        const r = (msg.response?.response ?? msg.response ?? {}) as Record<string, unknown>
        const commands = Array.isArray(r.commands)
          ? (r.commands as Record<string, unknown>[]).map((c) => ({ name: String(c.name ?? ''), description: String(c.description ?? '') })).filter((c) => c.name)
          : []
        finish({ models: claudeCatalog(r.models), commands })
        })
      )
      proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'catalog', request: { subtype: 'initialize' } })}\n`)
    })
    if (found?.models.length) this.catalogCache = { at: Date.now(), bin, ...found }
    return found ?? this.catalogCache
  }

  clearAuthFailure(): void {
    this.authFailed = false
  }

  run(request: RunRequest, emitRaw: (event: RunEvent) => void): RunHandle {
    let authError = false
    const emit = (event: RunEvent) => {
      if (event.type === 'error' && event.code === 'auth') authError = true
      if (event.type === 'done' && authError !== this.authFailed && (authError || sawReply)) {
        this.authFailed = authError
        this.onAuthChange()
      }
      if (event.type === 'text') sawReply = true
      emitRaw(event)
    }
    let sawReply = false
    const bin = this.bin()
    if (!bin) {
      emit({ type: 'error', code: 'not_installed', message: 'Claude Code is not installed on this machine.' })
      emit({ type: 'done' })
      return { done: Promise.resolve(), stop() {} }
    }

    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
    if (request.model) args.push('--model', request.model)
    if (request.effort) args.push('--effort', request.effort)
    if (request.sessionId) args.push('--resume', request.sessionId)
    if (request.ephemeral) args.push('--no-session-persistence')
    // Otherwise Claude Code lists the session under the handoff text that opens it.
    if (request.title && !request.sessionId && !request.ephemeral && this.canName) args.push('--name', request.title)

    const allow = [...(request.allow ?? [])]
    switch (request.mode) {
      case 'chat':
        // Conversation only: web lookups are allowed, the file system and shell are not.
        args.push('--tools', 'WebSearch,WebFetch')
        allow.push('WebSearch', 'WebFetch')
        break
      case 'plan':
        args.push('--permission-mode', 'plan')
        break
      case 'edit':
        args.push('--permission-mode', 'acceptEdits')
        break
      case 'auto':
        args.push('--permission-mode', 'acceptEdits')
        allow.push('Bash', 'WebSearch', 'WebFetch')
        break
    }
    // Tool servers from the app's shared list. The file can hold tokens, so only this user may read it.
    const mcp = request.mcp ?? []
    let mcpFile: string | undefined
    if (mcp.length) {
      mcpFile = join(this.tmpDir, `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
      writeFileSync(mcpFile, JSON.stringify(claudeMcpConfig(mcp, process.platform, homedir())), { encoding: 'utf8', mode: 0o600 })
      // The option takes any number of values, so it goes where another option follows it.
      args.splice(1, 0, '--mcp-config', mcpFile)
      allow.push(...claudeMcpAllow(mcp))
    }
    if (allow.length) args.push('--allowedTools', [...new Set(allow)].join(','))

    let systemFile: string | undefined
    if (request.system.trim()) {
      systemFile = join(this.tmpDir, `system-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
      writeFileSync(systemFile, request.system, 'utf8')
      args.push('--append-system-prompt-file', systemFile)
    }

    const images = request.images ?? []
    let stopped = false
    let finished = false
    let child: ChildProcessWithoutNullStreams | undefined
    let parser: ClaudeParser | undefined
    /** Questions waiting for the user, by request id. */
    const asks = new Map<string, PermissionAsk>()
    /** What the user allowed for the rest of this turn: rules, and exact tool calls. */
    const granted = new Set<string>()
    const exact = (ask: PermissionAsk) => `${ask.toolName} ${JSON.stringify(ask.input)}`
    const isGranted = (ask: PermissionAsk) => {
      const rule = sessionRule(ask.toolName, ask.input)
      return granted.has(exact(ask)) || (!!rule && granted.has(rule))
    }

    let settle!: () => void
    const done = new Promise<void>((resolve) => (settle = resolve))
    const finish = (problem?: string) => {
      if (finished) return
      finished = true
      if (systemFile) rmSync(systemFile, { force: true })
      if (mcpFile) rmSync(mcpFile, { force: true })
      if (stopped) emit({ type: 'error', code: 'aborted', message: 'Stopped.' })
      else if (problem && !parser?.sawError()) emit({ type: 'error', code: 'unknown', message: problem })
      emit({ type: 'done' })
      settle()
    }

    const send = (message: unknown) => {
      if (child?.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`)
    }
    const answer = (ask: PermissionAsk, response: Record<string, unknown>) => {
      asks.delete(ask.id)
      send({ type: 'control_response', response: { subtype: 'success', request_id: ask.id, response: { ...response, toolUseID: ask.toolUseId } } })
    }
    const allowAsk = (ask: PermissionAsk) => answer(ask, { behavior: 'allow', updatedInput: ask.input })
    const denyAsk = (ask: PermissionAsk, message: string) => {
      if (ask.toolUseId) parser?.refuse(ask.toolUseId)
      answer(ask, { behavior: 'deny', message })
    }

    /** Handles the lines that are questions to this app instead of output. True when the line was one. */
    const control = (line: string): boolean => {
      let msg: Record<string, any>
      try {
        msg = JSON.parse(line)
      } catch {
        return false
      }
      if (msg.type === 'control_cancel_request') {
        // Claude Code settled the question itself, for example through one of the user's hooks.
        const ask = asks.get(msg.request_id)
        if (ask) {
          asks.delete(ask.id)
          emit({ type: 'approval', request: ask.request, settled: true })
        }
        return true
      }
      if (msg.type === 'control_response') return true
      if (msg.type !== 'control_request') return false
      const ask = readPermissionAsk(msg)
      if (!ask) {
        // Never leave the CLI waiting on something this app cannot answer.
        send({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'This app does not support that request.' } })
      } else if (ANSWERED_HERE[ask.toolName]) {
        denyAsk(ask, ANSWERED_HERE[ask.toolName])
      } else if (isGranted(ask)) {
        allowAsk(ask)
      } else {
        asks.set(ask.id, ask)
        emit({ type: 'approval', request: ask.request })
      }
      return true
    }

    const start = (live: boolean) => {
      // Questions travel over stdin and stdout, and images cannot travel as plain text.
      // Both need the turn to be sent as a structured message.
      const structured = live || images.length > 0
      const runArgs = [...args]
      if (structured) runArgs.push('--input-format', 'stream-json')
      if (live) runArgs.push('--permission-prompt-tool', 'stdio')

      // A file Claude is about to rewrite is read first, so the change can be shown as a diff.
      const readCurrent = (path: string) => {
        try {
          const full = resolve(request.cwd, path)
          return statSync(full).size <= 2_000_000 ? readFileSync(full, 'utf8') : undefined
        } catch {
          return undefined
        }
      }
      const lines = createClaudeParser(
        emit,
        mcp.map((m) => m.name),
        readCurrent,
        request.plan
      )
      parser = lines
      let stderr = ''
      let sawOutput = false
      let closing = false
      const proc = spawnCli(bin, runArgs, request.cwd)
      child = proc
      proc.stdout.on(
        'data',
        lineReader((line) => {
          sawOutput = true
          if (live && line.includes('"control_') && control(line)) return
          lines.line(line)
          if (live && lines.ended() && !closing) {
            // The turn is over. Closing the input is what lets the CLI exit.
            closing = true
            proc.stdin.end()
            setTimeout(() => proc.kill(), EXIT_GRACE_MS).unref()
          }
        })
      )
      proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)))
      proc.stdin.on('error', () => {})
      if (structured) {
        const content = [
          { type: 'text', text: request.prompt },
          ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.base64 } }))
        ]
        const turn = `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`
        if (live) proc.stdin.write(turn)
        else proc.stdin.end(turn)
      } else {
        proc.stdin.end(request.prompt)
      }

      proc.on('error', (e) => finish(`Could not start Claude Code: ${e.message}`))
      proc.on('close', (code) => {
        if (live && !stopped && !sawOutput && code && /permission-prompt-tool|unknown option/i.test(stderr)) {
          // An older Claude Code without this option. Run the turn the earlier way, and remember.
          this.liveUnsupported = true
          start(false)
          return
        }
        finish(code && code !== 0 && !closing ? stderr.trim() || `Claude Code exited with code ${code}.` : undefined)
      })
    }
    // One-off runs (compare answers) have nobody watching for questions, so they keep the earlier behaviour.
    start(!request.ephemeral && !this.liveUnsupported)

    return {
      done,
      stop() {
        stopped = true
        child?.kill()
      },
      respondApproval(id: string, decision: ApprovalDecision) {
        const ask = asks.get(id)
        if (!ask) return
        if (decision === 'decline') {
          denyAsk(ask, DECLINED)
          return
        }
        if (decision === 'acceptForSession') {
          granted.add(exact(ask))
          const rule = sessionRule(ask.toolName, ask.input)
          if (rule) {
            granted.add(rule)
            emit({ type: 'grant', rules: [rule] })
          }
        }
        allowAsk(ask)
        // Other questions already on screen that the same permission covers are answered with it.
        for (const other of [...asks.values()]) {
          if (!isGranted(other)) continue
          allowAsk(other)
          emit({ type: 'approval', request: other.request, settled: true })
        }
      }
    }
  }
}
