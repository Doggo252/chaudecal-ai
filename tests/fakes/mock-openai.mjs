// Stand-in for a local model runtime (Ollama, LM Studio). Serves the two
// OpenAI compatible routes the app uses.

import { createServer } from 'node:http'

export function startMockOpenAI({ models = ['mock-llama:8b'], delayMs = 5 } = {}) {
  const requests = []
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) }))
      return
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = ''
      for await (const c of req) raw += c
      const body = JSON.parse(raw)
      requests.push(body)
      const lastContent = body.messages[body.messages.length - 1]?.content ?? ''
      // A message with images arrives as a list of parts.
      const parts = Array.isArray(lastContent) ? lastContent : [{ type: 'text', text: lastContent }]
      const last = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
      const imageCount = parts.filter((p) => p.type === 'image_url' && String(p.image_url?.url).startsWith('data:image/')).length
      const system = body.messages.find((m) => m.role === 'system')?.content ?? ''
      const isSummary = /running summary/i.test(system)
      const notes = []
      if (body.messages.length > 2) notes.push(`I can see ${body.messages.length - 1} earlier messages`)
      if (system.includes('Context file')) notes.push('I received the context file')
      if (system.includes('standing instructions')) notes.push('I have your standing instructions')
      if (imageCount) notes.push(`I can see ${imageCount} ${imageCount === 1 ? 'image' : 'images'}`)
      const reply = isSummary ? 'SUMMARY: the user is testing the app and asked several questions.' : `Local model here. You said: "${String(last).split('\n').pop()}".${notes.length ? ` ${notes.join('. ')}.` : ''}`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const word of reply.split(/(?<= )/)) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`)
        await new Promise((r) => setTimeout(r, delayMs))
      }
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ port, baseUrl: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}
