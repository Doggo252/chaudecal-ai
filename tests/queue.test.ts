// Messages written while a chat answers wait their turn, and what the working line says.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@shared/ipc'
import type { Message } from '@shared/types'
import { getState, queueMessage, sendQueued, setState, stopChat, unqueue } from '../src/renderer/src/state'
import { workStatus } from '../src/renderer/src/components/Working'

const send = vi.fn(async (_input: unknown) => {})
const stop = vi.fn(async (_id: string) => {})
const discardAttachment = vi.fn(async (_id: string) => {})
;(globalThis as unknown as { window: unknown }).window = { api: { send, stop, discardAttachment } }

const busy = (ids: string[]) => setState((s) => ({ app: { ...(s.app ?? ({} as AppState)), busy: ids } }))
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('messages written while a chat answers', () => {
  beforeEach(() => {
    send.mockClear()
    setState({ queued: {}, held: {} })
    busy(['c1'])
  })

  it('waits until the answer is done, then goes out one at a time', async () => {
    queueMessage('c1', { text: 'first' })
    queueMessage('c1', { text: 'second' })
    expect(send).not.toHaveBeenCalled()
    expect(getState().queued.c1.map((q) => q.text)).toEqual(['first', 'second'])

    busy([])
    sendQueued('c1')
    sendQueued('c1') // a second "finished" before the next answer starts sends nothing more
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toMatchObject({ conversationId: 'c1', text: 'first' })
    expect(getState().queued.c1.map((q) => q.text)).toEqual(['second'])
    await flush()
  })

  it('holds the queue after a stop until asked, and can take a message back', async () => {
    queueMessage('c1', { text: 'keep', attachments: [{ id: 'a1' } as never] })
    queueMessage('c1', { text: 'drop' })
    stopChat('c1')
    busy([])
    sendQueued('c1')
    expect(send).not.toHaveBeenCalled()

    unqueue('c1', getState().queued.c1[0].id)
    expect(discardAttachment).toHaveBeenCalledWith('a1')
    sendQueued('c1', true)
    expect(send.mock.calls[0][0]).toMatchObject({ text: 'drop' })
    await flush()
  })

  it('puts a message that could not be sent back at the front', async () => {
    send.mockRejectedValueOnce(new Error('This conversation is still answering.'))
    busy([])
    queueMessage('c1', { text: 'retry me' })
    await flush()
    await flush()
    expect(getState().queued.c1.map((q) => q.text)).toEqual(['retry me'])
    expect(getState().held.c1).toBe(true)
  })
})

describe('the working line', () => {
  const m = (patch: Partial<Message>): Message => ({ id: 'm', conversationId: 'c', role: 'assistant', text: '', createdAt: 0, status: 'streaming', ...patch }) as Message
  it('names the step under way', () => {
    expect(workStatus(m({}))).toBe('Getting started')
    expect(workStatus(m({ thinking: 'hmm' }))).toBe('Thinking')
    expect(workStatus(m({ tools: [{ id: 't', name: 'Bash', summary: 'npm test\nmore', status: 'running', kind: 'command' }] }))).toBe('Running npm test')
    expect(workStatus(m({ plan: [{ text: 'Fix the parser', status: 'active' }] }))).toBe('Fix the parser')
    expect(workStatus(m({ text: 'Here' }))).toBe('Writing')
  })
})
