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
import { CLAUDE_ROOT, chatgptReplyState, chatgptWebModels, claudeStreamEvent, sseReader, type ClaudeStreamState } from '@shared/webChat'
import type { ModelInfo } from '@shared/models'
import { siteApi } from '@shared/webImport'
import type { WebTabs } from './webtabs'

/** A file sent along with a message: text read from it, or a picture's bytes. */
export interface WebFile {
  name: string
  mime: string
  text?: string
  base64?: string
}

/** The longest text taken from the files of one message, so a huge file cannot swamp the chat. */
const MAX_FILE_TEXT = 400_000

/** Text files written into a message, for a site that is typed into. */
export function withFileText(text: string, files: WebFile[] = []): string {
  let room = MAX_FILE_TEXT
  const parts: string[] = []
  for (const f of files) {
    if (f.text === undefined || room <= 0) continue
    const body = f.text.slice(0, room)
    room -= body.length
    parts.push(`File "${f.name}":\n\n${body}${body.length < f.text.length ? '\n\n(The rest of the file was left out.)' : ''}`)
  }
  return parts.length ? [text, ...parts].filter(Boolean).join('\n\n') : text
}

export interface WebSendInput {
  service: WebService
  /** The chat on the site, when it exists already. */
  remoteId?: string
  /** The site's id of the message this one answers (claude.ai). */
  parentId?: string
  /** The site's project a new chat starts in. */
  projectId?: string
  text: string
  /** Files from this computer, attached to the message. */
  files?: WebFile[]
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

  private modelCache = new Map<WebService, { at: number; models: ModelInfo[] }>()

  /** The models the site offers this account, for its regular chats. Kept for an hour. */
  async models(service: WebService): Promise<ModelInfo[]> {
    const cached = this.modelCache.get(service)
    if (cached && Date.now() - cached.at < 3600_000) return cached.models
    // claude.ai's list of models is not read yet; its chats use the site's default.
    if (service !== 'chatgpt') return []
    try {
      const models = chatgptWebModels(await this.get('chatgpt', '/backend-api/models?history_and_training_disabled=false', await this.chatgptHeaders()))
      this.modelCache.set(service, { at: Date.now(), models })
      return models
    } catch {
      return cached?.models ?? []
    }
  }

  /** Sends one message and waits for the whole answer. Gives back the chat's id on the site. */
  async send(input: WebSendInput): Promise<{ remoteId: string }> {
    return input.service === 'claude' ? this.sendClaude(input) : this.sendChatgpt(input)
  }

