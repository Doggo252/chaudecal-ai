// Checks the Mac updater for real, with two packaged copies of the app. Run by hand
// on a Mac (it packages the app twice, which takes a few minutes):
//
//   node e2e/update-mac.mjs
//
// The current version is packaged and unpacked into a test folder, and a copy one
// patch version newer is put on a stand-in release page with its checksum. The
// older app runs with its own test data, finds the update, downloads and checks it,
// and on "Restart to update" swaps itself for the newer one, which then starts.
// Nothing outside the test folder is touched.

import { _electron as electron } from 'playwright-core'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('This check runs on a Mac only.')
  process.exit(0)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const current = pkg.version
const [major, minor, patch] = current.split('.').map(Number)
const next = `${major}.${minor}.${patch + 1}`
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const work = mkdtempSync(join(tmpdir(), 'chaude-update-'))
const out = (version) => join(work, `build-${version}`)
const step = (text) => console.log(`  ${text}`)

function packageApp(version) {
  step(`packaging ${version}`)
  execFileSync('npx', ['electron-builder', '--mac', 'zip', `--${arch}`, '--publish', 'never', `-c.directories.output=${out(version)}`, `-c.extraMetadata.version=${version}`], { cwd: root, stdio: 'ignore' })
  const zip = readdirSync(out(version)).find((n) => n.endsWith('.zip'))
  if (!zip) throw new Error(`no zip for ${version}`)
  return join(out(version), zip)
}

const versionOf = (app) => execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')]).toString().trim()

let server
let electronApp
try {
  execFileSync('npx', ['electron-vite', 'build'], { cwd: root, stdio: 'ignore' })
  const oldZip = packageApp(current)
  const newZip = packageApp(next)
  const apps = join(work, 'Applications')
  mkdirSync(apps)
  execFileSync('/usr/bin/ditto', ['-x', '-k', oldZip, apps])
  const appName = readdirSync(apps).find((n) => n.endsWith('.app'))
  const app = join(apps, appName)
  step(`installed ${appName} ${versionOf(app)} in a test folder`)

  // The stand-in release page, with the newer zip and its checksum, as GitHub publishes them.
  const bytes = readFileSync(newZip)
  const name = newZip.split('/').pop()
  server = createServer((req, res) => {
    if (req.url === '/latest') {
      const origin = `http://127.0.0.1:${server.address().port}`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ tag_name: `v${next}-build.2`, html_url: 'https://github.com/Doggo252/chaudecal-ai/releases', assets: [{ name, browser_download_url: `${origin}/download/${name}`, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }] }))
    } else if (req.url === `/download/${name}`) {
      res.writeHead(200, { 'content-length': String(bytes.length) })
      res.end(bytes)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))

  const data = join(work, 'data')
  const settings = { deviceName: 'Update test', claude: { cliPath: join(root, 'tests/fakes/fake-claude.mjs') }, chatgpt: { cliPath: join(root, 'tests/fakes/fake-codex.mjs') }, local: { endpoints: [], summarize: false } }
  electronApp = await electron.launch({
    executablePath: join(app, 'Contents', 'MacOS', appName.replace(/\.app$/, '')),
    env: { ...process.env, CHAUDECAL_USER_DATA: data, CHAUDECAL_SETTINGS_JSON: JSON.stringify(settings), CHAUDECAL_UPDATE_URL: `http://127.0.0.1:${server.address().port}/latest`, CHAUDECAL_BUILD_OVERRIDE: '1' }
  })
  const page = await electronApp.firstWindow()
  await page.waitForSelector('[data-testid="update-chip"][data-state="ready"]', { timeout: 120000 })
  step(`the update to ${next} was found, downloaded and checked in the background`)
  await page.screenshot({ path: join(root, 'e2e', 'artifacts', '40-update-ready.png') })
  const pid = await electronApp.evaluate(() => process.pid)
  await page.click('[data-testid="update-chip"]').catch(() => {})
  await new Promise((resolve, reject) => {
    const end = Date.now() + 30000
    const tick = () => {
      if (spawnSync('/bin/kill', ['-0', String(pid)]).status !== 0) return resolve()
      if (Date.now() > end) return reject(new Error('the old app did not quit'))
      setTimeout(tick, 200)
    }
    tick()
  })
  step('the old app quit')
  for (let i = 0; i < 100 && versionOf(app) !== next; i++) await new Promise((r) => setTimeout(r, 200))
  if (versionOf(app) !== next) throw new Error(`the app is still ${versionOf(app)}`)
  step(`the app in the test folder is now ${next}`)
  if (readdirSync(apps).length !== 1) throw new Error(`left over in the folder: ${readdirSync(apps).join(', ')}`)
  let running = ''
  for (let i = 0; i < 100 && !running; i++) {
    running = spawnSync('/usr/bin/pgrep', ['-f', join(app, 'Contents', 'MacOS')]).stdout.toString().trim()
    if (!running) await new Promise((r) => setTimeout(r, 200))
  }
  if (!running) throw new Error('the new app did not start')
  step(`the new app started (process ${running.split('\n')[0]})`)
  spawnSync('/usr/bin/pkill', ['-f', join(app, 'Contents', 'MacOS')])
  console.log('\nThe Mac update worked: found, downloaded, checked, swapped in and restarted.')
} catch (e) {
  console.error(`\nThe update check failed: ${e.stack ?? e}`)
  process.exitCode = 1
} finally {
  if (electronApp) await electronApp.close().catch(() => {})
  server?.close()
  if (existsSync(work)) rmSync(work, { recursive: true, force: true })
}
