import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Conversation, McpServer, Message } from '@shared/types'
import { kindOf, PROVIDER_LABEL } from '@shared/types'
import { collectArtifacts, ARTIFACT_KIND_LABEL, artifactLabel } from '@shared/artifacts'
import { formatTokens } from '@shared/tokens'
import type { FileChange } from '@shared/diff'
import { closeArtifact, PANEL_COVERS } from './ArtifactPanel'
import { setState, useUi } from '../state'
import { IconArtifact, IconChevron, IconClose, IconCode, IconComputer, IconDiff, IconFolder, IconGlobe, IconTerminal } from '../icons'
import { Counts, currentPlanMessage, shortModel } from './Messages'
import { FILES_LABEL, openIn } from './ChangesPanel'

const OPEN_KEY = 'chaude-details-open'
const NO_SERVERS: McpServer[] = []

/** Whether the details panel is open, remembered between launches. */
export function useDetailsOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === '1')
  const set = (next: boolean) => {
    localStorage.setItem(OPEN_KEY, next ? '1' : '0')
    setOpen(next)
  }
  return [open, set]
}

/** The chat's folder on this computer, for a code chat. */
export function useWorkspace(conversationId: string | undefined, enabled: boolean): string {
  const [folder, setFolder] = useState('')
  useEffect(() => {
    setFolder('')
    if (!conversationId || !enabled) return
    let live = true
    void window.api.getWorkspace(conversationId).then(
      (f) => live && setFolder(f),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [conversationId, enabled])
  return folder
}

/** A small ring that fills as the chat uses more of what the model can read at once. */
export function ContextRing({ percent, size = 16 }: { percent: number; size?: number }) {
  const p = Math.max(0, Math.min(100, percent))
  const tone = p >= 90 ? 'bad' : p >= 70 ? 'warn' : 'ok'
  const mid = size / 2
  // A thin outline with a filled slice inside reads as "this full", where a thin arc on its own looks like a spinner.
  const big = size > 24
  const outer = mid - (big ? 2 : 1)
  const inner = outer - (big ? 4 : 2.25)
  const a = (p / 100) * 2 * Math.PI
  const slice =
    p <= 0
      ? undefined
      : p >= 100
        ? undefined
        : `M ${mid} ${mid} L ${mid} ${mid - inner} A ${inner} ${inner} 0 ${p > 50 ? 1 : 0} 1 ${mid + inner * Math.sin(a)} ${mid - inner * Math.cos(a)} Z`
  return (
    <svg className={`ctx-ring ${tone}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={mid} cy={mid} r={outer} className="ctx-ring-track" strokeWidth={big ? 2 : 1.3} />
      {slice && <path d={slice} className="ctx-ring-fill" />}
      {p >= 100 && <circle cx={mid} cy={mid} r={inner} className="ctx-ring-fill" />}
    </svg>
  )
}

function Section({ title, count, children, start = true }: { title: string; count?: number; children: ReactNode; start?: boolean }) {
  const [open, setOpen] = useState(start)
  return (
    <section className={`details-section ${open ? 'open' : ''}`}>
      <button type="button" className="details-section-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{title}</span>
        {count !== undefined && <span className="details-count">{count}</span>}
        <span className="topbar-spacer" />
        <span className={`side-chev ${open ? 'open' : ''}`}>
          <IconChevron size={12} />
        </span>
      </button>
      {open && <div className="details-section-body">{children}</div>}
    </section>
  )
}

function Row({ icon, label, value, title }: { icon?: ReactNode; label: string; value: ReactNode; title?: string }) {
  return (
    <div className="details-row" title={title}>
      {icon && <span className="details-icon">{icon}</span>}
      <span className="details-label">{label}</span>
      <span className="details-value">{value}</span>
    </div>
  )
}

/** Everything about the chat at a glance, beside it: memory, tasks, where it runs, tool servers and what it made. */
export function DetailsPanel({
  conversation,
  messages,
  contextTokens,
  windowTokens,
  changes,
  folder,
  onThisComputer,
  onOpenChanges,
  onClose
}: {
  conversation: Conversation
  messages: Message[]
  contextTokens: number
  windowTokens: number
  changes: FileChange[]
  folder: string
  onThisComputer: boolean
  onOpenChanges: () => void
  onClose: () => void
}) {
  const mcp = useUi((s) => s.app?.mcp ?? NO_SERVERS)
  const deviceId = useUi((s) => s.app?.deviceId ?? '')
  const settings = useUi((s) => s.app?.settings)
  const code = kindOf(conversation) === 'code'
  const web = kindOf(conversation) === 'chat'
  const percent = Math.min(100, Math.round((contextTokens / Math.max(1, windowTokens)) * 100))
  const artifacts = useMemo(() => collectArtifacts(messages), [messages])
  const plan = currentPlanMessage(messages)?.plan ?? []
  const live = messages.some((m) => m.status === 'streaming')
  const lastAnswer = [...messages].reverse().find((m) => m.role === 'assistant' && m.model)
  const provider = conversation.private ? 'local' : conversation.provider !== 'auto' ? conversation.provider : lastAnswer?.provider
  const model = lastAnswer?.model || (provider && settings ? settings[provider]?.defaultModel : '')
  const servers = mcp.filter((s) => s.enabled)
  const added = changes.reduce((n, c) => n + c.added, 0)
  const removed = changes.reduce((n, c) => n + c.removed, 0)

  const openArtifact = (messageId: string, index: number) => {
    setState({ artifact: { conversationId: conversation.id, messageId, index } })
    if (matchMedia(PANEL_COVERS).matches) onClose()
  }

  return (
    <aside className="details-panel" data-testid="details-panel">
      <div className="artifact-head">
        <div className="artifact-heading">
          <div className="artifact-title">Details</div>
        </div>
        <span className="topbar-spacer" />
        <button type="button" className="icon-btn" title="Close" data-testid="details-close" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="details-body">
        {!web && (
          <Section title="Context">
            <div className="details-meter">
              <ContextRing percent={percent} size={40} />
              <div>
                <div className="details-big">{percent}% used</div>
                <div className="details-small">
                  About {formatTokens(contextTokens)} of {formatTokens(windowTokens)} tokens. Past that, Chaude sends a summary of the older part.
                </div>
              </div>
            </div>
          </Section>
        )}

        {plan.length > 0 && (
          <Section title="Tasks" count={plan.length}>
            <ul className="details-tasks" data-testid="details-tasks">
              {plan.map((s, i) => (
                // A step left going in a finished chat does not spin.
                <li key={i} className={s.status === 'active' && !live ? 'pending' : s.status}>
                  <span className="details-check" aria-hidden />
                  <span>{s.text}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="Environment">
          {provider && <Row label="Assistant" value={`${PROVIDER_LABEL[provider]}${model ? ` · ${shortModel(model)}` : ''}`} />}
          <Row
            icon={web ? <IconGlobe size={14} /> : <IconComputer size={14} />}
            label="Runs on"
            value={web ? (conversation.source?.service === 'chatgpt' || conversation.provider === 'chatgpt' ? 'chatgpt.com' : 'claude.ai') : conversation.runOnHub ? 'Your hub' : 'This computer'}
          />
          {code && folder && (
            <>
              <Row icon={<IconFolder size={14} />} label="Folder" value={folder.split(/[\\/]/).filter(Boolean).pop() ?? folder} title={folder} />
              {onThisComputer && (
                <div className="details-actions">
                  <button type="button" className="chip" onClick={() => openIn(conversation.id, 'editor')}>
                    <IconCode size={14} /> Editor
                  </button>
                  <button type="button" className="chip" onClick={() => openIn(conversation.id, 'files')}>
                    <IconFolder size={14} /> {FILES_LABEL}
                  </button>
                  <button type="button" className="chip" onClick={() => openIn(conversation.id, 'terminal')}>
                    <IconTerminal size={14} /> Terminal
                  </button>
                </div>
              )}
            </>
          )}
        </Section>

        {!web && (
          <Section title="Connectors" count={servers.length}>
            {!mcp.length && <div className="details-small">No tool servers yet. Add one so the assistants can use your other apps.</div>}
            {mcp.map((s) => {
              const on = s.enabled && !s.offOn.includes(deviceId)
              return (
                <div className="details-row" key={s.id} title={s.kind === 'url' ? s.url : s.command}>
                  <span className={`details-dot ${on ? 'on' : ''}`} aria-hidden />
                  <span className="details-label strong">{s.name}</span>
                  <span className="details-value">{on ? (s.trusted ? 'Runs without asking' : 'Asks first') : 'Off'}</span>
                </div>
              )
            })}
            <button type="button" className="details-link" onClick={() => setState({ view: { kind: 'settings', tab: 'tools' } })}>
              Manage tool servers
            </button>
          </Section>
        )}

        <Section title="Outputs" count={artifacts.length + changes.length}>
          {!artifacts.length && !changes.length && <div className="details-small">Artifacts and changed files from this chat show up here.</div>}
          {artifacts.map((a) => {
            const v = a.versions[a.versions.length - 1]
            return (
              <button type="button" className="details-output" key={a.key} data-testid="details-artifact" onClick={() => openArtifact(v.messageId, v.index)}>
                <span className="details-icon">
                  <IconArtifact size={14} />
                </span>
                <span className="details-output-name" title={a.title}>{artifactLabel(a.title)}</span>
                <span className="details-value">
                  {ARTIFACT_KIND_LABEL[v.kind]}
                  {a.versions.length > 1 ? ` · v${a.versions.length}` : ''}
                </span>
              </button>
            )
          })}
          {changes.length > 0 && (
            <button
              type="button"
              className="details-output"
              data-testid="details-changes"
              onClick={() => {
                closeArtifact()
                onOpenChanges()
              }}
            >
              <span className="details-icon">
                <IconDiff size={14} />
              </span>
              <span className="details-output-name">
                {changes.length} changed {changes.length === 1 ? 'file' : 'files'}
              </span>
              <Counts added={added} removed={removed} />
            </button>
          )}
        </Section>
      </div>
    </aside>
  )
}
