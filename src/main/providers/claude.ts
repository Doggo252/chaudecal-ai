// Claude, through the user's own installed Claude Code CLI and its subscription
// sign-in. Because it is the real CLI, the user's Claude Code settings, plugins,
// MCP servers, skills and CLAUDE.md files all apply here without extra work.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalDecision, ProviderStatus, RunEvent, Settings } from '@shared/types'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { findBinary, lineReader, runCli, spawnCli } from '../env'
import { createClaudeParser, readPermissionAsk, sessionRule, type ClaudeParser, type PermissionAsk } from './claudeParser'
import type { Provider, RunHandle, RunRequest } from './types'

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

  private bin(): string | undefined {
    return findBinary('claude', this.settings().claude.cliPath, [join(homedir(), '.claude', 'local', 'claude')])
  }

  async status(): Promise<ProviderStatus> {
    const models = this.settings().claude.models
    const bin = this.bin()
    if (!bin) {
      return { provider: 'claude', installed: false, ready: false, detail: 'Claude Code is not installed. Install it from claude.com/claude-code, then sign in.', models }
    }
    const [ver, auth] = await Promise.all([runCli(bin, ['--version']), runCli(bin, ['auth', 'status'])])
    const version = ver.stdout.trim().split('\n')[0] || undefined
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
    return { provider: 'claude', installed: true, ready, detail, version, models }
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
    if (request.sessionId) args.push('--resume', request.sessionId)
    if (request.ephemeral) args.push('--no-session-persistence')

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

      const lines = createClaudeParser(emit)
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
