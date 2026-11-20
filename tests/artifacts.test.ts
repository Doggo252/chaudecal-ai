import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { Message, ProviderStatus, Settings } from '@shared/types'
import { ARTIFACT_GUIDE } from '@shared/context'
import { artifactBlocks, artifactFileName, classifyFence, collectArtifacts, fenceClosed, findArtifact, parseFenceInfo, type ArtifactSource } from '@shared/artifacts'
import { artifactDocument, compileComponent, htmlDocument, mermaidDocument, moduleUrl, REACT_IMPORTS, svgDocument } from '@shared/artifactDoc'
import { ARTIFACT_SCHEME, artifactCsp, ERROR_MESSAGE_TYPE, frameUrlAllowed } from '@shared/artifactPolicy'
import { Store } from '../src/main/store'
import { ChatEngine } from '../src/main/chat'
import { Summarizer } from '../src/main/summarizer'
import { ClaudeProvider } from '../src/main/providers/claude'
import { CodexProvider } from '../src/main/providers/codex'
import { LocalProvider } from '../src/main/providers/local'
import { startMockOpenAI } from './fakes/mock-openai.mjs'
import { canRunFakes, tempDir, testSettings } from './helpers'

const F = '```'

describe('finding artifacts in a reply', () => {
  it('reads the language and the title from the opening fence', () => {
    expect(parseFenceInfo('html title="Pricing page"')).toEqual({ language: 'html', title: 'Pricing page' })
    expect(parseFenceInfo("JSX title='Counter'")).toEqual({ language: 'jsx', title: 'Counter' })
    expect(parseFenceInfo('python title=Script')).toEqual({ language: 'python', title: 'Script' })
    expect(parseFenceInfo('ts')).toEqual({ language: 'ts', title: undefined })
    expect(parseFenceInfo('')).toEqual({ language: '', title: undefined })
    expect(parseFenceInfo('title="Only a title"')).toEqual({ language: '', title: 'Only a title' })
  })

  it('takes titled blocks, and full pages, images, diagrams and components without one', () => {
    expect(classifyFence('html title="Page"', '<p>hi</p>')).toMatchObject({ kind: 'html', title: 'Page', titled: true })
    expect(classifyFence('html', '<!DOCTYPE html><html><head><title>My site</title></head></html>')).toMatchObject({ kind: 'html', title: 'My site', titled: false })
    expect(classifyFence('svg', '<svg viewBox="0 0 1 1"></svg>')).toMatchObject({ kind: 'svg', title: 'Image' })
    expect(classifyFence('xml', '<?xml version="1.0"?>\n<svg><title>Logo</title></svg>')).toMatchObject({ kind: 'svg', title: 'Logo' })
    expect(classifyFence('mermaid', 'graph TD; A-->B')).toMatchObject({ kind: 'mermaid', title: 'Diagram' })
    expect(classifyFence('jsx', 'export default function TodoList() { return <ul/> }')).toMatchObject({ kind: 'react', title: 'TodoList' })
    expect(classifyFence('tsx title="Chart"', 'const A = () => null\nexport default A')).toMatchObject({ kind: 'react', language: 'tsx' })
    expect(classifyFence('javascript title="App"', "import { useState } from 'react'\nexport default function App() { return <div/> }")).toMatchObject({ kind: 'react' })
    expect(classifyFence('markdown title="Plan"', '# Plan')).toMatchObject({ kind: 'markdown' })
    expect(classifyFence('python title="Script"', 'print(1)')).toMatchObject({ kind: 'code', language: 'python' })
    expect(classifyFence('title="Notes"', 'plain')).toMatchObject({ kind: 'code', language: 'text' })
  })

  it('leaves short examples as ordinary code blocks', () => {
    expect(classifyFence('html', '<div class="x">hi</div>')).toBeUndefined()
    expect(classifyFence('jsx', '<Button onClick={go} />')).toBeUndefined()
    expect(classifyFence('markdown', '# Heading')).toBeUndefined()
    expect(classifyFence('python', 'print(1)')).toBeUndefined()
    expect(classifyFence('', 'text')).toBeUndefined()
    expect(classifyFence('js title="Helper"', 'export const add = (a, b) => a + b')).toMatchObject({ kind: 'code' })
  })

  it('finds them in order, inside lists too, and keeps a document that contains code whole', () => {
    const text = [
      'Intro',
      '',
      `${F}\`markdown title="Read me"`,
      '# Title',
      `${F}js`,
      'x()',
      F,
      `${F}\``,
      '',
      '- a step',
      '',
      `  ${F}python title="Step"`,
      '  print(2)',
      `  ${F}`,
      '',
      `${F}python`,
      'not an artifact',
      F,
      '',
      '    indented code is never one'
    ].join('\n')
    const blocks = artifactBlocks(text)
    expect(blocks.map((b) => [b.index, b.kind, b.title])).toEqual([
      [0, 'markdown', 'Read me'],
      [1, 'code', 'Step']
    ])
    expect(blocks[0].content).toBe(`# Title\n${F}js\nx()\n${F}`)
    expect(blocks.every((b) => b.closed)).toBe(true)
    expect(artifactBlocks('no fences at all')).toEqual([])
  })

  it('knows when the last one is still being written', () => {
    const open = `Here:\n\n${F}html title="Page"\n<p>half`
    expect(artifactBlocks(open)).toMatchObject([{ title: 'Page', closed: false, content: '<p>half' }])
    expect(artifactBlocks(`${F}svg`)).toMatchObject([{ closed: false }])
    expect(fenceClosed(`${F}html\n<p>x</p>\n${F}`)).toBe(true)
    expect(fenceClosed(`${F}html\n<p>x</p>`)).toBe(false)
  })
})

