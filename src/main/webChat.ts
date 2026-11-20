// Regular chats: messages go through claude.ai or chatgpt.com, with the app's
// own sign-in to the site, so the chat lives on the site and shows up in the
// Claude and ChatGPT apps everywhere. The app draws the chat itself; the site is
// never shown. After each answer the chat is read back from the site, so what the
// app keeps is exactly what the site has.
//
// claude.ai is asked directly, the way its own page asks. chatgpt.com checks that
// a real page is sending, so there the app types the message into the site's own
// page (hidden) and reads the answer from the chat as the site keeps it.

import { randomUUID } from 'node:crypto'
import type { WebService } from '@shared/ipc'
import { CLAUDE_ROOT, chatgptReplyState, claudeStreamEvent, sseReader, type ClaudeStreamState } from '@shared/webChat'
import { siteApi } from '@shared/webImport'
import type { WebTabs } from './webtabs'

export interface WebSendInput {
  service: WebService
  /** The chat on the site, when it exists already. */
  remoteId?: string
  /** The site's id of the message this one answers (claude.ai). */
  parentId?: string
  text: string
  model?: string
  signal: AbortSignal
  /** The answer so far, each time more arrives. */
  onText: (text: string) => void
  /** The chat's id on the site, as soon as it is known. */
  onChat?: (remoteId: string) => void
}

