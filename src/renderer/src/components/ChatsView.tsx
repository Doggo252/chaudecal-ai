import { useMemo, useState } from 'react'
import { kindOf, type Conversation } from '@shared/types'
import { chatShown, openChat, setTab, useUi } from '../state'
import { IconArchive, IconPlus, IconSearch } from '../icons'
import { ProviderDot } from './ui'
import { whenAgo } from './ProjectView'

/** Chats of one kind whose title matches, the most recent first: the archived ones, or the rest. */
export function filterChats(conversations: Conversation[], kind: 'chat' | 'code', query: string, shown: (c: Conversation) => boolean, archived = false): Conversation[] {
  const q = query.trim().toLowerCase()
  return conversations.filter((c) => kindOf(c) === kind && !!c.archived === archived && shown(c) && (!q || c.title.toLowerCase().includes(q))).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** All your chats in one list, like the Chats page on claude.ai. */
export function ChatsView() {
  const conversations = useUi((s) => s.app?.conversations)
  const projects = useUi((s) => s.app?.projects)
  const tab = useUi((s) => s.tab)
  const show = useUi((s) => s.show)
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  const chats = useMemo(() => filterChats(conversations ?? [], tab, query, (c) => chatShown(c, show), archived), [conversations, tab, show, query, archived])
  const archivedCount = useMemo(() => filterChats(conversations ?? [], tab, '', (c) => chatShown(c, show), true).length, [conversations, tab, show])
  const projectName = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p.name])), [projects])

  return (
    <>
      <header className="topbar drag">
        <span className="topbar-spacer" />
      </header>
      <div className="scroll">
        <div className="projects-page" data-testid="chats-page">
          <div className="projects-head">
            <h1>{tab === 'code' ? 'Code chats' : 'Chats'}</h1>
            <button type="button" className="btn btn-primary" data-testid="chats-new" onClick={() => openChat(undefined)}>
              <IconPlus size={15} /> New chat
            </button>
          </div>
          {show !== 'local' && (
            <div className="projects-kinds" role="tablist">
              <button type="button" className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
                Chats
              </button>
              <button type="button" className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}>
                Code
              </button>
            </div>
          )}
          <label className="projects-search">
            <IconSearch size={15} />
            <input placeholder="Search your chats" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="chats-search" />
          </label>
          <div className="chats-count">
            {chats.length} {archived ? 'archived ' : ''}chat{chats.length === 1 ? '' : 's'}
            {(archivedCount > 0 || archived) && (
              <button type="button" className="link-btn" data-testid="chats-archived" onClick={() => setArchived(!archived)}>
                {archived ? 'Back to your chats' : `Archived (${archivedCount})`}
              </button>
            )}
          </div>
          {!chats.length && <div className="project-none">{query ? 'No chat has that title. Search (Ctrl K or ⌘K) also looks inside chats.' : archived ? 'No archived chats.' : 'No chats yet.'}</div>}
          <div className="chats-list">
            {chats.map((c) => (
              <div key={c.id} className="chats-row-wrap">
              <button type="button" className="chats-row" data-testid="chats-item" onClick={() => openChat(c.id)}>
                {show === 'all' && <ProviderDot provider={c.source?.service ?? c.provider} size={14} />}
                <span className="chats-row-title">{c.title}</span>
                <span className="chats-row-when">
                  {c.projectId && projectName.get(c.projectId) ? `${projectName.get(c.projectId)}, ` : ''}
                  {whenAgo(c.updatedAt)}
                </span>
              </button>
              <button type="button" className="icon-btn chats-row-action" title={c.archived ? 'Unarchive' : 'Archive'} data-testid="chats-archive" onClick={() => void window.api.updateConversation(c.id, { archived: !c.archived })}>
                <IconArchive size={14} />
              </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
