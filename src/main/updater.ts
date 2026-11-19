// Downloads and installs a newer build by itself. The builds are not signed with
// a paid certificate, so the standard Electron updaters (which insist on a
// signature on the Mac) cannot be used. Instead:
//
// - Mac: the release's zip is downloaded and checked against the checksum GitHub
//   publishes for it, unpacked, checked to be this same app, and swapped in for
//   the running app by a small script that waits for the app to quit and then
//   opens the new one. If the swap fails, the old app is put back.
// - Windows: the release's installer is downloaded, checked the same way, and run
//   silently. It replaces the installed app and opens it again.

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { ReleaseAsset, UpdateInfo } from '@shared/types'
import { pickAsset } from './updates'

const run = promisify(execFile)

/** The largest file the updater will download. */
const MAX_DOWNLOAD = 700 * 1024 * 1024

export interface UpdaterOptions {
  /** Where downloads and unpacked files go. */
  dir: string
  platform: string
  arch: string
  /** A packaged app. A development build only points at the release page. */
  packaged: boolean
  /** The running program, inside the app bundle on a Mac. */
  exePath: string
  quit: () => void
  onChange: (info: UpdateInfo) => void
}

/** The .app folder the running program is in, or undefined when it is not in one. */
export function bundleOf(exePath: string): string | undefined {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(exePath)
  return m?.[1]
}

/** Why this Mac app cannot replace itself, or undefined when it can. */
export function macInstallProblem(bundle: string | undefined, writable: (dir: string) => boolean): string | undefined {
  if (!bundle) return 'The app is not in an app bundle.'
  if (bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) return 'Move Chaude to your Applications folder first, then open it from there.'
  if (!writable(dirname(bundle))) return 'Chaude cannot replace itself in the folder it is in. Download the new version from the release page instead.'
  return undefined
}

/** The script that swaps the new app in once the running one has quit, and opens it. */
export const MAC_SWAP_SCRIPT = `#!/bin/sh
PID="$1"; OLD="$2"; NEW="$3"; DIRECT="$4"
while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done
BAK="$OLD.previous-$$"
if mv "$OLD" "$BAK"; then
  if mv "$NEW" "$OLD"; then rm -rf "$BAK"; else mv "$BAK" "$OLD"; fi
fi
if [ -n "$DIRECT" ]; then "$OLD/Contents/MacOS/$DIRECT" >/dev/null 2>&1 & else open "$OLD"; fi
`

/** Whether a downloaded file is the one GitHub published: by its checksum, or by its size when there is none. */
export function matches(asset: ReleaseAsset, sha256: string, size: number): boolean {
  if (asset.digest?.startsWith('sha256:')) return asset.digest.slice(7).toLowerCase() === sha256
  return size === asset.size
}

export class Updater {
  info?: UpdateInfo
  private file?: string
  private busy?: Promise<void>

  constructor(private o: UpdaterOptions) {}

  private set(patch: Partial<UpdateInfo>): void {
    if (!this.info) return
    this.info = { ...this.info, ...patch }
    this.o.onChange(this.info)
  }

  /** Why this machine cannot install the update by itself, or undefined when it can. */
  private problem(asset: ReleaseAsset | undefined): string | undefined {
    if (!this.o.packaged) return 'This is a development build.'
    if (!asset) return 'The release has no file for this computer.'
    if (this.o.platform === 'darwin')
      return macInstallProblem(bundleOf(this.o.exePath), (d) => {
        try {
          accessSync(d, constants.W_OK)
          return true
        } catch {
          return false
        }
      })
    if (this.o.platform === 'win32') return undefined
    return 'Updating by itself is not supported on this system.'
  }

  /** A newer build was found. With `auto`, it is downloaded straight away. */
  offer(found: UpdateInfo, auto: boolean): void {
    if (this.info && this.info.version === found.version && this.info.build === found.build) return
    const asset = pickAsset(found.assets, this.o.platform, this.o.arch)
    const problem = this.problem(asset)
    this.file = undefined
    this.info = { ...found, state: 'available', canInstall: !problem, ...(problem ? { message: problem } : {}) }
    this.o.onChange(this.info)
    if (auto && !problem) void this.download().catch(() => {})
  }

