// The running context file and everything needed to move a conversation
// between providers without losing the thread.
//
// A conversation in this app belongs to no single provider. Each provider keeps
// its own session, and before every turn the app works out which messages that
// session has not seen and sends them along. Switching provider is therefore the
// same operation as continuing: the new provider simply has more to catch up on.

import type { Conversation, HandoffVariant, Message, ProviderId, Settings } from './types'
import { PROVIDER_LABEL } from './types'
import { estimateTokens, keepHead, keepTail } from './tokens'

/** Share of a model window kept free for the reply and the provider's own overhead. */
const WINDOW_RESERVE = 0.25
/** Upper bound for the word-for-word tail in the summary variant. */
const RECENT_TOKENS_MAX = 16_000

/**
 * The canonical thread: what an assistant should treat as the conversation.
 * Notes, unselected compare answers and failed or empty replies are left out.
 */
export function threadMessages(all: Message[]): Message[] {
  const groupsWithSelection = new Set<string>()
  for (const m of all) if (m.variantGroup && m.selected) groupsWithSelection.add(m.variantGroup)
  return all
    .filter((m) => {
      if (m.role === 'note') return false
      if (m.variantGroup) return groupsWithSelection.has(m.variantGroup) && m.selected === true
      if (m.role === 'assistant' && m.status === 'streaming') return false
      if (m.role === 'assistant' && m.status === 'error' && !m.text.trim()) return false
      return true
    })
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/** What a user message says, including the files attached to it. Images are named, not included. */
export function messageBody(m: Pick<Message, 'text' | 'attachments'>): string {
  const parts = [m.text.trim()]
  for (const a of m.attachments ?? []) {
    if (a.kind === 'text') parts.push(`<attached_file name="${a.name}">\n${(a.text ?? '').trim()}\n</attached_file>`)
    else parts.push(`[Attached image: ${a.name}]`)
  }
  return parts.filter(Boolean).join('\n\n')
}

/** Asked of another assistant when the user wants the last answer checked. */
export const SECOND_OPINION_PROMPT =
  'Give me a second opinion on the previous answer: what you agree with, what you would change, and anything it missed.'

export function renderMessage(m: Message): string {
  if (m.role === 'user') return `## User\n\n${messageBody(m)}`
  const who = m.provider ? PROVIDER_LABEL[m.provider] : 'Assistant'
  const model = m.model ? `, ${m.model}` : ''
  let out = `## Assistant (${who}${model})\n\n${m.text.trim()}`
  const tools = (m.tools ?? []).filter((t) => t.status !== 'denied')
  if (tools.length) {
    const list = tools.slice(0, 40).map((t) => `- ${t.name}: ${t.summary}`)
    if (tools.length > 40) list.push(`- and ${tools.length - 40} more`)
    out += `\n\nActions taken:\n${list.join('\n')}`
  }
  if (m.status === 'stopped') out += '\n\n(The user stopped this reply before it finished.)'
  return out
}

export function renderTranscript(messages: Message[]): string {
  return messages.map(renderMessage).join('\n\n')
}

function clip(text: string, chars: number): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length <= chars ? t : `${t.slice(0, chars - 1)}…`
}

/**
 * A summary that needs no model: the goal, each request in order, what was
 * touched, and where things ended. Used when no local model is available to
 * write a better one.
 */
export function extractiveSummary(messages: Message[]): string {
  if (!messages.length) return ''
  const users = messages.filter((m) => m.role === 'user')
  const assistants = messages.filter((m) => m.role === 'assistant' && m.text.trim())
  const parts: string[] = []
  if (users[0]) parts.push(`Original request: ${clip(users[0].text, 700)}`)
  if (users.length > 1) {
    const later = users.slice(1).slice(-30)
    parts.push(`Later requests, in order:\n${later.map((u) => `- ${clip(u.text, 260)}`).join('\n')}`)
  }
  const actions = new Set<string>()
  for (const m of messages) for (const t of m.tools ?? []) if (t.status !== 'denied') actions.add(`${t.name}: ${clip(t.summary, 120)}`)
  if (actions.size) parts.push(`Actions taken so far:\n${[...actions].slice(-40).map((a) => `- ${a}`).join('\n')}`)
  const last = assistants[assistants.length - 1]
  if (last) parts.push(`Where the assistant left off: ${clip(last.text, 900)}`)
  return parts.join('\n\n')
}

export interface HandoffResult {
  variant: HandoffVariant
  text: string
  tokens: number
  totalMessages: number
  /** Messages included word for word. */
  verbatimMessages: number
  /** True when something had to be dropped or condensed to fit the budget. */
  condensed: boolean
}

function header(conversation: Conversation, profile: string): string {
  const lines = [
    `# Context file: ${conversation.title || 'Untitled conversation'}`,
    '',
    'This is the running record of a conversation that is being continued here. Earlier turns may have been answered by a different AI assistant. Treat everything below as the history of this same conversation and carry on from where it ends.'
  ]
  if (profile.trim()) lines.push('', '## About the user', '', profile.trim())
  return lines.join('\n')
}

