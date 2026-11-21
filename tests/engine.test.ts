import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalRequest, Conversation, Message, PermissionDenial, ProviderId, ProviderStatus, RouteDecision, Settings } from '@shared/types'
import { threadMessages } from '@shared/context'
import { Store } from '../src/main/store'
import { type WebChats, ChatEngine } from '../src/main/chat'
import { Summarizer } from '../src/main/summarizer'
import { ClaudeProvider } from '../src/main/providers/claude'
import { CodexProvider } from '../src/main/providers/codex'
import { LocalProvider } from '../src/main/providers/local'
import { startMockOpenAI } from './fakes/mock-openai.mjs'
import { canRunFakes, tempDir, testSettings, until } from './helpers'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  delete process.env.FAKE_CLAUDE_UTILIZATION
  delete process.env.FAKE_CLAUDE_LIMIT
  delete process.env.FAKE_CLAUDE_NO_LIVE
})

async function setup(patch: (s: Settings) => void = () => {}, web?: WebChats) {
  const runtime = await startMockOpenAI()
  cleanup.push(() => runtime.close())
  const dir = tempDir()
  const store = new Store(join(dir, 'app.db'))
  const settings = testSettings((s) => {
    s.local.endpoints = [{ id: 'ollama', name: 'Ollama', baseUrl: runtime.baseUrl, enabled: true }]
    patch(s)
  })
  const local = new LocalProvider(() => settings, { current: () => undefined })
  const codex = new CodexProvider(() => settings, '0.0.0-test', (l) => engine.recordLimits('chatgpt', l))
  cleanup.push(() => codex.dispose())
  const ready = (provider: ProviderId): ProviderStatus => ({ provider, installed: true, ready: true, detail: '', models: [] })
  const seen = { routes: [] as RouteDecision[], approvals: [] as { messageId: string; request: ApprovalRequest; settled?: boolean }[], denials: [] as PermissionDenial[][], streamed: 0 }
  const engine: ChatEngine = new ChatEngine(
    store,
    () => settings,
    { claude: new ClaudeProvider(() => settings, join(dir, 'tmp')), chatgpt: codex, local },
    () => ({ claude: ready('claude'), chatgpt: ready('chatgpt'), local: ready('local') }),
    {
      stream: () => void seen.streamed++,
      route: (_c, d) => void seen.routes.push(d),
      approval: (_c, messageId, request, settled) => void seen.approvals.push({ messageId, request, settled }),
      denials: (_c, _m, d) => void seen.denials.push(d),
      busy: () => {}
    },
    { context: join(dir, 'context'), scratch: join(dir, 'workspace'), attachments: join(dir, 'attachments') },
    new Summarizer(store, () => settings, local),
    web
  )
  const replies = (id: string) => store.messages(id).filter((m) => m.role === 'assistant')
  const last = (id: string): Message => replies(id)[replies(id).length - 1]
  return { store, settings, engine, seen, runtime, dir, replies, last }
}