describe('artifacts across a conversation', () => {
  const msg = (id: string, text: string, extra: Partial<ArtifactSource> = {}): ArtifactSource => ({ id, role: 'assistant', text, status: 'complete', createdAt: Number(id.replace(/\D/g, '')) || 1, ...extra })
  const page = (body: string) => `${F}html title="Greeting page"\n${body}\n${F}`

  it('gathers the same title into versions, oldest first, and keeps untitled ones apart', () => {
    const messages = [
      msg('m1', `${page('<h1>One</h1>')}\n\n${F}mermaid\ngraph TD; A-->B\n${F}`),
      { ...msg('u2', `${F}html title="Greeting page"\n<p>written by the user</p>\n${F}`), role: 'user' },
      msg('m3', `${page('<h1>Two</h1>')}\n\n${F}mermaid\ngraph TD; C-->D\n${F}`),
      msg('m4', page('<h1>Three</h1>'), { status: 'streaming' })
    ]
    const artifacts = collectArtifacts(messages)
    expect(artifacts.map((a) => [a.title, a.versions.length])).toEqual([
      ['Greeting page', 4],
      ['Diagram', 1],
      ['Diagram', 1]
    ])
    const greeting = artifacts[0]
    // A version the user saved (an edit of theirs) counts too, in its place.
    expect(greeting.versions.map((v) => v.content)).toEqual(['<h1>One</h1>', '<p>written by the user</p>', '<h1>Two</h1>', '<h1>Three</h1>'])
    expect(greeting.versions.map((v) => v.messageId)).toEqual(['m1', 'u2', 'm3', 'm4'])
    // A closed fence is finished even while the rest of the reply is still coming.
    expect(greeting.versions[3].complete).toBe(true)
    expect(collectArtifacts([msg('m5', `${F}html title="X"\n<p>`, { status: 'streaming' })])[0].versions[0].complete).toBe(false)
    expect(collectArtifacts([msg('m5', `${F}html title="X"\n<p>`, { status: 'complete' })])[0].versions[0].complete).toBe(true)

    expect(findArtifact(artifacts, 'm3', 0)).toMatchObject({ artifact: { title: 'Greeting page' }, version: 2 })
    expect(findArtifact(artifacts, 'm3', 1)?.artifact.versions[0].content).toBe('graph TD; C-->D')
    expect(findArtifact(artifacts, 'm9', 0)).toBeUndefined()
  })

  it('treats titles that differ only in case or spacing as the same artifact', () => {
    const artifacts = collectArtifacts([msg('m1', `${F}html title="My  Page"\n<p>1</p>\n${F}`), msg('m2', `${F}html title="my page"\n<p>2</p>\n${F}`)])
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].title).toBe('my page')
  })

  it('names saved files after the title, with the right extension', () => {
    expect(artifactFileName({ kind: 'html', language: 'html', title: 'Pricing page' })).toBe('pricing-page.html')
    expect(artifactFileName({ kind: 'react', language: 'tsx', title: 'Sales Chart' })).toBe('sales-chart.tsx')
    expect(artifactFileName({ kind: 'react', language: 'jsx', title: 'Counter' })).toBe('counter.jsx')
    expect(artifactFileName({ kind: 'mermaid', language: 'mermaid', title: 'Diagram' })).toBe('diagram.mmd')
    expect(artifactFileName({ kind: 'markdown', language: 'markdown', title: 'Café notes' })).toBe('cafe-notes.md')
    expect(artifactFileName({ kind: 'code', language: 'python', title: 'Count words' })).toBe('count-words.py')
    expect(artifactFileName({ kind: 'code', language: 'brainfreeze', title: '../../etc' })).toBe('etc.txt')
    expect(artifactFileName({ kind: 'svg', language: 'svg', title: '***' })).toBe('artifact.svg')
  })
})

