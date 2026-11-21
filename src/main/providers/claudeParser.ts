// Turns the Claude Code CLI's stream-json output (one JSON object per line)
// into the app's provider-neutral run events. Pure: no process handling here.

import { applyTaskTool, isTaskTool } from '@shared/taskList'
import type { ApprovalRequest, PermissionDenial, PlanStep, RunEvent, ToolCall, ToolKind } from '@shared/types'
import { claudeToolDiff } from '@shared/diff'
import { mcpToolLabel, mcpToolParts } from '@shared/mcp'
import { limitsFromClaude, type ClaudeRateLimitInfo } from '@shared/usage'
import { truncate } from './types'

type Json = Record<string, any>

/** The name shown for a tool. Tools of a tool server read "server: tool". */
export function toolLabel(name: string): string {
  const mcp = mcpToolParts(name)
  return mcp ? mcpToolLabel(mcp.server, mcp.tool) : name
}

export function describeTool(name: string, input: Json | undefined): string {
  const i = input ?? {}
  const pick = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.query ?? i.url ?? i.description ?? i.prompt
  if (typeof pick === 'string' && pick.trim()) return pick.trim().split('\n')[0].slice(0, 200)
  // A few plain values read better as "name: value" than as JSON.
  const entries = Object.entries(i)
  const plain = entries.every(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
  if (entries.length && entries.length <= 4 && plain) {
    return entries
      .map(([k, v]) => `${k}: ${String(v).split('\n')[0]}`)
      .join(', ')
      .slice(0, 200)
  }
  const raw = JSON.stringify(i)
  return raw === '{}' ? '' : raw.slice(0, 160)
}

/** The narrowest permission rule that would allow a denied tool call. */
export function ruleFor(name: string, input: Json | undefined): string {
  const cmd = input?.command
  if (name === 'Bash' && typeof cmd === 'string' && cmd.length <= 160 && !/[\n()"'`$;&|<>\\]/.test(cmd)) return `Bash(${cmd})`
  return name
}

/**
 * The rule that is remembered when the user allows something for the rest of the chat.
 * A command that is too involved to match exactly gets no rule, so it is asked about each time.
 */
export function sessionRule(name: string, input: Json | undefined): string | undefined {
  const rule = ruleFor(name, input)
  return name === 'Bash' && rule === 'Bash' ? undefined : rule
}

const COMMAND_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash'])
const READ_TOOLS = new Set(['Read', 'NotebookRead'])
const SEARCH_TOOLS = new Set(['Glob', 'Grep', 'LS', 'ToolSearch'])
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch'])
const AGENT_TOOLS = new Set(['Task', 'Agent'])

/** What sort of step one of Claude's tools is. */
export function claudeToolKind(name: string): ToolKind {
  if (COMMAND_TOOLS.has(name)) return 'command'
  if (READ_TOOLS.has(name)) return 'read'
  if (SEARCH_TOOLS.has(name)) return 'search'
  if (FILE_TOOLS.has(name)) return 'edit'
  if (WEB_TOOLS.has(name)) return 'web'
  if (AGENT_TOOLS.has(name)) return 'agent'
  if (mcpToolParts(name)) return 'tool'
  return 'other'
}

/** Claude's to-do list, as a checklist. */
export function todoPlan(input: Json | undefined): PlanStep[] | undefined {
  return applyTaskTool([], 'TodoWrite', input)
}
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** A question Claude Code asks in the middle of a turn: may this tool be used? */
export interface PermissionAsk {
  /** The id the answer has to carry. */
  id: string
  toolName: string
  toolUseId?: string
  input: Json
  request: ApprovalRequest
}

/** Reads a `can_use_tool` control request. Anything else gives undefined. */
export function readPermissionAsk(msg: Json): PermissionAsk | undefined {
  const r = msg?.request
  if (msg?.type !== 'control_request' || typeof msg.request_id !== 'string' || r?.subtype !== 'can_use_tool' || typeof r.tool_name !== 'string') return undefined
  const input: Json = r.input && typeof r.input === 'object' ? r.input : {}
  const summary = describeTool(r.tool_name, input) || r.tool_name
  const why = [r.decision_reason, r.description].find((t) => typeof t === 'string' && t.trim() && t.trim() !== summary)
  return {
    id: msg.request_id,
    toolName: r.tool_name,
    toolUseId: typeof r.tool_use_id === 'string' ? r.tool_use_id : undefined,
    input,
    request: {
      id: msg.request_id,
      kind: COMMAND_TOOLS.has(r.tool_name) ? 'command' : FILE_TOOLS.has(r.tool_name) ? 'file' : 'other',
      summary,
      reason: why ? String(why).trim().slice(0, 300) : undefined,
      tool: mcpToolParts(r.tool_name) ? toolLabel(r.tool_name) : typeof r.display_name === 'string' && r.display_name ? r.display_name : r.tool_name
    }
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && typeof (c as Json).text === 'string' ? (c as Json).text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export interface ClaudeParser {
  line(raw: string): void
  sawError(): boolean
  /** True once the CLI has reported the end of the turn. */
  ended(): boolean
  /** The user already said no to this tool call, so it is not offered again after the turn. */
  refuse(toolUseId: string): void
}

/** `mcpNames` are the tool servers this app added to the run. */
export function createClaudeParser(emit: (event: RunEvent) => void, mcpNames: string[] = [], readCurrent?: (path: string) => string | undefined, plan: PlanStep[] = []): ClaudeParser {
  /** The task list so far, carried over from the last turn. */
  let steps = plan
  /** Text for the current block already arrived as deltas, so the full copy is skipped. */
  let streamedText = false
  let anyText = false
  let errored = false
  let ended = false
  const tools = new Map<string, ToolCall>()
  const refused = new Set<string>()

  const text = (delta: string) => {
    if (!delta) return
    anyText = true
    emit({ type: 'text', delta })
  }
  const fail = (code: 'auth' | 'rate_limit' | 'unknown', message: string) => {
    if (errored) return
    errored = true
    emit({ type: 'error', code, message })
  }

  return {
    sawError: () => errored,
    ended: () => ended,
    refuse(toolUseId: string) {
      refused.add(toolUseId)
      const tool = tools.get(toolUseId)
      if (tool) emit({ type: 'tool', tool: { ...tool, status: 'denied' } })
    },
    line(raw: string) {
      let msg: Json
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      switch (msg.type) {
        case 'system': {
          if (msg.subtype === 'init') {
            if (msg.session_id) emit({ type: 'session', sessionId: msg.session_id })
            if (msg.model) emit({ type: 'model', model: msg.model })
            // A tool server from this app's list that did not come up is worth knowing about.
            for (const server of Array.isArray(msg.mcp_servers) ? msg.mcp_servers : []) {
              if (!mcpNames.includes(server?.name) || (server.status !== 'failed' && server.status !== 'needs-auth')) continue
              const summary = server.status === 'needs-auth' ? 'This tool server needs a sign-in that the app cannot do yet.' : 'This tool server could not be started or reached on this device.'
              emit({ type: 'tool', tool: { id: `mcp-${server.name}`, name: server.name, summary, status: 'error' } })
            }
          }
          return
        }
        case 'stream_event': {
          const ev = msg.event ?? {}
          // Only the top-level assistant is shown. Subagent chatter stays inside its tool call.
          if (msg.parent_tool_use_id) return
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'text' && anyText) text('\n\n')
          if (ev.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta') {
              streamedText = true
              text(ev.delta.text ?? '')
            } else if (ev.delta?.type === 'thinking_delta') {
              emit({ type: 'thinking', delta: ev.delta.thinking ?? '' })
            }
          }
          return
        }
        case 'assistant': {
          if (msg.error) {
            const body = toolResultText(msg.message?.content) || String(msg.error)
            if (msg.error === 'authentication_failed' || msg.error === 'oauth_org_not_allowed') {
              fail('auth', 'Claude is not signed in on this machine. Sign in again from Settings.')
            } else if (msg.error === 'rate_limit') {
              fail('rate_limit', body)
            } else {
              fail('unknown', body)
            }
            return
          }
          if (msg.parent_tool_use_id) return
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'text') {
              if (streamedText) streamedText = false
              else {
                if (anyText) text('\n\n')
                text(block.text ?? '')
              }
            } else if (block.type === 'tool_use') {
              // The task list is shown as a checklist, not as a step.
              if (isTaskTool(block.name)) {
                const next = applyTaskTool(steps, block.name, block.input)
                if (next) {
                  steps = next
                  emit({ type: 'plan', steps })
                }
                continue
              }
              const diff = FILE_TOOLS.has(block.name) ? claudeToolDiff(block.name, block.input, readCurrent) : undefined
              const tool: ToolCall = { id: block.id, name: toolLabel(block.name), summary: describeTool(block.name, block.input), status: 'running', kind: claudeToolKind(block.name), ...(diff ? { diff } : {}) }
              tools.set(tool.id, tool)
              emit({ type: 'tool', tool })
            }
          }
          return
        }
        case 'user': {
          if (msg.parent_tool_use_id) return
          const content = msg.message?.content
          if (!Array.isArray(content)) return
          for (const block of content) {
            if (block.type !== 'tool_result') continue
            const tool = tools.get(block.tool_use_id)
            if (!tool) continue
            const status = refused.has(tool.id) ? 'denied' : block.is_error ? 'error' : 'done'
            const done: ToolCall = { ...tool, status, output: truncate(toolResultText(block.content)) }
            tools.set(done.id, done)
            emit({ type: 'tool', tool: done })
          }
          return
        }
        case 'rate_limit_event': {
          const limits = limitsFromClaude((msg.rate_limit_info ?? {}) as ClaudeRateLimitInfo)
          if (limits.fiveHour || limits.weekly) emit({ type: 'limits', ...limits })
          return
        }
        case 'result': {
          ended = true
          const u = msg.usage
          if (u) {
            emit({
              type: 'usage',
              usage: {
                inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
                outputTokens: u.output_tokens ?? 0
              }
            })
          }
          const blocked: Json[] = Array.isArray(msg.permission_denials) ? msg.permission_denials : []
          for (const d of blocked) {
            const tool = tools.get(d.tool_use_id)
            if (tool) emit({ type: 'tool', tool: { ...tool, status: 'denied' } })
          }
          // What the user declined during the turn was their choice. Only the rest is offered again.
          const denials: PermissionDenial[] = blocked
            .filter((d) => !refused.has(d.tool_use_id))
            .map((d) => ({ toolName: d.tool_name, summary: describeTool(d.tool_name, d.tool_input), rule: ruleFor(d.tool_name, d.tool_input) }))
          if (denials.length) emit({ type: 'denials', denials })
          if (msg.is_error && !errored) {
            const errors = Array.isArray(msg.errors) ? msg.errors.filter((e: unknown) => typeof e === 'string' && e.trim()).join('\n') : ''
            const body = typeof msg.result === 'string' && msg.result.trim() ? msg.result : errors || 'Claude reported an error.'
            if (msg.api_error_status === 401) fail('auth', 'Claude is not signed in on this machine. Sign in again from Settings.')
            else if (msg.api_error_status === 429 || /usage limit|rate limit/i.test(body)) fail('rate_limit', body)
            else fail('unknown', body)
          }
          return
        }
      }
    }
  }
}
