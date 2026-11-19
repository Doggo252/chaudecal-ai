import { describe, expect, it } from 'vitest'
import { buildHandoff, composeChatMessages, composePrompt, extractiveSummary, planTurn, providerBudget, threadMessages, titleFromText } from '@shared/context'
import { estimateTokens } from '@shared/tokens'
import { defaultSettings, type Conversation, type Message } from '@shared/types'

const conv: Conversation = { id: 'c1', title: 'Trip planning', createdAt: 0, updatedAt: 0, provider: 'auto', models: {}, mode: 'chat' }
let clock = 0
function msg(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  clock += 1
  return { id: `m${clock}`, conversationId: 'c1', role, text, createdAt: clock, deviceId: 'd', status: 'complete', ...extra }
}

describe('threadMessages', () => {
  it('leaves out notes, unselected compare answers and empty failures', () => {
    const all = [
      msg('user', 'hi'),
      msg('note', 'Continued on ChatGPT'),
      msg('assistant', 'a', { variantGroup: 'g', selected: false, provider: 'claude' }),
      msg('assistant', 'b', { variantGroup: 'g', selected: true, provider: 'chatgpt' }),
      msg('assistant', '', { status: 'error' }),
      msg('assistant', 'partial', { status: 'streaming' })
    ]
    expect(threadMessages(all).map((m) => m.text)).toEqual(['hi', 'b'])
  })

  it('hides a compare group until one answer is kept', () => {
    const all = [msg('user', 'q'), msg('assistant', 'a', { variantGroup: 'g', selected: false }), msg('assistant', 'b', { variantGroup: 'g', selected: false })]
    expect(threadMessages(all).map((m) => m.text)).toEqual(['q'])
  })
})

describe('planTurn', () => {
  const prior = [msg('user', 'one'), msg('assistant', 'two', { provider: 'claude' }), msg('user', 'three'), msg('assistant', 'four', { provider: 'chatgpt' })]
  it('starts fresh with no history', () => {
    expect(planTurn([], undefined)).toEqual({ kind: 'fresh' })
  })
  it('hands off everything to a provider with no session', () => {
    const plan = planTurn(prior, undefined)
    expect(plan.kind).toBe('handoff')
    if (plan.kind === 'handoff') expect(plan.unseen).toHaveLength(4)
  })
  it('resumes when the session has seen everything', () => {
    expect(planTurn(prior, { sessionId: 's', syncedMessageId: prior[3].id })).toEqual({ kind: 'resume', sessionId: 's' })
  })
  it('catches a session up on turns another provider answered', () => {
    const plan = planTurn(prior, { sessionId: 's', syncedMessageId: prior[1].id })
    expect(plan.kind).toBe('catchup')
    if (plan.kind === 'catchup') expect(plan.unseen.map((m) => m.text)).toEqual(['three', 'four'])
  })
  it('falls back to a handoff when the remembered message is gone', () => {
    expect(planTurn(prior, { sessionId: 's', syncedMessageId: 'deleted' }).kind).toBe('handoff')
  })
})

describe('composePrompt', () => {
  const prior = [msg('user', 'Plan a trip to Lisbon'), msg('assistant', 'Here is a three day plan.', { provider: 'claude' })]
  it('sends the bare message on a fresh or resumed session', () => {
    expect(composePrompt({ plan: { kind: 'fresh' }, userText: 'hello', conversation: conv, variant: 'summary', budgetTokens: 1000 })).toBe('hello')
    expect(composePrompt({ plan: { kind: 'resume', sessionId: 's' }, userText: 'hello', conversation: conv, variant: 'full', budgetTokens: 1000 })).toBe('hello')
  })
  it('wraps a handoff in the context file and ends with the new message', () => {
    const text = composePrompt({ plan: { kind: 'handoff', unseen: prior }, userText: 'Add a day in Sintra', conversation: conv, variant: 'full', budgetTokens: 5000, profile: 'Be brief.' })
    expect(text).toContain('<context_file>')
    expect(text).toContain('Plan a trip to Lisbon')
    expect(text).toContain('Assistant (Claude)')
    expect(text).toContain('Be brief.')
    expect(text.trim().endsWith('Add a day in Sintra')).toBe(true)
  })
  it('sends only the missed turns on a catch-up', () => {
    const text = composePrompt({ plan: { kind: 'catchup', sessionId: 's', unseen: [prior[1]] }, userText: 'next', conversation: conv, variant: 'summary', budgetTokens: 5000 })
    expect(text).toContain('<conversation_since_your_last_reply>')
    expect(text).toContain('three day plan')
    expect(text).not.toContain('Plan a trip to Lisbon')
  })
})

