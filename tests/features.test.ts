import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Attachment, Blob, Conversation, Message, ProviderId, ProviderStatus, Settings } from '@shared/types'
import { MAX_IMAGE_BYTES, MAX_TEXT_CHARS } from '@shared/types'
import { messageBody, renderMessage, threadMessages } from '@shared/context'
import { Store } from '../src/main/store'
import { ChatEngine } from '../src/main/chat'
import { Summarizer } from '../src/main/summarizer'
import { ClaudeProvider } from '../src/main/providers/claude'
import { CodexProvider } from '../src/main/providers/codex'
import { LocalProvider, withImages } from '../src/main/providers/local'
import { makeAttachment, sniffImage } from '../src/main/attachments'
import { hidesOnClose, startedHidden } from '../src/main/background'
import { checkForUpdate, isNewerBuild, parseTag } from '../src/main/updates'
import { startMockOpenAI } from './fakes/mock-openai.mjs'
import { canRunFakes, tempDir, testSettings } from './helpers'

// The smallest valid PNG: one transparent pixel.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  delete process.env.FAKE_CLAUDE_LIMIT
  delete process.env.FAKE_LOG
})

async function setup(patch: (s: Settings) => void = () => {}) {
  const runtime = await startMockOpenAI()
  cleanup.push(() => runtime.close())
  const dir = tempDir()
  const log = join(dir, 'fake.log')
  process.env.FAKE_LOG = log
  const store = new Store(join(dir, 'app.db'))
  const settings = testSettings((s) => {
    s.local.endpoints = [{ id: 'ollama', name: 'Ollama', baseUrl: runtime.baseUrl, enabled: true }]
    patch(s)
  })
  const local = new LocalProvider(() => settings, { current: () => undefined })
  const codex = new CodexProvider(() => settings, '0.0.0-test', (l) => engine.recordLimits('chatgpt', l))
  cleanup.push(() => codex.dispose())
  const ready = (provider: ProviderId): ProviderStatus => ({ provider, installed: true, ready: true, detail: '', models: [] })
  const engine: ChatEngine = new ChatEngine(
    store,
    () => settings,
    { claude: new ClaudeProvider(() => settings, join(dir, 'tmp')), chatgpt: codex, local },
    () => ({ claude: ready('claude'), chatgpt: ready('chatgpt'), local: ready('local') }),
    { stream: () => {}, route: () => {}, approval: () => {}, denials: () => {}, busy: () => {} },
    { context: join(dir, 'context'), scratch: join(dir, 'workspace'), attachments: join(dir, 'attachments') },
    new Summarizer(store, () => settings, local)
  )
  const replies = (id: string) => store.messages(id).filter((m) => m.role === 'assistant')
  const last = (id: string): Message => replies(id)[replies(id).length - 1]
  /** Store a file the way the app does when one is picked, pasted or dropped. */
  const attach = (name: string, bytes: Buffer): Attachment => {
    const made = makeAttachment(name, bytes)
    if ('error' in made) throw new Error(made.error)
    if (made.blob) store.put<Blob>('blob', made.blob.id, made.blob)
    return made.attachment
  }
  return { store, settings, engine, runtime, dir, log, replies, last, attach }
}

