import { useEffect, useMemo, useState } from 'react'
import type { Attachment, Project } from '@shared/types'
import { projectKindOf } from '@shared/types'
import { estimateTokens, formatTokens } from '@shared/tokens'
import { getState, openChat, setState, toast, useUi } from '../state'
import { IconChevron, IconClose, IconFile, IconPin, IconPlus } from '../icons'
import { MenuItem, Popover, ProviderDot } from './ui'

/** Starts a new chat inside a project, of the project's kind. */
export function newChatIn(projectId: string): void {
  const project = getState().app?.projects.find((p) => p.id === projectId)
  // A project from claude.ai or chatgpt.com gets a regular chat on that site.
  const site = /^web-(claude|chatgpt)-p-/.exec(projectId)?.[1] as 'claude' | 'chatgpt' | undefined
  const kind = project ? projectKindOf(project) : site ? 'chat' : getState().tab
  openChat(undefined)
  setState((s) => ({ tab: kind, draft: { ...s.draft, projectId, kind, ...(site ? { provider: site, mode: 'chat' as const } : {}) } }))
}

/** "Just now", "3 hours ago", "2 days ago", then the date. */
export function whenAgo(at: number, now = Date.now()): string {
  const min = Math.floor((now - at) / 60000)
  if (min < 1) return 'Just now'
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  const d = new Date(at)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

/** What a project is, in a few words, under its name. */
export function projectSubtitle(p: Project): string {
  if (p.id.startsWith('web-claude-p-')) return 'Project from claude.ai'
  if (p.id.startsWith('web-chatgpt-p-')) return 'Project from chatgpt.com'
  if (projectKindOf(p) === 'code') return p.folder ?? 'Code project'
  return 'Chat project'
}

/** A project's page, laid out like a project in the Claude app: its chats on the left, what it knows on the right. */
export function ProjectView({ projectId }: { projectId: string }) {
  const project = useUi((s) => s.app?.projects.find((p) => p.id === projectId))
  const conversations = useUi((s) => s.app?.conversations)
  const show = useUi((s) => s.show)
  const chats = useMemo(() => (conversations ?? []).filter((c) => c.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt), [conversations, projectId])
  const [name, setName] = useState(project?.name ?? '')
  const [instructions, setInstructions] = useState(project?.instructions ?? '')
  // Follow changes made elsewhere (another device, or another field here), but not while typing in the field.
  useEffect(() => {
    if (document.activeElement?.getAttribute('data-testid') !== 'project-name') setName(project?.name ?? '')
    if (document.activeElement?.getAttribute('data-testid') !== 'project-instructions') setInstructions(project?.instructions ?? '')
  }, [project?.id, project?.name, project?.instructions])
  if (!project) return null

  const kind = projectKindOf(project)
  const save = (patch: Partial<Pick<Project, 'name' | 'instructions' | 'files' | 'pinned'>>) => void window.api.saveProject({ id: project.id, ...patch })
  const addFiles = async () => {
    const res = await window.api.pickAttachments()
    const text = res.attachments.filter((a): a is Attachment => a.kind === 'text')
    const skipped = res.attachments.length - text.length
    // The files as they are now, not as they were when the picker opened.
    const current = getState().app?.projects.find((p) => p.id === projectId)?.files ?? []
    if (text.length) save({ files: [...current, ...text] })
    if (skipped) toast('Pictures cannot be project files. Attach them in a chat instead.')
    if (res.errors.length) toast(res.errors[0])
  }
  const tokens = project.files.reduce((n, f) => n + estimateTokens(f.text ?? ''), 0)
  const remove = () => {
    if (confirm(`Delete the project "${project.name}"? Its chats stay, outside any project.`)) {
      void window.api.deleteProject(project.id)
      setState({ view: { kind: 'projects' } })
    }
  }

  return (
    <>
      <header className="topbar drag">
        <div className="crumbs no-drag">
          <button type="button" className="crumb" data-testid="project-crumb" onClick={() => setState({ view: { kind: 'projects' } })}>
            Projects
          </button>
          <span className="crumb-sep">/</span>
          <Popover className="crumb crumb-here" testId="project-menu" label={<>{project.name} <IconChevron size={12} /></>}>
            {(close) => (
              <>
                <MenuItem
                  testId="project-pin"
                  onClick={() => {
                    save({ pinned: !project.pinned })
                    close()
                  }}
                >
                  <IconPin size={14} /> {project.pinned ? 'Unpin' : 'Pin to the sidebar'}
                </MenuItem>
                <MenuItem
                  testId="project-rename"
                  onClick={() => {
                    close()
                    const el = document.querySelector<HTMLInputElement>('[data-testid="project-name"]')
                    el?.focus()
                    el?.select()
                  }}
                >
                  Rename
                </MenuItem>
                <MenuItem danger testId="project-delete" onClick={() => (close(), remove())}>
                  Delete project
                </MenuItem>
              </>
            )}
          </Popover>
        </div>
        <span className="topbar-spacer" />
      </header>
      <div className="scroll">
        <div className="project-page" data-testid="project-page">
          <div className="project-main">
            <input
              className="project-name"
              data-testid="project-name"
              aria-label="Project name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name.trim() && name.trim() !== project.name && save({ name: name.trim() })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            <p className="project-sub">{projectSubtitle(project)}</p>

            <button type="button" className="project-start" data-testid="project-new-chat" onClick={() => newChatIn(project.id)}>
              <span>{kind === 'code' ? `New code chat in ${project.name}` : `New chat in ${project.name}`}</span>
              <span className="project-start-go">
                <IconPlus size={16} />
              </span>
            </button>

            <div className="project-recents">
              <div className="project-recents-title">Recents</div>
              {!chats.length && <div className="project-none">No chats yet. Start one above, or move a chat here from its menu.</div>}
              {chats.map((c) => (
                <button type="button" className="project-chat" key={c.id} data-testid="project-chat" onClick={() => openChat(c.id)}>
                  {show === 'all' && <ProviderDot provider={c.source?.service ?? c.provider} size={13} />}
                  <span className="project-chat-title">{c.title}</span>
                  <span className="project-chat-when">{whenAgo(c.updatedAt)}</span>
                </button>
              ))}
            </div>
          </div>

          <aside className="project-side">
            <section className="project-card">
              <div className="project-card-head">
                <span>Instructions</span>
              </div>
              <textarea
                className="project-instructions"
                data-testid="project-instructions"
                placeholder="How the assistant should work in this project. For example: answer as a careful editor, and keep it short."
                value={instructions}
                rows={4}
                onChange={(e) => setInstructions(e.target.value)}
                onBlur={() => instructions !== project.instructions && save({ instructions })}
              />
            </section>

            <section className="project-card">
              <div className="project-card-head">
                <span>Files</span>
                <span className="project-card-note">{project.files.length ? `${project.files.length} file${project.files.length === 1 ? '' : 's'}, about ${formatTokens(tokens)} tokens` : ''}</span>
                <button type="button" className="icon-btn" title="Add text files, documents and PDFs" data-testid="project-add-files" onClick={() => void addFiles()}>
                  <IconPlus size={15} />
                </button>
              </div>
              {!project.files.length && <div className="project-card-empty">Their text goes to the assistant with every message in this project.</div>}
              {project.files.map((f) => (
                <div className="project-file" key={f.id} data-testid="project-file" title={`${f.pages ? `${f.pages} pages, ` : ''}${formatTokens(estimateTokens(f.text ?? ''))} tokens`}>
                  <IconFile size={14} />
                  <span className="project-file-name">{f.name}</span>
                  <button type="button" className="icon-btn" title="Remove" onClick={() => save({ files: project.files.filter((x) => x.id !== f.id) })}>
                    <IconClose size={13} />
                  </button>
                </div>
              ))}
            </section>

            {kind === 'code' && (
              <section className="project-card">
                <div className="project-card-head">
                  <span>Folder</span>
                  <button
                    type="button"
                    className="btn btn-small"
                    data-testid="project-folder"
                    onClick={() => void window.api.pickProjectFolder(project.id).then((f) => f && toast(`New chats here work in ${f}`))}
                  >
                    {project.folder ? 'Change' : 'Choose'}
                  </button>
                </div>
                <div className="project-card-empty">{project.folder ?? 'New code chats in this project work in this folder on this computer.'}</div>
              </section>
            )}
          </aside>
        </div>
      </div>
    </>
  )
}
