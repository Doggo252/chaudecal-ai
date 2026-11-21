import { useEffect, useMemo, useState } from 'react'
import { ARTIFACT_KIND_LABEL, artifactLabel, type ArtifactEntry, type ArtifactKind } from '@shared/artifacts'
import { chatShown, openChat, setState, useUi } from '../state'
import { IconArtifact, IconSearch } from '../icons'
import { whenAgo } from './ProjectView'

/** The groups the page can be narrowed to, like the kinds on Claude's Artifacts page. */
export const ARTIFACT_FILTERS: { id: string; label: string; kinds: ArtifactKind[] }[] = [
  { id: 'all', label: 'All', kinds: [] },
  { id: 'pages', label: 'Pages and components', kinds: ['html', 'react'] },
  { id: 'documents', label: 'Documents', kinds: ['markdown'] },
  { id: 'pictures', label: 'Images and diagrams', kinds: ['svg', 'mermaid'] },
  { id: 'code', label: 'Code', kinds: ['code'] }
]

/** The artifacts that match the search and the chosen kind. */
export function filterArtifacts(list: ArtifactEntry[], query: string, filter: string): ArtifactEntry[] {
  const kinds = ARTIFACT_FILTERS.find((f) => f.id === filter)?.kinds ?? []
  const q = query.trim().toLowerCase()
  return list.filter((a) => (!kinds.length || kinds.includes(a.kind)) && (!q || a.title.toLowerCase().includes(q) || a.conversationTitle.toLowerCase().includes(q)))
}

/** Every artifact from every chat in one place, like the Artifacts page on claude.ai. */
export function ArtifactsView() {
  const conversations = useUi((s) => s.app?.conversations)
  const show = useUi((s) => s.show)
  const [all, setAll] = useState<ArtifactEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')

  // Read again when chats change, so a new artifact shows up.
  useEffect(() => {
    let live = true
    void window.api.artifacts().then((list) => live && setAll(list))
    return () => {
      live = false
    }
  }, [conversations])

  const shown = useMemo(() => {
    const byId = new Map((conversations ?? []).map((c) => [c.id, c]))
    const visible = (all ?? []).filter((a) => {
      const c = byId.get(a.conversationId)
      return !!c && chatShown(c, show)
    })
    return filterArtifacts(visible, query, filter)
  }, [all, conversations, show, query, filter])

  const open = (a: ArtifactEntry) => {
    openChat(a.conversationId)
    setState({ artifact: { conversationId: a.conversationId, messageId: a.messageId, index: a.index } })
  }

  return (
    <>
      <header className="topbar drag">
        <span className="topbar-spacer" />
      </header>
      <div className="scroll">
        <div className="projects-page" data-testid="artifacts-page">
          <div className="projects-head">
            <h1>Artifacts</h1>
          </div>
          <div className="projects-kinds" role="tablist">
            {ARTIFACT_FILTERS.map((f) => (
              <button type="button" key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'on' : ''} data-testid={`artifacts-filter-${f.id}`} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
          <label className="projects-search">
            <IconSearch size={15} />
            <input placeholder="Search artifacts" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="artifacts-search" />
          </label>
          {all && !shown.length && (
            <div className="project-none" data-testid="artifacts-none">
              {query || filter !== 'all' ? 'No artifact matches.' : 'Pages, documents, diagrams and code that the assistants write show up here. Ask for one in any chat.'}
            </div>
          )}
          <div className="projects-grid">
            {shown.map((a) => (
              <button type="button" key={`${a.conversationId}:${a.messageId}:${a.index}`} className="projects-item artifacts-item" data-testid="artifacts-item" onClick={() => open(a)}>
                <span className={`artifacts-peek artifacts-peek-${a.look}`} aria-hidden="true">
                  {a.look === 'picture' ? <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(a.excerpt)}`} alt="" draggable={false} /> : a.excerpt}
                </span>
                <span className="projects-item-name">
                  <IconArtifact size={15} /> <span className="artifacts-title" title={a.title}>{artifactLabel(a.title)}</span>
                </span>
                <span className="projects-item-sub">
                  {ARTIFACT_KIND_LABEL[a.kind]}
                  {a.versions > 1 ? `, ${a.versions} versions` : ''}, {whenAgo(a.updatedAt).toLowerCase()}
                </span>
                <span className="projects-item-when">In {a.conversationTitle}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
