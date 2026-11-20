import { describe, expect, it } from 'vitest'
import { chatgptReplyState, claudeStreamText, sseReader } from '../src/shared/webChat'

describe('reading replies from the sites', () => {
  it('splits an event stream however it is cut', () => {
    const seen: string[] = []
    const read = sseReader((event, data) => seen.push(`${event}:${data}`))
    read('event: a\ndata: {"x"')
    read(':1}\n\nevent: b\r\ndata: two\r\n\r\n')
    expect(seen).toEqual(['a:{"x":1}', 'b:two'])
  })

  it('reads a claude.ai reply in content blocks, and the older completion form', () => {
    const blocks = [
      'event: message_start\ndata: {"type":"message_start"}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there."}}',
      'event: message_stop\ndata: {"type":"message_stop"}'
    ].join('\n\n')
    expect(claudeStreamText(blocks)).toMatchObject({ text: 'Hello there.', done: true })
    expect(claudeStreamText('data: {"type":"completion","completion":"Hi"}\n\ndata: {"type":"completion","completion":"!"}').text).toBe('Hi!')
  })

  it('reports a reached Claude limit', () => {
    const s = claudeStreamText('data: {"type":"message_limit","message_limit":{"type":"exceeded_limit","resetsAt":1795200000}}')
    expect(s.error).toMatch(/limit/)
    expect(s.resetsAt).toBe(1795200000000)
  })

  it('knows when a chatgpt.com answer has started and finished', () => {
    const sent = 1_000_000_000_000
    const chat = (status: string, text: string) => ({
      current_node: 'a1',
      mapping: {
        u1: { id: 'u1', parent: null, children: ['a1'], message: { id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['Hi'] }, create_time: sent / 1000 } },
        a1: { id: 'a1', parent: 'u1', children: [], message: { id: 'a1', author: { role: 'assistant' }, recipient: 'all', status, end_turn: status === 'finished_successfully', content: { content_type: 'text', parts: [text] }, create_time: sent / 1000 + 1 } }
      }
    })
    expect(chatgptReplyState(chat('in_progress', 'Hel'), sent)).toEqual({ text: 'Hel', done: false, started: true })
    expect(chatgptReplyState(chat('finished_successfully', 'Hello.'), sent)).toEqual({ text: 'Hello.', done: true, started: true })
    expect(chatgptReplyState(chat('finished_successfully', 'Old answer'), sent + 3_600_000).started).toBe(false)
  })
})
