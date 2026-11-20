// Stand-ins for claude.ai and chatgpt.com: just the parts the app reads to bring
// in a user's chats, in the shapes the real sites use (as read by open-source
// exporters). Used directly by unit tests, and over HTTP by the end-to-end test.

import { createServer } from 'node:http'

const iso = (s) => new Date(s * 1000).toISOString()
const T = 1_760_000_000 // a fixed moment, in unix seconds

export function makeSites() {
  const state = { signedIn: { claude: true, chatgpt: true }, requests: [], limitOnce: new Set(), touched: 0, claudeParents: [] }

  // ---------- ChatGPT ----------
  const node = (id, parent, children, message) => ({ id, parent, children, message })
  const msg = (id, role, content, extra = {}) => ({ id, author: { role }, create_time: T + Number(id.replace(/\D/g, '') || 0), content, metadata: {}, recipient: 'all', ...extra })
  const chatgptChats = {
    'g-trip': {
      title: 'Trip to Lisbon',
      create_time: T,
      update_time: T + 500,
      current_node: 'n9',
      mapping: {
        root: node('root', null, ['n1'], null),
        n1: node('n1', 'root', ['n2'], msg('n1', 'system', { content_type: 'text', parts: [''] }, { metadata: { is_visually_hidden_from_conversation: true } })),
        n2: node('n2', 'n1', ['n3'], msg('n2', 'user', { content_type: 'user_editable_context', user_profile: 'secret profile' })),
        // The first question was edited. The old one (n3) is a branch the user no longer sees.
        n3: node('n3', 'n2', ['n4', 'n5'], msg('n3', 'user', { content_type: 'text', parts: ['Plan three days in Lisbon.'] })),
        n4: node('n4', 'n3', [], msg('n4', 'assistant', { content_type: 'text', parts: ['An old answer on the other branch.'] })),
        n5: node('n5', 'n3', ['n6'], msg('n5', 'assistant', { content_type: 'thoughts', thoughts: [{ summary: 'Thinking', content: 'hidden thoughts' }] })),
        n6: node('n6', 'n5', ['n7'], msg('n6', 'assistant', { content_type: 'code', language: 'json', text: '{"q":"lisbon"}' }, { recipient: 'web.run' })),
        n7: node('n7', 'n6', ['n8'], msg('n7', 'tool', { content_type: 'text', parts: ['search results'] })),
        n8: node('n8', 'n7', ['n9'], msg('n8', 'assistant', { content_type: 'text', parts: ['Day one: Alfama. citeturn0search0'] }, { metadata: { model_slug: 'gpt-5' } })),
        n9: node('n9', 'n8', [], msg('n9', 'assistant', { content_type: 'text', parts: ['Day two: Belém.'] }, { metadata: { model_slug: 'gpt-5' } }))
      }
    },
    'g-photo': {
      title: 'What is in this photo?',
      create_time: T + 100,
      update_time: T + 200,
      current_node: 'p2',
      mapping: {
        p1: node('p1', null, ['p2'], msg('p1', 'user', { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_1' }, 'What is this?'] }, { metadata: { attachments: [{ name: 'cat.png' }] } })),
        p2: node('p2', 'p1', [], msg('p2', 'assistant', { content_type: 'text', parts: ['A cat on a sofa.'] }))
      }
    },
    'g-old': {
      title: 'An archived chat',
      create_time: T - 1000,
      update_time: T - 900,
      current_node: 'o2',
      mapping: {
        o1: node('o1', null, ['o2'], msg('o1', 'user', { content_type: 'text', parts: ['Old question'] })),
        o2: node('o2', 'o1', [], msg('o2', 'assistant', { content_type: 'text', parts: ['Old answer'] }))
      }
    },
    'g-project': {
      title: 'Project notes',
      create_time: T + 300,
      update_time: T + 400,
      current_node: 'j2',
      mapping: {
        j1: node('j1', null, ['j2'], msg('j1', 'user', { content_type: 'text', parts: ['Notes for the project'] })),
        j2: node('j2', 'j1', [], msg('j2', 'assistant', { content_type: 'text', parts: ['Here are the notes.'] }))
      }
    }
  }
  const chatgptItem = (id) => ({ id, title: chatgptChats[id].title, create_time: iso(chatgptChats[id].create_time), update_time: iso(chatgptChats[id].update_time), is_archived: id === 'g-old' })

  // ---------- Claude ----------
  const claudeChats = {
    'c-garden': {
      uuid: 'c-garden',
      name: 'Garden plan',
      created_at: iso(T + 50),
      updated_at: iso(T + 600),
      current_leaf_message_uuid: 'm4',
      chat_messages: [
        { uuid: 'm1', parent_message_uuid: '00000000-0000-4000-8000-000000000000', index: 0, sender: 'human', created_at: iso(T + 51), content: [{ type: 'text', text: 'Draw my garden.' }], attachments: [{ file_name: 'beds.txt', file_size: 20, extracted_content: 'Bed A: tomatoes\nBed B: beans' }], files: [] },
        {
          uuid: 'm2',
          parent_message_uuid: 'm1',
          index: 1,
          sender: 'assistant',
          created_at: iso(T + 52),
          content: [
            { type: 'thinking', thinking: 'planning' },
            { type: 'text', text: 'Here is a first layout.' },
            { type: 'tool_use', name: 'artifacts', input: { command: 'create', id: 'garden', type: 'text/html', title: 'Garden "layout"', content: '<!doctype html><h1>Beds</h1><p>A: tomatoes</p>' } },
            { type: 'tool_result', content: [{ type: 'text', text: 'OK' }] }
          ]
        },
        { uuid: 'm3', parent_message_uuid: 'm2', index: 2, sender: 'human', created_at: iso(T + 53), content: [{ type: 'text', text: 'Swap in peppers.' }] },
        {
          uuid: 'm4',
          parent_message_uuid: 'm3',
          index: 3,
          sender: 'assistant',
          created_at: iso(T + 54),
          content: [
            { type: 'tool_use', name: 'artifacts', input: { command: 'update', id: 'garden', old_str: 'tomatoes', new_str: 'peppers' } },
            { type: 'text', text: 'Updated.' },
            { type: 'tool_use', name: 'create_file', input: { path: '/mnt/user-data/outputs/plan.md', file_text: '# Plan\n\n```\nwater daily\n```' } }
          ]
        }
      ]
    },
    'c-hello': {
      uuid: 'c-hello',
      name: 'Hello Claude',
      created_at: iso(T + 10),
      updated_at: iso(T + 20),
      current_leaf_message_uuid: 'h2',
      chat_messages: [
        { uuid: 'h1', parent_message_uuid: null, index: 0, sender: 'human', created_at: iso(T + 11), text: 'Hello', content: [] },
        { uuid: 'h2', parent_message_uuid: 'h1', index: 1, sender: 'assistant', created_at: iso(T + 12), content: [{ type: 'text', text: 'Hi! How can I help?' }] }
      ]
    }
  }
  const claudeItem = (id) => ({ uuid: id, name: claudeChats[id].name, created_at: claudeChats[id].created_at, updated_at: claudeChats[id].updated_at, current_leaf_message_uuid: claudeChats[id].current_leaf_message_uuid })
  const emptyClaude = { uuid: 'c-empty', name: 'Untitled', created_at: iso(T), updated_at: iso(T), current_leaf_message_uuid: '00000000-0000-0000-0000-000000000000' }

  const json = (body, status = 200) => ({ status, body: JSON.stringify(body) })

  /** Answers one request the way the site would. */
  // ---------- Regular chats written through the sites ----------
  let made = 0
  const nowIso = () => new Date().toISOString()

  /** chatgpt.com's own page sends this when its send button is pressed. The answer is written over a moment. */
  function chatgptPageSend(body) {
    made++
    const now = Date.now() / 1000
    let id = body.conversation_id
    if (!id || !chatgptChats[id]) {
      id = `g-web-${made}`
      chatgptChats[id] = { title: `Web chat ${made}`, create_time: now, update_time: now, current_node: 'root', mapping: { root: node('root', null, [], null) } }
    }
    const chat = chatgptChats[id]
    const u = `wu-${made}`
    const a = `wa-${made}`
    chat.mapping[chat.current_node].children.push(u)
    chat.mapping[u] = node(u, chat.current_node, [a], { ...msg(u, 'user', { content_type: 'text', parts: [body.text] }), create_time: now })
    const answer = `ChatGPT on the web here. You said: "${body.text}".`
    chat.mapping[a] = node(a, u, [], { ...msg(a, 'assistant', { content_type: 'text', parts: [''] }), create_time: now + 0.1, status: 'in_progress', end_turn: null, metadata: { model_slug: body.model || 'gpt-web' } })
    chat.current_node = a
    chat.update_time = now
    setTimeout(() => (chat.mapping[a].message.content.parts = ['ChatGPT on the web here.']), 150)
    setTimeout(() => {
      chat.mapping[a].message.content.parts = [answer]
      chat.mapping[a].message.status = 'finished_successfully'
      chat.mapping[a].message.end_turn = true
      chat.update_time = Date.now() / 1000
    }, 500)
    return id
  }

  /** claude.ai: a new chat, an answer streamed back, and a name for it. */
  function claudeWrite(path, method, body) {
    const create = /^\/api\/organizations\/org-1\/chat_conversations$/.exec(path)
    if (create && method === 'POST') {
      const b = JSON.parse(body || '{}')
      claudeChats[b.uuid] = { uuid: b.uuid, name: b.name ?? '', created_at: nowIso(), updated_at: nowIso(), current_leaf_message_uuid: '00000000-0000-0000-0000-000000000000', chat_messages: [] }
      return { status: 201, body: JSON.stringify(claudeChats[b.uuid]) }
    }
    const complete = /^\/api\/organizations\/org-1\/chat_conversations\/([^/]+)\/completion$/.exec(path)
    if (complete && method === 'POST' && claudeChats[complete[1]]) {
      const chat = claudeChats[complete[1]]
      const b = JSON.parse(body || '{}')
      made++
      const h = `wh-${made}`
      const a = `wa-${made}`
      const answer = `Claude on the web here. You said: "${b.prompt}".`
      chat.chat_messages.push({ uuid: h, parent_message_uuid: b.parent_message_uuid, index: chat.chat_messages.length, sender: 'human', created_at: nowIso(), content: [{ type: 'text', text: b.prompt }] })
      chat.chat_messages.push({ uuid: a, parent_message_uuid: h, index: chat.chat_messages.length, sender: 'assistant', created_at: nowIso(), content: [{ type: 'text', text: answer }] })
      chat.current_leaf_message_uuid = a
      chat.updated_at = nowIso()
      state.claudeParents.push(b.parent_message_uuid)
      const words = answer.split(' ')
      const thirds = [words.slice(0, 4).join(' '), ` ${words.slice(4, 8).join(' ')}`, ` ${words.slice(8).join(' ')}`]
      const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`
      return {
        status: 200,
        contentType: 'text/event-stream',
        chunks: [
          ev({ type: 'message_start', message: { id: a } }),
          ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
          ...thirds.map((t) => ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
          ev({ type: 'message_stop' })
        ]
      }
    }
    const title = /^\/api\/organizations\/org-1\/chat_conversations\/([^/]+)\/title$/.exec(path)
    if (title && method === 'POST' && claudeChats[title[1]]) {
      const b = JSON.parse(body || '{}')
      claudeChats[title[1]].name = `Web: ${String(b.message_content).split(' ').slice(0, 4).join(' ')}`
      return { status: 200, body: JSON.stringify({ title: claudeChats[title[1]].name }) }
    }
    return undefined
  }

  function handle(service, path, headers = {}, method = 'GET', body = '') {
    state.requests.push(`${service} ${method === 'GET' ? '' : `${method} `}${path}`)
    const url = new URL(path, 'http://site')
    if (service === 'chatgpt' && url.pathname === '/backend-api/fake-send' && method === 'POST') return json({ conversation_id: chatgptPageSend(JSON.parse(body || '{}')) })
    if (service === 'claude' && method === 'POST') {
      if (!state.signedIn.claude) return json({ error: 'unauthorized' }, 403)
      const written = claudeWrite(url.pathname, method, body)
      if (written) return written
    }
    const key = `${service} ${url.pathname}`
    if (state.limitOnce.has(key)) {
      state.limitOnce.delete(key)
      return { status: 429, body: 'slow down' }
    }
    if (service === 'chatgpt') {
      if (url.pathname === '/api/auth/session') return json(state.signedIn.chatgpt ? { accessToken: 'token-1', user: { name: 'Test' } } : {})
      if (!state.signedIn.chatgpt || headers.Authorization !== 'Bearer token-1') return json({ detail: 'Unauthorized' }, 401)
      if (url.pathname === '/backend-api/conversations') {
        const archived = url.searchParams.get('is_archived') === 'true'
        const ids = Object.keys(chatgptChats).filter((id) => (id === 'g-old') === archived && id !== 'g-project')
        const offset = Number(url.searchParams.get('offset') ?? 0)
        const limit = Number(url.searchParams.get('limit') ?? 28)
        return json({ items: ids.slice(offset, offset + limit).map(chatgptItem), total: ids.length, limit, offset })
      }
      if (url.pathname === '/backend-api/gizmos/snorlax/sidebar') return json({ items: [{ gizmo: { gizmo: { id: 'g-p-1' } } }], cursor: null })
      if (url.pathname === '/backend-api/gizmos/g-p-1/conversations') return json(url.searchParams.get('cursor') === '0' ? { items: [chatgptItem('g-project')], cursor: 'next-abc' } : { items: [], cursor: null })
      const m = /^\/backend-api\/conversation\/([^/]+)$/.exec(url.pathname)
      if (m && chatgptChats[m[1]]) return json(chatgptChats[m[1]])
      return json({ detail: 'Not found' }, 404)
    }
    if (url.pathname === '/api/organizations') return state.signedIn.claude ? json([{ uuid: 'org-api', capabilities: ['api'] }, { uuid: 'org-1', capabilities: ['chat', 'claude_pro'] }]) : json({ error: 'unauthorized' }, 403)
    if (!state.signedIn.claude) return json({ error: 'unauthorized' }, 403)
    if (url.pathname === '/api/organizations/org-1/chat_conversations_v2') {
      const all = [...Object.keys(claudeChats).map(claudeItem), emptyClaude]
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 50)
      return json({ data: all.slice(offset, offset + limit), has_more: offset + limit < all.length })
    }
    const c = /^\/api\/organizations\/org-1\/chat_conversations\/([^/]+)$/.exec(url.pathname)
    if (c && claudeChats[c[1]]) return json(claudeChats[c[1]])
    return json({ error: 'not found' }, 404)
  }

  /** Something changed on the site: a new answer in one chat. */
  function addAnswer(service, text) {
    state.touched++
    if (service === 'claude') {
      const chat = claudeChats['c-hello']
      const prev = chat.current_leaf_message_uuid
      const id = `h-new-${state.touched}`
      chat.chat_messages.push({ uuid: id, parent_message_uuid: prev, index: chat.chat_messages.length, sender: 'assistant', created_at: iso(T + 30 + state.touched), content: [{ type: 'text', text }] })
      chat.current_leaf_message_uuid = id
      chat.updated_at = iso(T + 700 + state.touched)
    } else {
      const chat = chatgptChats['g-photo']
      const id = `p-new-${state.touched}`
      chat.mapping[chat.current_node].children.push(id)
      chat.mapping[id] = node(id, chat.current_node, [], msg(id, 'user', { content_type: 'text', parts: [text] }))
      chat.current_node = id
      chat.update_time = T + 700 + state.touched
    }
  }

  return { state, handle, addAnswer, chatgptChats, claudeChats }
}

/** Serves one site over HTTP on its own port. The page itself is a plain stand-in. */
export function serveSite(sites, service) {
  const server = createServer((req, res) => {
    const path = req.url ?? '/'
    if (path.startsWith('/api/') || path.startsWith('/backend-api/')) {
      const headers = {}
      if (req.headers.authorization) headers.Authorization = req.headers.authorization
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', async () => {
        const out = sites.handle(service, path, headers, req.method ?? 'GET', body)
        res.writeHead(out.status, { 'content-type': out.contentType ?? 'application/json' })
        if (out.chunks) {
          // An answer written while you watch.
          for (const chunk of out.chunks) {
            res.write(chunk)
            await new Promise((r) => setTimeout(r, 40))
          }
          res.end()
        } else res.end(out.body)
      })
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    // chatgpt.com's page has a message box and a send button, which the app uses for regular chats.
    const composer =
      service === 'chatgpt'
        ? `<div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button>
<script>
document.querySelector('[data-testid="send-button"]').addEventListener('click', async () => {
  const text = document.querySelector('#prompt-textarea').innerText.trim();
  const m = /\\/c\\/([^/?#]+)/.exec(location.pathname);
  const r = await fetch('/backend-api/fake-send', { method: 'POST', body: JSON.stringify({ conversation_id: m ? m[1] : null, text, model: new URLSearchParams(location.search).get('model') }) });
  const out = await r.json();
  document.querySelector('#prompt-textarea').textContent = '';
  if (!m) history.pushState({}, '', '/c/' + out.conversation_id);
});
</script>`
        : ''
    res.end(`<!doctype html><title>${service} stand-in</title><h1>${service === 'claude' ? 'Claude' : 'ChatGPT'} stand-in</h1><p>${path}</p>${composer}`)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}
