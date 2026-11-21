import { useMemo, useState, type ReactNode } from 'react'
import type { Conversation, Project, ProviderId } from '@shared/types'
import { kindOf, PROVIDER_LABEL, projectKindOf } from '@shared/types'
import { chatShown, openChat, projectShown, setShow, setState, setTab, toast, useUi, type Show } from '../state'
import { IconChevron, IconDownload, IconFolder, IconLock, IconPlus, IconSearch, IconSettings, IconColumns } from '../icons'
import { MenuItem, Meter, Popover, ProviderDot } from './ui'
import { newChatIn } from './ProjectView'

/** How many chats an open project shows in the sidebar before "View all". */
const PROJECT_PEEK = 5
/** How many projects the Projects section shows before "All projects". */
const PROJECTS_SHOWN = 8

const CLOSED_KEY = 'chaude.side.closed'
const OPEN_KEY = 'chaude.side.open'

function readSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

/** Remembers which sections and projects are folded, across restarts. */
function useFolds(key: string): [Set<string>, (id: string) => void] {
  const [set, setSet] = useState(() => readSet(key))
  const toggle = (id: string) =>
    setSet((old) => {
      const next = new Set(old)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(key, JSON.stringify([...next]))
      } catch {
        // Remembering is a nicety.
      }
      return next
    })
  return [set, toggle]
}

export const SHOW_LABEL: Record<Show, string> = { all: 'Chaude', claude: 'Claude', chatgpt: 'ChatGPT', local: 'Local AI' }

/** The assistant a chat's icon shows. */
function markOf(c: Conversation) {
  return c.source?.service ?? c.provider
}

