import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { Conversation } from '@shared/types'
import { artifactBlocks, collectArtifacts } from '@shared/artifacts'
import { artifactBlock, chatgptMessages, claudeMessages, cleanChatgptText, conversationIdFor, messageIdFor, toMillis } from '@shared/webImport'
import { Store } from '../src/main/store'
import { WebImporter } from '../src/main/webImport'
import { makeSites } from './fakes/fake-sites.mjs'
import { tempDir } from './helpers'

describe('reading what the sites send', () => {
  it('reads times in every form the sites use', () => {
    expect(toMillis(1_760_000_000.5)).toBe(1_760_000_000_500)
    expect(toMillis(1_760_000_000_500)).toBe(1_760_000_000_500)
    expect(toMillis('2025-07-10T14:53:58.103234Z')).toBe(Date.parse('2025-07-10T14:53:58.103Z'))
    expect(toMillis('1760000000')).toBe(1_760_000_000_000)
    expect(toMillis(undefined)).toBe(0)
    expect(toMillis('not a date')).toBe(0)
  })

  it('removes ChatGPT citation markers', () => {
    expect(cleanChatgptText('Alfama citeturn0search0 is old.')).toBe('Alfama  is old.')
    expect(cleanChatgptText('See 【4:0†source】 here')).toBe('See  here')
    // A named place or hotel keeps its name; picture groups and maps go.
    expect(cleanChatgptText('1. \ue200entity\ue202["city","Lonavala","Maharashtra"]\ue201 / Khandala')).toBe('1. Lonavala / Khandala')
    expect(cleanChatgptText('**\ue200entity\ue202["hotel","Taj Madikeri",0]\ue201 \u2014 Coorg**\ue200image_group\ue202{"query":["x"]}\ue201')).toBe('**Taj Madikeri \u2014 Coorg**')
  })

  it('writes artifacts with a fence their content cannot close', () => {
    const block = artifactBlock('markdown', 'Read "me"', '# A\n```js\nx\n```')
    expect(block.startsWith('````markdown title="Read \'me\'"')).toBe(true)
    expect(artifactBlocks(block)).toMatchObject([{ kind: 'markdown', title: "Read 'me'", content: '# A\n```js\nx\n```' }])
  })

  it('follows the ChatGPT branch the user last saw, and keeps only what was said', () => {
    const sites = makeSites()
    const messages = chatgptMessages(sites.chatgptChats['g-trip'])
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Plan three days in Lisbon.'],
      ['assistant', 'Day one: Alfama.\n\nDay two: Belém.']
    ])
    expect(messages[1]).toMatchObject({ remoteId: 'n8', model: 'gpt-5' })
    expect(JSON.stringify(messages)).not.toMatch(/secret profile|hidden thoughts|search results|old answer|lisbon"/)
    const photo = chatgptMessages(sites.chatgptChats['g-photo'])
    expect(photo[0].text).toBe('[Image]\n\nWhat is this?\n\n[Attached: cat.png]')
  })

  it('follows the Claude branch, rebuilds artifacts with their versions, and keeps attached text', () => {
    const sites = makeSites()
    const messages = claudeMessages(sites.claudeChats['c-garden'], 'c-garden')
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(messages[0].attachments).toMatchObject([{ name: 'beds.txt', kind: 'text', text: 'Bed A: tomatoes\nBed B: beans' }])
    expect(messages[1].text).not.toContain('planning')
    const artifacts = collectArtifacts(messages.map((m, i) => ({ id: `m${i}`, role: m.role, text: m.text, status: 'complete', createdAt: i })))
    expect(artifacts.map((a) => [a.title, a.versions.length, a.versions[0].kind])).toEqual([
      ["Garden 'layout'", 2, 'html'],
      ['plan.md', 1, 'markdown']
    ])
    expect(artifacts[0].versions.map((v) => v.content)).toEqual(['<!doctype html><h1>Beds</h1><p>A: tomatoes</p>', '<!doctype html><h1>Beds</h1><p>A: peppers</p>'])
    expect(artifacts[1].versions[0].content).toContain('```\nwater daily\n```')
    // The older form, with the words in "text".
    expect(claudeMessages(sites.claudeChats['c-hello']).map((m) => m.text)).toEqual(['Hello', 'Hi! How can I help?'])
  })
})

function setup() {
  const sites = makeSites()
  const store = new Store(join(tempDir(), 'app.db'))
  const statuses: string[] = []
  const importer = new WebImporter(store, async (service, path, headers) => sites.handle(service, path, headers), (s) => statuses.push(s.state), {
    pauseMs: 0,
    backoffMs: 5,
    origin: (s) => (s === 'claude' ? 'https://claude.ai' : 'https://chatgpt.com')
  })
  const convs = (service: string) => store.list<Conversation>('conversation').filter((c) => c.source?.service === service)
  return { sites, store, importer, statuses, convs }
}

