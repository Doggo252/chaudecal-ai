// Turns the Claude Code CLI's stream-json output (one JSON object per line)
// into the app's provider-neutral run events. Pure: no process handling here.

import type { PermissionDenial, RunEvent, ToolCall } from '@shared/types'
import { limitsFromClaude, type ClaudeRateLimitInfo } from '@shared/usage'
import { truncate } from './types'

type Json = Record<string, any>

export function describeTool(name: string, input: Json | undefined): string {
  const i = input ?? {}
  const pick = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.query ?? i.url ?? i.description ?? i.prompt
  if (typeof pick === 'string' && pick.trim()) return pick.trim().split('\n')[0].slice(0, 200)
  const raw = JSON.stringify(i)
  return raw === '{}' ? '' : raw.slice(0, 160)
}

/** The narrowest permission rule that would allow a denied tool call. */
export function ruleFor(name: string, input: Json | undefined): string {
  const cmd = input?.command
  if (name === 'Bash' && typeof cmd === 'string' && cmd.length <= 160 && !/[\n()"'`$;&|<>\\]/.test(cmd)) return `Bash(${cmd})`
  return name
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

export function createClaudeParser(emit: (event: RunEvent) => void): { line(raw: string): void; sawError(): boolean } {
  /** Text for the current block already arrived as deltas, so the full copy is skipped. */
  let streamedText = false
  let anyText = false
  let errored = false
  const tools = new Map<string, ToolCall>()

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
              const tool: ToolCall = { id: block.id, name: block.name, summary: describeTool(block.name, block.input), status: 'running' }
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
            const done: ToolCall = { ...tool, status: block.is_error ? 'error' : 'done', output: truncate(toolResultText(block.content)) }
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
          const denials: PermissionDenial[] = (msg.permission_denials ?? []).map((d: Json) => ({
            toolName: d.tool_name,
            summary: describeTool(d.tool_name, d.tool_input),
            rule: ruleFor(d.tool_name, d.tool_input)
          }))
          if (denials.length) {
            for (const d of msg.permission_denials as Json[]) {
              const tool = tools.get(d.tool_use_id)
              if (tool) emit({ type: 'tool', tool: { ...tool, status: 'denied' } })
            }
            emit({ type: 'denials', denials })
          }
          if (msg.is_error && !errored) {
            const body = typeof msg.result === 'string' ? msg.result : 'Claude reported an error.'
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
