// Finding and launching the provider command line tools.
//
// A desktop app started from the Dock or Start menu gets a bare PATH, so the
// tools a terminal would find are looked up explicitly.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const isWin = process.platform === 'win32'
let shellPath: string | undefined

/** Ask the user's login shell for its PATH once (macOS and Linux). */
export async function loadShellPath(): Promise<void> {
  if (isWin || shellPath !== undefined) return
  const shell = process.env.SHELL || '/bin/zsh'
  shellPath = await new Promise<string>((resolve) => {
    execFile(shell, ['-ilc', 'printf "__PATH__%s__END__" "$PATH"'], { timeout: 4000, env: { ...process.env, TERM: 'dumb' } }, (_err, stdout) => {
      const m = /__PATH__(.*?)__END__/s.exec(stdout ?? '')
      resolve(m ? m[1] : '')
    })
  })
}

function extraDirs(): string[] {
  const home = homedir()
  if (isWin) {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [join(home, '.local', 'bin'), join(appData, 'npm'), join(local, 'Programs', 'nodejs'), 'C:\\Program Files\\nodejs']
  }
  return [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.npm-global', 'bin'), join(home, '.bun', 'bin'), '/usr/bin', '/bin']
}

export function searchPath(): string {
  const parts = [...(shellPath ? shellPath.split(delimiter) : []), ...(process.env.PATH ?? '').split(delimiter), ...extraDirs()]
  return [...new Set(parts.filter(Boolean))].join(delimiter)
}

/** Locate a command. `fallbacks` are absolute paths to try when it is not on the PATH. */
export function findBinary(name: string, override: string, fallbacks: string[] = []): string | undefined {
  if (override.trim()) return existsSync(override.trim()) ? override.trim() : undefined
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of searchPath().split(delimiter)) {
    for (const ext of exts) {
      const p = join(dir, name + ext)
      if (existsSync(p)) return p
    }
  }
  return fallbacks.find((p) => existsSync(p))
}

/**
 * Environment for a provider CLI. Variables that would redirect the CLI away
 * from the user's own subscription sign-in are removed. That includes API keys,
 * which would otherwise switch billing from the plan to pay-per-token, and the
 * session variables present when this app is itself started from an AI tool.
 */
export function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE_|CLAUDECODE|ANTHROPIC_|OPENAI_|CODEX_|ELECTRON_|NODE_OPTIONS)/.test(k)) continue
    env[k] = v
  }
  env.PATH = searchPath()
  return env
}

export function spawnCli(bin: string, args: string[], cwd: string): ChildProcessWithoutNullStreams {
  // Windows cannot start .cmd shims directly. Arguments passed here never contain
  // user text (prompts go through stdin or files), so quoting them is safe.
  const viaShell = isWin && /\.(cmd|bat)$/i.test(bin)
  if (viaShell) {
    const quoted = [bin, ...args].map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ')
    return spawn(quoted, { cwd, env: cliEnv(), shell: true, windowsHide: true })
  }
  return spawn(bin, args, { cwd, env: cliEnv(), windowsHide: true })
}

export function runCli(bin: string, args: string[], timeoutMs = 8000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnCli(bin, args, homedir())
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e) })
      return
    }
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
    child.stdin.end()
  })
}

/** Split a stream into lines and hand each complete line to `onLine`. */
export function lineReader(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buf = ''
  return (chunk) => {
    buf += chunk.toString()
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (line.trim()) onLine(line)
    }
  }
}