describe('attachments', () => {
  it('recognises images by their content, not their name', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImage(Buffer.from('GIF89a'))).toBe('image/gif')
    expect(sniffImage(Buffer.from('RIFF0000WEBPVP8 '))).toBe('image/webp')
    expect(sniffImage(Buffer.from('hello'))).toBeUndefined()

    const disguised = makeAttachment('notes.txt', PNG)
    expect(disguised).toMatchObject({ attachment: { kind: 'image', mime: 'image/png' }, blob: { mime: 'image/png' } })
  })

  it('carries text files inside the message and refuses what it cannot use', () => {
    const text = makeAttachment('plan.md', Buffer.from('# Plan\nShip it.'))
    expect(text).toMatchObject({ attachment: { kind: 'text', name: 'plan.md', text: '# Plan\nShip it.' } })
    expect('blob' in text && text.blob).toBeFalsy()

    expect(makeAttachment('paper.pdf', Buffer.from('%PDF-1.7 ...'))).toMatchObject({ error: expect.stringContaining('PDF') })
    expect(makeAttachment('app.exe', Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x01]))).toMatchObject({ error: expect.stringContaining('not a text file') })
    expect(makeAttachment('huge.png', Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]))).toMatchObject({ error: expect.stringContaining('larger than') })

    const long = makeAttachment('log.txt', Buffer.from('x'.repeat(MAX_TEXT_CHARS + 500)))
    expect('attachment' in long && long.attachment.text!.length).toBeLessThan(MAX_TEXT_CHARS + 200)
    expect('attachment' in long && long.attachment.text).toContain('left out because it is too long')
  })

  it('writes attached files into the transcript so they survive a handoff', () => {
    const m = { text: 'Review this.', attachments: [{ id: 'a', name: 'plan.md', mime: 'text/plain', size: 9, kind: 'text', text: 'Ship it.' }, { id: 'b', name: 'shot.png', mime: 'image/png', size: 70, kind: 'image' }] } satisfies Pick<Message, 'text' | 'attachments'>
    expect(messageBody(m)).toBe('Review this.\n\n<attached_file name="plan.md">\nShip it.\n</attached_file>\n\n[Attached image: shot.png]')
    expect(messageBody({ text: 'Plain.' })).toBe('Plain.')
    const rendered = renderMessage({ ...m, id: '1', conversationId: 'c', role: 'user', createdAt: 1, deviceId: 'd', status: 'complete' })
    expect(rendered).toContain('## User')
    expect(rendered).toContain('Ship it.')
  })

  it('puts images on the newest user message for local models', () => {
    const turns = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'ok' },
      { role: 'user' as const, content: 'look' }
    ]
    const out = withImages(turns, [{ name: 'a.png', mime: 'image/png', base64: 'QUJD', path: '/tmp/a.png' }])
    expect(out[0].content).toBe('first')
    expect(out[2].content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }
    ])
    expect(withImages(turns, [])).toBe(turns)
  })
})