describe('preview pages', () => {
  it('shows a web page as written, with the error reporter ahead of its own scripts', () => {
    const doc = htmlDocument('<!doctype html><html><head><title>T</title></head><body><script>go()</script></body></html>')
    expect(doc.startsWith('<!doctype html><html><head><script>')).toBe(true)
    expect(doc).toContain(ERROR_MESSAGE_TYPE)
    expect(doc.indexOf(ERROR_MESSAGE_TYPE)).toBeLessThan(doc.indexOf('go()'))
    const fragment = htmlDocument('<p>Just a paragraph</p>')
    expect(fragment).toMatch(/^<!doctype html>/)
    expect(fragment).toContain('<p>Just a paragraph</p>')
  })

  it('places images and diagrams on a page, with the diagram text kept as text', () => {
    expect(svgDocument('<?xml version="1.0"?>\n<svg><rect/></svg>')).toContain('<body>\n<svg><rect/></svg>')
    const diagram = mermaidDocument('graph TD; A["<b>x</b>"] --> B')
    expect(diagram).toContain('A[&quot;&lt;b&gt;x&lt;/b&gt;&quot;] --&gt; B')
    expect(diagram).toContain('cdn.jsdelivr.net/npm/mermaid@11')
  })

  it('turns a React component into a module that loads React and its packages from esm.sh', () => {
    const code = compileComponent(
      "import { useState } from 'react'\nimport { LineChart } from 'recharts'\nimport * as d3 from 'd3-scale'\nexport default function App() { const [n] = useState(1); return <div className=\"p-2\">{n} from 'nowhere'</div> }",
      'jsx'
    )
    expect(code).toContain(`from "${REACT_IMPORTS['react/jsx-runtime']}"`)
    expect(code).toContain(`from '${REACT_IMPORTS.react}'`)
    expect(code).toContain("from 'https://esm.sh/recharts?external=react,react-dom'")
    expect(code).toContain("from 'https://esm.sh/d3-scale?external=react,react-dom'")
    // Text inside the component is left alone.
    expect(code).toContain("from 'nowhere'")
    expect(code).not.toContain('<div')
  })

  it('reads TypeScript components too', () => {
    const code = compileComponent('type P = { n?: number }\nexport default function A({ n = 1 }: P): JSX.Element { return <b>{n}</b> }', 'tsx')
    expect(code).not.toContain('type P')
    expect(code).toContain('export default function A')
  })

  it('says why a component cannot be shown', () => {
    expect(artifactDocument('react', "import Card from '@/components/ui/card'\nexport default () => <Card/>", 'jsx').error).toMatch(/a file of a project/)
    expect(artifactDocument('react', "import x from './x'\nexport default () => x", 'jsx').error).toMatch(/"\.\/x"/)
    expect(artifactDocument('react', 'function A() { return <b/> }', 'jsx').error).toMatch(/no default export/)
    expect(artifactDocument('react', 'export default function A() { return <b> }', 'jsx').error).toMatch(/could not be read/)
    expect(artifactDocument('code', 'x', 'python').error).toBeDefined()
    expect(moduleUrl('https://cdn.example/x.js')).toBe('https://cdn.example/x.js')
  })

  it('cannot be broken out of by a component that writes a closing script tag', () => {
    const doc = artifactDocument('react', 'export default function A() { return <p>{"</script><script>alert(1)</script>"}</p> }', 'jsx').html!
    const body = doc.slice(doc.indexOf('<div id="root">'))
    expect(body.match(/<\/script>/g)).toHaveLength(1)
    expect(doc).toContain('\\u003c/script>')
  })
})