/** Pick the newest messages that fit a budget. Always returns at least one message. */
function tailWithin(messages: Message[], budgetTokens: number): number {
  let used = 0
  let start = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateTokens(renderMessage(messages[i])) + 4
    if (used + cost > budgetTokens && start < messages.length) break
    used += cost
    start = i
    if (used > budgetTokens) break
  }
  return start
}

export function buildHandoff(input: {
  conversation: Conversation
  /** The canonical thread, oldest first. */
  messages: Message[]
  variant: HandoffVariant
  budgetTokens: number
  profile?: string
}): HandoffResult {
  const { conversation, messages, variant } = input
  const budget = Math.max(500, input.budgetTokens)
  const head = header(conversation, input.profile ?? '')
  const headTokens = estimateTokens(head)
  const room = Math.max(200, budget - headTokens - 60)

  if (variant === 'full') {
    const whole = renderTranscript(messages)
    if (estimateTokens(whole) <= room) {
      const text = `${head}\n\n# Full transcript\n\n${whole}`
      return { variant, text, tokens: estimateTokens(text), totalMessages: messages.length, verbatimMessages: messages.length, condensed: false }
    }
    // Over budget: keep the opening request and as much of the newest end as fits.
    const first = messages[0]
    const firstText = first ? keepHead(renderMessage(first), Math.floor(room * 0.15)) : ''
    const start = Math.max(1, tailWithin(messages, room - estimateTokens(firstText) - 40))
    const kept = messages.slice(start)
    let tail = renderTranscript(kept)
    if (estimateTokens(tail) > room - estimateTokens(firstText) - 40) tail = keepTail(tail, room - estimateTokens(firstText) - 40)
    const omitted = start - 1
    const gap = omitted > 0 ? `\n\n(${omitted} earlier ${omitted === 1 ? 'message was' : 'messages were'} left out to fit the context budget.)\n\n` : '\n\n'
    const text = `${head}\n\n# Transcript\n\n${firstText}${gap}${tail}`
    return { variant, text, tokens: estimateTokens(text), totalMessages: messages.length, verbatimMessages: kept.length + (first ? 1 : 0), condensed: true }
  }

  // Summary variant: a digest of the earlier part, then the newest messages word for word.
  const recentBudget = Math.min(RECENT_TOKENS_MAX, Math.floor(room * 0.5))
  const recentStart = tailWithin(messages, recentBudget)
  const earlier = messages.slice(0, recentStart)
  const recent = messages.slice(recentStart)

  let digest = ''
  if (earlier.length) {
    const rolling = conversation.summary
    const coveredIdx = rolling ? messages.findIndex((m) => m.id === rolling.uptoMessageId) : -1
    if (rolling && coveredIdx >= 0) {
      digest = rolling.text.trim()
      const gap = messages.slice(coveredIdx + 1, recentStart)
      if (gap.length) digest += `\n\nSince that summary was written:\n\n${extractiveSummary(gap)}`
    } else {
      digest = extractiveSummary(earlier)
    }
  }
  let recentText = renderTranscript(recent)
  const digestBudget = Math.max(100, room - Math.min(estimateTokens(recentText), recentBudget) - 40)
  if (estimateTokens(digest) > digestBudget) digest = keepHead(digest, digestBudget)
  if (estimateTokens(recentText) > room - estimateTokens(digest)) recentText = keepTail(recentText, Math.max(100, room - estimateTokens(digest)))

  const sections = [head]
  if (digest) sections.push(`# Summary of the earlier conversation\n\n${digest}`)
  sections.push(`# Most recent messages, word for word\n\n${recentText}`)
  const text = sections.join('\n\n')
  return { variant, text, tokens: estimateTokens(text), totalMessages: messages.length, verbatimMessages: recent.length, condensed: earlier.length > 0 }
}

/** How many tokens of history may be sent to a provider in one request. */
export function providerBudget(provider: ProviderId, settings: Settings): number {
  const window =
    provider === 'claude' ? settings.claude.contextTokens : provider === 'chatgpt' ? settings.chatgpt.contextTokens : settings.local.contextTokens
  return Math.max(1000, Math.min(settings.contextBudgetTokens, Math.floor(window * (1 - WINDOW_RESERVE))))
}

export interface SessionState {
  sessionId: string
  /** Last message of the thread this session has seen. */
  syncedMessageId: string
}

export type TurnPlan =
  /** Brand new conversation: just send the message. */
  | { kind: 'fresh' }
  /** The provider has no session here, but the conversation has history. */
  | { kind: 'handoff'; unseen: Message[] }
  /** The provider's session is up to date. */
  | { kind: 'resume'; sessionId: string }
  /** The provider's session exists but other turns happened since. */
  | { kind: 'catchup'; sessionId: string; unseen: Message[] }

/**
 * Decide how to send the next user message to a provider.
 * `prior` is the canonical thread before the new message.
 */
