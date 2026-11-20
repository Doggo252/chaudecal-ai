import { useMemo } from 'react'
import type { Conversation, ProviderId } from '@shared/types'
import { kindOf, PROVIDER_LABEL } from '@shared/types'
import { openChat, setState, setTab, toast, useUi } from '../state'
import { IconDownload, IconFolder, IconLock, IconPin, IconPlus, IconSearch, IconSettings } from '../icons'
import { Meter, ProviderDot } from './ui'

function groupLabel(ts: number, now: number): string {
  const day = 24 * 60 * 60 * 1000
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  if (ts >= startOfToday) return 'Today'
  if (ts >= startOfToday - day) return 'Yesterday'
  if (ts >= startOfToday - 7 * day) return 'Previous 7 days'
  if (ts >= startOfToday - 30 * day) return 'Previous 30 days'
  return 'Older'
}

export function Sidebar() {
  const app = useUi((s) => s.app)
  const view = useUi((s) => s.view)
  const asking = useUi((s) => s.approvals)
  const isMac = app?.platform === 'darwin'
  const tab = useUi((s) => s.tab)

  const groups = useMemo(() => {
    const now = Date.now()
    const list = (app?.conversations ?? []).filter((c) => kindOf(c) === tab).sort((a, b) => b.updatedAt - a.updatedAt)
    const out: { label: string; items: Conversation[] }[] = []
    const pinned = list.filter((c) => c.pinned)
    if (pinned.length) out.push({ label: 'Pinned', items: pinned })
    for (const c of list.filter((c) => !c.pinned)) {
      const label = groupLabel(c.updatedAt, now)
      const last = out[out.length - 1]
      if (last && last.label === label) last.items.push(c)
      else out.push({ label, items: [c] })
    }
    return out
  }, [app?.conversations, tab])

  if (!app) return <aside className="sidebar" />
  const busy = new Set(app.busy)
  const activeId = view.kind === 'chat' ? view.conversationId : undefined
  const hub = app.hub

  return (
    <aside className="sidebar">
      <div className="side-top drag">
        <div className="brand">Chaude</div>
        <div className="side-tabs no-drag" role="tablist" aria-label="Kind of chat">
          <button type="button" role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} data-testid="side-tab-chat" title="Regular chats on claude.ai and chatgpt.com" onClick={() => setTab('chat')}>
            Chats
          </button>
          <button type="button" role="tab" aria-selected={tab === 'code'} className={tab === 'code' ? 'on' : ''} data-testid="side-tab-code" title="Work and code chats that use this computer" onClick={() => setTab('code')}>
            Code
          </button>
        </div>
        <button type="button" className={`side-btn ${view.kind === 'chat' && !activeId ? 'active' : ''}`} data-testid="new-chat" onClick={() => openChat(undefined)}>
          <IconPlus /> {tab === 'chat' ? 'New chat' : 'New code chat'} <kbd>{isMac ? '⌘N' : 'Ctrl N'}</kbd>
        </button>
        <button type="button" className="side-btn" data-testid="open-search" onClick={() => setState({ dialog: { kind: 'search' } })}>
          <IconSearch /> Search chats <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
      </div>

      <nav className="side-list" aria-label="Conversations">
        <div className="side-group side-group-row">
          Projects
          <button
            type="button"
            className="icon-btn side-add"
            title="New project"
            data-testid="new-project"
            onClick={() =>
              void window.api.saveProject({ name: 'New project', instructions: '', files: [] }).then((projectId) => setState({ view: { kind: 'project', projectId } }))
            }
          >
            <IconPlus size={13} />
          </button>
        </div>
        {app.projects.map((p) => (
          <button type="button" key={p.id} className={`conv ${view.kind === 'project' && view.projectId === p.id ? 'active' : ''}`} data-testid="project" onClick={() => setState({ view: { kind: 'project', projectId: p.id }, sideOpen: false })} title={p.name}>
            <IconFolder size={14} />
            <span className="conv-title">{p.name}</span>
          </button>
        ))}
        {!groups.length && (
          <div className="side-empty">
            {tab === 'chat' ? 'Your chats from claude.ai and chatgpt.com, and new ones you start here, appear here.' : 'Chats that work on this computer with Claude Code, Codex or local AI appear here.'}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.label}>
            <div className="side-group">{g.label}</div>
            {g.items.map((c) => (
              <button type="button" key={c.id} className={`conv ${c.id === activeId ? 'active' : ''}`} data-testid="conversation" onClick={() => openChat(c.id)} title={c.title}>
                <span className={`conv-mark dot dot-${c.source?.service ?? (c.provider === 'chatgpt' ? 'chatgpt' : c.provider === 'local' ? 'local' : 'claude')}`} title={c.source ? (c.source.service === 'claude' ? 'From claude.ai' : 'From chatgpt.com') : PROVIDER_LABEL[c.provider === 'auto' ? 'claude' : c.provider]} />
                <span className="conv-title">{c.title}</span>
                {asking[c.id]?.length ? (
                  <span className="conv-ask" data-testid="conversation-asking" title="Waiting for your answer" />
                ) : (
                  busy.has(c.id) && <span className="spinner" />
                )}
                {c.private && (
                  <span className="conv-meta" title="Private: local AI only">
                    <IconLock size={13} />
                  </span>
                )}
                {c.pinned && (
                  <span className="conv-meta">
                    <IconPin size={13} />
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="side-bottom">
        <button type="button" className="usage-mini side-btn" style={{ display: 'grid' }} title="Open usage details" data-testid="usage-mini" onClick={() => setState({ view: { kind: 'settings', tab: 'usage' } })}>
          {(['claude', 'chatgpt'] as ProviderId[]).map((p) => {
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
