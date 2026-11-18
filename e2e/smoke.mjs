// End-to-end check of the real app window, driven like a user would.
// Claude, ChatGPT and the local runtime are replaced by the stand-ins in
// tests/fakes, so this spends nothing and needs no sign-in.
//
//   npm run build && npm run e2e

import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockOpenAI } from '../tests/fakes/mock-openai.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shots = join(root, 'e2e', 'artifacts')
rmSync(shots, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })
const electronPath = createRequire(import.meta.url)('electron')
const fakeClaude = join(root, 'tests/fakes/fake-claude.mjs')
const fakeCodex = join(root, 'tests/fakes/fake-codex.mjs')

const steps = []
function ok(name) {
  steps.push(name)
  console.log(`  ok  ${name}`)
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
      local: { endpoints: [{ id: 'ollama', name: 'Ollama', baseUrl: runtime.baseUrl, enabled: true }], summarize: false },
      hub: { hostEnabled: true, port: hubPort }
    },
    { FAKE_CLAUDE_UTILIZATION: '0.86' }
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
  })
  await b.page.waitForFunction(() => document.querySelectorAll('[data-testid="conversation"]').length === 2, null, { timeout: 15000 })
  ok('a second device pairs with the hub and receives every conversation')

  await b.page.click(`${tid('conversation')}:has-text("My cat is called Biscuit")`)
  await b.page.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-message"]').length === 3)
  await b.page.waitForFunction(async () => (await window.api.state()).notes.length === 1 && (await window.api.state()).profile.instructions === 'Be brief.')
  ok('messages, memory and instructions arrive on the second device')

  // B has no local runtime of its own. It uses the hub's.
  await b.page.evaluate(() => window.api.refreshProviders())
  await b.page.waitForFunction(async () => (await window.api.state()).localModels.some((m) => m.via === 'hub'))
  await pickProvider(b.page, 'local')
  await sendMessage(b.page, 'Local, are you there?')
  await waitForReply(b.page, 'local', 'I have your standing instructions')
  await shot(b.page, '08-client-using-hub-local-ai')
  ok('the second device runs local AI on the hub machine, with shared instructions applied')

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
}
