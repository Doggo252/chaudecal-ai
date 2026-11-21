import { describe, expect, it } from 'vitest'
import { applyTaskTool, isTaskTool } from '../src/shared/taskList'
import { createClaudeParser } from '../src/main/providers/claudeParser'
import { parseClaudeSession } from '../src/main/localSessions'
import type { PlanStep, RunEvent } from '../src/shared/types'

const texts = (steps?: PlanStep[]) => steps?.map((s) => `${s.status}:${s.text}`)

describe('task lists, however the tool writes them', () => {
  it('knows which tool calls write the list', () => {
    for (const n of ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'update_plan', 'mcp__ccd_turn__update_plan']) expect(isTaskTool(n)).toBe(true)
    for (const n of ['Bash', 'TaskStop', 'mcp__ccd_turn__wrap_up']) expect(isTaskTool(n)).toBe(false)
  })

  it('builds the list task by task and ticks tasks off by number, as newer Claude Code does', () => {
    let steps: PlanStep[] = []
    steps = applyTaskTool(steps, 'TaskCreate', { subject: 'Check the folder', description: 'x', activeForm: 'Checking' })!
    steps = applyTaskTool(steps, 'TaskCreate', { subject: 'Wait' })!
    steps = applyTaskTool(steps, 'TaskCreate', { subject: 'Wrap up' })!
    expect(steps.map((s) => s.id)).toEqual(['1', '2', '3'])
    steps = applyTaskTool(steps, 'TaskUpdate', { taskId: '1', status: 'completed' })!
    steps = applyTaskTool(steps, 'TaskUpdate', { taskId: '2', status: 'in_progress' })!
    expect(texts(steps)).toEqual(['done:Check the folder', 'active:Wait', 'pending:Wrap up'])
    steps = applyTaskTool(steps, 'TaskUpdate', { taskId: '3', status: 'deleted' })!
    expect(steps).toHaveLength(2)
    expect(applyTaskTool(steps, 'TaskUpdate', { taskId: '9', status: 'completed' })).toBeUndefined()
  })

  it("follows the Claude app's update_plan: whole lists, next step, and done and start by position", () => {
    let steps = applyTaskTool([], 'mcp__ccd_turn__update_plan', { items: [{ content: 'One', status: 'in_progress' }, { content: 'Two', status: 'pending' }, { content: 'Three', status: 'pending' }] })!
    steps = applyTaskTool(steps, 'mcp__ccd_turn__update_plan', { advance: true })!
    expect(texts(steps)).toEqual(['done:One', 'active:Two', 'pending:Three'])
    steps = applyTaskTool(steps, 'mcp__ccd_turn__update_plan', { done: [2], start: 3 })!
    expect(texts(steps)).toEqual(['done:One', 'done:Two', 'active:Three'])
    steps = applyTaskTool(steps, 'mcp__ccd_turn__update_plan', { advance: true })!
    expect(steps.every((s) => s.status === 'done')).toBe(true)
    expect(applyTaskTool([], 'mcp__ccd_turn__update_plan', { advance: true })).toBeUndefined()
  })

  it("reads TodoWrite and Codex's plan", () => {
    expect(texts(applyTaskTool([], 'TodoWrite', { todos: [{ content: 'Do A', activeForm: 'Doing A', status: 'in_progress' }, { content: 'Do B', status: 'completed' }] }))).toEqual(['active:Doing A', 'done:Do B'])
    expect(texts(applyTaskTool([], 'update_plan', { plan: [{ step: 'One', status: 'completed' }, { step: 'Two', status: 'inProgress' }] }))).toEqual(['done:One', 'active:Two'])
  })

  it('in a live turn, ticks off a task the last turn made', () => {
    const events: RunEvent[] = []
    const parser = createClaudeParser((e) => events.push(e), [], undefined, [{ id: '1', text: 'Wait', status: 'active' }])
    parser.line(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }] } }))
    const plans = events.filter((e) => e.type === 'plan')
    expect(plans).toHaveLength(1)
    expect(texts((plans[0] as { steps: PlanStep[] }).steps)).toEqual(['done:Wait'])
    expect(events.some((e) => e.type === 'tool')).toBe(false)
  })

  it('shows the list on the answers of a session brought in from this computer', () => {
    const line = (o: unknown) => JSON.stringify(o)
    const at = (s: number) => new Date(Date.UTC(2026, 10, 1, 10, 0, s)).toISOString()
    const s = parseClaudeSession(
      [
        line({ type: 'user', uuid: 'u1', sessionId: 's', cwd: '/w', timestamp: at(0), message: { role: 'user', content: 'Go.' } }),
        line({ type: 'assistant', uuid: 'a1', sessionId: 's', cwd: '/w', timestamp: at(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'p1', name: 'mcp__ccd_turn__update_plan', input: { items: [{ content: 'One', status: 'in_progress' }, { content: 'Two', status: 'pending' }] } }] } }),
        line({ type: 'assistant', uuid: 'a2', sessionId: 's', cwd: '/w', timestamp: at(2), message: { role: 'assistant', content: [{ type: 'text', text: 'Started.' }] } }),
        line({ type: 'user', uuid: 'u2', sessionId: 's', cwd: '/w', timestamp: at(3), message: { role: 'user', content: 'Go on.' } }),
        line({ type: 'assistant', uuid: 'a3', sessionId: 's', cwd: '/w', timestamp: at(4), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'p2', name: 'mcp__ccd_turn__update_plan', input: { advance: true } }, { type: 'text', text: 'Next.' }] } })
      ].join('\n')
    )!
    const answers = s.messages.filter((m) => m.role === 'assistant')
    expect(texts(answers[0].plan)).toEqual(['active:One', 'pending:Two'])
    expect(texts(answers[1].plan)).toEqual(['done:One', 'active:Two'])
    expect(answers.flatMap((m) => m.tools ?? [])).toHaveLength(0)
  })
})
