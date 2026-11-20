// Chats that live on claude.ai and chatgpt.com, drawn by this app: reading the
// replies the sites send back. Neither site documents this, so each reader takes
// what it understands and ignores the rest. Pure.

import { chatgptMessages } from './webImport'

/** The parent of the first message in a new claude.ai chat. */
export const CLAUDE_ROOT = '00000000-0000-4000-8000-000000000000'

/** Splits a server-sent event stream into events, however the pieces arrive. */
export function sseReader(onEvent: (event: string, data: string) => void): (chunk: string) => void {
  let buf = ''
  return (chunk) => {
    buf += chunk.replace(/\r\n/g, '\n')
    let at: number
    while ((at = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, at)
      buf = buf.slice(at + 2)
      let event = 'message'
      const data: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (data.length) onEvent(event, data.join('\n'))
    }
  }
}

export interface ClaudeStreamState {
  text: string
  /** Set when the site reports a problem, like a reached limit. */
  error?: string
  /** When a reached limit resets, in milliseconds. */
  resetsAt?: number
  done: boolean
}

/**
 * Applies one event of a claude.ai reply. Newer replies come as content blocks
 * with text deltas, the way Anthropic's API sends them; older ones as
 * "completion" events with the next piece of text.
 */
export function claudeStreamEvent(state: ClaudeStreamState, data: string): ClaudeStreamState {
  let ev: Record<string, unknown>
  try {
    ev = JSON.parse(data) as Record<string, unknown>
  } catch {
    return state
  }
  const type = String(ev.type ?? '')
  if (type === 'content_block_delta') {
    const delta = (ev.delta ?? {}) as Record<string, unknown>
    if (delta.type === 'text_delta' && typeof delta.text === 'string') return { ...state, text: state.text + delta.text }
    return state
  }
  if (type === 'content_block_start') {
    // A new text block after a tool call starts on its own paragraph.
    const block = (ev.content_block ?? {}) as Record<string, unknown>
    if (block.type === 'text' && state.text && !state.text.endsWith('\n')) return { ...state, text: `${state.text}\n\n${typeof block.text === 'string' ? block.text : ''}` }
    return state
  }
  if (type === 'completion' && typeof ev.completion === 'string') return { ...state, text: state.text + ev.completion }
  if (type === 'message_stop') return { ...state, done: true }
  if (type === 'error') {
    const err = (ev.error ?? {}) as Record<string, unknown>
    return { ...state, error: String(err.message ?? 'claude.ai could not answer.'), done: true }
  }
  if (type === 'message_limit') {
    const limit = (ev.message_limit ?? {}) as Record<string, unknown>
    if (limit.type === 'exceeded_limit') {
      const resets = typeof limit.resetsAt === 'number' ? limit.resetsAt * (limit.resetsAt < 1e12 ? 1000 : 1) : undefined
      return { ...state, error: 'You have reached your Claude limit for now.', ...(resets ? { resetsAt: resets } : {}) }
    }
  }
  return state
}

/** Reads a whole claude.ai reply stream at once. For tests and for replies that arrive in one piece. */
export function claudeStreamText(stream: string): ClaudeStreamState {
  let state: ClaudeStreamState = { text: '', done: false }
  sseReader((_event, data) => (state = claudeStreamEvent(state, data)))(`${stream}\n\n`)
  return state
}

/**
 * Where a chatgpt.com reply stands, from the chat as the site keeps it: the
 * text of the answer so far, and whether it has finished. Only an answer that
 * started after the question was sent counts.
 */
export function chatgptReplyState(chat: unknown, sentAt: number): { text: string; done: boolean; started: boolean } {
  const c = (chat ?? {}) as { current_node?: string; mapping?: Record<string, { message?: Record<string, unknown> }> }
  const node = c.mapping?.[c.current_node ?? '']?.message ?? {}
  const role = ((node.author ?? {}) as { role?: string }).role
  const created = typeof node.create_time === 'number' ? node.create_time * 1000 : 0
  const messages = chatgptMessages(chat)
  const last = messages[messages.length - 1]
  const started = !!last && last.role === 'assistant' && (last.createdAt === 0 || last.createdAt >= sentAt - 5000)
  if (!started) return { text: '', done: false, started: false }
  const finished = role === 'assistant' && node.status === 'finished_successfully' && (node.recipient === 'all' || node.recipient === undefined) && node.end_turn !== false && created >= sentAt - 5000
  return { text: last.text, done: finished, started: true }
}
