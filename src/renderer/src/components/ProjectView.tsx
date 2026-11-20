import { useEffect, useMemo, useState } from 'react'
import type { Attachment, Project } from '@shared/types'
import { estimateTokens, formatTokens } from '@shared/tokens'
import { getState, openChat, setState, toast, useUi } from '../state'
import { IconClose, IconFile, IconPlus } from '../icons'

/** Starts a new chat inside a project. */
export function newChatIn(projectId: string): void {
  // A project from claude.ai or chatgpt.com gets a regular chat there; the app's own projects get a code chat.
  const site = /^web-(claude|chatgpt)-p-/.exec(projectId)?.[1] as 'claude' | 'chatgpt' | undefined
  openChat(undefined)
  setState((s) => ({ tab: site ? 'chat' : s.tab, draft: { ...s.draft, projectId, ...(site ? { kind: 'chat' as const, provider: site, mode: 'chat' as const } : {}) } }))
}

/** A project's page: its instructions and files, and its chats. */
export function ProjectView({ projectId }: { projectId: string }) {
  const project = useUi((s) => s.app?.projects.find((p) => p.id === projectId))
  const conversations = useUi((s) => s.app?.conversations)
  const chats = useMemo(() => (conversations ?? []).filter((c) => c.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt), [conversations, projectId])
  const [name, setName] = useState(project?.name ?? '')
  const [instructions, setInstructions] = useState(project?.instructions ?? '')
  // Follow changes made elsewhere (another device, or another field here), but not while typing in the field.
  useEffect(() => {
    if (document.activeElement?.getAttribute('data-testid') !== 'project-name') setName(project?.name ?? '')
    if (document.activeElement?.getAttribute('data-testid') !== 'project-instructions') setInstructions(project?.instructions ?? '')
  }, [project?.id, project?.name, project?.instructions])
  if (!project) return null

  const save = (patch: Partial<Pick<Project, 'name' | 'instructions' | 'files'>>) => void window.api.saveProject({ id: project.id, ...patch })
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

  return (
    <>
      <header className="topbar drag">
        <span className="topbar-spacer" />
      </header>
      <div className="scroll">
        <div className="column project-page" data-testid="project-page">
          <input
            className="project-name"
            data-testid="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name.trim() !== project.name && save({ name: name.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <p className="lead">Every chat in this project gets its instructions and files, whichever assistant answers. Projects sync to your other devices.</p>

          <div className="group-title">Instructions</div>
          <textarea
            className="input project-instructions"
            data-testid="project-instructions"
            placeholder="For example: answer as a careful editor, use British spelling, and keep it short."
            value={instructions}
            rows={5}
            onChange={(e) => setInstructions(e.target.value)}
            onBlur={() => instructions !== project.instructions && save({ instructions })}
          />

          <div className="group-title">
            Files{project.files.length ? ` (about ${formatTokens(tokens)} tokens)` : ''}
          </div>
          <div className="group">
            {project.files.map((f) => (
              <div className="row" key={f.id} data-testid="project-file">
                <div className="row-main">
                  <div className="row-title">
                    <IconFile size={14} /> {f.name}
                  </div>
                  <div className="row-sub">{f.pages ? `${f.pages} pages, ` : ''}{formatTokens(estimateTokens(f.text ?? ''))} tokens</div>
                </div>
                <button type="button" className="icon-btn" title="Remove" onClick={() => save({ files: project.files.filter((x) => x.id !== f.id) })}>
                  <IconClose size={14} />
                </button>
              </div>
            ))}
            <div className="row">
              <div className="row-main">
                <div className="row-sub">Text files, documents and PDFs. Their text goes to the assistant with every message in this project.</div>
              </div>
              <button type="button" className="btn btn-small" data-testid="project-add-files" onClick={() => void addFiles()}>
                Add files
              </button>
            </div>
          </div>

          <div className="group-title project-chats-title">
            Chats
            <button type="button" className="btn btn-small btn-primary" data-testid="project-new-chat" onClick={() => newChatIn(project.id)}>
              <IconPlus size={14} /> New chat in this project
            </button>
          </div>
          <div className="group">
            {!chats.length && <div className="row row-sub">No chats yet.</div>}
            {chats.map((c) => (
              <button type="button" className="row project-chat" key={c.id} data-testid="project-chat" onClick={() => openChat(c.id)}>
                <span className="row-title">{c.title}</span>
                <span className="row-sub">{new Date(c.updatedAt).toLocaleDateString()}</span>
              </button>
            ))}
          </div>

          <button
            type="button"
            className="btn btn-small btn-danger project-delete"
            onClick={() => {
              if (confirm(`Delete the project "${project.name}"? Its chats stay, outside any project.`)) {
                void window.api.deleteProject(project.id)
                setState({ view: { kind: 'chat' } })
              }
            }}
          >
            Delete project
          </button>
        </div>
      </div>
    </>
  )
}
