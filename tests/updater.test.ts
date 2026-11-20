import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import type { UpdateInfo } from '@shared/types'
import { checkForUpdate, pickAsset } from '../src/main/updates'
import { AWAY_SECONDS, bundleOf, MAC_SWAP_SCRIPT, macInstallProblem, matches, shouldRestartForUpdate, Updater } from '../src/main/updater'
import { canRunFakes, tempDir } from './helpers'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const files = (v: string) => [
  { name: `Chaude-${v}-mac-arm64.dmg`, url: 'u1', size: 1 },
  { name: `Chaude-${v}-arm64-mac.zip`, url: 'u2', size: 2 },
  { name: `Chaude-${v}-mac.zip`, url: 'u3', size: 3 },
  { name: `Chaude-${v}-windows-setup.exe`, url: 'u4', size: 4 }
]

describe('choosing and checking the update', () => {
  it('picks the zip for this kind of Mac, and the installer on Windows', () => {
    expect(pickAsset(files('1.0.0'), 'darwin', 'arm64')?.url).toBe('u2')
    expect(pickAsset(files('1.0.0'), 'darwin', 'x64')?.url).toBe('u3')
    expect(pickAsset(files('1.0.0'), 'win32', 'x64')?.url).toBe('u4')
    expect(pickAsset(files('1.0.0'), 'linux', 'x64')).toBeUndefined()
    expect(pickAsset([], 'darwin', 'arm64')).toBeUndefined()
  })

  it('takes downloads only from the project releases', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          tag_name: 'v2.0.0-build.3',
          html_url: 'https://github.com/x',
          assets: [
            { name: 'Chaude-2.0.0-arm64-mac.zip', browser_download_url: 'https://github.com/Doggo252/chaudecal-ai/releases/download/v2/Chaude-2.0.0-arm64-mac.zip', size: 10, digest: 'sha256:ab' },
            { name: 'Chaude-2.0.0-mac.zip', browser_download_url: 'https://evil.example/Chaude-2.0.0-mac.zip', size: 10 }
          ]
        })
      )
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())))
    const found = await checkForUpdate({ version: '1.0.0', build: 1 }, `http://127.0.0.1:${(server.address() as { port: number }).port}/latest`)
    expect(found?.assets).toEqual([{ name: 'Chaude-2.0.0-arm64-mac.zip', url: 'https://github.com/Doggo252/chaudecal-ai/releases/download/v2/Chaude-2.0.0-arm64-mac.zip', size: 10, digest: 'sha256:ab' }])
  })

  it('checks a download by its checksum, or by its size when there is none', () => {
    expect(matches({ name: 'a', url: 'u', size: 3, digest: 'sha256:ABC' }, 'abc', 99)).toBe(true)
    expect(matches({ name: 'a', url: 'u', size: 3, digest: 'sha256:abc' }, 'abd', 3)).toBe(false)
    expect(matches({ name: 'a', url: 'u', size: 3 }, 'anything', 3)).toBe(true)
    expect(matches({ name: 'a', url: 'u', size: 3 }, 'anything', 4)).toBe(false)
  })

  it('only replaces a Mac app that is in a folder it can write to', () => {
    expect(bundleOf('/Applications/Chaude.app/Contents/MacOS/Chaude')).toBe('/Applications/Chaude.app')
    expect(bundleOf('/usr/local/bin/node')).toBeUndefined()
    expect(macInstallProblem('/Applications/Chaude.app', () => true)).toBeUndefined()
    expect(macInstallProblem('/private/var/folders/x/AppTranslocation/y/d/Chaude.app', () => true)).toMatch(/Applications folder/)
    expect(macInstallProblem('/Volumes/Chaude/Chaude.app', () => true)).toMatch(/Applications folder/)
    expect(macInstallProblem('/Applications/Chaude.app', () => false)).toMatch(/cannot replace itself/)
  })
})