  /** Downloads the update and checks it. Safe to call again while it runs. */
  download(): Promise<void> {
    if (this.busy) return this.busy
    this.busy = this.fetchFile().finally(() => (this.busy = undefined))
    return this.busy
  }

  private async fetchFile(): Promise<void> {
    const info = this.info
    const asset = pickAsset(info?.assets, this.o.platform, this.o.arch)
    if (!info || !asset || !info.canInstall) throw new Error('There is nothing to download.')
    if (this.file && existsSync(this.file)) return this.set({ state: 'ready', progress: 1 })
    if (asset.size > MAX_DOWNLOAD) return this.fail('The update is larger than expected.')
    mkdirSync(this.o.dir, { recursive: true })
    const target = join(this.o.dir, basename(asset.name))
    this.set({ state: 'downloading', progress: 0, message: undefined })
    try {
      const res = await fetch(asset.url, { headers: { 'user-agent': 'chaude' }, signal: AbortSignal.timeout(30 * 60 * 1000) })
      if (!res.ok || !res.body) throw new Error(`The download answered ${res.status}.`)
      const hash = createHash('sha256')
      const out = createWriteStream(target)
      let got = 0
      let last = 0
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        got += value.length
        if (got > MAX_DOWNLOAD) throw new Error('The update is larger than expected.')
        hash.update(value)
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
        if (Date.now() - last > 300) {
          last = Date.now()
          this.set({ progress: asset.size ? Math.min(1, got / asset.size) : 0 })
        }
      }
      await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))
      if (!matches(asset, hash.digest('hex'), got)) {
        rmSync(target, { force: true })
        throw new Error('The downloaded file does not match the release. Nothing was installed.')
      }
      this.file = target
      this.set({ state: 'ready', progress: 1 })
    } catch (e) {
      rmSync(target, { force: true })
      this.fail(e instanceof Error ? e.message : String(e))
      throw e
    }
  }

  private fail(message: string): void {
    this.set({ state: 'error', message })
  }

  /** Downloads if needed, installs, and restarts into the new version. */
  async apply(): Promise<{ error?: string }> {
    try {
      if (!this.info?.canInstall) return { error: this.info?.message ?? 'There is no update to install.' }
      await this.download()
      if (!this.file) return { error: this.info?.message ?? 'The update could not be downloaded.' }
      if (this.o.platform === 'darwin') await this.installMac(this.file)
      else if (this.o.platform === 'win32') this.installWindows(this.file)
      this.o.quit()
      return {}
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.fail(message)
      return { error: message }
    }
  }

  private async installMac(zip: string): Promise<void> {
    const current = bundleOf(this.o.exePath)
    if (!current) throw new Error('The app is not in an app bundle.')
    const staging = mkdtempSync(join(this.o.dir, 'staging-'))
    await run('/usr/bin/ditto', ['-x', '-k', zip, staging])
    const unpacked = readdirSync(staging).find((n) => n.endsWith('.app'))
    if (!unpacked) throw new Error('The update has no app in it.')
    const fresh = join(staging, unpacked)
    // Only ever replace this app with a newer copy of itself.
    const id = async (bundle: string) => (await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist')])).stdout.trim()
    if ((await id(fresh)) !== (await id(current))) throw new Error('The update is not this app. Nothing was installed.')
    if (!statSync(join(fresh, 'Contents', 'MacOS')).isDirectory()) throw new Error('The update is incomplete.')
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', fresh]).catch(() => {})
    const script = join(this.o.dir, 'swap.sh')
    writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o700 })
    // Tests run the app with their own data folder, and the new app has to start with it too.
    const direct = process.env.CHAUDECAL_USER_DATA ? basename(this.o.exePath) : ''
    spawn('/bin/sh', [script, String(process.pid), current, fresh, direct], { detached: true, stdio: 'ignore', env: process.env }).unref()
  }

  private installWindows(installer: string): void {
    // The installer's own options: silent, an update of what is there, then start the app.
    spawn(installer, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
  }
}
