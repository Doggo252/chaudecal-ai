// What was typed and attached in each chat's message box but not sent yet, so it is
// still there after going to another chat or page. Kept on this computer only.

import type { Attachment } from '@shared/types'

export interface ComposerDraft {
  text: string
  attached: Attachment[]
}

const KEY = 'chaude:drafts'
/** A draft left alone this long is let go. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000

type Saved = Record<string, ComposerDraft & { at: number }>

let cache: Saved | undefined

function all(): Saved {
  if (cache) return cache
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Saved
    const now = Date.now()
    cache = Object.fromEntries(Object.entries(parsed).filter(([, d]) => d && typeof d.text === 'string' && now - (d.at ?? 0) < KEEP_MS))
  } catch {
    cache = {}
  }
  return cache
}

/** The message box for a chat, or for a new chat of a kind ("new:chat", "new:code"). */
export function draftKey(conversationId: string | undefined, kind: string): string {
  return conversationId ?? `new:${kind}`
}

export function loadDraft(key: string): ComposerDraft {
  const d = all()[key]
  return { text: d?.text ?? '', attached: Array.isArray(d?.attached) ? d.attached : [] }
}

export function saveDraft(key: string, draft: ComposerDraft): void {
  const saved = all()
  if (!draft.text && !draft.attached.length) {
    if (!(key in saved)) return
    delete saved[key]
  } else {
    saved[key] = { text: draft.text, attached: draft.attached, at: Date.now() }
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(saved))
  } catch {
    // Storage full: the draft still lives for this run.
  }
}
