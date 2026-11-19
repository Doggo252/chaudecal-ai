// Files attached to a message. Images are kept as blob records so they sync
// between machines. Text files are read once and carried inside the message.
// A PDF is turned into text, page by page, and then travels like a text file,
// so every assistant can read it, local models included.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Attachment, Blob } from '@shared/types'
import { MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_TEXT_CHARS, newId } from '@shared/types'

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/** Identify an image by its first bytes, never by its file name. */
export function sniffImage(bytes: Uint8Array): string | undefined {
  const at = (i: number) => bytes[i] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif'
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'image/webp'
  return undefined
}

export type AttachmentOutcome = { attachment: Attachment; blob?: Blob } | { error: string }

const clean = (name: string): string => name.replace(/[\r\n"<>]/g, ' ').trim().slice(0, 120) || 'file'

export const isPdf = (bytes: Uint8Array): boolean => Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-'

/** Turns an image or a text file into an attachment. PDFs take longer and go through readAttachment. */
export function makeAttachment(name: string, bytes: Buffer): AttachmentOutcome {
  const label = clean(name)
  const mime = sniffImage(bytes)
  const id = newId()
  if (mime) {
    if (bytes.length > MAX_IMAGE_BYTES) return { error: `${label} is larger than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB.` }
    return { attachment: { id, name: label, mime, size: bytes.length, kind: 'image' }, blob: { id, name: label, mime, base64: bytes.toString('base64') } }
  }
  if (isPdf(bytes)) return { error: `${label} is a PDF, which has to be read with readAttachment.` }
  if (bytes.subarray(0, 8000).includes(0)) return { error: `${label} is not a text file or a supported image (PNG, JPEG, GIF, WebP).` }
  let text = bytes.toString('utf8')
  if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n(The rest of this file was left out because it is too long.)`
  return { attachment: { id, name: label, mime: 'text/plain', size: bytes.length, kind: 'text', text } }
}

/** Turns any supported file into an attachment. */
export async function readAttachment(name: string, bytes: Buffer): Promise<AttachmentOutcome> {
  return isPdf(bytes) ? readPdf(name, bytes) : makeAttachment(name, bytes)
}

/** The text of one page, with the line breaks the page had. */
function pageText(items: unknown[]): string {
  let out = ''
  for (const item of items as { str?: string; hasEOL?: boolean }[]) {
    if (typeof item.str !== 'string') continue
    out += item.str
    if (item.hasEOL) out += '\n'
  }
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Reads the text of a PDF. Pictures and scanned pages have no text and are not read.
 * A document longer than a message can carry is cut at a page boundary, and says so.
 */
export async function readPdf(name: string, bytes: Buffer): Promise<AttachmentOutcome> {
  const label = clean(name)
  if (bytes.length > MAX_FILE_BYTES) return { error: `${label} is larger than ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.` }
  let doc: Awaited<ReturnType<typeof import('unpdf').getDocumentProxy>>
  try {
    const { getDocumentProxy } = await import('unpdf')
    // The reader takes ownership of the bytes it is given, so it gets a copy.
    doc = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 })
  } catch (e) {
    const locked = e instanceof Error && e.name === 'PasswordException'
    return { error: locked ? `${label} is protected by a password. Remove the password and attach it again.` : `${label} could not be read as a PDF.` }
  }
  try {
    const pages = doc.numPages
    const parts: string[] = []
    let chars = 0
    let read = 0
    for (let n = 1; n <= pages; n++) {
      let text = ''
      try {
        const page = await doc.getPage(n)
        text = pageText((await page.getTextContent()).items)
        page.cleanup()
      } catch {
        // One broken page should not lose the rest of the document.
      }
      const part = `[Page ${n}]\n${text || '(no text on this page)'}`
      if (parts.length && chars + part.length > MAX_TEXT_CHARS) break
      parts.push(part.slice(0, MAX_TEXT_CHARS))
      chars += part.length
      read = n
    }
    if (!parts.some((p) => !p.endsWith('(no text on this page)'))) {
      return { error: `${label} has no text that can be read. It is probably a scan or made of pictures. Open it in the claude.ai or chatgpt.com tab instead.` }
    }
    if (read < pages) parts.push(`(Pages ${read + 1} to ${pages} of this document were left out because it is too long.)`)
    return { attachment: { id: newId(), name: label, mime: 'application/pdf', size: bytes.length, kind: 'text', text: parts.join('\n\n'), pages } }
  } finally {
    // Frees the memory the document used. Not every build of the reader has this.
    void (doc as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => {})
  }
}

/** Write an image where a command line tool can read it. Returns the path. */
export function imageFile(dir: string, blob: Blob): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${blob.id.replace(/[^a-z0-9-]/gi, '')}.${IMAGE_EXT[blob.mime] ?? 'bin'}`)
  if (!existsSync(path)) writeFileSync(path, Buffer.from(blob.base64, 'base64'))
  return path
}