export function Sidebar() {
  const app = useUi((s) => s.app)
  const view = useUi((s) => s.view)
  const asking = useUi((s) => s.approvals)
  const tab = useUi((s) => s.tab)
  const show = useUi((s) => s.show)
  const isMac = app?.platform === 'darwin'
  const [closed, toggleClosed] = useFolds(CLOSED_KEY)
  const [opened, toggleOpened] = useFolds(OPEN_KEY)

  const chats = useMemo(() => (app?.conversations ?? []).filter((c) => kindOf(c) === tab && chatShown(c, show)).sort((a, b) => b.updatedAt - a.updatedAt), [app?.conversations, tab, show])
  // Projects of this tab, the most recently used first.
  const projects = useMemo(() => {
    const latest = new Map<string, number>()
    for (const c of chats) if (c.projectId && !latest.has(c.projectId)) latest.set(c.projectId, c.updatedAt)
    return (app?.projects ?? [])
      .filter((p) => projectKindOf(p) === tab && projectShown(p, show))
      .map((p) => ({ p, at: Math.max(latest.get(p.id) ?? 0, p.updatedAt) }))
      .sort((a, b) => b.at - a.at)
      .map((x) => x.p)
  }, [app?.projects, chats, tab, show])

  if (!app) return <aside className="sidebar" />
  const busy = new Set(app.busy)
  const activeId = view.kind === 'chat' ? view.conversationId : undefined
  const hub = app.hub
  const marks = show === 'all'
  const chatsIn = (projectId: string) => chats.filter((c) => c.projectId === projectId)
  const openProject = (projectId: string) => setState({ view: { kind: 'project', projectId }, sideOpen: false })

  const row = (c: Conversation, nested?: boolean) => (
    <button type="button" key={c.id} className={`conv ${nested ? 'conv-nested' : ''} ${c.id === activeId ? 'active' : ''}`} data-testid={nested ? 'project-side-chat' : 'conversation'} onClick={() => openChat(c.id)} title={c.title}>
      {marks && (
        <span className="conv-mark" title={c.source ? (c.source.service === 'claude' ? 'From claude.ai' : 'From chatgpt.com') : c.provider === 'auto' ? 'Auto picks the assistant' : PROVIDER_LABEL[c.provider]}>
          <ProviderDot provider={markOf(c)} size={13} />
        </span>
      )}
      <span className="conv-title">{c.title}</span>
      {asking[c.id]?.length ? <span className="conv-ask" data-testid="conversation-asking" title="Waiting for your answer" /> : busy.has(c.id) && <span className="spinner" />}
      {c.private && (
        <span className="conv-meta" title="Private: local AI only">
          <IconLock size={13} />
        </span>
      )}
    </button>
  )

  /** A project that opens in place to show its latest chats, as in the Claude and ChatGPT apps. */
  const projectRow = (p: Project, open: boolean, toggle: () => void) => {
    const inside = chatsIn(p.id)
    return (
      <div key={p.id} className="side-project">
        <div className={`conv side-project-head ${view.kind === 'project' && view.projectId === p.id ? 'active' : ''}`}>
          <button type="button" className="side-fold" title={open ? 'Hide its chats' : 'Show its chats'} aria-expanded={open} data-testid="project-fold" onClick={toggle}>
            <span className={`side-chev ${open ? 'open' : ''}`}>
              <IconChevron size={12} />
            </span>
            <IconFolder size={14} />
          </button>
          <button type="button" className="side-project-name" data-testid="project" title={p.name} onClick={() => openProject(p.id)}>
            {p.name}
          </button>
          <button type="button" className="icon-btn side-add side-hover" title={`New chat in ${p.name}`} data-testid="project-side-new" onClick={() => newChatIn(p.id)}>
            <IconPlus size={13} />
          </button>
        </div>
        {open && (
          <div className="side-nest">
            {inside.slice(0, PROJECT_PEEK).map((c) => row(c, true))}
            {!inside.length && <div className="side-empty side-empty-small">No chats yet</div>}
            {inside.length > PROJECT_PEEK && (
              <button type="button" className="conv conv-nested side-more" onClick={() => openProject(p.id)}>
                View all {inside.length}
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  const newProject = () =>
    void window.api.saveProject({ name: 'New project', instructions: '', files: [], kind: tab }).then((projectId) => setState({ view: { kind: 'project', projectId }, sideOpen: false }))

  const section = (id: string, label: string, children: ReactNode, extra?: ReactNode) => {
    const isClosed = closed.has(id)
    return (
      <div className="side-section" key={id}>
        <div className="side-group side-group-row">
          <button type="button" className="side-section-head" aria-expanded={!isClosed} data-testid={`section-${id}`} onClick={() => toggleClosed(id)}>
            {label}
            <span className={`side-chev ${isClosed ? '' : 'open'}`}>
              <IconChevron size={11} />
            </span>
          </button>
          {extra}
        </div>
        {!isClosed && children}
      </div>
    )
  }

  const pinnedProjects = projects.filter((p) => p.pinned)
  const pinnedChats = chats.filter((c) => c.pinned)
  const empty = (
    <div className="side-empty">
      {tab === 'chat' ? 'Your chats from claude.ai and chatgpt.com, and new ones you start here, appear here.' : 'Chats that work on this computer with Claude Code, Codex or local AI appear here, sorted by folder.'}
    </div>
  )
  const addProject = (
    <button type="button" className="icon-btn side-add" title={tab === 'code' ? 'New code project' : 'New project'} data-testid="new-project" onClick={newProject}>
      <IconPlus size={13} />
    </button>
  )

  let list: ReactNode
  if (tab === 'chat') {
    const others = projects.filter((p) => !p.pinned)
    list = (
      <>
        {(pinnedProjects.length > 0 || pinnedChats.length > 0) &&
          section(
            'pinned',
            'Pinned',
            <>
              {pinnedProjects.map((p) => projectRow(p, !closed.has(`pin:${p.id}`), () => toggleClosed(`pin:${p.id}`)))}
              {pinnedChats.map((c) => row(c))}
            </>
          )}
        {section(
          'projects',
          'Projects',
          <>
            {others.slice(0, PROJECTS_SHOWN).map((p) => projectRow(p, opened.has(p.id), () => toggleOpened(p.id)))}
            {!others.length && <div className="side-empty side-empty-small">No projects yet</div>}
            {others.length > PROJECTS_SHOWN && (
              <button type="button" className="conv side-more" data-testid="all-projects" onClick={() => setState({ view: { kind: 'projects' }, sideOpen: false })}>
                All {others.length} projects
              </button>
            )}
          </>,
          addProject
        )}
        {section('recents', 'Recents', chats.filter((c) => !c.pinned).length ? chats.filter((c) => !c.pinned).map((c) => row(c)) : empty)}
      </>
    )
  } else {
    // The Code tab lists chats by folder, the way the Claude Code app does.
    const codeIds = new Set(projects.map((p) => p.id))
    const loose = chats.filter((c) => !c.pinned && (!c.projectId || !codeIds.has(c.projectId)))
    list = (
      <>
        {pinnedChats.length > 0 && section('code-pinned', 'Pinned', pinnedChats.map((c) => row(c)))}
        {section(
          'folders',
          'Projects',
          <>
            {[...pinnedProjects, ...projects.filter((p) => !p.pinned)].map((p) => {
              const isClosed = closed.has(`f:${p.id}`)
              const inside = chatsIn(p.id).filter((c) => !c.pinned)
              return (
                <div key={p.id} className="side-folder" data-testid="code-folder">
                  <div className={`conv side-project-head ${view.kind === 'project' && view.projectId === p.id ? 'active' : ''}`}>
                    <button type="button" className="side-fold" aria-expanded={!isClosed} title={isClosed ? 'Show its chats' : 'Hide its chats'} onClick={() => toggleClosed(`f:${p.id}`)}>
                      <span className={`side-chev ${isClosed ? '' : 'open'}`}>
                        <IconChevron size={12} />
                      </span>
                      <IconFolder size={14} />
                    </button>
                    <button type="button" className="side-project-name" data-testid="project" title={p.folder ?? p.name} onClick={() => openProject(p.id)}>
                      {p.name}
                    </button>
                    <button type="button" className="icon-btn side-add side-hover" title={`New code chat in ${p.name}`} data-testid="project-side-new" onClick={() => newChatIn(p.id)}>
                      <IconPlus size={13} />
                    </button>
                  </div>
                  {!isClosed && (
                    <div className="side-nest">
                      {inside.slice(0, 10).map((c) => row(c))}
                      {!inside.length && <div className="side-empty side-empty-small">No chats yet</div>}
                      {inside.length > 10 && (
                        <button type="button" className="conv conv-nested side-more" onClick={() => openProject(p.id)}>
                          View all {inside.length}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {loose.length > 0 && (
              <div className="side-folder" data-testid="code-folder-none">
                <div className="conv side-project-head">
                  <button type="button" className="side-fold side-fold-wide" aria-expanded={!closed.has('f:none')} onClick={() => toggleClosed('f:none')}>
                    <span className={`side-chev ${closed.has('f:none') ? '' : 'open'}`}>
                      <IconChevron size={12} />
                    </span>
                    <IconColumns size={14} />
                    <span className="side-project-name">No folder</span>
                  </button>
                </div>
                {!closed.has('f:none') && <div className="side-nest">{loose.map((c) => row(c))}</div>}
              </div>
            )}
            {!chats.length && !projects.length && empty}
          </>,
          addProject
        )}
      </>
    )
  }

  return (
    <aside className="sidebar">
      <div className="side-top drag">
        <div className="no-drag brand-row">
          <Popover
            className="brand brand-btn"
            testId="show-picker"
            title="Show every assistant, or one only"
            label={
              <>
                {show !== 'all' && <ProviderDot provider={show} size={15} />}
                {SHOW_LABEL[show]} <IconChevron size={13} />
              </>
            }
          >
            {(close) => (
              <>
                {(['all', 'claude', 'chatgpt', 'local'] as Show[]).map((s) => (
                  <MenuItem
                    key={s}
                    selected={show === s}
                    testId={`show-${s}`}
                    hint={s === 'all' ? 'Claude, ChatGPT and local AI together' : s === 'local' ? 'Only chats with AI that runs on this computer' : `Only ${PROVIDER_LABEL[s]} chats, as if this were the ${PROVIDER_LABEL[s]} app`}
                    onClick={() => {
                      setShow(s)
                      close()
                    }}
                  >
                    {s !== 'all' && <ProviderDot provider={s} />} {s === 'all' ? 'All assistants' : `${PROVIDER_LABEL[s]} only`}
                  </MenuItem>
                ))}
              </>
            )}
          </Popover>
        </div>
        {show !== 'local' && (
          <div className="side-tabs no-drag" role="tablist" aria-label="Kind of chat">
            <button type="button" role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} data-testid="side-tab-chat" title="Regular chats on claude.ai and chatgpt.com" onClick={() => setTab('chat')}>
              Chats
            </button>
            <button type="button" role="tab" aria-selected={tab === 'code'} className={tab === 'code' ? 'on' : ''} data-testid="side-tab-code" title="Work and code chats that use this computer" onClick={() => setTab('code')}>
              Code
            </button>
          </div>
        )}
        <button type="button" className={`side-btn ${view.kind === 'chat' && !activeId ? 'active' : ''}`} data-testid="new-chat" onClick={() => openChat(undefined)}>
          <IconPlus /> {tab === 'chat' ? 'New chat' : 'New code chat'} <kbd>{isMac ? '⌘N' : 'Ctrl N'}</kbd>
        </button>
        <button type="button" className="side-btn" data-testid="open-search" onClick={() => setState({ dialog: { kind: 'search' } })}>
          <IconSearch /> Search <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <button type="button" className={`side-btn ${view.kind === 'projects' ? 'active' : ''}`} data-testid="open-projects" onClick={() => setState({ view: { kind: 'projects' }, sideOpen: false })}>
          <IconFolder /> Projects
        </button>
      </div>

      <nav className="side-list" aria-label="Conversations">
        {list}
      </nav>

      <div className="side-bottom">
        <button type="button" className="usage-mini side-btn" style={{ display: 'grid' }} title="Open usage details" data-testid="usage-mini" onClick={() => setState({ view: { kind: 'settings', tab: 'usage' } })}>
          {(['claude', 'chatgpt'] as ProviderId[])
            .filter((p) => show === 'all' || show === p)
            .map((p) => {
              const w = app.usage[p].fiveHour
              return (
                <span className="usage-row" key={p}>
                  <span className="usage-name">
                    <ProviderDot provider={p} /> {PROVIDER_LABEL[p]}
                  </span>
                  <Meter window={w} compact />
                  <span className="pct">{typeof w.usedPct === 'number' ? `${Math.round(w.usedPct)}%` : w.status === 'exhausted' ? 'full' : w.status === 'warning' ? 'low' : ''}</span>
                </span>
              )
            })}
        </button>

        {hub.role !== 'off' && (
          <div className="hub-line" title={hub.detail}>
            <span className={`status ${hub.connected ? 'on' : 'off'}`} />
            {hub.role === 'host' ? 'Hub is running here' : hub.connected ? 'Synced with hub' : 'Hub offline'}
            {hub.pending > 0 && ` (${hub.pending} waiting)`}
          </div>
        )}

        {app.update && <UpdateChip />}

        <button type="button" className={`side-btn ${view.kind === 'settings' ? 'active' : ''}`} data-testid="open-settings" onClick={() => setState({ view: { kind: 'settings' } })}>
          <IconSettings /> Settings
        </button>
      </div>
    </aside>
  )
}

/** Says a newer version is out, and installs it where this machine can. */
function UpdateChip() {
  const u = useUi((x) => x.app!.update!)
  const version = `version ${u.version}, build ${u.build}`
  const openPage = () => void window.api.openExternal(u.url)
  const install = () =>
    void window.api.applyUpdate().then((r) => {
      if (r.error) toast(r.error)
    })
  if (u.state === 'downloading') {
    return (
      <button type="button" className="side-btn update-chip" data-testid="update-chip" data-state="downloading" title={`Downloading ${version}.`} disabled>
        <IconDownload /> Downloading update {Math.round((u.progress ?? 0) * 100)}%
      </button>
    )
  }
  if (u.state === 'ready') {
    return (
      <button type="button" className="side-btn update-chip" data-testid="update-chip" data-state="ready" title={`The new ${version} is downloaded. Restarts the app to install it.`} onClick={install}>
        <IconDownload /> Restart to update
      </button>
    )
  }
  if (u.canInstall && u.state !== 'error') {
    return (
      <button type="button" className="side-btn update-chip" data-testid="update-chip" data-state="available" title={`New ${version}. Downloads and installs it, then restarts the app.`} onClick={install}>
        <IconDownload /> Update to {u.version}
      </button>
    )
  }
  return (
    <button type="button" className="side-btn update-chip" data-testid="update-chip" data-state={u.state ?? 'available'} title={`New ${version}. ${u.message ? `${u.message} ` : ''}Opens the download page.`} onClick={openPage}>
      <IconDownload /> Update available
    </button>
  )
}
