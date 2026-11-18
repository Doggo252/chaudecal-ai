import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Blob, Conversation, Message, ProviderId, ProviderStatus, RunWireEvent, Settings } from '@shared/types'
import { Store } from '../src/main/store'
import { ChatEngine } from '../src/main/chat'
import { Summarizer } from '../src/main/summarizer'
import { ClaudeProvider } from '../src/main/providers/claude'
import { CodexProvider } from '../src/main/providers/codex'
import { LocalProvider } from '../src/main/providers/local'
import { HubServer } from '../src/main/sync/hubServer'
import { HubClient } from '../src/main/sync/hubClient'
import { checkFolder, cleanSendInput, createRunHost, RemoteRuns } from '../src/main/sync/remoteRuns'
import { makeAttachment } from '../src/main/attachments'
import { canRunFakes, tempDir, testSettings, until } from './helpers'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  delete process.env.FAKE_LOG
  delete process.env.FAKE_DELAY_MS
})

/** A hub with its own assistants, and a second device connected to it. */
async function setup(patch: (hub: Settings) => void = () => {}) {
  const dir = tempDir()
  const log = join(dir, 'fake.log')
  process.env.FAKE_LOG = log

  // ----- the hub -----
  const hubStore = new Store(join(dir, 'hub.db'))
  const hubSettings = testSettings((s) => {
    s.deviceName = 'Hub PC'
    s.hub.hostEnabled = true
    s.hub.port = 0
    s.hub.token = 'pair-me'
    s.hub.allowRemoteRuns = true
    patch(s)
  })
  const local = new LocalProvider(() => hubSettings, { current: () => undefined })
  const codex = new CodexProvider(() => hubSettings, '0.0.0-test', () => {})
  cleanup.push(() => codex.dispose())
  const ready = (provider: ProviderId): ProviderStatus => ({ provider, installed: true, ready: true, detail: '', models: [] })
  const statuses = () => ({ claude: ready('claude'), chatgpt: ready('chatgpt') })
  // eslint-disable-next-line prefer-const
  let server: HubServer
  const engine = new ChatEngine(
    hubStore,
    () => hubSettings,
    { claude: new ClaudeProvider(() => hubSettings, join(dir, 'tmp')), chatgpt: codex, local },
    statuses,
    {
      stream: (message) => server.broadcastRun({ type: 'stream', message }),
      route: (conversationId, decision) => server.broadcastRun({ type: 'route', conversationId, decision }),
      approval: (conversationId, messageId, request, settled) => server.broadcastRun({ type: 'approval', conversationId, messageId, request, settled }),
      denials: (conversationId, messageId, denials) => server.broadcastRun({ type: 'denials', conversationId, messageId, denials }),
      busy: (conversationId, busy) => server.broadcastRun({ type: 'busy', conversationId, busy })
    },
    { context: join(dir, 'context'), scratch: join(dir, 'workspace'), attachments: join(dir, 'attachments') },
    new Summarizer(hubStore, () => hubSettings, local)
  )
  const busy = () => hubStore.list<Conversation>('conversation').filter((c) => engine.isBusy(c.id)).map((c) => c.id)
  server = new HubServer(hubStore, () => hubSettings, '0.0.0-test', createRunHost(engine, () => hubSettings, statuses, busy))
  await server.start()
  cleanup.push(() => server.stop())

  // ----- the other device -----
  const store = new Store(join(dir, 'mac.db'))
  const settings = testSettings((s) => {
    s.hub.remoteUrl = `http://127.0.0.1:${server.port}`
    s.hub.remoteToken = 'pair-me'
  })
  const client = new HubClient(store, () => settings, () => {})
  const events: RunWireEvent[] = []
  const remote = new RemoteRuns(client, (e) => void events.push(e), () => {})
  client.start()
  cleanup.push(() => client.stop())
  await until(() => client.status().connected, 8000, 'the device to connect to the hub')
  await remote.refresh()

  const conversation = (partial: Partial<Conversation> = {}): Conversation => {
    const conv: Conversation = { id: `c-${Math.random().toString(36).slice(2, 8)}`, title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), provider: 'claude', models: {}, mode: 'chat', runOnHub: true, ...partial }
    store.put('conversation', conv.id, conv)
    return conv
  }
  const replies = (id: string) => store.messages(id).filter((m) => m.role === 'assistant')
  const finished = (id: string, count = 1) => until(() => replies(id).length >= count && !remote.isBusy(id), 15000, 'the reply to come back from the hub')
  return { dir, log, hub: { store: hubStore, settings: hubSettings, engine, server }, store, client, remote, events, conversation, replies, finished }
}

