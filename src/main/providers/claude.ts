// Claude, through the user's own installed Claude Code CLI and its subscription
// sign-in. Because it is the real CLI, the user's Claude Code settings, plugins,
// MCP servers, skills and CLAUDE.md files all apply here without extra work.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProviderStatus, RunEvent, Settings } from '@shared/types'
import { findBinary, lineReader, runCli, spawnCli } from '../env'
import { createClaudeParser } from './claudeParser'
import type { Provider, RunHandle, RunRequest } from './types'

export class ClaudeProvider implements Provider {
  /** The CLI can report itself signed in while its token has in fact expired. A failed run is the proof. */
  private authFailed = false

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
    const images = request.images ?? []
    // Images cannot travel as plain text, so the turn is sent as one structured message.
    if (images.length) args.push('--input-format', 'stream-json')

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

    const parser = createClaudeParser(emit)
    let stopped = false
    let stderr = ''
    const child = spawnCli(bin, args, request.cwd)
    child.stdout.on('data', lineReader((line) => parser.line(line)))
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)))
    child.stdin.on('error', () => {})
    if (images.length) {
      const content = [
        { type: 'text', text: request.prompt },
        ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.base64 } }))
      ]
      child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`)
    } else {
      child.stdin.end(request.prompt)
    }

    const done = new Promise<void>((resolve) => {
      let finished = false
      const finish = (problem?: string) => {
        if (finished) return
        finished = true
        if (systemFile) rmSync(systemFile, { force: true })
        if (stopped) emit({ type: 'error', code: 'aborted', message: 'Stopped.' })
        else if (problem && !parser.sawError()) emit({ type: 'error', code: 'unknown', message: problem })
        emit({ type: 'done' })
        resolve()
      }
      child.on('error', (e) => finish(`Could not start Claude Code: ${e.message}`))
      child.on('close', (code) => finish(code && code !== 0 ? stderr.trim() || `Claude Code exited with code ${code}.` : undefined))
    })

    return {
      done,
      stop() {
        stopped = true
        child.kill()
      }
    }
  }
}
