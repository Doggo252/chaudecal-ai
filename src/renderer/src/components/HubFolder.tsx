import { useEffect, useRef, useState } from 'react'
import type { FolderListing } from '@shared/types'
import { IconBack, IconFolder } from '../icons'

/**
 * Chooses a folder on the hub from another device: browse the hub's folders, or type a path.
 * Clicking a folder goes into it. "Use this folder" takes whatever path is showing.
 */
export function HubFolder(props: { hubName: string; platform?: string; current: string; onUse: (path: string) => Promise<string | undefined> }) {
  const [path, setPath] = useState(props.current)
  const [listing, setListing] = useState<FolderListing>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** Only the answer to the newest request is shown. */
  const asked = useRef(0)
  const input = useRef<HTMLInputElement>(null)

  /**
   * Shows the folders inside `to`. `from` says what asked: a click reports a failure, the folder the
   * picker opened on falls back to the hub's home folder, and a path being typed changes nothing if
   * it does not lead anywhere yet.
   */
  const go = async (to: string, from: 'click' | 'start' | 'typing' = 'click') => {
    const turn = ++asked.current
    setLoading(true)
    const found = await window.api.browseHubFolders(to)
    if (turn !== asked.current) return
    setLoading(false)
    if (found.error) {
      if (from === 'start' && to) void go('', 'start')
      else if (from !== 'typing') setError(found.error)
      return
    }
    if (from !== 'typing') {
      setError('')
      setPath(found.path)
    }
    setListing(found)
  }

  useEffect(() => {
    void go(props.current, 'start')
    // Loads once, when the picker opens.
  }, [])

  // After moving to a folder, show the end of its path: the folder's own name matters more than where the path starts.
  useEffect(() => {
    const el = input.current
    if (el && document.activeElement !== el) el.scrollLeft = el.scrollWidth
  }, [listing])

  // A typed path is followed once the typing pauses, so the list always shows what is inside it.
  useEffect(() => {
    const typed = path.trim()
    if (!listing || !typed || typed === listing.path) return
    const timer = setTimeout(() => void go(typed, 'typing'), 350)
    return () => clearTimeout(timer)
  }, [path])

  const use = async () => {
    const problem = await props.onUse(path)
    if (problem) setError(problem)
  }

  return (
    <div className="menu-form folder-browser">
      <div className="menu-title">Folder on {props.hubName}</div>
      <div className="folder-path">
        <button type="button" className="icon-btn" title="Up one folder" aria-label="Up one folder" data-testid="hub-folder-up" disabled={!listing?.parent} onClick={() => listing?.parent && void go(listing.parent)}>
          <IconBack size={15} />
        </button>
        <input
          ref={input}
          className="input"
          data-testid="hub-folder-input"
          placeholder={props.platform === 'win32' ? 'C:\\Users\\you\\project' : '/Users/you/project'}
          value={path}
          spellCheck={false}
          onChange={(e) => {
            setPath(e.target.value)
            setError('')
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void use()
          }}
        />
      </div>
      {listing && listing.places.length > 0 && (
        <div className="folder-places">
          {listing.places.map((p) => (
            <button type="button" key={p.path} className="folder-place" data-testid="hub-folder-place" onClick={() => void go(p.path)}>
              {p.name}
            </button>
          ))}
        </div>
      )}
      <div className={`folder-list ${loading ? 'loading' : ''}`} data-testid="hub-folder-list">
        {listing?.folders.map((f) => (
          <button type="button" key={f.path} className="folder-item" data-testid="hub-folder-item" title={f.path} onClick={() => void go(f.path)}>
            <IconFolder size={14} /> <span>{f.name}</span>
          </button>
        ))}
        {listing && listing.folders.length === 0 && <div className="folder-empty">No folders inside this one.</div>}
        {listing?.truncated && <div className="folder-empty">There are more folders here than can be listed. Type the path to reach one.</div>}
        {!listing && !error && <div className="folder-empty">Looking at {props.hubName}…</div>}
      </div>
      {error && (
        <div className="menu-error" data-testid="hub-folder-error">
          {error}
        </div>
      )}
      <button type="button" className="btn btn-small btn-primary" data-testid="hub-folder-save" onClick={() => void use()}>
        Use this folder
      </button>
    </div>
  )
}
