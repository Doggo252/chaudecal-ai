// Files attached to a message. Images are kept as blob records so they sync
// between machines. Text files are read once and carried inside the message.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Attachment, Blob } from '@shared/types'
import { MAX_IMAGE_BYTES, MAX_TEXT_CHARS, newId } from '@shared/types'

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

export function makeAttachment(name: string, bytes: Buffer): AttachmentOutcome {
  const label = name.replace(/[\r\n"<>]/g, ' ').trim().slice(0, 120) || 'file'
  const mime = sniffImage(bytes)
  const id = newId()
  if (mime) {
    if (bytes.length > MAX_IMAGE_BYTES) return { error: `${label} is larger than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB.` }
    return { attachment: { id, name: label, mime, size: bytes.length, kind: 'image' }, blob: { id, name: label, mime, base64: bytes.toString('base64') } }
  }
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return { error: `${label} is a PDF. PDFs are not supported yet, so open it in the claude.ai or chatgpt.com tab.` }
  if (bytes.subarray(0, 8000).includes(0)) return { error: `${label} is not a text file or a supported image (PNG, JPEG, GIF, WebP).` }
  let text = bytes.toString('utf8')
  if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n(The rest of this file was left out because it is too long.)`
  return { attachment: { id, name: label, mime: 'text/plain', size: bytes.length, kind: 'text', text } }
}

/** Write an image where a command line tool can read it. Returns the path. */
export function imageFile(dir: string, blob: Blob): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${blob.id.replace(/[^a-z0-9-]/gi, '')}.${IMAGE_EXT[blob.mime] ?? 'bin'}`)
  if (!existsSync(path)) writeFileSync(path, Buffer.from(blob.base64, 'base64'))
  return path
}