describe('remote run requests', () => {
  it('rebuilds a request from known fields only', () => {
    expect(cleanSendInput({ conversationId: 'c1', text: 'hi', provider: 'chatgpt', variant: 'full', retry: true, allow: ['Bash(ls)', 7], compare: ['claude', 'nope'], evil: { nested: true } })).toEqual({
      conversationId: 'c1',
      text: 'hi',
      provider: 'chatgpt',
      variant: 'full',
      retry: true,
      allow: ['Bash(ls)'],
      compare: ['claude']
    })
    expect(cleanSendInput({ conversationId: 'c1' })).toEqual({ conversationId: 'c1', text: '' })
    expect(cleanSendInput({ text: 'no conversation' })).toBeUndefined()
    expect(cleanSendInput(null)).toBeUndefined()
  })

  it('accepts only a real folder given by its full path', () => {
    const dir = tempDir()
    expect(checkFolder(dir)).toEqual({ path: dir })
    expect(checkFolder(`  ${dir}  `)).toEqual({ path: dir })
    expect(checkFolder('')).toEqual({ path: '' })
    expect(checkFolder('projects/app').error).toContain('full path')
    expect(checkFolder(join(dir, 'missing')).error).toContain('does not exist')
  })
})

describe.skipIf(!canRunFakes)('running assistants on the hub from another device', () => {
  it('stays off until the hub allows it', async () => {
    const { remote, conversation } = await setup((s) => (s.hub.allowRemoteRuns = false))
    expect(remote.info()).toMatchObject({ enabled: false, deviceName: 'Hub PC' })
    expect(remote.available()).toBe(false)
    const conv = conversation()
    await expect(remote.send({ conversationId: conv.id, text: 'Hello' })).rejects.toThrow(/turned off/)
    expect(remote.isBusy(conv.id)).toBe(false)
  })

  it('answers on the hub and brings the reply back, streaming on the way', async () => {
    const { remote, hub, store, events, conversation, replies, finished } = await setup()
    expect(remote.info()).toMatchObject({ enabled: true, deviceName: 'Hub PC', providers: { claude: { ready: true } } })
    const conv = conversation()

    await remote.send({ conversationId: conv.id, text: 'My cat is called Biscuit.' })
    await finished(conv.id)
    const reply = replies(conv.id)[0]
    expect(reply).toMatchObject({ provider: 'claude', status: 'complete', text: 'Claude here. You said: "My cat is called Biscuit.".' })
    // The hub did the work: both the question and the answer were written there.
    expect(store.messages(conv.id).map((m) => m.deviceId)).toEqual([hub.store.deviceId, hub.store.deviceId])
    expect(hub.store.get<Conversation>('conversation', conv.id)?.title).toBe('My cat is called Biscuit.')

    // Progress arrived live, and the finished reply was here before the run was reported over.
    const forConv = events.filter((e) => (e.type === 'stream' ? e.message.conversationId === conv.id : e.conversationId === conv.id))
    expect(forConv[0]).toEqual({ type: 'busy', conversationId: conv.id, busy: true })
    expect(forConv[forConv.length - 1]).toEqual({ type: 'busy', conversationId: conv.id, busy: false })
    const partial = forConv.filter((e): e is Extract<RunWireEvent, { type: 'stream' }> => e.type === 'stream')
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.every((e) => e.message.id === reply.id)).toBe(true)

    // The hub keeps the session, so a follow-up from the other device resumes it.
    await remote.send({ conversationId: conv.id, text: 'What did I just tell you?' })
    await finished(conv.id, 2)
    expect(replies(conv.id)[1].text).toContain('I resumed my earlier session')
  })

  it('takes attachments along', async () => {
    const { remote, store, conversation, replies, finished } = await setup()
    const conv = conversation({ provider: 'chatgpt' })
    const made = makeAttachment('plan.png', PNG)
    if ('error' in made) throw new Error(made.error)
    store.put<Blob>('blob', made.blob!.id, made.blob!)
    await remote.send({ conversationId: conv.id, text: 'What is this?', attachments: [made.attachment] })
    await finished(conv.id)
    expect(replies(conv.id)[0]).toMatchObject({ provider: 'chatgpt', status: 'complete' })
    expect(replies(conv.id)[0].text).toContain('I can see 1 image')
  })

  it('works in a folder on the hub, chosen from the other device', async () => {
    const { remote, hub, dir, conversation } = await setup()
    const conv = conversation({ mode: 'edit' })
    expect(await remote.getWorkspace(conv.id)).toBe('')
    expect((await remote.setWorkspace(conv.id, join(dir, 'nowhere'))).error).toContain('does not exist')
    expect(await remote.setWorkspace(conv.id, dir)).toEqual({ path: dir })
    expect(await remote.getWorkspace(conv.id)).toBe(dir)
    expect(hub.engine.workspace(conv.id)).toBe(dir)
    expect(await remote.setWorkspace(conv.id, '')).toEqual({ path: '' })
    expect(hub.engine.workspace(conv.id)).toBe('')
  })

  it('can be stopped from the other device', async () => {
    process.env.FAKE_DELAY_MS = '150'
    const { remote, store, events, conversation } = await setup()
    const conv = conversation()
    await remote.send({ conversationId: conv.id, text: 'Tell me a very long story about a lighthouse keeper and the sea.' })
    await until(() => events.some((e) => e.type === 'stream' && e.message.text.length > 0), 8000, 'the reply to start')
    // A second message is refused while the first is still being answered.
    await expect(remote.send({ conversationId: conv.id, text: 'Hurry up.' })).rejects.toThrow(/still answering/)
    remote.stop(conv.id)
    await until(() => !remote.isBusy(conv.id), 8000, 'the run to stop')
    const reply = store.messages(conv.id).find((m) => m.role === 'assistant') as Message
    expect(reply.status).toBe('stopped')
    expect(reply.text.length).toBeGreaterThan(0)
  })

  it('asks the other device before running a command', async () => {
    const { remote, events, log, conversation, replies, finished } = await setup()
    const conv = conversation({ provider: 'chatgpt', mode: 'edit' })
    await remote.send({ conversationId: conv.id, text: 'Install the packages [approve]' })
    await until(() => events.some((e) => e.type === 'approval'), 8000, 'the approval request to arrive')
    const ask = events.find((e): e is Extract<RunWireEvent, { type: 'approval' }> => e.type === 'approval')!
    expect(ask.request).toMatchObject({ kind: 'command', summary: 'npm install' })
    remote.respondApproval(conv.id, ask.messageId, ask.request.id, 'accept')
    await finished(conv.id)
    expect(replies(conv.id)[0].status).toBe('complete')
    expect(readFileSync(log, 'utf8')).toContain('"approval":"accept"')
  })

  it("shows Claude's question on the other device, and takes the answer from there", async () => {
    const { remote, events, log, conversation, replies, finished } = await setup()
    const conv = conversation({ provider: 'claude', mode: 'edit' })
    await remote.send({ conversationId: conv.id, text: 'Run the tests [deny]' })
    const asks = () => events.filter((e): e is Extract<RunWireEvent, { type: 'approval' }> => e.type === 'approval')
    await until(() => asks().length === 1, 8000, 'the question to arrive')
    expect(asks()[0].request).toMatchObject({ provider: 'claude', kind: 'command', summary: 'npm test' })
    remote.respondApproval(conv.id, asks()[0].messageId, asks()[0].request.id, 'accept')
    await finished(conv.id)
    expect(replies(conv.id)[0]).toMatchObject({ status: 'complete', provider: 'claude' })
    expect(replies(conv.id)[0].text).toContain('I ran the tests')
    // The hub confirms the question is settled, which is what clears the card on every device.
    expect(asks()[1]).toMatchObject({ settled: true, request: { id: asks()[0].request.id } })
    expect(readFileSync(log, 'utf8')).toContain('"behavior":"allow"')
  })

  it('notices runs that started or ended while it was not listening', async () => {
    process.env.FAKE_DELAY_MS = '120'
    const { remote, hub, events, conversation, client } = await setup()
    const conv = conversation()
    await client.flush()
    // Started at the hub itself, not through this device.
    const run = hub.engine.send({ conversationId: conv.id, text: 'A long answer please, with plenty of words in it.' })
    await until(() => hub.engine.isBusy(conv.id), 4000, 'the hub to start')
    events.length = 0
    await remote.refresh()
    expect(remote.isBusy(conv.id)).toBe(true)
    hub.engine.stop(conv.id)
    await run
    await until(() => !remote.isBusy(conv.id), 8000, 'the end of the run to be noticed')
  })
})
