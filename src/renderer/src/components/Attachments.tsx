import { useEffect, useState } from 'react'
import type { Attachment } from '@shared/types'
import { IconClose, IconFile } from '../icons'

// Image bytes are fetched once per attachment and kept for the life of the window.
const cache = new Map<string, Promise<string | undefined>>()

function imageUrl(id: string): Promise<string | undefined> {
  let p = cache.get(id)
  if (!p) {
    p = window.api.attachmentUrl(id).then((url) => {
      // Not here yet (still syncing from the other machine): ask again next time.
      if (!url) cache.delete(id)
      return url
    })
    cache.set(id, p)
  }
  return p
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function Thumb({ a, large }: { a: Attachment; large?: boolean }) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    let live = true
    void imageUrl(a.id).then((u) => live && setUrl(u))
    return () => {
      live = false
    }
  }, [a.id])
  if (!url) return <span className={`attach-thumb placeholder ${large ? 'large' : ''}`} title="This image has not synced to this machine yet" />
  return <img className={`attach-thumb ${large ? 'large' : ''}`} src={url} alt={a.name} title={a.name} />
}

/** Attachments on a sent message (large) or waiting in the message box (small, removable). */
export function AttachmentList({ items, onRemove }: { items: Attachment[]; onRemove?: (a: Attachment) => void }) {
  if (!items.length) return null
  return (
    <div className={`attachments ${onRemove ? 'pending' : ''}`} data-testid="attachments">
      {items.map((a) => (
        <span className={`attachment ${a.kind}`} key={a.id} data-testid="attachment" data-kind={a.kind} data-pages={a.pages}>
          {a.kind === 'image' ? (
            <Thumb a={a} large={!onRemove} />
          ) : (
            <span className="attach-file" title={a.name}>
              <IconFile size={15} />
              <span className="attach-name">{a.name}</span>
              <span className="muted">{a.pages ? `${a.pages} ${a.pages === 1 ? 'page' : 'pages'}` : size(a.size)}</span>
            </span>
          )}
          {onRemove && (
            <button type="button" className="attach-remove" title={`Remove ${a.name}`} onClick={() => onRemove(a)}>
              <IconClose size={11} />
            </button>
          )}
        </span>
      ))}
    </div>
  )
}

/** Read a pasted or dropped file as base64 for the backend. */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
