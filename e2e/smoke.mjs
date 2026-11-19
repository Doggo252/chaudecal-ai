// End-to-end check of the real app window, driven like a user would.
// Claude, ChatGPT and the local runtime are replaced by the stand-ins in
// tests/fakes, so this spends nothing and needs no sign-in.
//
//   npm run build && npm run e2e

import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockOpenAI } from '../tests/fakes/mock-openai.mjs'
import { makePdf } from '../tests/fakes/pdf.mjs'
import { makeSites, serveSite } from '../tests/fakes/fake-sites.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shots = join(root, 'e2e', 'artifacts')
rmSync(shots, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })
const electronPath = createRequire(import.meta.url)('electron')
const fakeClaude = join(root, 'tests/fakes/fake-claude.mjs')
const fakeCodex = join(root, 'tests/fakes/fake-codex.mjs')

const steps = []
const started = Date.now()
function ok(name) {
  steps.push(name)
  console.log(`  ok  ${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s  ${name}`)
}
function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`)
}
const freePort = () =>
  new Promise((res) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })

async function launch(name, settings, env = {}) {
  const userData = mkdtempSync(join(tmpdir(), `chaudecal-e2e-${name}-`))
  const app = await electron.launch({
    // E2E_APP points at a packaged build to test that instead of the development build.
    executablePath: process.env.E2E_APP || electronPath,
    args: process.env.E2E_APP ? [] : [root],
    // Let the app decide light or dark itself instead of the test harness forcing light.
    colorScheme: 'no-override',
    // The stand-ins are configured before the app starts, so no real service is ever contacted.
    env: { ...process.env, CHAUDECAL_USER_DATA: userData, CHAUDECAL_SETTINGS_JSON: JSON.stringify(settings), FAKE_DELAY_MS: '12', ...env }
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log(`  [${name}] page error: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && console.log(`  [${name}] console error: ${m.text()}`))
  await page.waitForSelector('[data-testid="new-chat"]', { timeout: 20000 })
  return { app, page, userData, name }
}

const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) })
const tid = (id) => `[data-testid="${id}"]`

async function sendMessage(page, text) {
  await page.fill(tid('composer-input'), text)
  await page.click(tid('send'))
}
async function waitForReply(page, provider, containing, timeout = 15000) {
  await page.waitForFunction(
    ([p, t]) => [...document.querySelectorAll(`[data-testid="assistant-message"][data-provider="${p}"]`)].some((el) => el.textContent.includes(t)),
    [provider, containing],
    { timeout }
  )
  // The reply is final once the send button is back.
  await page.waitForSelector(tid('send'), { timeout })
}
async function pickProvider(page, provider) {
  await page.click(tid('provider-picker'))
  await page.click(tid(`provider-${provider}`))
}

const runtime = await startMockOpenAI()
const hubPort = await freePort()

// Files for the attachment check: a real image and a small text file.
const attachDir = mkdtempSync(join(tmpdir(), 'chaudecal-e2e-files-'))
// Each app writes the notifications it would have shown into its own file.
const noticeDir = mkdtempSync(join(tmpdir(), 'chaudecal-e2e-notices-'))
const noticeFile = { hub: join(noticeDir, 'hub.jsonl'), client: join(noticeDir, 'client.jsonl') }
// The hub's "home folder" for the folder browser, so the test never lists or photographs a real one.
const homeDir = mkdtempSync(join(tmpdir(), 'chaudecal-e2e-home-'))
for (const name of ['Desktop', 'Documents', 'projects/website', 'projects/api']) mkdirSync(join(homeDir, name), { recursive: true })
const notices = (name) => (existsSync(noticeFile[name]) ? readFileSync(noticeFile[name], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const notesFile = join(attachDir, 'notes.md')
writeFileSync(notesFile, '# Notes\nThe launch is on Friday.\n')
const pdfFile = join(attachDir, 'handbook.pdf')
writeFileSync(pdfFile, makePdf([['Staff handbook', 'Leave is twenty five days a year.'], ['Expenses are paid monthly.']]))
const attachFiles = [join(root, 'build/icon.png'), notesFile, pdfFile].join(delimiter)

// A tool server for the assistants: the stand-in MCP server, copied to a short neutral path so the screenshots show no real folder.
const toolsDir = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'chaudecal-tools-'))
const toolServer = join(toolsDir, 'notes-server.mjs')
copyFileSync(join(root, 'tests/fakes/fake-mcp.mjs'), toolServer)
const savedNotes = join(toolsDir, 'saved-notes.txt')
// Where downloaded artifacts go, instead of asking with a dialog.
const saveDir = join(attachDir, 'saved')
mkdirSync(saveDir)

// Stand-in for the GitHub releases page, announcing a newer build.
const releases = createHttpServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ tag_name: 'v9.9.9-build.1', html_url: 'https://github.com/Doggo252/chaudecal-ai/releases/latest' }))
})
await new Promise((r) => releases.listen(0, '127.0.0.1', r))
const releasesUrl = `http://127.0.0.1:${releases.address().port}/latest`

// A stand-in speech-to-text server, for dictation. It checks that a recording arrived.
let heardAudio = 0
const speechServer = createHttpServer(async (req, res) => {
  const parts = []
  for await (const chunk of req) parts.push(chunk)
  const size = parts.reduce((n, c) => n + c.length, 0)
  const body = Buffer.concat(parts).toString('latin1')
  const ok = req.url === '/v1/audio/transcriptions' && /multipart\/form-data/.test(req.headers['content-type'] ?? '') && body.includes('name="file"') && body.includes('whisper-1')
  if (ok) heardAudio = size
  res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' })
  res.end(JSON.stringify(ok ? { text: 'Hello from dictation' } : { error: 'bad request' }))
})
await new Promise((r) => speechServer.listen(0, '127.0.0.1', r))
const speechUrl = `http://127.0.0.1:${speechServer.address().port}/v1`

