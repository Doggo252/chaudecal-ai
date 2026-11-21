// Mentioning a file of a code chat's folder with @ in the message box.

/** The @word being typed just before the caret, and where it starts. Undefined when there is none. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | undefined {
  const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret))
  if (!m) return undefined
  return { start: caret - m[2].length - 1, query: m[2] }
}

/** The files that best match what was typed after the @: names first, then folders, shorter paths first. */
export function rankFiles(files: string[], query: string, max = 8): string[] {
  const q = query.toLowerCase().replace(/\\/g, '/')
  if (!q) return [...files].sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, max)
  const scored: [number, string][] = []
  for (const f of files) {
    const path = f.toLowerCase()
    const name = path.slice(path.lastIndexOf('/') + 1)
    const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : path.startsWith(q) ? 2 : path.includes(q) ? 3 : -1
    if (score >= 0) scored.push([score, f])
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]))
  return scored.slice(0, max).map(([, f]) => f)
}

/** The text with the @word replaced by the chosen file, and where the caret goes after it. */
export function insertMention(text: string, at: { start: number; query: string }, file: string): { text: string; caret: number } {
  const quoted = /\s/.test(file) ? `"${file}"` : file
  const before = text.slice(0, at.start)
  const after = text.slice(at.start + 1 + at.query.length)
  const inserted = `@${quoted}${after.startsWith(' ') ? '' : ' '}`
  return { text: before + inserted + after, caret: before.length + inserted.length + (after.startsWith(' ') ? 1 : 0) }
}
