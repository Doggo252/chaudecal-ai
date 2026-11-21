// The assistant's task list, as one checklist. The tools write it in different ways:
//  - Claude Code's TodoWrite sends the whole list each time.
//  - Newer Claude Code adds tasks one by one (TaskCreate) and ticks them off by
//    number (TaskUpdate), across the turns of a session.
//  - The Claude desktop app's update_plan sends the whole list, or just "next
//    step" (advance) or which steps are done and which starts (done, start).
//  - Codex's update_plan sends the whole list as steps.
// Each call gives back the list as it stands afterwards.

import type { PlanStep } from './types'

type Json = Record<string, any>

/** Whether a tool call writes the task list, so it shows as the checklist rather than as a step. */
export function isTaskTool(name: string): boolean {
  return name === 'TodoWrite' || name === 'TaskCreate' || name === 'TaskUpdate' || name === 'update_plan' || /__update_plan$/.test(name)
}

const statusOf = (s: unknown): PlanStep['status'] => {
  const v = String(s ?? '').toLowerCase()
  if (/^(completed?|done)$/.test(v)) return 'done'
  if (/progress|active|running/.test(v)) return 'active'
  return 'pending'
}

const clean = (s: unknown) => (typeof s === 'string' ? s.trim() : '')

/** The list after one task tool call, or nothing when the call is not one or carries nothing usable. */
export function applyTaskTool(steps: PlanStep[], name: string, input: Json | undefined): PlanStep[] | undefined {
  if (!input || !isTaskTool(name)) return undefined
  if (name === 'TodoWrite') {
    if (!Array.isArray(input.todos)) return undefined
    return (input.todos as Json[])
      .filter((t) => clean(t?.content))
      .map((t) => {
        const status = statusOf(t.status)
        return { text: status === 'active' && clean(t.activeForm) ? clean(t.activeForm) : clean(t.content), status }
      })
  }
  if (name === 'TaskCreate') {
    const text = clean(input.subject)
    if (!text) return undefined
    // Claude Code numbers a session's tasks 1, 2, 3 in the order they are made.
    const next = steps.reduce((n, s) => Math.max(n, Number(s.id) || 0), 0) + 1
    return [...steps, { id: String(next), text, status: 'pending' }]
  }
  if (name === 'TaskUpdate') {
    const id = String(input.taskId ?? input.id ?? '')
    if (!steps.some((s) => s.id === id)) return undefined
    if (input.status === 'deleted') return steps.filter((s) => s.id !== id)
    return steps.map((s) => (s.id === id ? { ...s, ...(clean(input.subject) ? { text: clean(input.subject) } : {}), ...(input.status ? { status: statusOf(input.status) } : {}) } : s))
  }
  // update_plan, from the Claude desktop app or from Codex.
  const whole = Array.isArray(input.items) ? input.items : Array.isArray(input.plan) ? input.plan : undefined
  if (whole) {
    return (whole as Json[]).filter((t) => clean(t?.content ?? t?.step)).map((t) => ({ text: clean(t.content ?? t.step), status: statusOf(t.status) }))
  }
  if (!steps.length) return undefined
  let next = steps.map((s) => ({ ...s }))
  if (Array.isArray(input.done) || typeof input.start === 'number') {
    for (const n of Array.isArray(input.done) ? input.done : []) if (next[Number(n) - 1]) next[Number(n) - 1].status = 'done'
    if (typeof input.start === 'number' && next[input.start - 1]) {
      next = next.map((s) => (s.status === 'active' ? { ...s, status: 'pending' as const } : s))
      next[input.start - 1].status = 'active'
    }
    return next
  }
  if (input.advance) {
    const at = next.findIndex((s) => s.status === 'active')
    if (at >= 0) next[at].status = 'done'
    const following = next.findIndex((s, i) => i > at && s.status === 'pending')
    if (following >= 0) next[following].status = 'active'
    return next
  }
  return undefined
}
