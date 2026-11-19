// Quick ask: a small box that opens over whatever the user is doing, from a
// keyboard shortcut. And screen capture: a screenshot of the whole screen or of
// one window, attached to a message.

import { BrowserWindow, desktopCapturer, globalShortcut, screen } from 'electron'
import { join } from 'node:path'

/** Option+Space on a Mac, Alt+Space on Windows, as in the ChatGPT app. */
export const QUICK_SHORTCUT = 'Alt+Space'

let quick: BrowserWindow | undefined

function load(w: BrowserWindow, hash: string): void {
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`)
  else void w.loadFile(join(__dirname, '../renderer/index.html'), { hash })
}

/** Opens the quick ask box on the screen the pointer is on, or closes it if it is open. */
export function toggleQuick(preload: string): void {
  if (quick && !quick.isDestroyed() && quick.isVisible()) {
    quick.hide()
    return
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const width = Math.min(680, display.workArea.width - 40)
  const bounds = { width, height: 76, x: Math.round(display.workArea.x + (display.workArea.width - width) / 2), y: Math.round(display.workArea.y + display.workArea.height * 0.22) }
  if (!quick || quick.isDestroyed()) {
    quick = new BrowserWindow({
      ...bounds,
      frame: false,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      fullscreenable: false,
      backgroundColor: '#00000000',
      transparent: process.platform === 'darwin',
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false }
    })
    quick.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    quick.on('blur', () => quick?.hide())
    quick.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    quick.webContents.on('will-navigate', (e) => e.preventDefault())
    load(quick, 'quick')
    quick.once('ready-to-show', () => quick?.show())
  } else {
    quick.setBounds(bounds)
    quick.show()
  }
  quick.focus()
  quick.webContents.send('event:command', 'quick-focus')
}

export function hideQuick(): void {
  if (quick && !quick.isDestroyed()) quick.hide()
}

/** Turns the shortcut on or off. Gives back false when another app already uses it. */
export function setQuickShortcut(on: boolean, preload: string): boolean {
  if (globalShortcut.isRegistered(QUICK_SHORTCUT)) globalShortcut.unregister(QUICK_SHORTCUT)
  if (!on) return true
  return globalShortcut.register(QUICK_SHORTCUT, () => toggleQuick(preload))
}

export interface CaptureSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  /** A small picture of it, as a data address. */
  thumb: string
}

// Tests use a pretend screen, so no real screen is captured.
const FAKE = process.env.CHAUDECAL_E2E_CAPTURE

/** The screens and windows that can be captured, with small pictures of each. */
export async function captureSources(): Promise<CaptureSource[]> {
  if (FAKE) return [{ id: 'fake:screen', name: 'Entire screen', kind: 'screen', thumb: '' }]
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false })
  return sources
    .filter((s) => !/^Chaude$/.test(s.name))
    .map((s) => ({ id: s.id, name: s.id.startsWith('screen:') ? (sources.filter((x) => x.id.startsWith('screen:')).length > 1 ? s.name : 'Entire screen') : s.name, kind: s.id.startsWith('screen:') ? ('screen' as const) : ('window' as const), thumb: s.thumbnail.toDataURL() }))
}

/** A full-size picture of one screen or window, as PNG bytes. */
export async function captureSource(id: string, hideWhile: BrowserWindow[] = []): Promise<Buffer | undefined> {
  if (FAKE) return Buffer.from(FAKE, 'base64')
  // The app's own windows step aside while the whole screen is captured.
  const hidden = id.startsWith('screen:') ? hideWhile.filter((w) => !w.isDestroyed() && w.isVisible()) : []
  for (const w of hidden) w.hide()
  if (hidden.length) await new Promise((r) => setTimeout(r, 250))
  try {
    const sizes = screen.getAllDisplays().map((d) => ({ width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) }))
    const big = sizes.reduce((a, b) => (a.width * a.height > b.width * b.height ? a : b), { width: 1920, height: 1080 })
    const sources = await desktopCapturer.getSources({ types: [id.startsWith('screen:') ? 'screen' : 'window'], thumbnailSize: big })
    const source = sources.find((s) => s.id === id)
    if (!source || source.thumbnail.isEmpty()) return undefined
    return source.thumbnail.toPNG()
  } finally {
    for (const w of hidden) w.show()
  }
}