describe('bringing chats in', () => {
  it('brings in every ChatGPT chat, archived and in projects too, and only fetches changed ones later', async () => {
    const { sites, store, importer, convs } = setup()
    const first = await importer.run('chatgpt')
    expect(first).toMatchObject({ state: 'done', changed: 4, count: 4 })
    expect(convs('chatgpt').map((c) => c.title).sort()).toEqual(['An archived chat', 'Project notes', 'Trip to Lisbon', 'What is in this photo?'])
    const trip = store.get<Conversation>('conversation', conversationIdFor('chatgpt', 'g-trip'))!
    expect(trip).toMatchObject({ provider: 'chatgpt', mode: 'chat', source: { url: 'https://chatgpt.com/c/g-trip', remoteTitle: 'Trip to Lisbon' } })
    expect(store.messages(trip.id).map((m) => [m.role, m.provider])).toEqual([
      ['user', undefined],
      ['assistant', 'chatgpt']
    ])

    sites.state.requests.length = 0
    const again = await importer.run('chatgpt')
    expect(again).toMatchObject({ state: 'done', changed: 0, count: 4 })
    expect(sites.state.requests.some((r) => r.includes('/backend-api/conversation/'))).toBe(false)

    sites.addAnswer('chatgpt', 'One more question')
    sites.state.requests.length = 0
    expect(await importer.run('chatgpt')).toMatchObject({ changed: 1 })
    expect(sites.state.requests.filter((r) => r.includes('/backend-api/conversation/'))).toEqual(['chatgpt /backend-api/conversation/g-photo'])
    expect(store.messages(conversationIdFor('chatgpt', 'g-photo')).pop()!.text).toBe('One more question')
  })

  it('brings in Claude chats from the chat organization, skipping empty ones', async () => {
    const { sites, store, importer, convs } = setup()
    expect(await importer.run('claude')).toMatchObject({ state: 'done', changed: 2, count: 2 })
    expect(convs('claude').map((c) => c.title).sort()).toEqual(['Garden plan', 'Hello Claude'])
    expect(sites.state.requests.some((r) => r.includes('org-api'))).toBe(false)
    const garden = store.messages(conversationIdFor('claude', 'c-garden'))
    expect(garden.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4'].map((id) => messageIdFor('claude', id)))
    expect(garden[0].createdAt).toBeLessThan(garden[1].createdAt)
  })

  it('keeps a title changed in the app, and a chat deleted in the app stays deleted', async () => {
    const { sites, store, importer } = setup()
    await importer.run('claude')
    const hello = conversationIdFor('claude', 'c-hello')
    const garden = conversationIdFor('claude', 'c-garden')
    store.put('conversation', hello, { ...store.get<Conversation>('conversation', hello)!, title: 'My own title' })
    store.deleteConversation(garden)
    sites.addAnswer('claude', 'A new answer')
    sites.claudeChats['c-garden'].updated_at = new Date().toISOString()
    sites.state.requests.length = 0
    await importer.run('claude')
    expect(store.get<Conversation>('conversation', hello)!.title).toBe('My own title')
    expect(store.messages(hello).pop()!.text).toBe('A new answer')
    expect(store.get('conversation', garden)).toBeUndefined()
    expect(sites.state.requests.some((r) => r.includes('c-garden'))).toBe(false)
  })

  it('drops messages that left the chat on the site, and keeps ones written in the app', async () => {
    const { sites, store, importer } = setup()
    await importer.run('claude')
    const id = conversationIdFor('claude', 'c-hello')
    store.put('message', 'app-1', { id: 'app-1', conversationId: id, role: 'user', text: 'Asked in the app', createdAt: Date.now(), deviceId: store.deviceId, status: 'complete' })
    // On the site, the question was edited: the old answer is on a branch nobody sees now.
    const chat = sites.claudeChats['c-hello']
    chat.chat_messages.push({ uuid: 'h3', parent_message_uuid: null, index: 2, sender: 'human', created_at: chat.chat_messages[0].created_at, content: [{ type: 'text', text: 'Hello again' }] })
    chat.current_leaf_message_uuid = 'h3'
    chat.updated_at = new Date().toISOString()
    await importer.run('claude')
    expect(store.messages(id).map((m) => m.text)).toEqual(['Hello again', 'Asked in the app'])
  })

  it('says when nobody is signed in, and waits and tries again when the site says to slow down', async () => {
    const { sites, importer } = setup()
    sites.state.signedIn.chatgpt = false
    const out = await importer.run('chatgpt')
    expect(out).toMatchObject({ state: 'signed-out' })
    expect(out.message).toMatch(/Sign in with the button above/)
    sites.state.signedIn.chatgpt = true
    sites.state.limitOnce.add('chatgpt /backend-api/conversation/g-trip')
    expect(await importer.run('chatgpt')).toMatchObject({ state: 'done', changed: 4 })
  })

  it('gives the same ids on every device, so two devices that both import make no duplicates', async () => {
    const one = setup()
    const two = setup()
    await one.importer.run('claude')
    await two.importer.run('claude')
    const ids = (s: Store) => s.list<Conversation>('conversation').map((c) => c.id).sort()
    expect(ids(one.store)).toEqual(ids(two.store))
    expect(one.store.deviceId).not.toBe(two.store.deviceId)
  })

  it('runs one import at a time for each site', async () => {
    const { sites, importer } = setup()
    const [a, b] = await Promise.all([importer.run('claude'), importer.run('claude')])
    expect(a).toBe(b)
    expect(sites.state.requests.filter((r) => r === 'claude /api/organizations')).toHaveLength(1)
  })
})
