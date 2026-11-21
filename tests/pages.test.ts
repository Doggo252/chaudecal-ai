// The Chats and Artifacts pages: every artifact from every chat, and every chat in one list.

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'
import { listArtifacts } from '@shared/artifacts'
import { filterArtifacts } from '../src/renderer/src/components/ArtifactsView'
import { filterChats } from '../src/renderer/src/components/ChatsView'
import type { Conversation, Message } from '@shared/types'
import { tempDir } from './helpers'

const page = (title: string, body: string) => '```html title="' + title + '"\n<!doctype html><p>' + body + '</p>\n```'

function msg(id: string, conversationId: string, text: string, createdAt: number, status = 'complete'): Message {
  return { id, conversationId, role: 'assistant', text, createdAt, deviceId: 'd', status } as Message
}

function conv(id: string, patch: Partial<Conversation> = {}): Conversation {
  return { id, title: id, provider: 'claude', createdAt: 1, updatedAt: 1, ...patch } as Conversation
}

describe('artifacts page', () => {
  it('lists each artifact once with its newest finished version, newest first, from every chat', () => {
    const list = listArtifacts(
      [
        { id: 'a', title: 'Garden plans' },
        { id: 'b', title: 'Budget' }
      ],
      [
        msg('a1', 'a', `Here it is.\n\n${page('Planter', 'one')}`, 10),
        msg('a2', 'a', `Changed it.\n\n${page('Planter', 'two')}`, 20),
        msg('b1', 'b', 'Sums:\n\n```python title="totals.py"\nprint(1 + 2)\n```', 30),
        msg('b2', 'b', 'Plain answer with no blocks.', 40),
        msg('x1', 'gone', page('Lost', 'x'), 50)
      ]
    )
    expect(list.map((a) => [a.title, a.conversationTitle, a.versions])).toEqual([
      ['totals.py', 'Budget', 1],
      ['Planter', 'Garden plans', 2]
    ])
    expect(list[1]).toMatchObject({ kind: 'html', messageId: 'a2', index: 0, updatedAt: 20 })
    expect(list[1].excerpt).toContain('two')
  })

  it('leaves out an artifact that is still being written', () => {
    const list = listArtifacts([{ id: 'a', title: 'A' }], [msg('a1', 'a', '```html title="Half"\n<p>still going', 1, 'streaming')])
    expect(list).toEqual([])
  })

  it('reads them from the store, without deleted chats or plain messages', () => {
    const store = new Store(join(tempDir(), 'app.db'))
    store.put('conversation', 'a', conv('a', { title: 'Garden plans' }))
    store.put('conversation', 'b', conv('b', { title: 'Gone' }))
    store.put('message', 'a1', msg('a1', 'a', page('Planter', 'one'), 1))
    store.put('message', 'a2', msg('a2', 'a', 'No artifact here.', 2))
    store.put('message', 'b1', msg('b1', 'b', page('Old', 'x'), 3))
    store.deleteConversation('b')
    expect(store.artifacts().map((a) => a.title)).toEqual(['Planter'])
  })

  it('narrows by kind and by the artifact or chat title', () => {
    const list = listArtifacts(
      [
        { id: 'a', title: 'Garden plans' },
        { id: 'b', title: 'Budget' }
      ],
      [msg('a1', 'a', page('Planter', 'one'), 1), msg('b1', 'b', '```markdown title="Notes"\n# Notes\n```', 2), msg('b2', 'b', '```mermaid\ngraph TD; A-->B\n```', 3)]
    )
    expect(filterArtifacts(list, '', 'documents').map((a) => a.title)).toEqual(['Notes'])
    expect(filterArtifacts(list, '', 'pictures').map((a) => a.kind)).toEqual(['mermaid'])
    expect(filterArtifacts(list, 'garden', 'all').map((a) => a.title)).toEqual(['Planter'])
    expect(filterArtifacts(list, 'budget', 'pages')).toEqual([])
  })
})

describe('chats page', () => {
  it('shows the chats of one kind that match, newest first', () => {
    const chats = [conv('Soup recipe', { kind: 'chat', updatedAt: 1 }), conv('Fix the build', { kind: 'code', updatedAt: 5 }), conv('Soup shopping', { kind: 'chat', updatedAt: 9, provider: 'chatgpt' }), conv('Trip', { kind: 'chat', updatedAt: 3 })]
    expect(filterChats(chats, 'chat', '', () => true).map((c) => c.id)).toEqual(['Soup shopping', 'Trip', 'Soup recipe'])
    expect(filterChats(chats, 'chat', 'soup', () => true).map((c) => c.id)).toEqual(['Soup shopping', 'Soup recipe'])
    expect(filterChats(chats, 'chat', '', (c) => c.provider === 'claude').map((c) => c.id)).toEqual(['Trip', 'Soup recipe'])
    expect(filterChats(chats, 'code', '', () => true).map((c) => c.id)).toEqual(['Fix the build'])
  })

  it('keeps archived chats apart', () => {
    const chats = [conv('Old trip', { kind: 'chat', updatedAt: 2, archived: true }), conv('Soup', { kind: 'chat', updatedAt: 1 })]
    expect(filterChats(chats, 'chat', '', () => true).map((c) => c.id)).toEqual(['Soup'])
    expect(filterChats(chats, 'chat', '', () => true, true).map((c) => c.id)).toEqual(['Old trip'])
  })
})