export class WebChatError extends Error {
  constructor(
    message: string,
    readonly code: 'signed-out' | 'limit' | 'site' | 'stopped',
    readonly resetsAt?: number
  ) {
    super(message)
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class WebChat {
  private orgs = new Map<WebService, string>()

  constructor(
    private tabs: WebTabs,
    private options: { pollMs: number; timeoutMs: number } = { pollMs: 1000, timeoutMs: 10 * 60_000 }
  ) {}

  private async get(service: WebService, path: string, headers: Record<string, string> = {}): Promise<unknown> {
    const res = await this.tabs.request(service, path, headers)
    if (res.status === 401 || res.status === 403 || res.status === 0) throw new WebChatError(`Not signed in to ${service === 'claude' ? 'claude.ai' : 'chatgpt.com'} in Chaude. Sign in under Settings, "Claude and ChatGPT".`, 'signed-out')
    if (res.status !== 200) throw new WebChatError(`${service === 'claude' ? 'claude.ai' : 'chatgpt.com'} answered ${res.status}.`, 'site')
    try {
      return JSON.parse(res.body) as unknown
    } catch {
      throw new WebChatError('The site answered with something other than data. It may want to check that you are human: sign in again under Settings.', 'site')
    }
  }

  /** Sends one message and waits for the whole answer. Gives back the chat's id on the site. */
  async send(input: WebSendInput): Promise<{ remoteId: string }> {
    return input.service === 'claude' ? this.sendClaude(input) : this.sendChatgpt(input)
  }

  // ----- claude.ai -----

  private async claudeOrg(): Promise<string> {
    const known = this.orgs.get('claude')
    if (known) return known
    const session = await siteApi.claude.open((path) => this.get('claude', path))
    if (!session?.org) throw new WebChatError('Not signed in to claude.ai in Chaude. Sign in under Settings, "Claude and ChatGPT".', 'signed-out')
    this.orgs.set('claude', session.org)
    return session.org
  }

  private async sendClaude(input: WebSendInput): Promise<{ remoteId: string }> {
    const org = await this.claudeOrg()
    const base = `/api/organizations/${encodeURIComponent(org)}/chat_conversations`
    const json = { 'content-type': 'application/json' }
    let remoteId = input.remoteId
    const fresh = !remoteId
    if (!remoteId) {
      remoteId = randomUUID()
      const made = await this.tabs.request('claude', base, json, { method: 'POST', body: JSON.stringify({ uuid: remoteId, name: '', ...(input.model ? { model: input.model } : {}) }) })
      if (made.status === 401 || made.status === 403) throw new WebChatError('Not signed in to claude.ai in Chaude. Sign in under Settings, "Claude and ChatGPT".', 'signed-out')
      if (made.status < 200 || made.status >= 300) throw new WebChatError(`claude.ai could not start the chat (${made.status}).`, 'site')
    }
    input.onChat?.(remoteId)
    let state: ClaudeStreamState = { text: '', done: false }
    const read = sseReader((_event, data) => {
      const before = state.text
      state = claudeStreamEvent(state, data)
      if (state.text !== before) input.onText(state.text)
    })
    const body = {
      prompt: input.text,
      parent_message_uuid: input.parentId ?? CLAUDE_ROOT,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: 'en-US',
      attachments: [],
      files: [],
      sync_sources: [],
      rendering_mode: 'messages',
      ...(input.model ? { model: input.model } : {})
    }
    const res = await this.tabs.stream('claude', `${base}/${encodeURIComponent(remoteId)}/completion`, { method: 'POST', headers: { ...json, accept: 'text/event-stream' }, body: JSON.stringify(body) }, read, input.signal)
    if (input.signal.aborted) throw new WebChatError('Stopped.', 'stopped')
    if (res.status === 401 || res.status === 403) throw new WebChatError('Not signed in to claude.ai in Chaude. Sign in under Settings, "Claude and ChatGPT".', 'signed-out')
    if (res.status === 429 || state.resetsAt) throw new WebChatError(state.error ?? 'You have reached your Claude limit for now.', 'limit', state.resetsAt)
    if (res.error || state.error) throw new WebChatError(state.error ?? `claude.ai could not answer: ${res.error}`, 'site')
    if (fresh) {
      // claude.ai names a chat from its first message, the way its own page does.
      await this.tabs
        .request('claude', `${base}/${encodeURIComponent(remoteId)}/title`, json, { method: 'POST', body: JSON.stringify({ message_content: input.text.slice(0, 2000), recent_titles: [] }) })
        .catch(() => undefined)
    }
    return { remoteId }
  }

  // ----- chatgpt.com -----

  private async chatgptHeaders(): Promise<Record<string, string>> {
    const session = await siteApi.chatgpt.open((path) => this.get('chatgpt', path))
    if (!session) throw new WebChatError('Not signed in to chatgpt.com in Chaude. Sign in under Settings, "Claude and ChatGPT".', 'signed-out')
    return session.headers
  }

  private async sendChatgpt(input: WebSendInput): Promise<{ remoteId: string }> {
    const headers = await this.chatgptHeaders()
    const page = input.remoteId ? `/c/${encodeURIComponent(input.remoteId)}` : `/${input.model ? `?model=${encodeURIComponent(input.model)}` : ''}`
    await this.tabs.open('chatgpt', page)
    const sentAt = Date.now()
    const typed = await this.tabs.run<string>('chatgpt', chatgptTypeScript(input.text))
    if (typed !== 'sent') {
      if (typed === 'no-composer') throw new WebChatError('chatgpt.com did not show its message box. You may need to sign in again under Settings.', 'signed-out')
      throw new WebChatError('chatgpt.com did not take the message. Try again in a moment.', 'site')
    }
    // A new chat gets its address once the site has started it.
    let remoteId = input.remoteId
    const until = Date.now() + 60_000
    while (!remoteId && Date.now() < until) {
      const m = /\/c\/([^/?#]+)/.exec(this.tabs.where('chatgpt'))
      if (m) remoteId = decodeURIComponent(m[1])
      else await sleep(300)
    }
    if (!remoteId) throw new WebChatError('chatgpt.com did not start the chat.', 'site')
    input.onChat?.(remoteId)
    const stopOnSite = () => void this.tabs.run('chatgpt', `(() => { const b = document.querySelector('[data-testid="stop-button"]'); if (b) b.click(); return 1 })()`).catch(() => {})
    input.signal.addEventListener('abort', stopOnSite, { once: true })
    try {
      const deadline = Date.now() + this.options.timeoutMs
      let last = ''
      while (Date.now() < deadline) {
        if (input.signal.aborted) throw new WebChatError('Stopped.', 'stopped')
        await sleep(this.options.pollMs)
        const chat = await this.get('chatgpt', `/backend-api/conversation/${encodeURIComponent(remoteId)}`, headers)
        const state = chatgptReplyState(chat, sentAt)
        if (state.text && state.text !== last) {
          last = state.text
          input.onText(state.text)
        }
        if (state.done) return { remoteId }
        const limited = await this.tabs.run<string>('chatgpt', CHATGPT_LIMIT_SCRIPT).catch(() => '')
        if (limited) throw new WebChatError(limited, 'limit')
      }
      throw new WebChatError('chatgpt.com took too long to answer.', 'site')
    } finally {
      input.signal.removeEventListener('abort', stopOnSite)
    }
  }
}

/** Types a message into chatgpt.com's own message box and presses its send button. */
export function chatgptTypeScript(text: string): string {
  return `(async () => {
    const wait = async (find, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { const v = find(); if (v) return v; await new Promise((r) => setTimeout(r, 200)); }
      return null;
    };
    const box = await wait(() => document.querySelector('#prompt-textarea'), 30000);
    if (!box) return 'no-composer';
    const text = ${JSON.stringify(text)};
    box.focus();
    if (box.isContentEditable) {
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, text);
      if (!box.innerText.trim()) { box.textContent = text; box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })); }
    } else {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const send = await wait(() => { const b = document.querySelector('[data-testid="send-button"]'); return b && !b.disabled ? b : null; }, 15000);
    if (!send) return 'no-send';
    send.click();
    return 'sent';
  })()`
}

/** Reads a "you have reached your limit" notice off chatgpt.com's page, if there is one. */
const CHATGPT_LIMIT_SCRIPT = `(() => {
  const el = [...document.querySelectorAll('[role="alert"], .text-token-text-error, [data-testid*="limit"]')].find((e) => /limit|try again (after|in)/i.test(e.textContent || ''));
  return el ? el.textContent.trim().slice(0, 300) : '';
})()`
