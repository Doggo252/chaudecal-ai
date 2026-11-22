// Find in this chat (Cmd+F): marks every match with the browser's own text highlights
// and moves between them. Leaves the page itself untouched.

import { useEffect, useRef, useState, type RefObject } from 'react'

const MAX = 2000

/** Every place `query` appears in the text under `root`, ignoring case. */
export function findRanges(root: HTMLElement, query: string): Range[] {
  const q = query.toLowerCase()
  if (!q) return []
  const out: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node && out.length < MAX; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').toLowerCase()
    for (let at = text.indexOf(q); at >= 0 && out.length < MAX; at = text.indexOf(q, at + q.length)) {
      const r = document.createRange()
      r.setStart(node, at)
      r.setEnd(node, at + q.length)
      out.push(r)
    }
  }
  return out
}

export function FindBar({ root, onClose }: { root: RefObject<HTMLElement | null>; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [ranges, setRanges] = useState<Range[]>([])
  const [at, setAt] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const highlights = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights
  const Highlight = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight

  useEffect(() => {
    input.current?.focus()
    return () => {
      highlights?.delete('find')
      highlights?.delete('find-now')
    }
  }, [highlights])

  useEffect(() => {
    const found = root.current ? findRanges(root.current, query.trim()) : []
    setRanges(found)
    setAt(0)
  }, [query, root])

  useEffect(() => {
    if (!highlights || !Highlight) return
    highlights.set('find', new Highlight(...ranges))
    const now = ranges[at]
    if (now) {
      highlights.set('find-now', new Highlight(now))
      now.startContainer.parentElement?.scrollIntoView({ block: 'center' })
    } else highlights.delete('find-now')
  }, [ranges, at, highlights, Highlight])

  const step = (by: number) => ranges.length && setAt((i) => (i + by + ranges.length) % ranges.length)

  return (
    <div className="find-wrap">
      <div className="find-bar" role="search" data-testid="find-bar">
        <input
          ref={input}
          value={query}
          placeholder="Find in chat"
          aria-label="Find in chat"
          data-testid="find-input"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            if (e.key === 'Enter') {
              e.preventDefault()
              step(e.shiftKey ? -1 : 1)
            }
          }}
        />
        <span className="find-count" data-testid="find-count">
          {query.trim() ? (ranges.length ? `${at + 1} of ${ranges.length}${ranges.length >= MAX ? '+' : ''}` : 'None') : ''}
        </span>
        <button type="button" className="icon-btn" title="Previous (Shift Enter)" disabled={!ranges.length} onClick={() => step(-1)}>
          ↑
        </button>
        <button type="button" className="icon-btn" title="Next (Enter)" disabled={!ranges.length} onClick={() => step(1)}>
          ↓
        </button>
        <button type="button" className="icon-btn" title="Close (Esc)" data-testid="find-close" onClick={onClose}>
          ✕
        </button>
      </div>
    </div>
  )
}
