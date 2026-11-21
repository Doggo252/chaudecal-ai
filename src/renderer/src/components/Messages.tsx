import { createContext, memo, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { parseForm } from '@shared/forms'
import { ChatFormView } from './ChatForm'
import type { ApprovalDecision, ApprovalRequest, Message, PermissionDenial, PlanStep, ProviderId, ToolCall } from '@shared/types'
import type { FileDiff } from '@shared/diff'
import { groupSteps, type StepGroup } from '@shared/steps'
import { artifactBlocks, formBlocks } from '@shared/artifacts'

const hasArtifact = (text: string) => /```|~~~/.test(text) && artifactBlocks(text).length > 0
import { PROVIDER_LABEL } from '@shared/types'
import { renderMarkdown } from '../markdown'
import { setState, toast } from '../state'
import { IconBranch, IconCheck, IconCopy, IconEdit, IconOpinion, IconRetry, IconSwitch } from '../icons'
import { ProviderDot } from './ui'
import { AttachmentList, GeneratedImages } from './Attachments'
import { ReadAloudButton } from './Speech'
import { Working } from './Working'

function shortModel(model?: string): string {
  if (!model) return ''
  const m = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

const Prose = memo(function Prose({ text, answerable = false }: { text: string; answerable?: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  const forms = useMemo(() => formBlocks(text).map((b) => (b ? parseForm(b.json, b.title) : undefined)), [text])
  const box = useRef<HTMLDivElement>(null)
  // Forms are drawn into the places the reply's markdown left for them.
  const [slots, setSlots] = useState<HTMLElement[]>([])
  useLayoutEffect(() => {
    setSlots(box.current ? [...box.current.querySelectorAll<HTMLElement>('.chat-form-slot')] : [])
  }, [html])
  return (
    <>
      <div className="prose" ref={box} dangerouslySetInnerHTML={{ __html: html }} />
      {slots.map((el, i) => (forms[i] ? createPortal(<ChatFormView form={forms[i]!} answerable={answerable} />, el, `form-${i}`) : null))}
    </>
  )
})

function Counts({ added, removed }: { added: number; removed: number }) {
  if (!added && !removed) return null
  return (
    <span className="diff-counts">
      {added > 0 && <span className="diff-plus">+{added}</span>}
      {removed > 0 && <span className="diff-minus">−{removed}</span>}
    </span>
  )
}

function DiffView({ diff, head }: { diff: FileDiff; head: boolean }) {
  return (
    <div className="diff" data-testid="diff">
      {head && (
      <div className="diff-head">
        <span className="diff-path">{diff.path}</span>
        {diff.created && <span className="badge">new file</span>}
        {diff.deleted && <span className="badge">deleted</span>}
        <Counts added={diff.added} removed={diff.removed} />
      </div>
      )}
      <div className="diff-lines">
        {diff.lines.map((l, i) =>
          l.t === '@' ? (
            <div className="diff-gap" key={i}>
              ⋯
            </div>
          ) : (
            <div className={`diff-line ${l.t === '+' ? 'add' : l.t === '-' ? 'del' : ''}`} key={i}>
              <span className="diff-sign">{l.t === ' ' ? '' : l.t === '-' ? '−' : '+'}</span>
              <span className="diff-text">{l.s || ' '}</span>
            </div>
          )
        )}
        {diff.added + diff.removed > diff.lines.filter((l) => l.t === '+' || l.t === '-').length && <div className="diff-gap">The rest of this change is not shown.</div>}
      </div>
    </div>
  )
}

function ToolRow({ t }: { t: ToolCall }) {
  const added = (t.diff ?? []).reduce((a, d) => a + d.added, 0)
  const removed = (t.diff ?? []).reduce((a, d) => a + d.removed, 0)
  return (
    <details className="tool" data-testid="tool-row" data-kind={t.kind ?? 'other'}>
      <summary>
        <span className="tool-name">{t.name}</span>
        <span className="tool-summary">{t.summary}</span>
        <Counts added={added} removed={removed} />
        {t.status === 'running' ? <span className="spinner" /> : <span className={`tool-state ${t.status}`}>{t.status === 'done' ? '' : t.status === 'denied' ? 'not allowed' : 'failed'}</span>}
      </summary>
      {t.diff?.map((d, i) => <DiffView diff={d} key={i} head={(t.diff?.length ?? 0) > 1 || !!d.created || !!d.deleted} />)}
      {t.output && <pre>{t.output}</pre>}
    </details>
  )
}

function Group({ g }: { g: StepGroup }) {
  if (g.tools.length === 1) return <ToolRow t={g.tools[0]} />
  return (
    <details className="tool tool-group" data-testid="step-group" data-kind={g.kind}>
      <summary>
        <span className="tool-name">{g.label}</span>
        <span className="tool-summary" />
        <Counts added={g.added} removed={g.removed} />
        {g.running ? <span className="spinner" /> : g.problems > 0 ? <span className="tool-state error">{g.problems} not done</span> : null}
      </summary>
      <div className="tool-group-rows">
        {g.tools.map((t) => (
          <ToolRow t={t} key={t.id} />
        ))}
      </div>
    </details>
  )
}

function Tools({ tools }: { tools: ToolCall[] }) {
  const groups = useMemo(() => groupSteps(tools), [tools])
  return (
    <div className="tools">
      {groups.map((g) => (
        <Group g={g} key={g.tools[0].id} />
      ))}
    </div>
  )
}

/** The answer whose task list is the chat's current one, and whether that list is pinned above the message box. */
const CurrentPlan = createContext<{ id?: string; pinned: boolean }>({ pinned: false })

/** The last answer that carries a task list. */
export function currentPlanMessage(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant' && messages[i].plan?.length) return messages[i]
  return undefined
}

/**
 * A task list still being worked through is pinned above the message box: while
 * the assistant works, or when the last answer left it unfinished. An old list
 * the chat has moved on from is not.
 */
export function planPinned(messages: Message[], m = currentPlanMessage(messages)): boolean {
  if (!m?.plan?.some((s) => s.status !== 'done')) return false
  if (messages.some((x) => x.status === 'streaming')) return true
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') return messages[i].id === m.id
  return false
}

/** The task list. Folded to one line unless asked to show, and opens with a click. */
export function Plan({ steps, live, open, testId = 'plan' }: { steps: PlanStep[]; live: boolean; open: boolean; testId?: string }) {
  const done = steps.filter((s) => s.status === 'done').length
  const active = steps.find((s) => s.status === 'active')
  return (
    <details className="plan-card" data-testid={testId} open={open}>
      <summary className="plan-head">
        <span>Tasks</span>
        {active && <span className="plan-now">{active.text}</span>}
        <span className="muted">
          {done} of {steps.length} done
        </span>
      </summary>
      <ul>
        {steps.map((s, i) => (
          <li key={i} className={`plan-step ${s.status}`} data-status={s.status}>
            <span className="plan-mark">{s.status === 'done' ? <IconCheck size={13} /> : s.status === 'active' && live ? <span className="spinner" /> : <span className="plan-dot" />}</span>
            <span className="plan-text">{s.text}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

function Who({ m }: { m: Message }) {
  const p = m.provider ?? 'local'
  return (
    <div className="msg-who">
      <ProviderDot provider={p} />
      <span className="name">{PROVIDER_LABEL[p]}</span>
      {m.model && <span>{shortModel(m.model)}</span>}
      {m.onComputer && (
        <span className="badge computer-badge" title="Done on your computer through Chaude. The website does not have this part.">
          On this computer
        </span>
      )}
    </div>
  )
}

function AssistantBody({ m, answerable = false }: { m: Message; answerable?: boolean }) {
  const current = useContext(CurrentPlan)
  return (
    <>
      {m.thinking && (
        <details className="thinking">
          <summary>{m.status === 'streaming' && !m.text ? 'Thinking…' : 'Thought process'}</summary>
          <div className="thinking-body">{m.thinking}</div>
        </details>
      )}
      {!!m.plan?.length && <Plan steps={m.plan} live={m.status === 'streaming'} open={current.id === m.id && !current.pinned} />}
      {!!m.tools?.length && <Tools tools={m.tools} />}
      {m.text && <Prose text={m.text} answerable={answerable && m.status === 'complete'} />}
      {!!m.images?.length && <GeneratedImages items={m.images} />}
      {m.status === 'streaming' && <Working m={m} />}
      {m.status === 'stopped' && <div className="muted tiny" style={{ marginTop: 6 }}>Stopped</div>}
    </>
  )
}

function ErrorBox({ m, onRetry, onSwitch }: { m: Message; onRetry: () => void; onSwitch: () => void }) {
  const code = m.error?.code
  const who = m.provider ? PROVIDER_LABEL[m.provider] : 'The assistant'
  const title = code === 'rate_limit' ? `${who} has reached its usage limit.` : code === 'auth' ? `${who} needs you to sign in again.` : code === 'not_installed' ? `${who} is not set up on this machine.` : code === 'unreachable' ? `${who} could not be reached.` : `${who} ran into a problem.`
  return (
    <div className="msg-error" data-testid="message-error">
      <div className="msg-error-text">
        <b>{title}</b>
        {m.error?.message && code !== 'auth' && <div className="muted">{m.error.message}</div>}
      </div>
      <div className="card-actions">
        {(code === 'auth' || code === 'not_installed') && (
          <button type="button" className="btn btn-small" onClick={() => setState({ view: { kind: 'settings', tab: 'accounts' } })}>
            Open settings
          </button>
        )}
        <button type="button" className="btn btn-small" data-testid="error-switch" onClick={onSwitch}>
          <IconSwitch size={14} /> Continue elsewhere
        </button>
        <button type="button" className="btn btn-small" onClick={onRetry}>
          <IconRetry size={14} /> Retry
        </button>
      </div>
    </div>
  )
}

interface Actions {
  onRetry: () => void
  onSwitch: () => void
  onBranch: (messageId: string) => void
  /** Missing when no other assistant can be asked. */
  onSecondOpinion?: () => void
  /** Change an earlier question and ask it again. Missing while the conversation is answering. */
  onEdit?: (messageId: string, text: string) => void
}

function UserMessage({ m, focus, onEdit }: { m: Message; focus: boolean; onEdit?: (messageId: string, text: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(m.text)
  const save = () => {
    const text = draft.trim()
    if (!text && !m.attachments?.length) return
    setEditing(false)
    if (text !== m.text.trim()) onEdit?.(m.id, text)
  }
  return (
    <div className={`msg msg-user ${focus ? 'focus' : ''} ${editing ? 'editing' : ''}`} data-testid="user-message" data-message-id={m.id}>
      {!!m.attachments?.length && <AttachmentList items={m.attachments} />}
      {m.research && !editing && <span className="badge research-badge">Research</span>}
      {m.onComputer && !editing && <span className="badge computer-badge">On this computer</span>}
      {editing ? (
        <div className="edit-box">
          <textarea
            autoFocus
            className="edit-input"
            data-testid="edit-input"
            value={draft}
            rows={Math.min(12, Math.max(2, draft.split('\n').length))}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                save()
              }
              if (e.key === 'Escape') setEditing(false)
            }}
          />
          <div className="edit-actions">
            <span className="muted tiny">The answers after this question are replaced.</span>
            <button type="button" className="btn btn-small" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-small btn-primary" data-testid="edit-send" onClick={save}>
              Send
            </button>
          </div>
        </div>
      ) : m.text && hasArtifact(m.text) ? (
        <div className="bubble bubble-rich">
          <Prose text={m.text} />
        </div>
      ) : (
        m.text && <div className="bubble">{m.text}</div>
      )}
      {!editing && onEdit && (
        <div className="msg-actions user-actions">
          <button
            type="button"
            className="icon-btn"
            title="Edit this question and ask again"
            data-testid="edit-question"
            onClick={() => {
              setDraft(m.text)
              setEditing(true)
            }}
          >
            <IconEdit size={15} />
          </button>
        </div>
      )}
    </div>
  )
}

function AssistantMessage({ m, focus, onRetry, onSwitch, onBranch, onSecondOpinion, isLast }: { m: Message; focus: boolean; isLast: boolean } & Actions) {
  return (
    <div className={`msg msg-assistant ${focus ? 'focus' : ''}`} data-testid="assistant-message" data-provider={m.provider} data-message-id={m.id}>
      <Who m={m} />
      <AssistantBody m={m} answerable={isLast} />
      {m.status === 'error' && <ErrorBox m={m} onRetry={onRetry} onSwitch={onSwitch} />}
      {m.status !== 'streaming' && m.status !== 'error' && (
        <div className="msg-actions">
          <button
            type="button"
            className="icon-btn"
            title="Copy"
            onClick={() => {
              void navigator.clipboard.writeText(m.text)
              toast('Copied')
            }}
          >
            <IconCopy size={15} />
          </button>
          <ReadAloudButton id={m.id} text={m.text} />
          {isLast && (
            <button type="button" className="icon-btn" title="Answer again" onClick={onRetry}>
              <IconRetry size={15} />
            </button>
          )}
          {isLast && (
            <button type="button" className="icon-btn" title="Continue with a different assistant" onClick={onSwitch}>
              <IconSwitch size={15} />
            </button>
          )}
          {isLast && onSecondOpinion && m.status === 'complete' && (
            <button type="button" className="icon-btn" title="Ask another assistant for a second opinion on this answer" data-testid="second-opinion" onClick={onSecondOpinion}>
              <IconOpinion size={15} />
            </button>
          )}
          <button type="button" className="icon-btn" title="Branch: start a new conversation from here" data-testid="branch" onClick={() => onBranch(m.id)}>
            <IconBranch size={15} />
          </button>
        </div>
      )}
    </div>
  )
}

function CompareGroup({ variants }: { variants: Message[] }) {
  const [showOthers, setShowOthers] = useState(false)
  const chosen = variants.find((v) => v.selected)
  const settled = variants.every((v) => v.status !== 'streaming')
  if (chosen && !showOthers) {
    return (
      <div className="msg msg-assistant" data-testid="assistant-message" data-provider={chosen.provider} data-message-id={chosen.id}>
        <Who m={chosen} />
        <AssistantBody m={chosen} />
        <div className="compare-others">
          Kept from {variants.length} answers.{' '}
          <button type="button" className="linkish" onClick={() => setShowOthers(true)}>
            Show the others
          </button>
        </div>
      </div>
    )
  }
  return (
    <>
      <div className="compare" data-testid="compare-group">
        {variants.map((v) => (
          <div className="compare-card" key={v.id} data-provider={v.provider} data-testid="compare-card" data-message-id={v.id}>
            <Who m={v} />
            <AssistantBody m={v} />
            {v.status === 'error' && (
              <div className="msg-error">
                <div className="msg-error-text">{v.error?.message ?? 'This assistant could not answer.'}</div>
              </div>
            )}
            <div className="compare-foot">
              {v.selected ? (
                <span className="badge ok">Kept</span>
              ) : (
                <button type="button" className="btn btn-small" disabled={!settled || v.status === 'error' || !v.text} data-testid="keep-answer" onClick={() => void window.api.selectVariant(v.id)}>
                  Keep this answer
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {chosen ? (
        <div className="compare-others" style={{ textAlign: 'center' }}>
          <button type="button" className="linkish" onClick={() => setShowOthers(false)}>
            Hide the other answers
          </button>
        </div>
      ) : (
        settled && <div className="compare-others" style={{ textAlign: 'center' }}>Keep one answer to continue the conversation from it.</div>
      )}
    </>
  )
}

export function ApprovalCard({ provider, request, onDecision }: { provider: ProviderId; request: ApprovalRequest; onDecision: (d: ApprovalDecision) => void }) {
  return (
    <div className="card" data-testid="approval-card">
      <div className="card-title">
        {PROVIDER_LABEL[provider]} wants to {request.kind === 'command' ? 'run a command' : request.kind === 'file' ? 'change files' : `use ${request.tool ?? 'a tool'}`}
      </div>
      <ul>
        <li>
          <code>{request.summary}</code>
        </li>
        {request.reason && <li>{request.reason}</li>}
      </ul>
      <div className="card-actions">
        <button type="button" className="btn btn-small btn-primary" data-testid="approve-once" onClick={() => onDecision('accept')}>
          Allow once
        </button>
        <button type="button" className="btn btn-small" data-testid="approve-chat" onClick={() => onDecision('acceptForSession')}>
          Allow for this chat
        </button>
        <button type="button" className="btn btn-small" data-testid="approve-decline" onClick={() => onDecision('decline')}>
          Decline
        </button>
      </div>
    </div>
  )
}

export function DenialCard({ denials, onAllow, onDismiss }: { denials: PermissionDenial[]; onAllow: () => void; onDismiss: () => void }) {
  return (
    <div className="card" data-testid="denial-card">
      <div className="card-title">Claude was not allowed to do {denials.length === 1 ? 'this' : 'these'}</div>
      <ul>
        {denials.map((d, i) => (
          <li key={i}>
            {d.toolName}: <code>{d.summary}</code>
          </li>
        ))}
      </ul>
      <div className="card-actions">
        <button type="button" className="btn btn-small btn-primary" data-testid="allow-denied" onClick={onAllow}>
          Allow and continue
        </button>
        <button type="button" className="btn btn-small" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

type Item = { kind: 'single'; m: Message } | { kind: 'group'; id: string; variants: Message[] }

export function MessageList({ messages, focusId, onRetry, onSwitch, onBranch, onSecondOpinion, onEdit }: { messages: Message[]; focusId?: string } & Actions) {
  const items = useMemo(() => {
    const out: Item[] = []
    const groups = new Map<string, Message[]>()
    for (const m of messages) {
      if (!m.variantGroup) {
        out.push({ kind: 'single', m })
        continue
      }
      let list = groups.get(m.variantGroup)
      if (!list) {
        list = []
        groups.set(m.variantGroup, list)
        out.push({ kind: 'group', id: m.variantGroup, variants: list })
      }
      list.push(m)
    }
    return out
  }, [messages])

  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant' && !m.variantGroup)?.id
  const lastId = messages[messages.length - 1]?.id
  const planMessage = currentPlanMessage(messages)
  const pinned = planPinned(messages, planMessage)
  const current = useMemo(() => ({ id: planMessage?.id, pinned }), [planMessage, pinned])

  return (
    <CurrentPlan.Provider value={current}>
      {items.map((item) => {
        if (item.kind === 'group') return <CompareGroup key={item.id} variants={item.variants} />
        const m = item.m
        if (m.role === 'note') {
          return (
            <div className="note" key={m.id}>
              {m.text}
            </div>
          )
        }
        if (m.role === 'user') return <UserMessage key={m.id} m={m} focus={m.id === focusId} onEdit={onEdit} />
        return <AssistantMessage key={m.id} m={m} focus={m.id === focusId} onRetry={onRetry} onSwitch={onSwitch} onBranch={onBranch} onSecondOpinion={onSecondOpinion} isLast={m.id === lastAssistantId && m.id === lastId} />
      })}
    </CurrentPlan.Provider>
  )
}