describe.skipIf(!canRunFakes)('attachments through the engine', () => {
  it('sends an image and a text file to each assistant in the form it expects', async () => {
    const { engine, store, last, attach, log, runtime, dir } = await setup()
    for (const provider of ['claude', 'chatgpt', 'local'] as const) {
      const conv = engine.createConversation({ provider })
      const files = [attach('shot.png', PNG), attach('plan.md', Buffer.from('Ship it on Friday.'))]
      await engine.send({ conversationId: conv.id, text: 'What is in these?', attachments: files })
      expect(last(conv.id), provider).toMatchObject({ provider, status: 'complete' })
      expect(last(conv.id).text, provider).toContain('I can see 1 image')
      const user = store.messages(conv.id).find((m) => m.role === 'user')!
      expect(user.text).toBe('What is in these?')
      expect(user.attachments?.map((a) => a.kind)).toEqual(['image', 'text'])
    }
    // Claude got one structured message, ChatGPT got a file it could open, the local model got a data URL.
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(lines.find((l) => l.tool === 'claude' && l.args?.includes('--input-format'))).toBeTruthy()
    expect(lines.find((l) => l.tool === 'claude' && l.images === 1)).toBeTruthy()
    expect(lines.find((l) => l.tool === 'codex' && l.images === 1)).toBeTruthy()
    expect(existsSync(join(dir, 'attachments'))).toBe(true)
    const sent = runtime.requests[runtime.requests.length - 1].messages
    const parts = sent[sent.length - 1].content
    expect(parts[0].text).toContain('<attached_file name="plan.md">\nShip it on Friday.')
    expect(parts[1].image_url.url.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('sends a message that is only an attachment, and names the chat after it', async () => {
    const { engine, store, last, attach } = await setup()
    const conv = engine.createConversation({ provider: 'claude' })
    await engine.send({ conversationId: conv.id, text: '', attachments: [attach('holiday.png', PNG)] })
    expect(last(conv.id).text).toContain('I can see 1 image')
    expect(store.get<Conversation>('conversation', conv.id)?.title).toBe('holiday.png')
  })

  it('takes earlier images along when the conversation moves to another assistant', async () => {
    const { engine, last, attach } = await setup()
    const conv = engine.createConversation({ provider: 'claude' })
    await engine.send({ conversationId: conv.id, text: 'Here is my floor plan.', attachments: [attach('plan.png', PNG)] })
    // Same assistant again: it already has the image.
    await engine.send({ conversationId: conv.id, text: 'Thanks.' })
    expect(last(conv.id).text).not.toContain('I can see')

    engine.switchProvider(conv.id, 'chatgpt')
    await engine.send({ conversationId: conv.id, text: 'Where would you put the sofa?' })
    expect(last(conv.id).text).toContain('I received the context file')
    expect(last(conv.id).text).toContain('I can see 1 image')
  })

  it('ignores attachments whose bytes were never stored', async () => {
    const { engine, store, last } = await setup()
    const conv = engine.createConversation({ provider: 'claude' })
    const ghost: Attachment = { id: 'missing', name: 'ghost.png', mime: 'image/png', size: 5, kind: 'image' }
    await engine.send({ conversationId: conv.id, text: 'Anything attached?', attachments: [ghost] })
    expect(store.messages(conv.id)[0].attachments).toBeUndefined()
    expect(last(conv.id).text).not.toContain('I can see')
  })

  it('removes image bytes with the conversation, unless a branch still shows them', async () => {
    const { engine, store, attach, last } = await setup()
    const conv = engine.createConversation({ provider: 'claude' })
    const image = attach('plan.png', PNG)
    await engine.send({ conversationId: conv.id, text: 'Keep this.', attachments: [image] })
    const copy = engine.branch(conv.id, last(conv.id).id)!

    store.deleteConversation(conv.id)
    expect(store.get<Blob>('blob', image.id)?.base64).toBeTruthy()
    store.deleteConversation(copy.id)
    expect(store.get<Blob>('blob', image.id)).toBeUndefined()
  })
})

describe.skipIf(!canRunFakes)('branching', () => {
  it('copies the conversation up to a message and lets the two go separate ways', async () => {
    const { engine, store, last, replies } = await setup()
    const conv = engine.createConversation({ provider: 'claude', title: 'Trip' })
    await engine.send({ conversationId: conv.id, text: 'Plan a trip to Lisbon.' })
    const firstReply = last(conv.id)
    await engine.send({ conversationId: conv.id, text: 'Make it five days.' })

    const copy = engine.branch(conv.id, firstReply.id)!
    expect(copy).toMatchObject({ title: 'Trip (branch)', provider: 'claude' })
    const copied = store.messages(copy.id)
    expect(copied.map((m) => m.text)).toEqual(['Plan a trip to Lisbon.', firstReply.text])
    expect(copied.every((m) => m.conversationId === copy.id)).toBe(true)
    expect(copied.some((m) => m.id === firstReply.id)).toBe(false)

    // The branch has no session of its own, so the assistant is caught up from the context file.
    await engine.send({ conversationId: copy.id, text: 'Make it a weekend.' })
    expect(last(copy.id).text).toContain('I received the context file')
    expect(replies(conv.id)).toHaveLength(2)
    expect(threadMessages(store.messages(copy.id))).toHaveLength(4)
    expect(engine.branch(conv.id, 'no-such-message')).toBeUndefined()
  })
})

describe.skipIf(!canRunFakes)('automatic failover', () => {
  it('asks first by default', async () => {
    const { engine, last, replies } = await setup()
    const conv = engine.createConversation({ provider: 'claude' })
    await engine.send({ conversationId: conv.id, text: 'Hello [limit]' })
    expect(replies(conv.id)).toHaveLength(1)
    expect(last(conv.id)).toMatchObject({ provider: 'claude', status: 'error', error: { code: 'rate_limit' } })
  })

  it('carries on with another assistant when asked to', async () => {
    const { engine, store, last, replies } = await setup((s) => (s.autoFailover = true))
    const conv = engine.createConversation({ provider: 'claude' })
    await engine.send({ conversationId: conv.id, text: 'Remember that the door code is 4471.' })
    // Only Claude is out of room. The stand-in for ChatGPT answers normally.
    process.env.FAKE_CLAUDE_LIMIT = '1'
    await engine.send({ conversationId: conv.id, text: 'What is the door code?' })

    // The failed reply is gone, a note explains what happened, and ChatGPT answered with the context.
    expect(replies(conv.id).map((m) => m.provider)).toEqual(['claude', 'chatgpt'])
    expect(last(conv.id)).toMatchObject({ provider: 'chatgpt', status: 'complete' })
    expect(last(conv.id).text).toContain('I received the context file')
    expect(store.messages(conv.id).filter((m) => m.role === 'note').map((m) => m.text)).toEqual(['Claude reached its limit. Continued on ChatGPT.'])
    // The conversation stays on the assistant that has room.
    expect(store.get<Conversation>('conversation', conv.id)?.provider).toBe('chatgpt')
  })

  it('never sends a private conversation to a cloud service', async () => {
    const { engine, last } = await setup((s) => (s.autoFailover = true))
    const conv = engine.createConversation({ provider: 'claude', private: true })
    await engine.send({ conversationId: conv.id, text: 'Secret.', provider: 'chatgpt' })
    expect(last(conv.id).provider).toBe('local')
  })
})

describe('background and updates', () => {
  it('closes to the tray only on a hub that is not a Mac', () => {
    const base = { platform: 'win32', hosting: true, keepRunning: true, quitting: false }
    expect(hidesOnClose(base)).toBe(true)
    expect(hidesOnClose({ ...base, quitting: true })).toBe(false)
    expect(hidesOnClose({ ...base, hosting: false })).toBe(false)
    expect(hidesOnClose({ ...base, keepRunning: false })).toBe(false)
    expect(hidesOnClose({ ...base, platform: 'darwin' })).toBe(false)
    expect(startedHidden(['app.exe', '--hidden'], false)).toBe(true)
    expect(startedHidden(['app.exe'], true)).toBe(true)
    expect(startedHidden(['app.exe'], false)).toBe(false)
  })

  it('reads release tags and compares builds', () => {
    expect(parseTag('v0.2.0-build.14')).toEqual({ version: '0.2.0', build: 14 })
    expect(parseTag('v1.0.0')).toEqual({ version: '1.0.0', build: 0 })
    expect(parseTag('nightly')).toBeUndefined()
    expect(isNewerBuild({ version: '0.2.0', build: 15 }, { version: '0.2.0', build: 14 })).toBe(true)
    expect(isNewerBuild({ version: '0.2.0', build: 14 }, { version: '0.2.0', build: 14 })).toBe(false)
    expect(isNewerBuild({ version: '0.3.0', build: 1 }, { version: '0.2.0', build: 90 })).toBe(true)
    expect(isNewerBuild({ version: '0.1.0', build: 99 }, { version: '0.2.0', build: 1 })).toBe(false)
    // A build made on a developer's machine has no number and is left alone.
    expect(isNewerBuild({ version: '0.2.0', build: 15 }, { version: '0.2.0', build: 0 })).toBe(false)
    expect(isNewerBuild({ version: '0.10.0', build: 1 }, { version: '0.9.0', build: 1 })).toBe(true)
  })

  it('finds a newer release and survives a server that is down', async () => {
    let tag = 'v0.2.0-build.9'
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ tag_name: tag, html_url: 'https://github.com/Doggo252/chaudecal-ai/releases/tag/x' }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/latest`

    expect(await checkForUpdate({ version: '0.2.0', build: 4 }, url)).toEqual({ version: '0.2.0', build: 9, url: 'https://github.com/Doggo252/chaudecal-ai/releases/tag/x' })
    expect(await checkForUpdate({ version: '0.2.0', build: 9 }, url)).toBeUndefined()
    tag = 'not a tag'
    expect(await checkForUpdate({ version: '0.2.0', build: 4 }, url)).toBeUndefined()
    expect(await checkForUpdate({ version: '0.2.0', build: 4 }, 'http://127.0.0.1:1/none')).toBeUndefined()
  })
})
