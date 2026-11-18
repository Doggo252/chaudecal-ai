// Keeps each conversation's rolling summary up to date, using a local model so
// that summarising never spends a paid limit. When no local model is reachable
// the context file falls back to the built-in extractive summary instead.

import type { Conversation, Settings } from '@shared/types'
import { renderTranscript, threadMessages } from '@shared/context'
import { estimateTokens, keepTail } from '@shared/tokens'
import type { Store } from './store'
import type { LocalProvider } from './providers/local'

/** Newest part of a conversation that is always kept word for word, so not summarised. */
const KEEP_RECENT_TOKENS = 6000
/** Do not bother a model until this much new material has built up. */
const MIN_NEW_TOKENS = 2500

export class Summarizer {
  private running = new Set<string>()

  constructor(
    private store: Store,
    private settings: () => Settings,
    private local: LocalProvider
  ) {}

  async maybeSummarize(conversationId: string): Promise<void> {
    const s = this.settings()
    if (!s.local.summarize || this.running.has(conversationId)) return
    const conv = this.store.get<Conversation>('conversation', conversationId)
    if (!conv) return
    const thread = threadMessages(this.store.messages(conversationId))

    // Everything older than the recent tail is a candidate.
    let tail = 0
    let cut = thread.length
    for (let i = thread.length - 1; i >= 0; i--) {
      tail += estimateTokens(thread[i].text)
      if (tail > KEEP_RECENT_TOKENS) break
      cut = i
    }
    const older = thread.slice(0, cut)
    if (!older.length) return
    const doneIdx = conv.summary ? older.findIndex((m) => m.id === conv.summary!.uptoMessageId) : -1
    const fresh = older.slice(doneIdx + 1)
    if (!fresh.length || estimateTokens(renderTranscript(fresh)) < MIN_NEW_TOKENS) return

    this.running.add(conversationId)
    try {
      const room = Math.max(1500, Math.floor(s.local.contextTokens * 0.6))
      const previous = doneIdx >= 0 && conv.summary ? conv.summary.text : ''
      const material = keepTail(renderTranscript(fresh), room - estimateTokens(previous))
      const text = await this.local.complete([
        {
          role: 'system',
          content:
            'You maintain the running summary of a conversation between a user and AI assistants. The summary lets a different assistant continue the work without the full history. Write plain prose and short lists. Keep: what the user wants, decisions made and why, facts and constraints, names, file paths, commands, code identifiers, and what is still open. Leave out pleasantries. Do not address the user and do not add opinions.'
        },
        {
          role: 'user',
          content: [
            previous ? `Summary so far:\n\n${previous}` : 'There is no summary yet.',
            `New part of the conversation to fold in:\n\n${material}`,
            'Write the updated summary now. Reply with the summary only, at most about 500 words.'
          ].join('\n\n---\n\n')
        }
      ])
      if (!text) return
      const latest = this.store.get<Conversation>('conversation', conversationId)
      if (!latest) return
      this.store.put('conversation', conversationId, {
        ...latest,
        summary: { text, uptoMessageId: fresh[fresh.length - 1].id, updatedAt: Date.now(), source: 'local' }
      } satisfies Conversation)
    } finally {
      this.running.delete(conversationId)
    }
  }
}