describe.skipIf(!canRunFakes)('regular chats that use this computer', () => {
  it('does one turn here with Claude Code, and tells the website about it with the next message', async () => {
    const sent: string[] = []
    const web: WebChats = {
      send: async (i) => {
        sent.push(i.text)
        i.onChat?.('r1')
        i.onText('Site answer.')
        return { remoteId: 'r1' }
      },
      refresh: async () => {}
    }
    const { engine, last } = await setup(() => {}, web)
    const conv = engine.createConversation({ provider: 'claude', kind: 'chat', mode: 'chat' })
    await engine.send({ conversationId: conv.id, text: 'Hello site.' })
    expect(sent).toEqual(['Hello site.'])
    expect(last(conv.id)).toMatchObject({ text: 'Site answer.', provider: 'claude' })
    await engine.send({ conversationId: conv.id, text: 'Tidy my downloads.', computer: true })
    expect(last(conv.id)).toMatchObject({ provider: 'claude', onComputer: true, status: 'complete' })
    expect(last(conv.id).text).toContain('Claude here')
    expect(sent).toHaveLength(1)
    await engine.send({ conversationId: conv.id, text: 'Thanks.' })
    expect(sent[1]).toMatch(/^\(Meanwhile, on my computer, through Chaude:/)
    expect(sent[1]).toContain('I asked: Tidy my downloads.')
    expect(sent[1]).toContain('Result: Claude here')
    expect(sent[1].endsWith('Thanks.')).toBe(true)
  })
})

describe.skipIf(!canRunFakes)('conversation engine', () => {
  it('carries one conversation across Claude, ChatGPT and local AI', async () => {
    const { engine, store, last, runtime } = await setup()
    const conv = engine.createConversation({ provider: 'claude' })

    await engine.send({ conversationId: conv.id, text: 'My cat is called Biscuit.' })
    expect(last(conv.id)).toMatchObject({ provider: 'claude', status: 'complete', text: 'Claude here. You said: "My cat is called Biscuit.".' })
    expect(store.get<Conversation>('conversation', conv.id)?.title).toBe('My cat is called Biscuit.')

    // Same provider again: its own session continues, nothing is re-sent.
    await engine.send({ conversationId: conv.id, text: 'What did I just tell you?' })
    expect(last(conv.id).text).toBe('Claude here. You said: "What did I just tell you?". I resumed my earlier session.')

    // First turn on ChatGPT: it has never seen this conversation, so it gets the context file.
    engine.switchProvider(conv.id, 'chatgpt')
    await engine.send({ conversationId: conv.id, text: 'And now you?', variant: 'full' })
    expect(last(conv.id)).toMatchObject({ provider: 'chatgpt' })
    expect(last(conv.id).text).toContain('I received the context file')

    // Back to Claude: its session is resumed and told only what it missed.
    engine.switchProvider(conv.id, 'claude')
    await engine.send({ conversationId: conv.id, text: 'Back to you.' })
    expect(last(conv.id).text).toBe('Claude here. You said: "Back to you.". I was caught up on what happened in between. I resumed my earlier session.')

    // Local models are stateless: they get the history as messages.
    engine.switchProvider(conv.id, 'local')
    await engine.send({ conversationId: conv.id, text: 'Local, your turn.' })
    expect(last(conv.id)).toMatchObject({ provider: 'local', model: 'ollama/mock-llama:8b' })
    // Eight earlier messages, plus the system message that explains artifacts.
    expect(last(conv.id).text).toContain('I can see 9 earlier messages')
    const sent = runtime.requests[runtime.requests.length - 1].messages
    expect(sent.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user'])
    expect(sent[1].content).toBe('My cat is called Biscuit.')

    // The switches are marked in the transcript but are not part of what assistants see.
    const notes = store.messages(conv.id).filter((m) => m.role === 'note').map((m) => m.text)
    expect(notes).toEqual(['Continued on ChatGPT', 'Continued on Claude', 'Continued on Local AI'])
    expect(threadMessages(store.messages(conv.id))).toHaveLength(10)
  })

  it('changes an earlier question, drops what came after it, and answers it afresh', async () => {
    const { engine, store } = await setup()
    const conv = engine.createConversation({ provider: 'claude' })
    await engine.send({ conversationId: conv.id, text: 'My dog is called Rex.' })
    await engine.send({ conversationId: conv.id, text: 'What is my dog called?' })
    await engine.send({ conversationId: conv.id, text: 'And how old is he?' })
    const second = store.messages(conv.id).filter((m) => m.role === 'user')[1]
    await engine.send({ conversationId: conv.id, text: 'What breed is my dog?', edit: second.id })
    const after = store.messages(conv.id)
    expect(after.map((m) => [m.role, m.text])).toEqual([
      ['user', 'My dog is called Rex.'],
      ['assistant', 'Claude here. You said: "My dog is called Rex.".'],
      ['user', 'What breed is my dog?'],
      // The session last saw a message that is gone, so Claude is caught up afresh instead of resumed.
      ['assistant', expect.not.stringContaining('I resumed my earlier session')]
    ])
    expect(after[2].id).toBe(second.id)
    await expect(engine.send({ conversationId: conv.id, text: 'x', edit: after[1].id })).rejects.toThrow(/can no longer be changed/)
  })

  it("gives every assistant in a project's chats the project's instructions and files", async () => {
    const { engine, store, last, runtime } = await setup()
    store.put('project', 'p1', { id: 'p1', name: 'Garden', instructions: 'Use metric units.', files: [{ id: 'f1', name: 'beds.txt', mime: 'text/plain', size: 5, kind: 'text', text: 'Bed A' }], createdAt: 1, updatedAt: 1 })
    const conv = engine.createConversation({ provider: 'claude', projectId: 'p1' })
    await engine.send({ conversationId: conv.id, text: 'How big is bed A?' })
    expect(last(conv.id).text).toContain('I know the project Garden and its files')
    engine.switchProvider(conv.id, 'local')
    await engine.send({ conversationId: conv.id, text: 'And you?' })
    const system = runtime.requests[runtime.requests.length - 1].messages.find((m: { role: string }) => m.role === 'system')?.content ?? ''
    expect(system).toContain('Use metric units.')
    expect(system).toContain('Bed A')
    const outside = engine.createConversation({ provider: 'claude' })
    await engine.send({ conversationId: outside.id, text: 'Hello' })
    expect(last(outside.id).text).not.toContain('I know the project')
  })

  it('asks for the smallest change in code chats while Ponytail is on, and nowhere else', async () => {
    const systemOf = async (kind: 'code' | 'chat', ponytail: boolean) => {
      const { engine, runtime } = await setup((s) => {
        s.ponytail = ponytail
      })
      const conv = engine.createConversation({ provider: 'local', kind })
      await engine.send({ conversationId: conv.id, text: 'Add a button.' })
      return runtime.requests[runtime.requests.length - 1].messages.find((m: { role: string }) => m.role === 'system')?.content ?? ''
    }
    expect(await systemOf('code', true)).toContain('You are a lazy senior developer.')
    expect(await systemOf('code', false)).not.toContain('lazy senior developer')
    expect(await systemOf('chat', true)).not.toContain('lazy senior developer')
  })

  it('keeps pictures ChatGPT makes, with image generation switched on', async () => {
    const { engine, store, last } = await setup()
    const conv = engine.createConversation({ provider: 'chatgpt' })
    await engine.send({ conversationId: conv.id, text: 'Draw a red square. [image]' })
    const reply = last(conv.id)
    expect(reply.text).toContain('Here is your picture')
    expect(reply.images).toMatchObject([{ name: 'image-1.png', mime: 'image/png', kind: 'image' }])
    expect(store.get<{ base64: string }>('blob', reply.images![0].id)?.base64.startsWith('iVBOR')).toBe(true)
    expect(reply.tools).toMatchObject([{ name: 'Image', summary: 'A small red square', status: 'done' }])
    store.deleteConversation(conv.id)
    expect(store.get('blob', reply.images![0].id)).toBeUndefined()
  })

  it('sends a research question in Auto to an assistant that can search, with the research instructions', async () => {
    const { engine, store, last } = await setup((s) => {
      s.routing.preferLocalForShort = true
    })
    const conv = engine.createConversation({ provider: 'auto' })
    await engine.send({ conversationId: conv.id, text: 'Heat pumps?', research: true })
    const reply = last(conv.id)
    expect(reply.provider).toBe('claude')
    expect(reply.text).toContain('```markdown title="Research: Heat pumps"')
    expect(store.messages(conv.id).find((m) => m.role === 'user')?.research).toBe(true)
  })

  it('keeps both context files on disk, ready to hand over', async () => {
    const { engine, last } = await setup()
    const conv = engine.createConversation({ provider: 'claude' })
    await engine.send({ conversationId: conv.id, text: 'Remember the number 4471.' })
    const dir = engine.contextDir(conv.id)
    expect(existsSync(join(dir, 'summary.md'))).toBe(true)
    const full = readFileSync(join(dir, 'full.md'), 'utf8')
    expect(full).toContain('Remember the number 4471.')
    expect(full).toContain(last(conv.id).text)
    expect(engine.handoff(conv.id, 'full', 'local')!.tokens).toBeLessThanOrEqual(12_000)
  })

  it('applies your instructions and memory to every assistant', async () => {
    const { engine, store, last } = await setup()
    store.put('profile', 'profile', { id: 'profile', instructions: 'Be brief.', updatedAt: 1 })
    for (const provider of ['claude', 'chatgpt', 'local'] as const) {
      const conv = engine.createConversation({ provider })
      await engine.send({ conversationId: conv.id, text: 'hi' })
      expect(last(conv.id).text, provider).toContain('I have your standing instructions')
    }
  })

  it('records a used-up limit and lets the question be answered elsewhere', async () => {
    const { engine, store, last, replies } = await setup()
    const conv = engine.createConversation({ provider: 'claude' })
    await engine.send({ conversationId: conv.id, text: 'First question' })

    process.env.FAKE_CLAUDE_LIMIT = '1'
    await engine.send({ conversationId: conv.id, text: 'Second question' })
    expect(last(conv.id)).toMatchObject({ status: 'error', error: { code: 'rate_limit' } })
    expect(engine.usage('claude').fiveHour.status).toBe('exhausted')

    engine.switchProvider(conv.id, 'chatgpt')
    await engine.send({ conversationId: conv.id, text: '', retry: true, provider: 'chatgpt', variant: 'summary' })
    expect(replies(conv.id).filter((m) => m.status === 'error')).toHaveLength(0)
    expect(last(conv.id)).toMatchObject({ provider: 'chatgpt', status: 'complete' })
    expect(last(conv.id).text).toContain('You said: "Second question"')
    expect(last(conv.id).text).toContain('I received the context file')
    expect(store.messages(conv.id).filter((m) => m.role === 'user')).toHaveLength(2)
  })

  it('tracks usage from what each service reports', async () => {
    process.env.FAKE_CLAUDE_UTILIZATION = '0.86'
    const { engine } = await setup()
    const a = engine.createConversation({ provider: 'claude' })
    await engine.send({ conversationId: a.id, text: 'hi' })
    expect(engine.usage('claude').fiveHour).toMatchObject({ usedPct: 86, status: 'warning' })
    expect(engine.usage('claude').tokensInWindow).toBeGreaterThan(0)

    const b = engine.createConversation({ provider: 'chatgpt' })
    await engine.send({ conversationId: b.id, text: 'hi' })
    await until(() => engine.usage('chatgpt').weekly.usedPct === 31, 4000, 'ChatGPT limits')
    expect(engine.usage('chatgpt').fiveHour).toMatchObject({ usedPct: 12, status: 'ok' })
  })

  it('routes automatically and explains the choice', async () => {
    const { engine, seen, last } = await setup()
    const conv = engine.createConversation({ provider: 'auto' })
    await engine.send({ conversationId: conv.id, text: 'Refactor this function to be async' })
    expect(last(conv.id).provider).toBe('claude')
    expect(seen.routes[0].reason).toMatch(/Coding/)

    engine.recordLimits('claude', { fiveHour: { usedPct: 95 } })
    await engine.send({ conversationId: conv.id, text: 'And add a test' })
    expect(last(conv.id).provider).toBe('chatgpt')
    expect(seen.routes[1].reason).toMatch(/Claude is running low/)
    expect(last(conv.id).text).toContain('I received the context file')

    engine.recordLimits('claude', { fiveHour: { usedPct: 100 } })
    engine.recordLimits('chatgpt', { fiveHour: { usedPct: 100 } })
    await engine.send({ conversationId: conv.id, text: 'One more thing' })
    expect(last(conv.id).provider).toBe('local')
  })

  it('keeps private conversations on local AI', async () => {
    const { engine, last } = await setup()
    const conv = engine.createConversation({ provider: 'claude', private: true })
    await engine.send({ conversationId: conv.id, text: 'secret' })
    expect(last(conv.id).provider).toBe('local')
  })

  it('compares answers side by side and continues from the one that is kept', async () => {
    const { engine, store, replies, last } = await setup()
    const conv = engine.createConversation({ provider: 'claude' })
    await engine.send({ conversationId: conv.id, text: 'Name a colour', compare: ['claude', 'chatgpt', 'local'] })
    const variants = replies(conv.id)
    expect(variants.map((m) => m.provider)).toEqual(['claude', 'chatgpt', 'local'])
    expect(new Set(variants.map((m) => m.variantGroup)).size).toBe(1)
    expect(variants.every((m) => m.status === 'complete' && m.selected === false)).toBe(true)
    // Until one is kept, none of them is part of the conversation.
    expect(threadMessages(store.messages(conv.id))).toHaveLength(1)

    engine.selectVariant(variants[1].id)
    expect(threadMessages(store.messages(conv.id)).map((m) => m.provider)).toEqual([undefined, 'chatgpt'])

    // Claude answered only in a throwaway session, so it is caught up from the context file.
    await engine.send({ conversationId: conv.id, text: 'Why that one?' })
    expect(last(conv.id).provider).toBe('claude')
    expect(last(conv.id).text).toContain('I received the context file')
  })

  it('passes on approval requests from both assistants while a turn is running', async () => {
    const { engine, seen, last } = await setup()
    const a = engine.createConversation({ provider: 'claude', mode: 'edit' })
    const asking = engine.send({ conversationId: a.id, text: 'run the tests [deny]' })
    await until(() => seen.approvals.length === 1, 5000, "Claude's question")
    expect(seen.approvals[0].request).toMatchObject({ provider: 'claude', kind: 'command', summary: 'npm test' })
    engine.respondApproval(a.id, seen.approvals[0].messageId, seen.approvals[0].request.id, 'decline')
    await asking
    expect(last(a.id).tools?.[0]).toMatchObject({ name: 'Bash', status: 'denied' })
    expect(last(a.id).text).toBe('I need permission to run the tests.')
    // Declining is an answer. Nothing is offered again once the turn has ended.
    expect(seen.denials).toHaveLength(0)
    // Every window is told the question is settled, so a card on another device goes away.
    expect(seen.approvals[1]).toMatchObject({ settled: true, request: { id: seen.approvals[0].request.id } })

    const b = engine.createConversation({ provider: 'chatgpt', mode: 'edit' })
    const sending = engine.send({ conversationId: b.id, text: 'install it [approve]' })
    await until(() => seen.approvals.length === 3, 5000, "ChatGPT's question")
    expect(seen.approvals[2].request).toMatchObject({ provider: 'chatgpt', kind: 'command' })
    engine.respondApproval(b.id, seen.approvals[2].messageId, seen.approvals[2].request.id, 'decline')
    await sending
    expect(last(b.id).tools?.[0]).toMatchObject({ name: 'Command', status: 'denied' })
  })

  it('remembers what was allowed for the rest of a chat, but not in other chats', async () => {
    const { engine, seen, last } = await setup()
    const conv = engine.createConversation({ provider: 'claude', mode: 'edit' })
    const first = engine.send({ conversationId: conv.id, text: 'run the tests [deny]' })
    await until(() => seen.approvals.length === 1, 5000, 'the question')
    engine.respondApproval(conv.id, seen.approvals[0].messageId, seen.approvals[0].request.id, 'acceptForSession')
    await first
    expect(last(conv.id).text).toContain('I ran the tests')

    // A later turn in the same chat runs the same command without asking.
    await engine.send({ conversationId: conv.id, text: 'and again [deny]' })
    expect(last(conv.id).tools?.[0]).toMatchObject({ name: 'Bash', status: 'done' })
    expect(seen.approvals.filter((x) => !x.settled)).toHaveLength(1)

    // Choosing another folder withdraws it, and another chat never had it.
    engine.setWorkspace(conv.id, tempDir())
    const other = engine.createConversation({ provider: 'claude', mode: 'edit' })
    for (const id of [conv.id, other.id]) {
      const before = seen.approvals.filter((x) => !x.settled).length
      const again = engine.send({ conversationId: id, text: 'once more [deny]' })
      await until(() => seen.approvals.filter((x) => !x.settled).length === before + 1, 5000, 'a new question')
      const ask = seen.approvals.filter((x) => !x.settled).at(-1)!
      engine.respondApproval(id, ask.messageId, ask.request.id, 'accept')
      await again
    }
  })

  it('offers a blocked action after the turn when Claude Code cannot ask during it', async () => {
    process.env.FAKE_CLAUDE_NO_LIVE = '1'
    const { engine, seen, last } = await setup()
    const a = engine.createConversation({ provider: 'claude', mode: 'edit' })
    await engine.send({ conversationId: a.id, text: 'run the tests [deny]' })
    expect(seen.denials[0]).toEqual([{ toolName: 'Bash', summary: 'npm test', rule: 'Bash(npm test)' }])
    expect(last(a.id).tools?.[0]).toMatchObject({ name: 'Bash', status: 'denied' })
    await engine.send({ conversationId: a.id, text: 'You may. [deny]', allow: ['Bash(npm test)'], provider: 'claude' })
    expect(seen.denials).toHaveLength(1)
    expect(last(a.id).tools?.[0]).toMatchObject({ status: 'done' })
    expect(seen.approvals).toHaveLength(0)
  })

  it('refuses a second message while the first is still being answered, and can stop', async () => {
    process.env.FAKE_DELAY_MS = '40'
    const { engine, store, replies } = await setup()
    const conv = engine.createConversation({ provider: 'chatgpt' })
    const first = engine.send({ conversationId: conv.id, text: 'a long enough message that it takes a moment to answer' })
    await expect(engine.send({ conversationId: conv.id, text: 'second' })).rejects.toThrow(/still answering/)
    await new Promise((r) => setTimeout(r, 150))
    engine.stop(conv.id)
    await first
    delete process.env.FAKE_DELAY_MS
    expect(engine.isBusy(conv.id)).toBe(false)
    expect(store.messages(conv.id).filter((m) => m.role === 'user')).toHaveLength(1)
    expect(replies(conv.id).every((m) => m.status === 'stopped')).toBe(true)
  })

  it('writes a rolling summary with the local model once a conversation is long', async () => {
    const { engine, store } = await setup((s) => {
      s.local.summarize = true
    })
    const conv = engine.createConversation({ provider: 'local' })
    for (let i = 0; i < 12; i++) {
      store.put('message', `old${i}`, { id: `old${i}`, conversationId: conv.id, role: i % 2 ? 'assistant' : 'user', text: `Earlier point ${i}. ${'filler '.repeat(700)}`, createdAt: i + 1, deviceId: 'd', status: 'complete' } satisfies Message)
    }
    await engine.send({ conversationId: conv.id, text: 'Carry on.' })
    await until(() => !!store.get<Conversation>('conversation', conv.id)?.summary, 8000, 'the summary')
    const summary = store.get<Conversation>('conversation', conv.id)!.summary!
    expect(summary).toMatchObject({ source: 'local' })
    expect(summary.text).toMatch(/^SUMMARY:/)
    expect(engine.handoff(conv.id, 'summary')!.text).toContain('SUMMARY: the user is testing the app')
  })
})