describe('downloading', () => {
  async function serve(body: Buffer) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(body.length) })
      res.end(body)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())))
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }
  function make(platform = 'win32', packaged = true) {
    const seen: UpdateInfo[] = []
    const updater = new Updater({ dir: tempDir(), platform, arch: 'x64', packaged, exePath: 'C:/Chaude/Chaude.exe', quit: () => {}, onChange: (i) => seen.push(i) })
    return { updater, seen }
  }
  const release = (url: string, digest?: string, size = 5): UpdateInfo => ({ version: '9.0.0', build: 1, url: 'page', assets: [{ name: 'Chaude-9.0.0-windows-setup.exe', url, size, ...(digest ? { digest } : {}) }] })

  it('downloads in the background when allowed, and is then ready to install', async () => {
    const body = Buffer.from('hello')
    const base = await serve(body)
    const { updater, seen } = make()
    updater.offer(release(`${base}/f`, `sha256:${createHash('sha256').update(body).digest('hex')}`), true)
    await updater.download()
    expect(updater.info).toMatchObject({ state: 'ready', progress: 1, canInstall: true })
    expect(seen[0]).toMatchObject({ state: 'available' })
  })

  it('refuses a file that does not match the release', async () => {
    const base = await serve(Buffer.from('tampered'))
    const { updater } = make()
    updater.offer(release(`${base}/f`, 'sha256:0000'), false)
    await expect(updater.download()).rejects.toThrow(/does not match/)
    expect(updater.info).toMatchObject({ state: 'error' })
    expect(await updater.apply()).toEqual({ error: expect.stringMatching(/does not match/) })
  })

  it('only points at the release page from a development build', () => {
    const { updater } = make('win32', false)
    updater.offer(release('http://x/f'), true)
    expect(updater.info).toMatchObject({ state: 'available', canInstall: false, message: 'This is a development build.' })
  })
})

describe.skipIf(!canRunFakes)('swapping in the new Mac app', () => {
  it('waits for the app to quit, swaps the new one in, removes the old, and opens it', () => {
    const dir = tempDir()
    const app = (name: string, marker: string) => {
      const bin = join(dir, name, 'Contents', 'MacOS')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'Chaude'), `#!/bin/sh\necho started-${marker} > "${join(dir, 'launched.txt')}"\n`)
      chmodSync(join(bin, 'Chaude'), 0o755)
      return join(dir, name)
    }
    const old = app('Chaude.app', 'old')
    const fresh = app('staging/Chaude.app', 'new')
    const script = join(dir, 'swap.sh')
    writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o700 })
    // A process that has already ended stands in for the app that quit.
    const ended = spawnSync('/usr/bin/true').pid
    execFileSync('/bin/sh', [script, String(ended), old, fresh, 'Chaude'])
    for (let i = 0; i < 50 && !existsSync(join(dir, 'launched.txt')); i++) execFileSync('/bin/sleep', ['0.1'])
    expect(readFileSync(join(dir, 'launched.txt'), 'utf8').trim()).toBe('started-new')
    expect(readFileSync(join(old, 'Contents', 'MacOS', 'Chaude'), 'utf8')).toContain('started-new')
    expect(existsSync(fresh)).toBe(false)
    expect(execFileSync('/bin/ls', [dir]).toString()).not.toMatch(/previous/)
  })

  it('swaps without opening the app when the user quit', () => {
    const dir = tempDir()
    const app = (name: string, marker: string) => {
      const bin = join(dir, name, 'Contents', 'MacOS')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'Chaude'), `#!/bin/sh\necho started-${marker} > "${join(dir, 'launched.txt')}"\n`)
      chmodSync(join(bin, 'Chaude'), 0o755)
      return join(dir, name)
    }
    const old = app('Chaude.app', 'old')
    const fresh = app('staging/Chaude.app', 'new')
    const script = join(dir, 'swap.sh')
    writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o700 })
    const ended = spawnSync('/usr/bin/true').pid
    execFileSync('/bin/sh', [script, String(ended), old, fresh, 'Chaude', 'no'])
    execFileSync('/bin/sleep', ['0.5'])
    expect(existsSync(join(dir, 'launched.txt'))).toBe(false)
    expect(readFileSync(join(old, 'Contents', 'MacOS', 'Chaude'), 'utf8')).toContain('started-new')
  })
})

describe('when an update restarts the app by itself', () => {
  const base = { ready: true, busy: false, idleSeconds: AWAY_SECONDS, windowShown: true }
  it('waits for the user to step away from an open window', () => {
    expect(shouldRestartForUpdate(base)).toBe(true)
    expect(shouldRestartForUpdate({ ...base, idleSeconds: 120 })).toBe(false)
  })
  it('goes sooner when the app is only in the background', () => {
    expect(shouldRestartForUpdate({ ...base, idleSeconds: 120, windowShown: false })).toBe(true)
  })
  it('never interrupts work, and needs a downloaded update', () => {
    expect(shouldRestartForUpdate({ ...base, busy: true })).toBe(false)
    expect(shouldRestartForUpdate({ ...base, ready: false })).toBe(false)
  })
})
