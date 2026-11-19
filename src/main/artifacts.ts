// Serves artifact previews to the window under a private scheme, each with its
// own strict content policy, and keeps the frames that show them from going
// anywhere else. The window's own policy would block the scripts a preview needs,
// and a page written into a frame directly would inherit it, hence the scheme.

import { app, dialog, protocol, type BrowserWindow, type WebContents } from 'electron'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ARTIFACT_SCHEME, artifactCsp, frameUrlAllowed } from '@shared/artifactPolicy'

/** Largest preview page kept, in characters. */
const MAX_PAGE = 8 * 1024 * 1024
/** How many preview pages are kept. Older ones are dropped, and a frame showing one reloads it from the panel. */
const KEEP = 40

const pages = new Map<string, string>()

/** Must run before the app is ready. */
export function registerArtifactScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true } }])
}

export function servePreviews(): void {
  protocol.handle(ARTIFACT_SCHEME, (request) => {
    const url = new URL(request.url)
    const page = url.hostname === 'view' ? pages.get(url.pathname.replace(/^\//, '')) : undefined
    if (page === undefined) return new Response('This preview is no longer available.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    return new Response(page, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': artifactCsp(),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store'
      }
    })
  })
}

/** A kept preview page, for the app in a browser. */
export function previewPage(id: string): string | undefined {
  return pages.get(id)
}

/** Keeps a preview page and gives back the address a frame loads it from. */
export function previewUrl(html: string): string {
  if (typeof html !== 'string' || html.length > MAX_PAGE) throw new Error('This preview is too large to show.')
  const id = randomBytes(16).toString('hex')
  pages.set(id, html)
  while (pages.size > KEEP) pages.delete(pages.keys().next().value as string)
  return `${ARTIFACT_SCHEME}://view/${id}`
}

/** Frames inside the window may show previews and nothing else. A preview's links do not go anywhere. */
export function guardFrames(contents: WebContents): void {
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return
    if (!frameUrlAllowed(event.url)) event.preventDefault()
  })
}

/** Saves an artifact where the user chooses. Gives back the path, or nothing when they cancel. */
export async function saveArtifact(win: BrowserWindow | undefined, name: string, content: string): Promise<string> {
  const safe = basename(String(name)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 120) || 'artifact.txt'
  // Tests save without a dialog.
  const testDir = process.env.CHAUDECAL_E2E_SAVE_DIR
  let path: string | undefined
  if (testDir) path = join(testDir, safe)
  else {
    const options = { defaultPath: join(app.getPath('downloads'), safe) }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    path = result.canceled ? undefined : result.filePath
  }
  if (!path) return ''
  writeFileSync(path, String(content), 'utf8')
  return path
}