describe('what a preview may reach', () => {
  it('loads code only from a few public hosts, takes no images from the internet, and posts no forms', () => {
    const csp = artifactCsp()
    const rule = (name: string) => csp.split('; ').find((r) => r.startsWith(`${name} `)) ?? ''
    expect(rule('default-src')).toBe("default-src 'none'")
    expect(rule('img-src')).toBe('img-src data: blob:')
    expect(rule('connect-src')).not.toMatch(/https:(\s|$)|\*/)
    expect(rule('script-src')).not.toMatch(/https:(\s|$)|\*/)
    expect(rule('script-src')).toContain('https://esm.sh')
    expect(rule('form-action')).toBe("form-action 'none'")
    expect(rule('frame-src')).toBe("frame-src 'none'")
  })

  it('lets frames in the window show previews and nothing else', () => {
    expect(frameUrlAllowed(`${ARTIFACT_SCHEME}://view/abc`)).toBe(true)
    expect(frameUrlAllowed('about:blank')).toBe(true)
    expect(frameUrlAllowed('https://example.com/')).toBe(false)
    expect(frameUrlAllowed('file:///etc/passwd')).toBe(false)
    expect(frameUrlAllowed('javascript:alert(1)')).toBe(false)
  })

  it('tells the assistants how to write them, without an em dash', () => {
    expect(ARTIFACT_GUIDE).toContain('```html title="Pricing page"')
    expect(ARTIFACT_GUIDE).not.toMatch(/[\u2013\u2014]/)
  })
})

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function engineWith(patch: (s: Settings) => void) {
  const runtime = await startMockOpenAI()
  cleanup.push(() => runtime.close())
  const dir = tempDir()
  const store = new Store(join(dir, 'app.db'))
  const settings = testSettings((s) => {
    s.local.endpoints = [{ id: 'ollama', name: 'Ollama', baseUrl: runtime.baseUrl, enabled: true }]
    patch(s)
  })
  const local = new LocalProvider(() => settings, { current: () => undefined })
  const codex = new CodexProvider(() => settings, '0.0.0-test', () => {})
  cleanup.push(() => codex.dispose())
  const ready = (provider: 'claude' | 'chatgpt' | 'local'): ProviderStatus => ({ provider, installed: true, ready: true, detail: '', models: [] })
  const engine = new ChatEngine(
    store,
    () => settings,
    { claude: new ClaudeProvider(() => settings, join(dir, 'tmp')), chatgpt: codex, local },
    () => ({ claude: ready('claude'), chatgpt: ready('chatgpt'), local: ready('local') }),
    { stream: () => {}, route: () => {}, approval: () => {}, denials: () => {}, busy: () => {} },
    { context: join(dir, 'context'), scratch: join(dir, 'workspace'), attachments: join(dir, 'attachments') },
    new Summarizer(store, () => settings, local)
  )
  const last = (id: string): Message => store.messages(id).filter((m) => m.role === 'assistant').pop()!
  return { engine, runtime, last }
}

describe.skipIf(!canRunFakes)('assistants and artifacts', () => {
  it('tells every assistant how to write artifacts, and the reply carries them', async () => {
    const { engine, runtime, last } = await engineWith(() => {})
    const conv = engine.createConversation({ provider: 'claude' })
    await engine.send({ conversationId: conv.id, text: 'Make me a page. [artifact]' })
    const reply = last(conv.id)
    expect(reply.text).toContain('I know how to write artifacts.')
    expect(artifactBlocks(reply.text).map((b) => [b.kind, b.title])).toEqual([
      ['html', 'Greeting page'],
      ['svg', 'Two shapes'],
      ['code', 'Count words']
    ])

    engine.switchProvider(conv.id, 'local')
    await engine.send({ conversationId: conv.id, text: 'And you?' })
    const system = runtime.requests[runtime.requests.length - 1].messages.find((m: { role: string }) => m.role === 'system')?.content ?? ''
    expect(system).toContain(ARTIFACT_GUIDE)
  })

  it('leaves the instructions out when artifacts are turned off', async () => {
    const { engine, runtime, last } = await engineWith((s) => {
      s.artifacts = false
    })
    const conv = engine.createConversation({ provider: 'claude' })
    await engine.send({ conversationId: conv.id, text: 'Make me a page. [artifact]' })
    expect(last(conv.id).text).toContain('Nobody told me about artifacts.')
    engine.switchProvider(conv.id, 'local')
    await engine.send({ conversationId: conv.id, text: 'And you?' })
    const system = runtime.requests[runtime.requests.length - 1].messages.find((m: { role: string }) => m.role === 'system')?.content ?? ''
    expect(system).not.toContain('artifacts')
  })
})