// Stand-ins for claude.ai and chatgpt.com, for bringing in chats through the website tabs.
const sites = makeSites()
const claudeSite = await serveSite(sites, 'claude')
const chatgptSite = await serveSite(sites, 'chatgpt')
const webOrigins = JSON.stringify({ claude: claudeSite.origin, chatgpt: chatgptSite.origin })
let a
let b
try {
  // ---------- Device A: the hub ----------
  a = await launch(
    'hub',
    {
      deviceName: 'Hub PC',
      theme: 'light',
      claude: { cliPath: fakeClaude },
      chatgpt: { cliPath: fakeCodex },
      local: { endpoints: [{ id: 'ollama', name: 'Ollama', baseUrl: runtime.baseUrl, enabled: true }], summarize: false, speechUrl },
      hub: { hostEnabled: true, port: hubPort, allowRemoteRuns: true }
    },
    { FAKE_CLAUDE_UTILIZATION: '0.86', CHAUDECAL_E2E_ATTACH: attachFiles, CHAUDECAL_UPDATE_URL: releasesUrl, CHAUDECAL_E2E_NOTIFY: noticeFile.hub, CHAUDECAL_E2E_HOME: homeDir, CHAUDECAL_E2E_SAVE_DIR: saveDir, CHAUDECAL_E2E_WEB_ORIGINS: webOrigins, CHAUDECAL_E2E_FAKE_MIC: '1' }
  )
  await a.page.waitForFunction(async () => {
    const s = await window.api.state()
    return s.providers.claude?.ready && s.providers.chatgpt?.ready && s.providers.local?.ready && s.hub.connected
  })
  await shot(a.page, '01-new-chat')
  ok('app starts, all three providers ready, hub running')

  // Claude answers, streaming.
  await pickProvider(a.page, 'claude')
  await sendMessage(a.page, 'My cat is called Biscuit.')
  await waitForReply(a.page, 'claude', 'Claude here. You said: "My cat is called Biscuit."')
  await a.page.waitForSelector(tid('conversation'))
  ok('Claude answers and the conversation appears in the sidebar')

  // The stand-in reports 86% of the 5-hour limit used: the app offers to switch.
  await a.page.waitForSelector(tid('limit-banner'))
  const banner = await a.page.textContent(tid('limit-banner'))
  assert(/Claude's 5-hour limit is running low \(86% used\)/.test(banner), `banner text was: ${banner}`)
  await shot(a.page, '02-limit-warning')
  ok('low limit warning appears with an offer to continue elsewhere')

  // Take the offer: hand the conversation to ChatGPT with the full transcript.
  await a.page.click(tid('banner-switch'))
  await a.page.waitForSelector(tid('switch-dialog'))
  assert(await a.page.$(`${tid('target-chatgpt')}.selected`), 'ChatGPT should be preselected as the target')
  await a.page.waitForFunction(() => /tokens/.test(document.querySelector('[data-testid="variant-full"]')?.textContent ?? ''))
  await a.page.click(tid('variant-full'))
  await shot(a.page, '03-switch-dialog')
  await a.page.click(tid('switch-confirm'))
  await sendMessage(a.page, 'What is my cat called?')
  await waitForReply(a.page, 'chatgpt', 'I received the context file')
  assert((await a.page.textContent(`${tid('assistant-message')}[data-provider="chatgpt"]`)).includes('fake'), 'the reply must come from the stand-in, not the real service')
  await shot(a.page, '04-continued-on-chatgpt')
  ok('conversation continues on ChatGPT with the context file')

  // And back: Claude is caught up on what it missed.
  await pickProvider(a.page, 'claude')
  await sendMessage(a.page, 'Back to you.')
  await waitForReply(a.page, 'claude', 'I was caught up on what happened in between')
  ok('switching back catches Claude up on the turns it missed')

  // Compare mode: all three side by side, keep one.
  await a.page.click(tid('new-chat'))
  await a.page.click(tid('compare-toggle'))
  for (const p of ['claude', 'chatgpt', 'local']) await a.page.click(tid(`compare-${p}`))
  await a.page.keyboard.press('Escape')
  await sendMessage(a.page, 'Name a colour.')
  await a.page.waitForFunction(() => document.querySelectorAll('[data-testid="compare-card"]').length === 3)
  await a.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="keep-answer"]')].length === 3 && [...document.querySelectorAll('[data-testid="keep-answer"]')].every((b) => !b.disabled))
  await shot(a.page, '05-compare')
  await a.page.click(`${tid('compare-card')}[data-provider="local"] ${tid('keep-answer')}`)
  await a.page.waitForFunction(() => document.querySelectorAll('[data-testid="compare-card"]').length === 0)
  assert((await a.page.textContent(`${tid('assistant-message')}[data-provider="local"]`)).includes('Local model here'), 'kept answer should be the local one')
  ok('compare mode shows three answers and keeps the chosen one')

  // Search across everything.
  await a.page.click(tid('open-search'))
  await a.page.fill(tid('search-input'), 'Biscuit')
  await a.page.waitForSelector(tid('search-hit'))
  await shot(a.page, '06-search')
  await a.page.click(tid('search-hit'))
  await a.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="user-message"]')].some((el) => el.textContent.includes('Biscuit')))
  ok('search finds a message and opens its conversation')

  // Attachments: an image, a text file and a PDF go to the assistant with the message.
  await a.page.click(tid('new-chat'))
  await pickProvider(a.page, 'claude')
  await a.page.click(tid('attach'))
  await a.page.waitForFunction(() => document.querySelectorAll('.attachments.pending [data-testid="attachment"]').length === 3)
  assert((await a.page.textContent('.attachments.pending [data-pages="2"]')).includes('handbook.pdf'), 'the PDF should be shown with its page count')
  await sendMessage(a.page, 'What is in these?')
  await waitForReply(a.page, 'claude', 'I can see 1 image. I read the attached file. I read a PDF of 2 pages')
  await a.page.waitForFunction(() => {
    const img = document.querySelector('[data-testid="user-message"] img.attach-thumb')
    return img && img.complete && img.naturalWidth > 0 && !!document.querySelector('[data-testid="user-message"] [data-kind="text"]') && !!document.querySelector('[data-testid="user-message"] [data-pages="2"]')
  })
  await shot(a.page, '10-attachments')
  ok('an image, a text file and a PDF are attached, shown, and reach the assistant')

  // Second opinion: another assistant reviews the answer, and gets the image too.
  await a.page.click(tid('second-opinion'), { force: true })
  await waitForReply(a.page, 'chatgpt', 'I can see 1 image')
  assert((await a.page.textContent(`${tid('assistant-message')}[data-provider="chatgpt"]`)).includes('I received the context file'), 'the second assistant should get the context file')
  await shot(a.page, '11-second-opinion')
  ok('a second opinion comes from another assistant, with the context and the image')

  // Branch from the first answer into a separate conversation.
  await a.page.click(`${tid('assistant-message')}[data-provider="claude"] ${tid('branch')}`, { force: true })
  await a.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="conversation"]')].some((el) => el.textContent.includes('(branch)')))
  await a.page.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-message"]').length === 1 && document.querySelectorAll('[data-testid="user-message"]').length === 1)
  assert(await a.page.$(`${tid('conversation')}.active:has-text("(branch)")`), 'the branch should be the open conversation')
  ok('branching copies the conversation up to that answer into a new one')

  // A newer build was announced by the stand-in releases page.
  await a.page.waitForSelector(tid('update-chip'))
  assert((await a.page.getAttribute(tid('update-chip'), 'title')).includes('9.9.9'), 'the update chip should name the new version')
  await shot(a.page, '12-update-available')
  ok('a newer build is announced in the sidebar')

  // Settings screens.
  await a.page.click(tid('open-settings'))
  for (const tab of ['general', 'accounts', 'local', 'sync', 'memory', 'usage']) {
    await a.page.click(tid(`settings-tab-${tab}`))
    await a.page.waitForTimeout(150)
    await shot(a.page, `07-settings-${tab}`)
  }
  await a.page.click(tid('settings-tab-usage'))
  assert((await a.page.textContent(tid('usage-claude'))).includes('86% used'), 'usage page should show Claude at 86%')
  assert((await a.page.textContent(tid('usage-chatgpt'))).includes('12% used'), 'usage page should show ChatGPT at 12%')
  await a.page.click(tid('settings-tab-memory'))
  await a.page.fill(tid('profile-input'), 'Be brief.')
  await a.page.click(tid('settings-tab-memory'))
  await a.page.fill(tid('note-input'), 'My main project is written in Swift')
  await a.page.click(tid('note-add'))
  ok('settings show sign-in state, usage from both services, and save memory')

  // Tool servers (MCP): add one in Settings, test it, and both assistants can use it after asking.
  await a.page.click(tid('settings-tab-tools'))
  await a.page.click(tid('mcp-add'))
  await a.page.fill(tid('mcp-name'), 'Notes')
  await a.page.fill(tid('mcp-command'), `node "${toolServer}"`)
  await a.page.fill(tid('mcp-env'), `FAKE_MCP_LOG=${savedNotes}`)
  await a.page.click(tid('mcp-test'))
  await a.page.waitForFunction(() => /Connected to fake-mcp\. 2 tools: echo, add_note/.test(document.querySelector('[data-testid="mcp-test-result"]')?.textContent ?? ''), null, { timeout: 15000 })
  await shot(a.page, '16-tool-server-editor')
  await a.page.click(tid('mcp-save'))
  await a.page.waitForSelector(`${tid('mcp-server')}[data-name="notes"]`)
  // Pasted JSON adds a server too. This one cannot start, and its test says why.
  await a.page.click(tid('mcp-add-json'))
  await a.page.fill(tid('mcp-json'), '{"command": "node", "args": ["x.js"]}')
  await a.page.click(tid('mcp-json-add'))
  await a.page.waitForSelector(`${tid('mcp-server')}[data-name="server"]`)
  await a.page.click(`${tid('mcp-server')}[data-name="server"] ${tid('mcp-row-test')}`)
  await a.page.waitForFunction(() => /stopped before it answered/.test(document.querySelector('[data-testid="mcp-server"][data-name="server"] [data-testid="mcp-test-result"]')?.textContent ?? ''), null, { timeout: 15000 })
  await a.page.click(`${tid('mcp-server')}[data-name="server"] ${tid('mcp-remove')}`)
  await a.page.waitForFunction(() => document.querySelectorAll('[data-testid="mcp-server"]').length === 1)
  await a.page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 8000 })
  await shot(a.page, '17-tool-servers')
  ok('a tool server is added in Settings, tested from the app, and a broken one says why')

  await a.page.click(tid('new-chat'))
  await pickProvider(a.page, 'claude')
  await sendMessage(a.page, 'Save a note: milk. [mcp]')
  await a.page.waitForSelector(tid('approval-card'), { timeout: 15000 })
  let toolQuestion = await a.page.textContent(tid('approval-card'))
  assert(toolQuestion.includes('Claude wants to use notes: add_note') && toolQuestion.includes('milk'), `the card should name the tool, got: ${toolQuestion}`)
  assert(!existsSync(savedNotes), 'nothing should be saved before the answer')
  await shot(a.page, '18-tool-asks-first')
  await a.page.click(tid('approve-once'))
  await waitForReply(a.page, 'claude', 'The notes tool answered: saved')
  await pickProvider(a.page, 'chatgpt')
  await sendMessage(a.page, 'And once more. [mcp]')
  await a.page.waitForSelector(tid('approval-card'), { timeout: 15000 })
  toolQuestion = await a.page.textContent(tid('approval-card'))
  assert(toolQuestion.includes('ChatGPT wants to use notes: add_note'), `the card should name the tool, got: ${toolQuestion}`)
  await a.page.click(tid('approve-chat'))
  await waitForReply(a.page, 'chatgpt', 'The notes tool answered: saved')
  assert(readFileSync(savedNotes, 'utf8') === 'milk\nmilk\n', `both assistants should have saved the note, got ${JSON.stringify(readFileSync(savedNotes, 'utf8'))}`)
  await shot(a.page, '19-tool-used')
  ok('Claude and ChatGPT both use the tool server, each after asking')

  // Work shown the way coding tools show it: a checklist, steps grouped by sort, and diffs of file edits.
  await a.page.click(tid('new-chat'))
  await pickProvider(a.page, 'claude')
  await sendMessage(a.page, 'Tidy up the greeting. [work]')
  await waitForReply(a.page, 'claude', 'The work is done')
  const last = `${tid('assistant-message')}:last-of-type`
  assert((await a.page.textContent(`${last} ${tid('plan')}`)).includes('3 of 3 done'), 'the checklist should be all ticked off')
  const groupText = async (kind) => a.page.textContent(`${last} [data-kind="${kind}"] > summary`)
  const edited = await groupText('edit')
  assert(edited.includes('Edited 2 files') && edited.includes('+5') && edited.includes('−1'), `the edits should be grouped with their counts, got ${edited}`)
  assert((await groupText('command')).includes('Ran 2 commands'), 'the commands should be grouped')
  assert(!(await a.page.$(`${last} ${tid('tool-row')}[data-kind="other"]`)), 'the to-do list should not show as a step')
  await a.page.click(`${last} [data-kind="edit"] > summary`)
  await a.page.click(`${last} ${tid('step-group')}[data-kind="edit"] ${tid('tool-row')}:first-of-type > summary`)
  await a.page.waitForSelector(`${last} ${tid('diff')} .diff-line.add:has-text("hello there")`)
  await shot(a.page, '33-steps-claude')
  await pickProvider(a.page, 'chatgpt')
  await sendMessage(a.page, 'Now the readme. [work]')
  await waitForReply(a.page, 'chatgpt', 'The work is done')
  assert((await a.page.textContent(`${last} ${tid('plan')}`)).includes('2 of 2 done'), "ChatGPT's plan should show as a checklist")
  const readme = await a.page.textContent(`${last} ${tid('tool-row')}[data-kind="edit"] > summary`)
  assert(readme.includes('README.md') && readme.includes('+2') && readme.includes('−1'), `ChatGPT's edit should carry its diff, got ${readme}`)
  ok('a checklist, grouped steps and diffs show what Claude and ChatGPT did')

  // Math is drawn as formulas, and prices stay text.
  await pickProvider(a.page, 'claude')
  await sendMessage(a.page, 'Some formulas please. [math]')
  await waitForReply(a.page, 'claude', 'Tickets cost')
  assert((await a.page.$$(`${last} .prose math`)).length === 3, 'three formulas should be drawn')
  assert((await a.page.$$(`${last} .prose .math-block math mfrac`)).length === 1, 'the fraction should be drawn as a fraction')
  assert((await a.page.textContent(`${last} .prose`)).includes('Tickets cost $5 and $10.'), 'prices should stay as text')
  assert(!(await a.page.textContent(`${last} .prose`)).includes('\\frac'), 'no TeX source should show')
  await shot(a.page, '35-math')
  ok('math formulas are drawn, and prices stay text')

  // An earlier question can be changed and asked again. The answer after it is replaced.
  const oldQuestion = `${tid('user-message')}:has-text("Some formulas please.")`
  await a.page.hover(oldQuestion)
  await a.page.click(`${oldQuestion} ${tid('edit-question')}`)
  await a.page.fill(tid('edit-input'), 'Just one formula, please.')
  await shot(a.page, '36-edit-question')
  await a.page.click(tid('edit-send'))
  await waitForReply(a.page, 'claude', 'You said: "Just one formula, please."')
  assert(!(await a.page.$(oldQuestion)), 'the old question should be gone')
  assert(!(await a.page.$(`${tid('assistant-message')}:has-text("Tickets cost")`)), 'the old answer should be gone')
  ok('an earlier question can be edited and asked again')

  // Dictation: a recording goes to the speech-to-text server, and its text lands in the message box.
  await a.page.click(tid('dictate'))
  await a.page.waitForSelector(`${tid('dictate')}[data-state="recording"]`)
  await new Promise((r) => setTimeout(r, 700))
  await a.page.click(tid('dictate'))
  await a.page.waitForFunction(() => document.querySelector('[data-testid="composer-input"]').value === 'Hello from dictation', null, { timeout: 15000 })
  assert(heardAudio > 1000, `a real recording should have been sent, got ${heardAudio} bytes`)
  assert(await a.page.$(`${tid('assistant-message')}:last-of-type ${tid('read-aloud')}`), 'answers can be read aloud')
  await a.page.fill(tid('composer-input'), '')
  ok('dictation turns a recording into text, and answers have a read-aloud button')

  // ---------- Device B: a client of the hub ----------
  const token = await a.page.evaluate(async () => (await window.api.state()).settings.hub.token)
  assert(token && token.length >= 10, 'hub should have generated a pairing code')
  b = await launch('client', {
    deviceName: 'Mac',
    theme: 'light',
    claude: { cliPath: fakeClaude },
    chatgpt: { cliPath: fakeCodex },
    local: { endpoints: [], summarize: false },
    hub: { remoteUrl: `127.0.0.1:${hubPort}`, remoteToken: token }
  }, { CHAUDECAL_E2E_NOTIFY: noticeFile.client })
  await b.page.waitForFunction(() => document.querySelectorAll('[data-testid="conversation"]').length === 6, null, { timeout: 15000 })
  ok('a second device pairs with the hub and receives every conversation')

  await b.page.click(`${tid('conversation')}:has-text("My cat is called Biscuit")`)
  await b.page.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-message"]').length === 3)
  await b.page.waitForFunction(async () => (await window.api.state()).notes.length === 1 && (await window.api.state()).profile.instructions === 'Be brief.')
  ok('messages, memory and instructions arrive on the second device')

  // The tool server arrives too, and can be switched off for this device alone.
  await b.page.waitForFunction(async () => (await window.api.state()).mcp.map((m) => m.name).join() === 'notes')
  await b.page.click(tid('open-settings'))
  await b.page.click(tid('settings-tab-tools'))
  await b.page.click(`${tid('mcp-server')}[data-name="notes"] ${tid('mcp-toggle')}`)
  const clientId = await b.page.evaluate(async () => (await window.api.state()).deviceId)
  await a.page.waitForFunction(async (id) => (await window.api.state()).mcp[0]?.offOn.join() === id, clientId, { timeout: 15000 })
  assert((await b.page.textContent(`${tid('mcp-server')}[data-name="notes"]`)).includes('Off on this device'), 'the second device should show the server as off here')
  await b.page.click(`${tid('conversation')}:has-text("My cat is called Biscuit")`)
  ok('the tool server syncs to the second device, which can switch it off for itself')

  // The attached image was synced too, not just its name.
  await b.page.click(`${tid('conversation')}:has-text("What is in these?"):not(:has-text("(branch)"))`)
  await b.page.waitForFunction(() => {
    const img = document.querySelector('[data-testid="user-message"] img.attach-thumb')
    return img && img.complete && img.naturalWidth > 0
  }, null, { timeout: 15000 })
  await b.page.click(`${tid('conversation')}:has-text("My cat is called Biscuit")`)
  ok('attached images sync to the second device')

  // B has no local runtime of its own. It uses the hub's.
  await b.page.evaluate(() => window.api.refreshProviders())
  await b.page.waitForFunction(async () => (await window.api.state()).localModels.some((m) => m.via === 'hub'))
  await pickProvider(b.page, 'local')
  await sendMessage(b.page, 'Local, are you there?')
  await waitForReply(b.page, 'local', 'I have your standing instructions')
  await shot(b.page, '08-client-using-hub-local-ai')
  ok('the second device runs local AI on the hub machine, with shared instructions applied')

  // Remote work: the message is typed on B, and the hub's own assistant does the work.
  await b.page.waitForFunction(async () => (await window.api.state()).remote?.enabled)
  await b.page.click(tid('new-chat'))
  await pickProvider(b.page, 'claude')
  await b.page.click(tid('runs-on-picker'))
  await b.page.click(tid('runs-on-hub'))
  await sendMessage(b.page, 'Run this one on the hub.')
  await waitForReply(b.page, 'claude', 'Claude here. You said: "Run this one on the hub."')
  const hubId = await a.page.evaluate(async () => (await window.api.state()).deviceId)
  const remoteConv = await b.page.evaluate(async () => (await window.api.state()).conversations.find((c) => c.title.startsWith('Run this one')).id)
  const writers = await b.page.evaluate(async (id) => (await window.api.messages(id)).map((m) => m.deviceId), remoteConv)
  assert(writers.length === 2 && writers.every((d) => d === hubId), `both messages should have been written by the hub, got ${writers}`)
  assert((await b.page.textContent('.composer-foot')).includes('Runs on Hub PC'), 'the message box should say where the work runs')
  ok('a conversation typed on the second device is answered by the assistant on the hub')

  // The working folder for such a conversation is a folder on the hub. B browses the hub's folders to choose it.
  const folderNames = () => b.page.$$eval(tid('hub-folder-item'), (els) => els.map((el) => el.textContent.trim()))
  const folderPath = () => b.page.inputValue(tid('hub-folder-input'))
  const openFolder = async (name, inside) => {
    await b.page.click(`${tid('hub-folder-item')}:has-text("${name}")`)
    await b.page.waitForFunction(([sel, want]) => document.querySelector(sel)?.value === want, [tid('hub-folder-input'), inside])
  }
  await b.page.click(tid('mode-picker'))
  await b.page.click(tid('mode-edit'))
  await b.page.click(tid('hub-folder-picker'))
  await b.page.waitForSelector(`${tid('hub-folder-item')}:has-text("projects")`)
  assert((await folderPath()) === homeDir, `the browser should open on the hub's home folder, got ${await folderPath()}`)
  assert(JSON.stringify(await folderNames()) === JSON.stringify(['Desktop', 'Documents', 'projects']), `unexpected folders: ${await folderNames()}`)
  await openFolder('projects', join(homeDir, 'projects'))
  await b.page.waitForSelector(`${tid('hub-folder-item')}:has-text("website")`)
  assert(JSON.stringify(await folderNames()) === JSON.stringify(['api', 'website']), `unexpected folders: ${await folderNames()}`)
  await shot(b.page, '13-folder-on-the-hub')
  await openFolder('api', join(homeDir, 'projects', 'api'))
  await b.page.click(tid('hub-folder-up'))
  await b.page.waitForSelector(`${tid('hub-folder-item')}:has-text("website")`)
  await b.page.click(`${tid('hub-folder-place')}:has-text("Home")`)
  await b.page.waitForSelector(`${tid('hub-folder-item')}:has-text("Documents")`)
  ok("the second device browses the hub's folders")

  // A path can still be typed. A wrong one is refused by the hub, and a right one shows what is inside it.
  await b.page.fill(tid('hub-folder-input'), join(homeDir, 'not-here'))
  await b.page.click(tid('hub-folder-save'))
  await b.page.waitForSelector(tid('hub-folder-error'))
  await b.page.fill(tid('hub-folder-input'), join(homeDir, 'projects'))
  await b.page.waitForSelector(`${tid('hub-folder-item')}:has-text("website")`)
  await openFolder('website', join(homeDir, 'projects', 'website'))
  await b.page.click(tid('hub-folder-save'))
  await b.page.waitForFunction(() => document.querySelector('[data-testid="hub-folder-picker"]')?.textContent.includes('website'))
  assert((await a.page.evaluate((id) => window.api.getWorkspace(id), remoteConv)) === join(homeDir, 'projects', 'website'), 'the hub should now use that folder for the conversation')
  await sendMessage(b.page, 'List the files. [tool]')
  await waitForReply(b.page, 'claude', 'List the files.')
  await shot(b.page, '14-running-on-the-hub')
  ok('the chosen folder is used on the hub, and a wrong path is refused')

  // Claude asks before it runs a command. The question appears on B while the hub waits, and the answer goes back.
  await sendMessage(b.page, 'Now run the tests. [deny]')
  await b.page.waitForSelector(tid('approval-card'), { timeout: 15000 })
  const question = await b.page.textContent(tid('approval-card'))
  assert(question.includes('Claude wants to run a command') && question.includes('npm test'), `the card should say what Claude wants to do, got: ${question}`)
  await b.page.waitForSelector(tid('conversation-asking'))
  await shot(b.page, '15-claude-asks-first')
  await b.page.click(tid('approve-once'))
  await waitForReply(b.page, 'claude', 'I ran the tests')
  assert((await b.page.$(tid('approval-card'))) === null, 'the question should be gone once answered')
  assert((await b.page.$(tid('denial-card'))) === null, 'nothing should be offered again after the turn')
  assert((await b.page.$(tid('conversation-asking'))) === null, 'the sidebar should stop marking the conversation as waiting')
  ok('Claude asks before running a command, and carries on once it is allowed')

  // Notifications: the device that sent the message hears about the question and the reply. The hub, which did the work, stays quiet.
  const mine = notices('client').filter((n) => n.conversationId === remoteConv)
  const asked = mine.find((n) => n.title === 'Claude needs your answer')
  assert(asked && asked.body.includes('Wants to run: npm test') && asked.body.includes('Run this one on the hub.'), `the second device should be told about the question, got ${JSON.stringify(mine)}`)
  assert(mine.some((n) => n.title === 'Run this one on the hub.' && n.body.startsWith('Claude: ') && n.body.includes('I ran the tests')), `the second device should be told the reply is ready, got ${JSON.stringify(mine)}`)
  assert(mine.indexOf(asked) < mine.length - 1, 'the question should be announced before the reply')
  assert(!notices('hub').some((n) => n.conversationId === remoteConv), 'the hub should not announce a run that another device started and is watching')
  assert(notices('hub').some((n) => n.body.startsWith('ChatGPT: ')), 'the hub should announce replies to its own messages')
  ok('the device that asked is notified about a waiting question and a finished reply')

  // What B wrote shows up on A.
  await a.page.click(tid('new-chat'))
  await a.page.click(`${tid('conversation')}:has-text("My cat is called Biscuit")`)
  await a.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="assistant-message"][data-provider="local"]')].some((el) => el.textContent.includes('Local model here')), null, { timeout: 15000 })
  ok('messages written on the second device sync back to the hub')

  // The embedded sites. Off by default because it loads the real pages over the network.
  if (process.env.E2E_WEB === '1') {
    for (const [service, host] of [['claude', 'claude.ai'], ['chatgpt', 'chatgpt.com']]) {
      const seen = b.page.evaluate((svc) => new Promise((res) => window.api.on('web', (w) => w.service === svc && /^https:/.test(w.url) && !w.loading && res(w.url))), service)
      await b.page.click(tid(`web-${service}`))
      const url = await Promise.race([seen, new Promise((_, rej) => setTimeout(() => rej(new Error(`${host} did not load`)), 45000))])
      assert(new URL(url).hostname.endsWith(host) || /auth|login/.test(url), `expected ${host}, got ${url}`)
      console.log(`       ${service} tab loaded ${new URL(url).origin}${new URL(url).pathname}`)
    }
    ok('claude.ai and chatgpt.com load inside the app')
    await b.page.click(tid('new-chat'))
  }

  // Theme: an accent color recolors the main buttons, the switches and the user's own messages, and is remembered.
  const css = (page, sel, prop) => page.$eval(sel, (el, p) => getComputedStyle(el)[p], prop)
  await b.page.click(tid('open-settings'))
  await b.page.click(tid('settings-tab-general'))
  const inkButton = await css(b.page, `${tid('theme-preview')} .btn-primary`, 'backgroundColor')
  const plainBubble = await css(b.page, `${tid('theme-preview')} .bubble`, 'backgroundColor')
  await b.page.click(tid('accent-purple'))
  await b.page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="theme-preview"] .btn-primary')).backgroundColor === 'rgb(139, 92, 246)')
  assert((await css(b.page, `${tid('theme-preview')} .btn-primary`, 'color')) === 'rgb(255, 255, 255)', 'text on the purple button should be white')
  assert((await css(b.page, `${tid('theme-preview')} .bubble`, 'backgroundColor')) !== plainBubble, 'the message bubble should be tinted')
  // Switches that are on use the accent too (their color fades over, so this waits for it).
  await b.page.waitForFunction(() => getComputedStyle(document.querySelector('.toggle.on')).backgroundColor === 'rgb(139, 92, 246)')
  assert((await b.page.getAttribute(tid('accent-purple'), 'aria-checked')) === 'true', 'the chosen swatch should be marked')
  await shot(b.page, '20-accent-color')
  // Any color can be chosen. A pale one gets dark text.
  await b.page.fill(tid('accent-custom'), '#ffe45c')
  await b.page.waitForFunction(async () => (await window.api.state()).settings.accent === '#ffe45c')
  assert((await css(b.page, `${tid('theme-preview')} .btn-primary`, 'backgroundColor')) === 'rgb(255, 228, 92)', 'the custom color should be used')
  assert((await css(b.page, `${tid('theme-preview')} .btn-primary`, 'color')) === 'rgb(27, 26, 24)', 'text on a pale color should be dark')
  // It applies in a conversation too, and going back to the default undoes all of it.
  await b.page.click(tid('accent-blue'))
  await b.page.click(`${tid('conversation')}:has-text("My cat is called Biscuit")`)
  await b.page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="send"]')).backgroundColor === 'rgb(47, 127, 230)')
  await shot(b.page, '21-accent-in-chat')
  await b.page.click(tid('open-settings'))
  await b.page.click(tid('settings-tab-general'))
  await b.page.click(tid('accent-default'))
  await b.page.waitForFunction((want) => getComputedStyle(document.querySelector('[data-testid="theme-preview"] .btn-primary')).backgroundColor === want, inkButton)
  assert((await css(b.page, `${tid('theme-preview')} .bubble`, 'backgroundColor')) === plainBubble, 'the default look should come back unchanged')
  assert((await a.page.evaluate(async () => (await window.api.state()).settings.accent)) === 'default', 'the accent is a setting of each device, so the hub keeps its own')
  await b.page.click(tid('accent-blue'))
  await b.page.click(tid('theme-dark'))
  await b.page.waitForFunction(() => matchMedia('(prefers-color-scheme: dark)').matches)
  await shot(b.page, '22-accent-dark')
  await b.page.click(tid('theme-light'))
  await b.page.waitForFunction(() => !matchMedia('(prefers-color-scheme: dark)').matches)
  await b.page.click(tid('accent-default'))
  ok('an accent color, preset or custom, recolors the app and can be undone')

  // Text size: every piece of text grows or shrinks by the same step, and it is remembered on this device only.
  const px = async (sel) => parseFloat(await css(b.page, sel, 'fontSize'))
  const bubbleSize = await px(`${tid('theme-preview')} .bubble`)
  const bodySize = await px('body')
  await b.page.click(tid('text-larger'))
  await b.page.waitForFunction((was) => parseFloat(getComputedStyle(document.body).fontSize) > was, bodySize)
  assert(Math.abs((await px('body')) - bodySize * 1.25) < 0.01, 'extra large text should be a quarter larger')
  assert(Math.abs((await px(`${tid('theme-preview')} .bubble`)) - bubbleSize * 1.25) < 0.01, 'messages should grow by the same step')
  assert((await b.page.getAttribute(tid('text-larger'), 'aria-pressed')) === 'true', 'the chosen size should be marked')
  await b.page.waitForFunction(async () => (await window.api.state()).settings.textSize === 'larger')
  await shot(b.page, '23-text-size-large')
  await b.page.click(`${tid('conversation')}:has-text("My cat is called Biscuit")`)
  await b.page.waitForSelector('.prose')
  assert(await b.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'larger text should not push the window sideways')
  await shot(b.page, '24-text-size-in-chat')
  await b.page.click(tid('open-settings'))
  await b.page.click(tid('settings-tab-general'))
  await b.page.click(tid('text-small'))
  await b.page.waitForFunction((was) => parseFloat(getComputedStyle(document.body).fontSize) < was, bodySize)
  await b.page.click(tid('text-default'))
  await b.page.waitForFunction((was) => parseFloat(getComputedStyle(document.body).fontSize) === was, bodySize)
  assert((await a.page.evaluate(async () => (await window.api.state()).settings.textSize)) === 'default', 'the text size is a setting of each device')
  await b.page.click(tid('new-chat'))
  ok('the text size can be made smaller or larger')

  const until = async (fn, what, timeout = 15000) => {
    const end = Date.now() + timeout
    for (;;) {
      const value = await fn().catch(() => undefined)
      if (value) return value
      if (Date.now() > end) throw new Error(`timed out waiting: ${what}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  // Projects: instructions and files that every chat in the project gets, synced to the other device.
  await a.page.click(tid('new-project'))
  await a.page.waitForSelector(tid('project-page'))
  await a.page.fill(tid('project-name'), 'Garden plans')
  await a.page.press(tid('project-name'), 'Enter')
  await a.page.fill(tid('project-instructions'), 'Use metric units.')
  await a.page.click(tid('project-add-files'))
  await a.page.waitForFunction(() => document.querySelectorAll('[data-testid="project-file"]').length === 2)
  await a.page.waitForFunction(async () => (await window.api.state()).projects.some((p) => p.name === 'Garden plans' && p.instructions === 'Use metric units.' && p.files.length === 2))
  assert((await a.page.inputValue(tid('project-instructions'))) === 'Use metric units.', 'the instructions should still be there after adding files')
  await a.page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 8000 })
  await shot(a.page, '37-project')
  await a.page.click(tid('project-new-chat'))
  assert((await a.page.textContent(tid('draft-project'))).includes('Garden plans'), 'the new chat should say it is in the project')
  await pickProvider(a.page, 'claude')
  await sendMessage(a.page, 'How should I lay out the beds?')
  await waitForReply(a.page, 'claude', 'I know the project Garden plans and its files')
  assert((await a.page.textContent(tid('conversation-project'))).includes('Garden plans'), 'the chat should show its project')
  await a.page.click(tid('conversation-project'))
  await a.page.waitForSelector(`${tid('project-chat')}:has-text("How should I lay out the beds?")`)
  await b.page.waitForFunction(async () => (await window.api.state()).projects.some((p) => p.name === 'Garden plans' && p.files.length === 2), null, { timeout: 15000 })
  await a.page.click(tid('new-chat'))
  ok('a project gives its chats instructions and files, and syncs to the other device')

  // Scheduled tasks: a prompt that runs by itself into its own chat. "Run now" runs it straight away.
  await a.page.click(tid('open-settings'))
  await a.page.click(tid('settings-tab-tasks'))
  await a.page.click(tid('new-task'))
  await a.page.waitForSelector(tid('task'))
  await a.page.fill(tid('task-title'), 'Morning news')
  await a.page.fill(tid('task-prompt'), 'Summarise the news for me.')
  await a.page.click('h2')
  await a.page.selectOption(tid('task-every'), 'weekday')
  await a.page.waitForFunction(async () => (await window.api.state()).tasks.some((t) => t.title === 'Morning news' && t.prompt === 'Summarise the news for me.' && t.schedule.every === 'weekday' && t.nextRun > Date.now()))
  assert((await a.page.textContent(tid('task-status'))).includes('Every weekday at 09:00. Next run:'), 'the task should say when it runs next')
  await shot(a.page, '38-scheduled-task')
  await a.page.click(tid('task-run-now'))
  await a.page.waitForFunction(() => document.querySelector('.topbar-title')?.textContent === 'Morning news')
  await a.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="assistant-message"]')].some((el) => el.textContent.includes('Summarise the news for me.')), null, { timeout: 15000 })
  await a.page.waitForSelector(tid('send'))
  assert(await a.page.evaluate(async () => (await window.api.state()).tasks.find((t) => t.title === 'Morning news').lastRun > 0), 'the run should be recorded')

  // Export: the chat as Markdown, and as one web page.
  await a.page.click(tid('conversation-menu'))
  await a.page.click(tid('export-markdown'))
  const md = join(saveDir, 'Morning-news.md')
  await until(async () => existsSync(md), 'the Markdown export')
  const mdText = readFileSync(md, 'utf8')
  assert(mdText.startsWith('# Morning news') && mdText.includes('## You\n\nSummarise the news for me.'), `the Markdown should hold the chat, got ${mdText.slice(0, 200)}`)
  await a.page.click(tid('conversation-menu'))
  await a.page.click(tid('export-html'))
  const html = join(saveDir, 'Morning-news.html')
  await until(async () => existsSync(html), 'the web page export')
  assert(/^<!doctype html>/.test(readFileSync(html, 'utf8')) && readFileSync(html, 'utf8').includes('Summarise the news for me.'), 'the web page should hold the chat')
  await a.page.click(tid('new-chat'))
  ok('a scheduled task runs into its own chat, and a chat exports as Markdown or a web page')

  // Chats from claude.ai and chatgpt.com come in through the website tabs' sign-ins, and sync to the other device.
  await a.page.click(tid('open-settings'))
  await a.page.click(tid('settings-tab-accounts'))
  sites.state.signedIn.chatgpt = false
  await a.page.click(tid('web-import-now-chatgpt'))
  await a.page.waitForSelector(`${tid('web-import-chatgpt')}[data-state="signed-out"]`, { timeout: 30000 })
  assert((await a.page.content()).includes('Not signed in to chatgpt.com in the app'), 'a missing sign-in should be explained')
  sites.state.signedIn.chatgpt = true
  await a.page.click(tid('web-import-now-chatgpt'))
  await a.page.waitForSelector(`${tid('web-import-chatgpt')}[data-state="done"]`, { timeout: 30000 })
  await a.page.click(tid('web-import-now-claude'))
  await a.page.waitForSelector(`${tid('web-import-claude')}[data-state="done"]`, { timeout: 30000 })
  const imported = await a.page.evaluate(async () => (await window.api.state()).conversations.filter((c) => c.source).map((c) => c.title).sort())
  assert(JSON.stringify(imported) === JSON.stringify(['An archived chat', 'Garden plan', 'Hello Claude', 'Project notes', 'Trip to Lisbon', 'What is in this photo?']), `six chats should come in, got ${JSON.stringify(imported)}`)
  assert(sites.state.requests.every((r) => !r.includes('org-api')), 'only the chat organization should be read')
  await a.page.click(tid('web-import-auto-claude'))
  await a.page.waitForFunction(async () => (await window.api.state()).settings.webImport.claude === true)
  await a.page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 8000 })
  // Only the two rows, so no folder path of the machine running the test shows up.
  await a.page.evaluate(() => document.querySelector('[data-testid="web-import-claude"]').closest('.row').scrollIntoView({ block: 'center' }))
  await new Promise((r) => setTimeout(r, 400))
  const box = await a.page.evaluate(() => {
    const first = document.querySelector('[data-testid="web-import-claude"]').closest('.row').getBoundingClientRect()
    const last = document.querySelector('[data-testid="web-import-auto-claude"]').closest('.row').getBoundingClientRect()
    return { x: first.x, y: first.y, width: first.width, height: last.bottom - first.y }
  })
  await a.page.screenshot({ path: join(shots, '31-web-import.png'), clip: box })
  // An imported Claude chat, with its artifact in two versions and the attached file.
  await a.page.click(`${tid('conversation')}:has-text("Garden plan")`)
  await a.page.waitForSelector(`${tid('artifact-card')}:has-text("Garden 'layout'")`)
  assert((await a.page.$$(tid('artifact-card'))).length === 3, 'the artifact appears twice (two versions) and the file once')
  assert((await a.page.textContent(`${tid('user-message')}:first-of-type`)).includes('beds.txt'), 'the attached file comes along')
  await a.page.click(`${tid('assistant-message')}:last-of-type ${tid('artifact-card')}:has-text("Garden")`)
  await a.page.waitForFunction(() => document.querySelector('[data-testid="artifact-version"]')?.textContent === '2 of 2')
  await a.page.click(tid('artifact-close'))
  await shot(a.page, '32-imported-chat')
  // Back to the original on the site.
  const opened = a.page.evaluate(() => new Promise((res) => window.api.on('web', (w) => w.url.includes('/chat/c-garden') && !w.loading && res(w.url))))
  await a.page.click(tid('conversation-menu'))
  await a.page.click(tid('open-source'))
  await Promise.race([opened, new Promise((_, rej) => setTimeout(() => rej(new Error('the original chat did not open')), 15000))])
  await a.page.click(tid('new-chat'))
  // The other device gets them through sync, without signing in to anything.
  await b.page.waitForFunction(async () => (await window.api.state()).conversations.filter((c) => c.source).length === 6, null, { timeout: 15000 })
  ok('chats from claude.ai and chatgpt.com come in through the website tabs and sync to the other device')

  // Artifacts: Claude writes a web page, an image and a program. They open in a panel beside the conversation.
  const panelTitle = () => a.page.textContent(tid('artifact-title'))
  const previewFrame = () => until(async () => a.page.frames().find((f) => f.url().startsWith('chaudecal-artifact://')), 'a preview frame')
  const frameText = async (selector, want, timeout) => until(async () => (await (await previewFrame()).textContent(selector)) === want, `${selector} to read "${want}"`, timeout)
  // In a narrow window the panel covers the conversation, so this works with either layout.
  const covers = () => a.page.evaluate(() => matchMedia('(max-width: 1080px)').matches)
  const showChat = async () => {
    if ((await a.page.$(tid('artifact-panel'))) && (await a.page.$eval('.chat-pane', (el) => getComputedStyle(el).display)) === 'none') await a.page.click(tid('artifact-close'))
  }
  const openCard = async (selector) => {
    await showChat()
    await a.page.click(selector)
  }
  const replyDone = async (containing) => {
    await a.page.waitForFunction((t) => [...document.querySelectorAll('[data-testid="assistant-message"][data-provider="claude"]')].some((el) => el.textContent.includes(t)), containing, { timeout: 15000 })
    await a.page.waitForFunction(async () => (await window.api.state()).busy.length === 0, null, { timeout: 15000 })
  }
  // E2E_NARROW=1 runs the whole artifacts flow in a window too narrow for the panel beside the conversation.
  if (process.env.E2E_NARROW === '1') {
    await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 800))
    await until(covers, 'the window to become narrow')
  }
  console.log(`       the window is ${(await covers()) ? 'narrow, so the panel covers the conversation' : 'wide enough for the panel beside the conversation'}`)
  await a.page.click(tid('new-chat'))
  await pickProvider(a.page, 'claude')
  await sendMessage(a.page, 'Make me a page. [artifact]')
  // The panel opens by itself while the reply is still being written.
  await a.page.waitForSelector(tid('artifact-panel'), { timeout: 15000 })
  await replyDone('A small example stays in the reply')
  assert((await a.page.textContent(`${tid('assistant-message')}:last-of-type`)).includes('I know how to write artifacts.'), 'Claude should have been told how to write artifacts')
  const cards = await a.page.$$eval(`${tid('assistant-message')}:last-of-type ${tid('artifact-card')}`, (els) => els.map((e) => e.querySelector('.artifact-card-title').textContent))
  assert(JSON.stringify(cards) === JSON.stringify(['Greeting page', 'Two shapes', 'Count words']), `three artifact cards expected, got ${JSON.stringify(cards)}`)
  assert((await a.page.$$(`${tid('assistant-message')}:last-of-type .code-block`)).length === 1, 'the small example should stay an ordinary code block')
  await until(async () => (await panelTitle()) === 'Count words', 'the panel to follow the newest artifact')
  assert((await a.page.textContent(tid('artifact-code'))).includes('sys.stdin'), 'a program is shown as code')

  // The page runs its own script, but cannot reach the app or the internet.
  await openCard(`${tid('artifact-card')}:has-text("Greeting page")`)
  await until(async () => (await panelTitle()) === 'Greeting page', 'the page to open')
  await frameText('#ran', 'Scripts ran.')
  await frameText('#reach', 'The app is out of reach.')
  await frameText('#net', 'The request was blocked.')
  const frame = await previewFrame()
  assert(await frame.evaluate(() => document.getElementById('pic').naturalWidth === 0), 'an image from the internet should not load')
  // A link in the preview stays put, and says so.
  const pageUrl = frame.url()
  await frame.click('#out')
  await a.page.waitForFunction(() => /Links in a preview do not open/.test(document.querySelector('.toast')?.textContent ?? ''))
  assert(frame.url() === pageUrl, 'a link should not take the preview anywhere')
  await shot(a.page, '25-artifact-page')
  // A script that sends the frame elsewhere is stopped too. Running the preview again brings it back.
  await frame.evaluate(() => {
    location.href = 'https://example.com/'
  })
  await new Promise((r) => setTimeout(r, 800))
  assert(!a.page.frames().some((f) => f.url().startsWith('https://example.com')), 'the preview should not be able to go to another site')
  await a.page.click(tid('artifact-reload'))
  await frameText('#ran', 'Scripts ran.')
  await a.page.click(tid('artifact-tab-code'))
  assert((await a.page.textContent(tid('artifact-code'))).includes('<h1 id="hello">'), 'the code tab shows the source')
  await a.page.click(tid('artifact-download'))
  const saved = join(saveDir, 'greeting-page.html')
  await until(async () => existsSync(saved), 'the page to be saved')
  assert(readFileSync(saved, 'utf8').includes('Hello from an artifact'), 'the saved file holds the page')
  await a.page.click(tid('artifact-tab-preview'))

  // An image.
  await openCard(`${tid('artifact-card')}:has-text("Two shapes")`)
  await until(async () => (await panelTitle()) === 'Two shapes', 'the image to open')
  await until(async () => (await (await previewFrame()).$('svg circle')) !== null, 'the image to be drawn')
  ok('Claude writes artifacts, which open in a side panel with a live, sealed-off preview')

  // A new version of the page, a document, and a component. The page's script fails on purpose.
  await showChat()
  await sendMessage(a.page, 'Change it. [artifact-v2]')
  await replyDone('Here is the page again.')
  await openCard(`${tid('assistant-message')}:last-of-type ${tid('artifact-card')}:has-text("Greeting page")`)
  await until(async () => (await a.page.textContent(tid('artifact-version'))) === '2 of 2', 'the second version')
  await frameText('#hello', 'Hello again')
  await a.page.waitForSelector(tid('artifact-error'), { timeout: 15000 })
  assert((await a.page.textContent(tid('artifact-error'))).includes('Something broke on purpose'), 'the error on the page is shown')
  await shot(a.page, '26-artifact-version-error')
  await a.page.click(tid('artifact-prev'))
  await until(async () => (await a.page.textContent(tid('artifact-version'))) === '1 of 2', 'the first version')
  await frameText('#hello', 'Hello from an artifact')
  await a.page.click(tid('artifact-next'))
  await a.page.waitForSelector(tid('artifact-fix'), { timeout: 15000 })
  await a.page.click(tid('artifact-fix'))
  await replyDone('Please fix it and write the artifact again in full with the same title.')
  ok('writing an artifact again makes a new version, and a broken preview can be sent back to be fixed')

  // A document is shown formatted, and the code inside it stays code.
  await openCard(`${tid('artifact-card')}:has-text("Read me")`)
  await a.page.waitForSelector(`${tid('artifact-document')} h1`)
  assert((await a.page.textContent(`${tid('artifact-document')} h1`)) === 'Shopping list', 'the document is formatted')
  assert((await a.page.$$(`${tid('artifact-document')} .code-block`)).length === 1 && (await a.page.$$(`${tid('artifact-document')} ${tid('artifact-card')}`)).length === 0, 'code in a document stays a code block')
  await a.page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 8000 })
  await shot(a.page, '27-artifact-document')

  // A React component. It loads React from esm.sh, so its preview is only checked with E2E_NET=1.
  await openCard(`${tid('artifact-card')}:has-text("Counter")`)
  await until(async () => (await panelTitle()) === 'Counter', 'the component to open')
  if (process.env.E2E_NET === '1') {
    await frameText('#count', 'Clicked 0 times', 45000)
    await (await previewFrame()).click('#count')
    await frameText('#count', 'Clicked 1 times')
    await a.page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 8000 })
    await shot(a.page, '28-artifact-react')
    await openCard(`${tid('artifact-card')}:has-text("Diagram")`)
    await until(async () => (await (await previewFrame()).$('.mermaid svg')) !== null, 'the diagram to be drawn', 45000)
    assert((await (await previewFrame()).textContent('.mermaid svg')).includes('Draft'), 'the diagram shows its steps')
    await a.page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 8000 })
    await shot(a.page, '29-artifact-diagram')
    await openCard(`${tid('artifact-card')}:has-text("Counter")`)
    console.log('       the React component and the Mermaid diagram loaded their libraries from the internet')
  }
  await a.page.click(tid('artifact-tab-code'))
  assert((await a.page.textContent(tid('artifact-code'))).includes('useState'), 'the component source is shown')

  // The panel can fill the window, and closes.
  const paneShown = async () => (await a.page.$eval('.chat-pane', (el) => getComputedStyle(el).display)) !== 'none'
  if (!(await covers())) {
    await a.page.click(tid('artifact-wide'))
    await until(async () => !(await paneShown()), 'the panel to fill the window')
    await a.page.click(tid('artifact-wide'))
    await until(paneShown, 'the conversation to come back')
  }
  await a.page.click(tid('artifact-close'))
  await until(async () => !(await a.page.$(tid('artifact-panel'))), 'the panel to close')
  // In a narrow window the panel covers the conversation instead of squeezing it, and closing it brings the conversation back.
  const [width, height] = await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
  await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700))
  await until(covers, 'the window to become narrow')
  await openCard(`${tid('artifact-card')}:has-text("Read me")`)
  await until(async () => !(await paneShown()), 'the panel to cover the conversation')
  assert(await a.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'nothing should stick out sideways in a narrow window')
  await shot(a.page, '30-artifact-narrow')
  await a.page.click(tid('artifact-close'))
  await until(paneShown, 'the conversation to come back after closing')
  await a.app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height])
  await a.page.click(tid('new-chat'))
  ok('documents and components open too, and the panel fills the window, covers a narrow one, or closes')

  // Dark appearance.
  await b.page.evaluate(() => window.api.updateSettings({ theme: 'dark' }))
  await b.page.waitForFunction(() => matchMedia('(prefers-color-scheme: dark)').matches)
  await b.page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(32, 31, 29)')
  await shot(b.page, '09-dark')
  ok('dark appearance')

  console.log(`\nAll ${steps.length} end-to-end checks passed. Screenshots are in e2e/artifacts.`)
} catch (e) {
  for (const d of [a, b]) if (d) await shot(d.page, `failure-${d.name}`).catch(() => {})
  console.error(`\nEnd-to-end check failed after ${steps.length} passing steps:\n${e.stack ?? e}`)
  process.exitCode = 1
} finally {
  for (const d of [b, a]) if (d) await d.app.close().catch(() => {})
  await runtime.close()
  releases.close()
  speechServer.close()
  await claudeSite.close()
  await chatgptSite.close()
  rmSync(attachDir, { recursive: true, force: true })
  rmSync(noticeDir, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
  rmSync(toolsDir, { recursive: true, force: true })
}
