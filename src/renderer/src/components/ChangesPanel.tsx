import { useEffect, useMemo, useState } from 'react'
import type { Message } from '@shared/types'
import type { OpenHow } from '@shared/ipc'
import { collectChanges, shortPath, type FileChange } from '@shared/diff'
import { toast } from '../state'
import { IconChevron, IconClose, IconCode, IconFolder, IconTerminal } from '../icons'
import { Counts, DiffView } from './Messages'

/** The files a code chat changed, from the steps in the messages shown. */
export function useChanges(messages: Message[]): FileChange[] {
  return useMemo(() => collectChanges(messages.flatMap((m) => m.tools ?? [])), [messages])
}

/** Opens the chat's folder, or a file in it, in an editor, Finder or Explorer, or a terminal. */
export function openIn(conversationId: string, how: OpenHow, file?: string) {
  void window.api.openWorkspace(conversationId, how, file).catch((e) => toast(String(e.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
}

export const FILES_LABEL = navigator.platform.toLowerCase().includes('mac') ? 'Finder' : 'File Explorer'

function ChangedFile({ change, folder, conversationId, open, onToggle, local }: { change: FileChange; folder: string; conversationId: string; open: boolean; onToggle: () => void; local: boolean }) {
  const name = shortPath(change.path, folder)
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  return (
    <div className={`change ${open ? 'open' : ''}`} data-testid="changed-file">
      <div className="change-head">
        <button type="button" className="change-toggle" aria-expanded={open} onClick={onToggle} title={change.path}>
          <span className={`side-chev ${open ? 'open' : ''}`}>
            <IconChevron size={12} />
          </span>
          <span className="change-name">{slash >= 0 ? name.slice(slash + 1) : name}</span>
          {slash >= 0 && <span className="change-dir">{name.slice(0, slash)}</span>}
          {change.created && !change.deleted && <span className="badge">new</span>}
          {change.deleted && <span className="badge">deleted</span>}
          <Counts added={change.added} removed={change.removed} />
        </button>
        {local && !change.deleted && (
          <span className="change-actions">
            <button type="button" className="icon-btn" title="Open in your code editor" onClick={() => openIn(conversationId, 'editor', change.path)}>
              <IconCode size={14} />
            </button>
            <button type="button" className="icon-btn" title={`Show in ${FILES_LABEL}`} onClick={() => openIn(conversationId, 'files', change.path)}>
              <IconFolder size={14} />
            </button>
          </span>
        )}
      </div>
      {open && (
        <div className="change-edits">
          {change.edits.map((d, i) => (
            <DiffView diff={d} head={false} key={i} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Every file the chat changed, beside the conversation, as the Changes view of a code editor. */
export function ChangesPanel({ conversationId, changes, local, onClose }: { conversationId: string; changes: FileChange[]; local: boolean; onClose: () => void }) {
  const [folder, setFolder] = useState('')
  const [shut, setShut] = useState<Set<string>>(new Set())
  useEffect(() => {
    void window.api.getWorkspace(conversationId).then(setFolder, () => setFolder(''))
  }, [conversationId])
  const added = changes.reduce((n, c) => n + c.added, 0)
  const removed = changes.reduce((n, c) => n + c.removed, 0)
  const toggle = (path: string) =>
    setShut((old) => {
      const next = new Set(old)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  return (
    <aside className="artifact-panel changes-panel" data-testid="changes-panel">
      <div className="artifact-head">
        <div className="artifact-heading">
          <div className="artifact-title">Changes</div>
          <div className="artifact-sub">
            {changes.length} {changes.length === 1 ? 'file' : 'files'} <Counts added={added} removed={removed} />
          </div>
        </div>
        <span className="topbar-spacer" />
        {local && (
          <>
            <button type="button" className="icon-btn" title="Open the folder in your code editor" data-testid="open-editor" onClick={() => openIn(conversationId, 'editor')}>
              <IconCode />
            </button>
            <button type="button" className="icon-btn" title={`Open the folder in ${FILES_LABEL}`} onClick={() => openIn(conversationId, 'files')}>
              <IconFolder />
            </button>
            <button type="button" className="icon-btn" title="Open a terminal in the folder" onClick={() => openIn(conversationId, 'terminal')}>
              <IconTerminal />
            </button>
          </>
        )}
        <button type="button" className="icon-btn" title="Close" data-testid="changes-close" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="artifact-body changes-body">
        {folder && (
          <div className="changes-folder" title={folder}>
            <bdi>{folder}</bdi>
          </div>
        )}
        {!changes.length && <div className="side-empty">No files changed in this chat yet.</div>}
        {changes.map((c) => (
          <ChangedFile key={c.path} change={c} folder={folder} conversationId={conversationId} local={local} open={!shut.has(c.path)} onToggle={() => toggle(c.path)} />
        ))}
      </div>
    </aside>
  )
}