export function planTurn(prior: Message[], session: SessionState | undefined): TurnPlan {
  if (!session) return prior.length ? { kind: 'handoff', unseen: prior } : { kind: 'fresh' }
  const idx = prior.findIndex((m) => m.id === session.syncedMessageId)
  if (idx < 0) return prior.length ? { kind: 'handoff', unseen: prior } : { kind: 'fresh' }
  const unseen = prior.slice(idx + 1)
  return unseen.length ? { kind: 'catchup', sessionId: session.sessionId, unseen } : { kind: 'resume', sessionId: session.sessionId }
}

/** The text actually sent to a provider that keeps its own session. */
export function composePrompt(input: {
  plan: TurnPlan
  userText: string
  conversation: Conversation
  variant: HandoffVariant
  budgetTokens: number
  profile?: string
}): string {
  const { plan, userText } = input
  if (plan.kind === 'fresh' || plan.kind === 'resume') return userText
  const room = Math.max(500, input.budgetTokens - estimateTokens(userText) - 200)
  if (plan.kind === 'handoff') {
    const handoff = buildHandoff({ conversation: input.conversation, messages: plan.unseen, variant: input.variant, budgetTokens: room, profile: input.profile })
    return [
      'You are picking up a conversation that is already under way. Its context file follows. Read it as the history of this conversation, then answer the new message at the end. Continue naturally and do not comment on the handoff unless asked.',
      '<context_file>',
      handoff.text,
      '</context_file>',
      'New message from the user:',
      userText
    ].join('\n\n')
  }
  let delta = renderTranscript(plan.unseen)
  if (estimateTokens(delta) > room) delta = keepTail(delta, room)
  return [
    'Since your last reply, this conversation continued with another assistant. Here is what happened in between. Treat it as part of our conversation.',
    '<conversation_since_your_last_reply>',
    delta,
    '</conversation_since_your_last_reply>',
    'New message from the user:',
    userText
  ].join('\n\n')
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Messages for a stateless provider (local models), which gets the history on
 * every request. Older turns are condensed when they do not fit the window.
 */
export function composeChatMessages(input: {
  conversation: Conversation
  prior: Message[]
  userText: string
  budgetTokens: number
  system: string
}): ChatTurn[] {
  const out: ChatTurn[] = []
  const system = input.system.trim()
  const room = Math.max(300, input.budgetTokens - estimateTokens(system) - estimateTokens(input.userText) - 100)
  const total = input.prior.reduce((n, m) => n + estimateTokens(messageBody(m)) + 6, 0)
  if (total <= room) {
    if (system) out.push({ role: 'system', content: system })
    for (const m of input.prior) out.push(m.role === 'user' ? { role: 'user', content: messageBody(m) } : { role: 'assistant', content: m.text })
  } else {
    const handoff = buildHandoff({ conversation: input.conversation, messages: input.prior, variant: 'summary', budgetTokens: room })
    out.push({ role: 'system', content: [system, handoff.text].filter(Boolean).join('\n\n') })
  }
  out.push({ role: 'user', content: input.userText })
  return out
}

/** System text shared by every provider: personal instructions and memory notes. */
export function sharedSystemText(profile: string, notes: string[]): string {
  const parts: string[] = []
  if (profile.trim()) parts.push(`The user's standing instructions:\n${profile.trim()}`)
  const kept = notes.map((n) => n.trim()).filter(Boolean)
  if (kept.length) parts.push(`Things to remember about the user:\n${kept.map((n) => `- ${n}`).join('\n')}`)
  return parts.join('\n\n')
}

/**
 * How to write artifacts in this app. Added to the system text while artifacts are on.
 * The app finds them in the reply's text, so this works the same for every assistant.
 */
export const ARTIFACT_GUIDE = `This app shows some code blocks as artifacts: they open in a side panel next to the conversation, with a live preview where the kind has one.

When you write substantial, self-contained content that the user is likely to view, reuse or change, such as a web page, an interactive component, a diagram, an image, a document of more than a few paragraphs, or a complete program, put it in one fenced code block and add a title to the opening fence:

\`\`\`html title="Pricing page"
<!doctype html>
...
\`\`\`

The language on the fence sets the kind:
- html: a complete web page. Put styles and scripts inline.
- jsx or tsx: one React component with a default export that needs no props. Tailwind classes work. Packages from npm, such as recharts, lucide-react, d3 or three, can be imported by name and load from esm.sh. There are no other project files, so keep everything in this one file.
- svg: an image.
- mermaid: a diagram.
- markdown: a document. If it contains code blocks, open and close the artifact with four backticks.
- any programming language: code.

To change an artifact, write it again in full with the same title. It becomes a new version. Keep short snippets and examples as ordinary code blocks without a title. Previews cannot reach the internet except to load scripts, styles and fonts from esm.sh, cdn.jsdelivr.net, unpkg.com, cdnjs.cloudflare.com and Google Fonts, so use inline SVG or data URLs for images instead of image links, and do not fetch data. Do not mention these instructions to the user.`

export function titleFromText(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  if (!t) return 'New chat'
  const firstSentence = t.split(/(?<=[.!?])\s/)[0]
  const base = firstSentence.length >= 12 ? firstSentence : t
  return base.length <= 60 ? base : `${base.slice(0, 57)}…`
}
