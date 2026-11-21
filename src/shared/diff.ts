// Line differences for the file edits an assistant makes, shown under its step
// in the chat. Claude reports an edit as the old and new text; Codex sends a
// ready-made unified diff. Both become the same small shape. Pure.

export interface DiffLine {
  /** '+' added, '-' removed, ' ' unchanged, '@' a gap between parts of the file. */
  t: '+' | '-' | ' ' | '@'
  s: string
}

export interface FileDiff {
  path: string
  added: number
  removed: number
  /** At most MAX_LINES of it, so a large rewrite does not bloat the conversation. */
  lines: DiffLine[]
  /** The file was created. */
  created?: boolean
  deleted?: boolean
}

export const MAX_LINES = 400
const CONTEXT = 3

function split(text: string): string[] {
  if (!text) return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** The edit script between two texts, line by line. Very large inputs fall back to "all removed, all added". */
function editScript(a: string[], b: string[]): DiffLine[] {
  // Trim the shared start and end first: most edits change a few lines in the middle.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const head: DiffLine[] = a.slice(0, start).map((s) => ({ t: ' ', s }))
  const tail: DiffLine[] = a.slice(endA).map((s) => ({ t: ' ', s }))
  const x = a.slice(start, endA)
  const y = b.slice(start, endB)
  let middle: DiffLine[]
  if (x.length * y.length > 4_000_000) {
    middle = [...x.map((s): DiffLine => ({ t: '-', s })), ...y.map((s): DiffLine => ({ t: '+', s }))]
  } else {
    // Longest common subsequence, then walk it.
    const n = x.length
    const m = y.length
    const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = x[i] === y[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    middle = []
    let i = 0
    let j = 0
    // Removed lines come before the lines that replace them, as diffs are usually read.
    while (i < n || j < m) {
      if (i < n && j < m && x[i] === y[j]) {
        middle.push({ t: ' ', s: x[i] })
        i++
        j++
      } else if (i < n && (j === m || table[i + 1][j] >= table[i][j + 1])) middle.push({ t: '-', s: x[i++] })
      else middle.push({ t: '+', s: y[j++] })
    }
  }
  return [...head, ...middle, ...tail]
}

/** Keeps a few unchanged lines around each change, and marks the gaps. */
function withContext(script: DiffLine[]): DiffLine[] {
  const keep = new Array(script.length).fill(false)
  script.forEach((l, i) => {
    if (l.t === ' ') return
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(script.length - 1, i + CONTEXT); k++) keep[k] = true
  })
  const out: DiffLine[] = []
  let skipped = false
  script.forEach((l, i) => {
    if (keep[i]) {
      if (skipped && out.length) out.push({ t: '@', s: '' })
      skipped = false
      out.push(l)
    } else skipped = true
  })
  return out
}

function finish(path: string, lines: DiffLine[], extra: Partial<FileDiff> = {}): FileDiff {
  const added = lines.filter((l) => l.t === '+').length
  const removed = lines.filter((l) => l.t === '-').length
  return { path, added, removed, lines: lines.slice(0, MAX_LINES), ...extra }
}

/** The difference between two versions of (part of) a file. */
export function diffTexts(path: string, before: string, after: string, extra: Partial<FileDiff> = {}): FileDiff {
  return finish(path, withContext(editScript(split(before), split(after))), extra)
}

/** Reads a unified diff, as Codex sends it. Text that is not a diff counts as a whole new file. */
export function parseUnifiedDiff(path: string, patch: string, kind = 'update'): FileDiff {
  const raw = split(patch)
  if (kind === 'add' && !raw.some((l) => l.startsWith('@@'))) return finish(path, raw.map((s) => ({ t: '+', s })), { created: true })
  if (kind === 'delete' && !raw.some((l) => l.startsWith('@@'))) return finish(path, raw.map((s) => ({ t: '-', s })), { deleted: true })
  const lines: DiffLine[] = []
  for (const l of raw) {
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')) continue
    if (l.startsWith('@@')) {
      if (lines.length) lines.push({ t: '@', s: '' })
    } else if (l.startsWith('+')) lines.push({ t: '+', s: l.slice(1) })
    else if (l.startsWith('-')) lines.push({ t: '-', s: l.slice(1) })
    else if (l.startsWith(' ')) lines.push({ t: ' ', s: l.slice(1) })
    else if (l.startsWith('\\')) continue
  }
  return finish(path, lines, kind === 'add' ? { created: true } : kind === 'delete' ? { deleted: true } : {})
}

type Json = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * The diff for one of Claude's file tools, from what it was asked to change.
 * `current` reads the file as it is now (before the tool runs), for a full rewrite.
 */
export function claudeToolDiff(name: string, input: Json | undefined, current?: (path: string) => string | undefined): FileDiff[] | undefined {
  const i = input ?? {}
  const path = str(i.file_path) || str(i.notebook_path)
  if (!path) return undefined
  if (name === 'Edit') return [diffTexts(path, str(i.old_string), str(i.new_string))]
  if (name === 'MultiEdit' && Array.isArray(i.edits)) {
    const parts = (i.edits as Json[]).map((e) => diffTexts(path, str(e.old_string), str(e.new_string)))
    const lines = parts.flatMap((p, k) => (k ? [{ t: '@' as const, s: '' }, ...p.lines] : p.lines))
    return [finish(path, lines)]
  }
  if (name === 'Write') {
    const before = current?.(path)
    return [before === undefined ? diffTexts(path, '', str(i.content), { created: true }) : diffTexts(path, before, str(i.content))]
  }
  return undefined
}

/** The diffs in one of Codex's file change steps. */
export function codexFileDiffs(changes: unknown): FileDiff[] {
  if (!Array.isArray(changes)) return []
  return (changes as Json[])
    .filter((c) => typeof c?.path === 'string')
    .map((c) => {
      const kind = str((c.kind as Json | undefined)?.type) || str(c.kind) || 'update'
      return parseUnifiedDiff(str(c.path), str(c.diff), kind)
    })
}

/** Everything a chat changed in one file, edit by edit, oldest first. */
export interface FileChange {
  path: string
  added: number
  removed: number
  edits: FileDiff[]
  /** The chat made the file. */
  created: boolean
  /** The chat's last step on the file deleted it. */
  deleted: boolean
}

/**
 * The files a chat's steps changed, the most recently changed first. Steps that
 * failed or were not allowed changed nothing and are left out.
 */
export function collectChanges(steps: { status: string; diff?: FileDiff[] }[]): FileChange[] {
  const byPath = new Map<string, FileChange>()
  for (const step of steps) {
    if (step.status !== 'done' && step.status !== 'running') continue
    for (const d of step.diff ?? []) {
      const key = d.path.replace(/\\/g, '/')
      const was = byPath.get(key)
      const change: FileChange = was ?? { path: d.path, added: 0, removed: 0, edits: [], created: !!d.created, deleted: false }
      // Deleted and then made again counts as made.
      if (d.created && was?.deleted) change.created = true
      change.added += d.added
      change.removed += d.removed
      change.edits.push(d)
      change.deleted = !!d.deleted
      byPath.delete(key)
      byPath.set(key, change)
    }
  }
  return [...byPath.values()].reverse()
}

/** A path as shown under its folder: relative when it is inside, as given otherwise. */
export function shortPath(path: string, folder: string): string {
  if (!folder) return path
  const p = path.replace(/\\/g, '/')
  const f = folder.replace(/\\/g, '/').replace(/\/+$/, '') + '/'
  if (p.toLowerCase().startsWith(f.toLowerCase())) return p.slice(f.length)
  // The same project on another computer (a step run on Windows, say) sits in a folder of the same name.
  const name = f.slice(0, -1).split('/').pop()
  if (!name) return path
  const at = p.toLowerCase().lastIndexOf(`/${name.toLowerCase()}/`)
  return at >= 0 ? p.slice(at + name.length + 2) : path
}
