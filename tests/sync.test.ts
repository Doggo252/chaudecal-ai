import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { Conversation, Message, Settings } from '@shared/types'
import { Store } from '../src/main/store'
import { HubServer } from '../src/main/sync/hubServer'
import { HubClient, normalizeHubUrl } from '../src/main/sync/hubClient'
import { LocalProvider } from '../src/main/providers/local'
import { startMockOpenAI } from './fakes/mock-openai.mjs'
import { tempDir, testSettings, until } from './helpers'

interface Device {
  store: Store
  settings: Settings
  client: HubClient
}

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function startHub(patch: (s: Settings) => void = () => {}) {
  const store = new Store(join(tempDir(), 'hub.db'))
  const settings = testSettings((s) => {
    s.hub.hostEnabled = true
    s.hub.port = 0
    s.hub.token = 'pair-me'
    patch(s)
  })
  const server = new HubServer(store, () => settings, '0.0.0-test')
  await server.start()
  cleanup.push(() => server.stop())
  return { store, settings, server, url: `http://127.0.0.1:${server.port}` }
}

function startClient(url: string, token = 'pair-me'): Device {
  const store = new Store(join(tempDir(), 'client.db'))
  const settings = testSettings((s) => {
    s.hub.remoteUrl = url
    s.hub.remoteToken = token
  })
  const client = new HubClient(store, () => settings, () => {})
  client.start()
  cleanup.push(() => client.stop())
  return { store, settings, client }
}

function conversation(id: string, title: string): Conversation {
  return { id, title, createdAt: 1, updatedAt: 1, provider: 'auto', models: {}, mode: 'chat' }
}
function message(id: string, conversationId: string, text: string, createdAt: number, deviceId: string): Message {
  return { id, conversationId, role: 'user', text, createdAt, deviceId, status: 'complete' }
}

describe('hub sync', () => {
  it('carries a conversation from one device to another through the hub', async () => {
    const hub = await startHub()
    const mac = startClient(hub.url)
    const laptop = startClient(hub.url)
    await until(() => mac.client.status().connected && laptop.client.status().connected, 8000, 'both clients to connect')

    mac.store.put('conversation', 'c1', conversation('c1', 'From the Mac'))
    mac.store.put('message', 'm1', message('m1', 'c1', 'hello from the mac', 1, mac.store.deviceId))

    await until(() => laptop.store.messages('c1').length === 1, 8000, 'the message to reach the other device')
    expect(laptop.store.get<Conversation>('conversation', 'c1')?.title).toBe('From the Mac')
    expect(hub.store.messages('c1')[0].text).toBe('hello from the mac')
    expect(mac.client.status().pending).toBe(0)
  })

  it('merges messages written on two devices into the same conversation', async () => {
    const hub = await startHub()
    hub.store.put('conversation', 'c1', conversation('c1', 'Shared'))
    const a = startClient(hub.url)
    const b = startClient(hub.url)
    await until(() => !!a.store.get('conversation', 'c1') && !!b.store.get('conversation', 'c1'), 8000, 'the conversation to arrive')

    a.store.put('message', 'ma', message('ma', 'c1', 'from a', 10, a.store.deviceId))
    b.store.put('message', 'mb', message('mb', 'c1', 'from b', 20, b.store.deviceId))

    await until(() => a.store.messages('c1').length === 2 && b.store.messages('c1').length === 2, 8000, 'both messages on both devices')
    expect(a.store.messages('c1').map((m) => m.text)).toEqual(['from a', 'from b'])
    expect(hub.store.messages('c1').map((m) => m.text)).toEqual(['from a', 'from b'])
  })

  it('keeps working offline and catches up when the hub returns', async () => {
    const offline = startClient('http://127.0.0.1:9')
    offline.store.put('conversation', 'c9', conversation('c9', 'Written offline'))
    await until(() => !offline.client.status().connected && /offline/i.test(offline.client.status().detail), 8000, 'the client to report offline')
    expect(offline.client.status().pending).toBe(1)
    expect(offline.store.get<Conversation>('conversation', 'c9')?.title).toBe('Written offline')

    const hub = await startHub()
    offline.settings.hub.remoteUrl = hub.url
    await offline.client.syncNow()
    await until(() => !!hub.store.get('conversation', 'c9'), 8000, 'the offline change to reach the hub')
    // The client marks it sent once the hub's answer is back, a moment after the hub has it.
    await until(() => offline.client.status().pending === 0, 8000, 'the client to mark the change as sent')
  })

  it('lets the newer edit win and spreads deletions', async () => {
    const hub = await startHub()
    const a = startClient(hub.url)
    const b = startClient(hub.url)
    await until(() => a.client.status().connected && b.client.status().connected)
    a.store.put('conversation', 'c1', conversation('c1', 'First title'))
    await until(() => !!b.store.get('conversation', 'c1'))

    b.store.put('conversation', 'c1', { ...conversation('c1', 'Renamed on b') })
    await until(() => a.store.get<Conversation>('conversation', 'c1')?.title === 'Renamed on b', 8000, 'the rename to arrive')

    a.store.deleteConversation('c1')
    await until(() => !b.store.get('conversation', 'c1') && !hub.store.get('conversation', 'c1'), 8000, 'the deletion to spread')
  })

  it('syncs large image attachments in several batches', async () => {
    const hub = await startHub()
    const mac = startClient(hub.url)
    await until(() => mac.client.status().connected, 8000, 'the client to connect')
    // Four images of about 9 MB each: more than one batch may carry.
    const base64 = 'A'.repeat(9 * 1024 * 1024)
    for (const id of ['img-1', 'img-2', 'img-3', 'img-4']) mac.store.put('blob', id, { id, name: `${id}.png`, mime: 'image/png', base64 })
    expect(mac.store.dirty().length).toBeLessThan(4)
    await until(() => hub.store.list('blob').length === 4, 15000, 'all four images to reach the hub')
    await until(() => mac.store.dirtyCount() === 0, 8000, 'the client to finish sending')

    const laptop = startClient(hub.url)
    await until(() => laptop.store.list('blob').length === 4, 15000, 'all four images to reach the second device')
    expect(laptop.store.list<{ id: string; base64: string }>('blob').map((b) => [b.id, b.base64.length]).sort()).toEqual(['img-1', 'img-2', 'img-3', 'img-4'].map((id) => [id, base64.length]))

    // Deleting an image frees its bytes everywhere but keeps the deletion on record.
    mac.store.remove('blob', 'img-1')
    await until(() => laptop.store.get('blob', 'img-1') === undefined, 15000, 'the deletion to reach the second device')
    expect(laptop.store.list('blob')).toHaveLength(3)
  })

  it('rejects a wrong pairing code', async () => {
    const hub = await startHub()
    const stranger = startClient(hub.url, 'wrong')
    await until(() => /pairing code/i.test(stranger.client.status().detail), 8000, 'the rejection')
    expect(stranger.client.status().connected).toBe(false)
    const res = await fetch(`${hub.url}/api/sync/pull?since=0`)
    expect(res.status).toBe(401)
  })

  it('finds text across conversations', async () => {
    const store = new Store(join(tempDir(), 's.db'))
    store.put('conversation', 'c1', conversation('c1', 'Kitchen renovation'))
    store.put('conversation', 'c2', conversation('c2', 'Tax questions'))
    store.put('message', 'm1', message('m1', 'c1', 'Which worktop material resists heat best?', 1, 'd'))
    store.put('message', 'm2', message('m2', 'c2', 'Can I deduct a home office?', 2, 'd'))
    expect(store.search('worktop').map((h) => h.conversationId)).toEqual(['c1'])
    expect(store.search('deduct office')[0]).toMatchObject({ conversationId: 'c2', messageId: 'm2' })
    expect(store.search('kitchen')[0]).toMatchObject({ conversationId: 'c1', snippet: 'Title match' })
    store.remove('message', 'm1')
    expect(store.search('worktop')).toEqual([])
    store.close()
  })

  it('accepts hub addresses the way people type them', () => {
    expect(normalizeHubUrl('my-pc')).toBe('http://my-pc:47600')
    expect(normalizeHubUrl('my-pc:5000/')).toBe('http://my-pc:5000')
    expect(normalizeHubUrl('http://100.64.0.2:47600')).toBe('http://100.64.0.2:47600')
    expect(normalizeHubUrl('  ')).toBe('')
  })
})

