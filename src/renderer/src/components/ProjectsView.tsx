import { useMemo, useState } from 'react'
import { projectKindOf } from '@shared/types'
import { projectShown, setState, setTab, useUi } from '../state'
import { IconFolder, IconPin, IconPlus, IconSearch } from '../icons'
import { projectSubtitle, whenAgo } from './ProjectView'

/** Every project of the open tab, like the Projects page of the Claude app. */
export function ProjectsView() {
  const app = useUi((s) => s.app)
  const tab = useUi((s) => s.tab)
  const show = useUi((s) => s.show)
  const [query, setQuery] = useState('')
  const projects = useMemo(() => {
    const latest = new Map<string, number>()
    for (const c of app?.conversations ?? []) if (c.projectId) latest.set(c.projectId, Math.max(latest.get(c.projectId) ?? 0, c.updatedAt))
    const q = query.trim().toLowerCase()
    return (app?.projects ?? [])
      .filter((p) => projectKindOf(p) === tab && projectShown(p, show) && (!q || p.name.toLowerCase().includes(q)))
      .map((p) => ({ p, at: Math.max(latest.get(p.id) ?? 0, p.updatedAt), chats: (app?.conversations ?? []).filter((c) => c.projectId === p.id).length }))
      .sort((a, b) => Number(!!b.p.pinned) - Number(!!a.p.pinned) || b.at - a.at)
  }, [app?.projects, app?.conversations, tab, show, query])

  const create = () =>
    void window.api.saveProject({ name: 'New project', instructions: '', files: [], kind: tab }).then((projectId) => setState({ view: { kind: 'project', projectId } }))

  return (
    <>
      <header className="topbar drag">
        <span className="topbar-spacer" />
      </header>
      <div className="scroll">
        <div className="projects-page" data-testid="projects-page">
          <div className="projects-head">
            <h1>{tab === 'code' ? 'Code projects' : 'Projects'}</h1>
            <button type="button" className="btn btn-primary" data-testid="projects-new" onClick={create}>
              <IconPlus size={15} /> New project
            </button>
          </div>
          {show !== 'local' && (
            <div className="projects-kinds" role="tablist">
              <button type="button" className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
                Chat projects
              </button>
              <button type="button" className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}>
                Code projects
              </button>
            </div>
          )}
          <label className="projects-search">
            <IconSearch size={15} />
            <input placeholder="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="projects-search" />
          </label>
          {!projects.length && (
            <div className="project-none">
              {query ? 'No project has that name.' : tab === 'code' ? 'Code projects are folders on your computers. Chats that work in a folder land in its project.' : 'Projects keep chats, instructions and files together. Projects from claude.ai and chatgpt.com come in when you import.'}
            </div>
          )}
          <div className="projects-grid">
            {projects.map(({ p, at, chats }) => (
              <button type="button" key={p.id} className="projects-item" data-testid="projects-item" onClick={() => setState({ view: { kind: 'project', projectId: p.id } })}>
                <span className="projects-item-name">
                  <IconFolder size={15} /> {p.name} {p.pinned && <IconPin size={12} />}
                </span>
                <span className="projects-item-sub">{projectSubtitle(p)}</span>
                <span className="projects-item-when">
                  {chats} chat{chats === 1 ? '' : 's'}, updated {whenAgo(at).toLowerCase()}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
