// The files in a code chat's folder, for mentioning one with @ in the message box.

import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { cliEnv, findBinary } from './env'

const MAX = 20000

/** Folders that are never worth listing: dependencies, builds and caches. */
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', '.cache', '.venv', 'venv', '__pycache__', 'target', 'Library', 'Temp', 'obj', '.idea', '.vscode', 'coverage', 'release'])

const cache = new Map<string, { at: number; files: Promise<string[]> }>()

function gitFiles(folder: string): Promise<string[] | undefined> {
  const git = findBinary('git', '')
  if (!git) return Promise.resolve(undefined)
  return new Promise((done) => {
    execFile(git, ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: folder, env: cliEnv(), maxBuffer: 32 * 1024 * 1024, timeout: 8000, windowsHide: true }, (err, out) => {
      if (err) return done(undefined)
      done(out.split('\n').filter(Boolean).slice(0, MAX))
    })
  })
}

async function walk(folder: string): Promise<string[]> {
  const files: string[] = []
  const queue = [folder]
  while (queue.length && files.length < MAX) {
    const dir = queue.shift()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && relative(folder, full).split(/[\\/]/).length < 12) queue.push(full)
      } else if (e.isFile()) files.push(relative(folder, full).replace(/\\/g, '/'))
    }
  }
  return files
}

/** Every file in the folder, relative to it, with slashes. Git's list when it is a repository, so ignored files stay out. */
export function folderFiles(folder: string): Promise<string[]> {
  const hit = cache.get(folder)
  if (hit && Date.now() - hit.at < 20_000) return hit.files
  const files = gitFiles(folder).then((list) => list ?? walk(folder))
  cache.set(folder, { at: Date.now(), files })
  files.catch(() => cache.delete(folder))
  return files
}
