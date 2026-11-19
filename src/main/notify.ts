// Decides when this device should show a system notification about a run, and what it says.
// Pure: showing the notification is done by the caller.

import { PROVIDER_LABEL, type ApprovalRequest, type Conversation, type Message } from '@shared/types'

export interface Notice {
  title: string
  body: string
}

/**
 * Whether this device should speak up.
 *
 * A run is announced on the device that sent the message, and only while the app is in the
 * background. The hub also announces a question from a run that another device started when
 * no other device is connected to see it, since the run would otherwise wait unnoticed.
 */
export function shouldNotify(o: { enabled: boolean; inBackground: boolean; startedHere: boolean; kind: 'finished' | 'question'; hub: boolean; listeners: number }): boolean {
  if (!o.enabled || !o.inBackground) return false
  if (o.startedHere) return true
  return o.kind === 'question' && o.hub && o.listeners === 0
}

function oneLine(text: string, max = 140): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/[#*_`>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

const titleOf = (conversation: Conversation | undefined) => conversation?.title?.trim() || 'Chaude'

/** What to say when a reply has arrived. Undefined when there is nothing worth announcing. */
export function finishedNotice(conversation: Conversation | undefined, reply: Message | undefined): Notice | undefined {
  // Stopped by the user, who therefore already knows.
  if (!reply || reply.status === 'stopped' || reply.status === 'streaming') return undefined
  const title = titleOf(conversation)
  // A private conversation never shows its contents outside the window.
  if (conversation?.private) return { title: 'Chaude', body: 'A reply is ready in a private chat.' }
  const who = reply.provider ? PROVIDER_LABEL[reply.provider] : 'The assistant'
  if (reply.variantGroup) return { title, body: 'The answers are ready to compare.' }
  if (reply.status === 'error') {
    if (reply.error?.code === 'rate_limit') return { title, body: `${who} reached its limit before it could finish.` }
    if (reply.error?.code === 'auth') return { title, body: `${who} needs you to sign in again.` }
    return { title, body: `${who} could not finish: ${oneLine(reply.error?.message ?? 'something went wrong', 110)}` }
  }
  const text = oneLine(reply.text)
  return { title, body: text ? `${who}: ${text}` : `${who} has finished.` }
}

/** What to say when an assistant has stopped to ask for permission. */
export function questionNotice(conversation: Conversation | undefined, request: ApprovalRequest): Notice {
  const who = request.provider ? PROVIDER_LABEL[request.provider] : 'The assistant'
  const title = `${who} needs your answer`
  if (conversation?.private) return { title, body: 'It is waiting for permission in a private chat.' }
  const what = oneLine(request.summary, 110)
  const wants = request.kind === 'command' ? `Wants to run: ${what}` : request.kind === 'file' ? `Wants to change: ${what}` : `Wants to use ${request.tool ?? 'a tool'}${what && what !== request.tool ? `: ${what}` : ''}`
  return { title, body: `${wants}\nIn "${titleOf(conversation)}"` }
}
