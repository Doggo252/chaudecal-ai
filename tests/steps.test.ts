import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@shared/types'
import { claudeToolDiff, codexFileDiffs, diffTexts, MAX_LINES, parseUnifiedDiff } from '@shared/diff'
import { groupSteps } from '@shared/steps'
import { claudeToolKind, createClaudeParser, todoPlan } from '../src/main/providers/claudeParser'
import { codexItemToTool, codexPlan } from '../src/main/providers/codex'

describe('diffs', () => {
  it('shows what changed with a little context around it', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n')
    const after = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n')
    const d = diffTexts('x.txt', before, after)
    expect([d.added, d.removed]).toEqual([2, 1])
    expect(d.lines.map((l) => `${l.t}${l.s}`)).toEqual([' b', ' c', ' d', '-e', '+E', ' f', ' g', ' h', ' i', ' j', '+k'])
  })

  it('marks gaps between changes that are far apart', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    const changed = [...lines]
    changed[2] = 'changed 2'
    changed[25] = 'changed 25'
    const d = diffTexts('x', lines.join('\n'), changed.join('\n'))
    expect(d.lines.filter((l) => l.t === '@')).toHaveLength(1)
    expect([d.added, d.removed]).toEqual([2, 2])
  })

  it('keeps large rewrites small', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `l${i}`).join('\n')
    const d = diffTexts('big', '', big, { created: true })
    expect(d.added).toBe(3000)
    expect(d.lines).toHaveLength(MAX_LINES)
    expect(d.created).toBe(true)
  })

  it('reads the unified diffs Codex sends, and whole new or deleted files', () => {
    const d = parseUnifiedDiff('a.md', 'diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n@@ -9 +9 @@\n-x\n+y\n')
    expect([d.added, d.removed]).toEqual([2, 2])
    expect(d.lines.map((l) => l.t).join('')).toBe(' -+@-+')
    expect(parseUnifiedDiff('n.txt', 'one\ntwo\n', 'add')).toMatchObject({ added: 2, removed: 0, created: true })
    expect(codexFileDiffs([{ path: 'b.txt', kind: { type: 'delete' }, diff: 'gone\n' }])).toMatchObject([{ path: 'b.txt', removed: 1, deleted: true }])
  })

  it("turns Claude's edits into diffs, comparing a rewrite with the file as it was", () => {
    expect(claudeToolDiff('Edit', { file_path: 'a.ts', old_string: 'x = 1', new_string: 'x = 2' })).toMatchObject([{ path: 'a.ts', added: 1, removed: 1 }])
    expect(claudeToolDiff('MultiEdit', { file_path: 'a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] })).toMatchObject([{ added: 2, removed: 2 }])
    expect(claudeToolDiff('Write', { file_path: 'new.md', content: 'one\ntwo' }, () => undefined)).toMatchObject([{ added: 2, removed: 0, created: true }])
    expect(claudeToolDiff('Write', { file_path: 'old.md', content: 'one\nTWO' }, () => 'one\ntwo')).toMatchObject([{ added: 1, removed: 1 }])
    expect(claudeToolDiff('Read', { file_path: 'a' })).toBeUndefined()
  })
})

describe('steps and plans', () => {
  const tool = (id: string, kind: ToolCall['kind'], extra: Partial<ToolCall> = {}): ToolCall => ({ id, name: 'T', summary: id, status: 'done', kind, ...extra })

  it('groups steps of the same sort that follow each other', () => {
    const groups = groupSteps([
      tool('1', 'read'),
      tool('2', 'read'),
      tool('3', 'edit', { diff: [{ path: 'a', added: 3, removed: 1, lines: [] }] }),
      tool('4', 'edit', { diff: [{ path: 'b', added: 1, removed: 0, lines: [] }] }),
      tool('5', 'command'),
      tool('6', 'command', { status: 'error' }),
      tool('7', 'command', { status: 'running' }),
      tool('8', 'web'),
      tool('9', undefined),
      tool('10', undefined)
    ])
    expect(groups.map((g) => g.label)).toEqual(['Read 2 files', 'Edited 2 files', 'Running 3 commands', 'Looked something up on the web', 'T', 'T'])
    expect(groups[1]).toMatchObject({ added: 4, removed: 1 })
    expect(groups[2]).toMatchObject({ running: true, problems: 1 })
  })

  it("knows the sort of each of Claude's tools", () => {
    expect(['Bash', 'Read', 'Grep', 'Edit', 'Write', 'WebSearch', 'Task', 'mcp__notes__add', 'Skill'].map(claudeToolKind)).toEqual(['command', 'read', 'search', 'edit', 'edit', 'web', 'agent', 'tool', 'other'])
  })

  it("turns Claude's to-do list and ChatGPT's plan into a checklist", () => {
    expect(todoPlan({ todos: [{ content: 'Do A', activeForm: 'Doing A', status: 'in_progress' }, { content: 'Do B', status: 'completed' }, { content: 'Do C', status: 'pending' }, { content: ' ' }] })).toEqual([
      { text: 'Doing A', status: 'active' },
      { text: 'Do B', status: 'done' },
      { text: 'Do C', status: 'pending' }
    ])
    expect(codexPlan([{ step: 'One', status: 'completed' }, { step: 'Two', status: 'inProgress' }, { step: 'Three', status: 'pending' }])).toEqual([
      { text: 'One', status: 'done' },
      { text: 'Two', status: 'active' },
      { text: 'Three', status: 'pending' }
    ])
  })

  it('shows the to-do list as a checklist instead of a step, and a file edit with its diff', () => {
    const events: { type: string }[] = []
    const parser = createClaudeParser((e) => events.push(e), [], () => 'old\n')
    const content = [
      { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'A', status: 'pending' }] } },
      { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'f.txt', content: 'new\n' } }
    ]
    parser.line(JSON.stringify({ type: 'assistant', message: { content } }))
    expect(events.map((e) => e.type)).toEqual(['plan', 'tool'])
    expect(events[1]).toMatchObject({ tool: { kind: 'edit', diff: [{ path: 'f.txt', added: 1, removed: 1 }] } })
    expect(codexItemToTool({ type: 'fileChange', id: 'f', status: 'completed', changes: [{ path: 'r.md', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' }] })).toMatchObject({ kind: 'edit', diff: [{ path: 'r.md', added: 1, removed: 1 }] })
  })
})