describe('buildHandoff', () => {
  const long = Array.from({ length: 60 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `Message number ${i}. ${'detail '.repeat(120)}`, i % 2 ? { provider: 'claude' } : {}))

  it('includes everything word for word when it fits', () => {
    const h = buildHandoff({ conversation: conv, messages: long.slice(0, 4), variant: 'full', budgetTokens: 400_000 })
    expect(h.condensed).toBe(false)
    expect(h.verbatimMessages).toBe(4)
    expect(h.text).toContain('Message number 0.')
  })

  it('never exceeds the budget, for either variant', () => {
    for (const variant of ['full', 'summary'] as const) {
      for (const budget of [800, 3000, 12_000]) {
        const h = buildHandoff({ conversation: conv, messages: long, variant, budgetTokens: budget })
        expect(h.tokens).toBeLessThanOrEqual(budget)
        expect(h.condensed).toBe(true)
        // The newest message always survives.
        expect(h.text).toContain('Message number 59.')
      }
    }
  })

  it('keeps the opening request when trimming a full transcript', () => {
    const h = buildHandoff({ conversation: conv, messages: long, variant: 'full', budgetTokens: 6000 })
    expect(h.text).toContain('Message number 0.')
    expect(h.text).toMatch(/earlier messages were left out/)
  })

  it('uses the rolling summary and covers the gap after it', () => {
    const withSummary: Conversation = { ...conv, summary: { text: 'ROLLING SUMMARY TEXT', uptoMessageId: long[9].id, updatedAt: 1, source: 'local' } }
    const h = buildHandoff({ conversation: withSummary, messages: long, variant: 'summary', budgetTokens: 8000 })
    expect(h.text).toContain('ROLLING SUMMARY TEXT')
    expect(h.text).toContain('Since that summary was written')
    expect(h.text).toContain('Most recent messages, word for word')
  })

  it('falls back to an outline when there is no rolling summary', () => {
    const h = buildHandoff({ conversation: conv, messages: long, variant: 'summary', budgetTokens: 8000 })
    expect(h.text).toContain('Original request: Message number 0.')
  })
})

describe('other helpers', () => {
  it('caps a provider budget at its model window, leaving room for the reply', () => {
    const s = defaultSettings('test')
    expect(providerBudget('claude', s)).toBe(150_000)
    expect(providerBudget('chatgpt', s)).toBe(300_000)
    expect(providerBudget('local', s)).toBe(12_000)
    s.contextBudgetTokens = 50_000
    expect(providerBudget('chatgpt', s)).toBe(50_000)
  })

  it('gives a stateless model full history when it fits and a digest when it does not', () => {
    const prior = [msg('user', 'a'), msg('assistant', 'b')]
    const small = composeChatMessages({ conversation: conv, prior, userText: 'c', budgetTokens: 2000, system: 'sys' })
    expect(small.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    const big = Array.from({ length: 40 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', 'x'.repeat(2000)))
    const squeezed = composeChatMessages({ conversation: conv, prior: big, userText: 'c', budgetTokens: 3000, system: 'sys' })
    expect(squeezed).toHaveLength(2)
    expect(squeezed[0].content).toContain('Context file')
    expect(squeezed.reduce((n, m) => n + estimateTokens(m.content), 0)).toBeLessThanOrEqual(3000)
  })

  it('summarises without a model', () => {
    const s = extractiveSummary([msg('user', 'Fix the login bug'), msg('assistant', 'Done', { tools: [{ id: 't', name: 'Edit', summary: 'src/login.ts', status: 'done' }] }), msg('user', 'Now add tests')])
    expect(s).toContain('Original request: Fix the login bug')
    expect(s).toContain('Now add tests')
    expect(s).toContain('Edit: src/login.ts')
  })

  it('makes a short title', () => {
    expect(titleFromText('How do I centre a div in CSS? I have tried a lot.')).toBe('How do I centre a div in CSS?')
    expect(titleFromText('x'.repeat(200)).length).toBeLessThanOrEqual(60)
  })
})

describe('projects', () => {
  it("gives the assistant the project's instructions and files, cut to fit", async () => {
    const { projectSystemText } = await import('@shared/context')
    expect(projectSystemText(undefined)).toBe('')
    const project = { name: 'Garden', instructions: 'Use metric units.', files: [{ name: 'beds.txt', text: 'Bed A' }, { name: 'long.md', text: 'x'.repeat(50) }, { name: 'last.md', text: 'never' }] }
    const full = projectSystemText(project)
    expect(full).toContain('part of the project "Garden"')
    expect(full).toContain("The project's instructions:\nUse metric units.")
    expect(full).toContain('<project_file name="beds.txt">\nBed A\n</project_file>')
    const cut = projectSystemText(project, 20)
    expect(cut).toContain('(The rest of this file is left out.)')
    expect(cut).toContain('left out for length: last.md')
  })
})
