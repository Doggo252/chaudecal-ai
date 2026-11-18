// Tells the user when a newer build has been published. It never downloads or
// installs anything: the builds are unsigned, so the user fetches the installer
// from the Releases page.

import type { UpdateInfo } from '@shared/types'

export const RELEASES_API = 'https://api.github.com/repos/Doggo252/chaudecal-ai/releases/latest'

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

export async function checkForUpdate(current: { version: string; build: number }, url = RELEASES_API): Promise<UpdateInfo | undefined> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'chaudecal-ai' }, signal: AbortSignal.timeout(10000) })
    if (!res.ok) return undefined
    const body = (await res.json()) as { tag_name?: string; html_url?: string }
    const latest = parseTag(body.tag_name ?? '')
    if (!latest || !isNewerBuild(latest, current)) return undefined
    const page = typeof body.html_url === 'string' && /^https:\/\/github\.com\//.test(body.html_url) ? body.html_url : 'https://github.com/Doggo252/chaudecal-ai/releases/latest'
    return { ...latest, url: page }
  } catch {
    return undefined
  }
}