describe('local AI through the hub', () => {
  it('lets a client use a model that runs on the hub machine', async () => {
    const runtime = await startMockOpenAI({ models: ['mock-llama:8b', 'nomic-embed-text'] })
    cleanup.push(() => runtime.close())
    const hub = await startHub((s) => {
      s.local.endpoints = [{ id: 'ollama', name: 'Ollama', baseUrl: runtime.baseUrl, enabled: true }]
    })
    const mac = startClient(hub.url)
    await until(() => mac.client.status().connected)

    const local = new LocalProvider(() => mac.settings, mac.client)
    const models = await local.models(true)
    // The embedding model is not offered for chat.
    expect(models).toEqual([{ id: 'mock-llama:8b', endpointId: 'ollama', endpointName: 'Ollama', via: 'hub' }])

    let text = ''
    const events: string[] = []
    const handle = local.run({ prompt: 'ping', messages: [{ role: 'user', content: 'ping' }], system: '', model: 'ollama/mock-llama:8b', mode: 'chat', cwd: '.' }, (e) => {
      events.push(e.type)
      if (e.type === 'text') text += e.delta
    })
    await handle.done
    expect(text).toBe('Local model here. You said: "ping".')
    expect(events).toContain('usage')
    expect(events[events.length - 1]).toBe('done')
    expect(runtime.requests[0].model).toBe('mock-llama:8b')
  })

  it('reports clearly when no model is reachable', async () => {
    const settings = testSettings()
    const local = new LocalProvider(() => settings, { current: () => undefined })
    const seen: string[] = []
    await local.run({ prompt: 'x', system: '', model: '', mode: 'chat', cwd: '.' }, (e) => seen.push(e.type === 'error' ? `error:${e.code}` : e.type)).done
    expect(seen).toEqual(['error:unreachable', 'done'])
    expect((await local.status()).ready).toBe(false)
  })
})
