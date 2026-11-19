// Looks for a newer build on the project's GitHub releases. Installing it is
// the updater's job (updater.ts).

import type { ReleaseAsset, UpdateInfo } from '@shared/types'

export const RELEASES_API = 'https://api.github.com/repos/Doggo252/chaudecal-ai/releases/latest'
/** Downloads are only taken from the project's own releases. */
export const RELEASE_DOWNLOADS = 'https://github.com/Doggo252/chaudecal-ai/releases/download/'

/** Release tags look like v0.2.0-build.14. */
export function parseTag(tag: string): { version: string; build: number } | undefined {
  const m = /^v?(\d+\.\d+\.\d+)(?:-build\.(\d+))?$/.exec(tag.trim())
  return m ? { version: m[1], build: Number(m[2] ?? 0) } : undefined
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

export function isNewerBuild(latest: { version: string; build: number }, current: { version: string; build: number }): boolean {
  const v = compareVersions(latest.version, current.version)
  if (v !== 0) return v > 0
  // A build made on a developer's machine has no build number and is never nagged.
  return current.build > 0 && latest.build > current.build
}

/** The file this machine installs from: the zip for its kind of Mac, or the Windows installer. */
export function pickAsset(assets: ReleaseAsset[] | undefined, platform: string, arch: string): ReleaseAsset | undefined {
  const list = assets ?? []
  if (platform === 'darwin') return arch === 'arm64' ? list.find((a) => /-arm64-mac\.zip$/.test(a.name)) : list.find((a) => /-mac\.zip$/.test(a.name) && !/arm64/.test(a.name))
  if (platform === 'win32') return list.find((a) => /-windows-setup\.exe$/.test(a.name))
  return undefined
}

export async function checkForUpdate(current: { version: string; build: number }, url = RELEASES_API, downloads = RELEASE_DOWNLOADS): Promise<UpdateInfo | undefined> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'chaude' }, signal: AbortSignal.timeout(10000) })
    if (!res.ok) return undefined
    const body = (await res.json()) as { tag_name?: string; html_url?: string; assets?: { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown }[] }
    const latest = parseTag(body.tag_name ?? '')
    if (!latest || !isNewerBuild(latest, current)) return undefined
    const page = typeof body.html_url === 'string' && /^https:\/\/github\.com\//.test(body.html_url) ? body.html_url : 'https://github.com/Doggo252/chaudecal-ai/releases/latest'
    const assets: ReleaseAsset[] = (Array.isArray(body.assets) ? body.assets : [])
      .filter((a) => typeof a.name === 'string' && typeof a.browser_download_url === 'string' && a.browser_download_url.startsWith(downloads) && typeof a.size === 'number')
      .map((a) => ({ name: a.name as string, url: a.browser_download_url as string, size: a.size as number, ...(typeof a.digest === 'string' ? { digest: a.digest } : {}) }))
    return { ...latest, url: page, assets }
  } catch {
    return undefined
  }
}