  /** Gives a chat on the site a new name, so the site and its apps show the name given here. */
  async rename(service: WebService, remoteId: string, title: string): Promise<boolean> {
    const json = { 'content-type': 'application/json' }
    if (service === 'claude') {
      const org = await this.claudeOrg()
      const res = await this.tabs.request('claude', `/api/organizations/${encodeURIComponent(org)}/chat_conversations/${encodeURIComponent(remoteId)}`, json, { method: 'PUT', body: JSON.stringify({ name: title }) })
      return res.status >= 200 && res.status < 300
    }
    const headers = await this.chatgptHeaders()
    const res = await this.tabs.request('chatgpt', `/backend-api/conversation/${encodeURIComponent(remoteId)}`, { ...headers, ...json }, { method: 'PATCH', body: JSON.stringify({ title }) })
    return res.status >= 200 && res.status < 300
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
      const made = await this.tabs.request('claude', base, json, { method: 'POST', body: JSON.stringify({ uuid: remoteId, name: '', ...(input.model ? { model: input.model } : {}), ...(input.projectId ? { project_uuid: input.projectId } : {}) }) })
      if (made.status === 401 || made.status === 403) throw new WebChatError('Not signed in to claude.ai in Chaude. Sign in under Settings, "Claude and ChatGPT".', 'signed-out')
      if (made.status < 200 || made.status >= 300) throw new WebChatError(`claude.ai could not start the chat (${made.status}).`, 'site')
    }
    input.onChat?.(remoteId)
    // Text files go with the message, as claude.ai's page sends them. Pictures are uploaded first.
    const attachments: { file_name: string; file_type: string; file_size: number; extracted_content: string }[] = []
    const files: string[] = []
    let room = MAX_FILE_TEXT
    for (const f of input.files ?? []) {
      if (f.text !== undefined) {
        const text = f.text.slice(0, Math.max(0, room))
        room -= text.length
        attachments.push({ file_name: f.name, file_type: f.mime === 'application/pdf' ? 'text/plain' : f.mime || 'text/plain', file_size: text.length, extracted_content: text })
      } else if (f.base64) {
        const up = await this.tabs.upload('claude', `/api/${encodeURIComponent(org)}/upload`, { name: f.name, mime: f.mime, base64: f.base64 })
        if (up.status === 401 || up.status === 403) throw new WebChatError('Not signed in to claude.ai in Chaude. Sign in under Settings, "Claude and ChatGPT".', 'signed-out')
        let uuid = ''
        try {
          const got = JSON.parse(up.body) as { file_uuid?: string; uuid?: string }
          uuid = got.file_uuid ?? got.uuid ?? ''
        } catch {
          // Not an answer the app understands.
        }
        if (up.status < 200 || up.status >= 300 || !uuid) throw new WebChatError(`claude.ai did not take the picture "${f.name}" (${up.status}).`, 'site')
        files.push(uuid)
      }
    }
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
      attachments,
      files,
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
    // A new chat in a project starts on the project's own page.
    const start = input.projectId ? `/g/${encodeURIComponent(input.projectId)}/project` : '/'
    // The site picks up a model given in the address, for a new chat and for one that carries on.
    const page = `${input.remoteId ? `/c/${encodeURIComponent(input.remoteId)}` : start}${input.model ? `?model=${encodeURIComponent(input.model)}` : ''}`
    await this.tabs.open('chatgpt', page)
    const sentAt = Date.now()
    const pictures = (input.files ?? []).filter((f) => f.base64).map((f) => ({ name: f.name, mime: f.mime, base64: f.base64! }))
    const text = withFileText(input.text, input.files)
    const ready = await this.tabs.run<string>('chatgpt', chatgptPrepareScript(pictures))
    if (ready === 'signed-out') throw new WebChatError('Not signed in to chatgpt.com in Chaude. Sign in under Settings, "Claude and ChatGPT".', 'signed-out')
    if (ready === 'no-upload') throw new WebChatError('chatgpt.com did not take the pictures. Try again, or send them in a chat that works on this computer.', 'site')
    if (ready !== 'ready') {
      const [, title, shown] = ready.split('|')
      throw new WebChatError(`chatgpt.com did not show its message box${title ? ` (the page says "${title}${shown ? `: ${shown}` : ''}")` : ''}. Try again in a moment.`, 'site')
    }
    // Typed as a keyboard would, which every version of the site's message box takes.
    await this.tabs.insertText('chatgpt', text)
    const typed = await this.tabs.run<string>('chatgpt', chatgptSendScript(text, pictures.length > 0))
    if (typed !== 'sent') throw new WebChatError('chatgpt.com did not take the message. Try again in a moment.', 'site')
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
    const stopOnSite = () => void this.tabs.run('chatgpt', `(() => { const b = document.querySelector('[data-testid="stop-button"], button[aria-label="Stop generating"]'); if (b) b.click(); return 1 })()`).catch(() => {})
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

// chatgpt.com has changed its message box more than once, so each of its known forms is tried.
const CHATGPT_FIND = `
  const findBox = () =>
    document.querySelector('#prompt-textarea') ||
    document.querySelector('form textarea[name="prompt"]') ||
    document.querySelector('main form [contenteditable="true"]') ||
    document.querySelector('form textarea');
  const findSend = () =>
    [...document.querySelectorAll('[data-testid="send-button"], [data-composer-submit], button[aria-label="Send message"], button[aria-label="Send prompt"]')].find((b) => !b.disabled && b.offsetParent !== null) ||
    [...document.querySelectorAll('[data-testid="send-button"], [data-composer-submit]')].find((b) => !b.disabled);
  const boxText = (box) => (box.isContentEditable ? box.innerText : box.value) || '';
  const wait = async (find, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = find(); if (v) return v; await new Promise((r) => setTimeout(r, 200)); }
    return null;
  };
`

/**
 * Gets chatgpt.com's message box ready: found, emptied and focused, with any pictures added.
 * Gives back 'ready', 'signed-out', 'no-upload', or 'no-composer' with what the page shows.
 */
export function chatgptPrepareScript(pictures: { name: string; mime: string; base64: string }[] = []): string {
  return `(async () => {
    ${CHATGPT_FIND}
    const box = await wait(findBox, 30000);
    // The page for people who are not signed in has a message box too.
    if (document.querySelector('form[data-logged-out], form[action*="/unauth"]')) return 'signed-out';
    if (!box) return 'no-composer|' + document.title + '|' + (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 160);
    const pictures = ${JSON.stringify(pictures)};
    if (pictures.length) {
      // Pictures go in through the page's own file picker, as if chosen there.
      const input = document.querySelector('input[type="file"][accept*="image"]') || document.querySelector('input[type="file"]');
      if (!input) return 'no-upload';
      const dt = new DataTransfer();
      for (const p of pictures) dt.items.add(new File([Uint8Array.from(atob(p.base64), (c) => c.charCodeAt(0))], p.name, { type: p.mime }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
    }
    box.focus();
    if (boxText(box).trim()) document.execCommand('selectAll', false);
    return 'ready';
  })()`
}

/**
 * After the text was typed in: makes sure it is in the box, then presses send.
 * Gives back 'sent', 'no-composer' or 'no-send'.
 */
export function chatgptSendScript(text: string, withPictures = false): string {
  return `(async () => {
    ${CHATGPT_FIND}
    const box = findBox();
    if (!box) return 'no-composer';
    const text = ${JSON.stringify(text)};
    // Typing did not reach the box: put the text in the way a paste would.
    if (boxText(box).trim() !== text.trim()) {
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
    }
    const send = await wait(findSend, ${withPictures ? 120000 : 15000});
    if (send) {
      // Give the page a moment to see the text before the button is pressed.
      await wait(() => !send.hasAttribute('data-visually-disabled'), 1500);
      send.click();
      return 'sent';
    }
    if (box.form && box.form.requestSubmit) { box.form.requestSubmit(); return 'sent'; }
    return 'no-send';
  })()`
}

/** Reads a "you have reached your limit" notice off chatgpt.com's page, if there is one. */
const CHATGPT_LIMIT_SCRIPT = `(() => {
  const el = [...document.querySelectorAll('[role="alert"], .text-token-text-error, [data-testid*="limit"]')].find((e) => /limit|try again (after|in)/i.test(e.textContent || ''));
  return el ? el.textContent.trim().slice(0, 300) : '';
})()`
