// Groups an assistant's steps the way people read them: "Ran 3 commands",
// "Edited 2 files +12 -3". Steps of the same sort that follow each other form one
// group. Pure.

import type { ToolCall, ToolKind } from './types'

export interface StepGroup {
  kind: ToolKind
  tools: ToolCall[]
  label: string
  /** Lines added and removed across the group's file edits. */
  added: number
  removed: number
  running: boolean
  /** How many steps failed or were not allowed. */
  problems: number
}

const n = (count: number, one: string, many: string) => (count === 1 ? one : many.replace('#', String(count)))

function labelFor(kind: ToolKind, tools: ToolCall[], running: boolean): string {
  const count = tools.length
  const files = new Set(tools.flatMap((t) => (t.diff?.length ? t.diff.map((d) => d.path) : [t.summary]))).size
  switch (kind) {
    case 'command':
      return running ? n(count, 'Running a command', 'Running # commands') : n(count, 'Ran a command', 'Ran # commands')
    case 'read':
      return running ? n(files, 'Reading a file', 'Reading # files') : n(files, 'Read a file', 'Read # files')
    case 'search':
      return running ? 'Searching' : n(count, 'Searched the files', 'Searched the files # times')
    case 'edit':
      return running ? n(files, 'Editing a file', 'Editing # files') : n(files, 'Edited a file', 'Edited # files')
    case 'web':
      return running ? 'Searching the web' : n(count, 'Looked something up on the web', 'Looked # things up on the web')
    case 'agent':
      return running ? n(count, 'A helper is working', '# helpers are working') : n(count, 'A helper worked on it', '# helpers worked on it')
    case 'tool':
      return running ? n(count, 'Using a tool', 'Using # tools') : n(count, 'Used a tool', 'Used # tools')
    default:
      return count === 1 ? tools[0].name : `${count} steps`
  }
}

/** The steps, grouped. A step with no sort stands alone. */
export function groupSteps(tools: ToolCall[]): StepGroup[] {
  const groups: { kind: ToolKind; tools: ToolCall[] }[] = []
  for (const t of tools) {
    const kind = t.kind ?? 'other'
    const last = groups[groups.length - 1]
    if (last && last.kind === kind && kind !== 'other') last.tools.push(t)
    else groups.push({ kind, tools: [t] })
  }
  return groups.map(({ kind, tools: list }) => {
    const running = list.some((t) => t.status === 'running')
    const diffs = list.flatMap((t) => t.diff ?? [])
    return {
      kind,
      tools: list,
      label: labelFor(kind, list, running),
      added: diffs.reduce((a, d) => a + d.added, 0),
      removed: diffs.reduce((a, d) => a + d.removed, 0),
      running,
      problems: list.filter((t) => t.status === 'error' || t.status === 'denied').length
    }
  })
}

/** All of one answer's steps as one quiet line: "Ran 2 commands, read 3 files, edited openers.ts". */
export interface StepSummary {
  label: string
  added: number
  removed: number
  running: boolean
  problems: number
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

function phrase(kind: ToolKind, list: ToolCall[], running: boolean): string {
  if (kind === 'edit' || kind === 'read') {
    const paths = [...new Set(list.flatMap((t) => (t.diff?.length ? t.diff.map((d) => d.path) : [t.summary.split('\n')[0].trim()])))].filter(Boolean)
    if (paths.length === 1 && paths[0].length < 260) {
      const created = kind === 'edit' && list.every((t) => !!t.diff?.length && t.diff.every((d) => d.created))
      const verb = kind === 'read' ? (running ? 'Reading' : 'Read') : created ? (running ? 'Creating' : 'Created') : running ? 'Editing' : 'Edited'
      return `${verb} ${baseName(paths[0])}`
    }
  }
  return labelFor(kind, list, running)
}

export function summarizeSteps(tools: ToolCall[]): StepSummary {
  const order: ToolKind[] = []
  const byKind = new Map<ToolKind, ToolCall[]>()
  for (const t of tools) {
    const kind = t.kind ?? 'other'
    if (!byKind.has(kind)) {
      byKind.set(kind, [])
      order.push(kind)
    }
    byKind.get(kind)?.push(t)
  }
  const parts = order.map((kind) => {
    const list = byKind.get(kind) ?? []
    const text = phrase(kind, list, list.some((t) => t.status === 'running'))
    // A tool's own name keeps its capitals; the app's own words read on as one sentence.
    return { text, own: kind === 'other' }
  })
  const label = parts.map((p, i) => (i === 0 || p.own ? p.text : p.text.charAt(0).toLowerCase() + p.text.slice(1))).join(', ')
  const diffs = tools.flatMap((t) => t.diff ?? [])
  return {
    label,
    added: diffs.reduce((a, d) => a + d.added, 0),
    removed: diffs.reduce((a, d) => a + d.removed, 0),
    running: tools.some((t) => t.status === 'running'),
    problems: tools.filter((t) => t.status === 'error' || t.status === 'denied').length
  }
}
