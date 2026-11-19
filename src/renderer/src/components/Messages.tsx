import { memo, useMemo, useState } from 'react'
import type { ApprovalDecision, ApprovalRequest, Message, PermissionDenial, ProviderId, ToolCall } from '@shared/types'
import { PROVIDER_LABEL } from '@shared/types'
import { renderMarkdown } from '../markdown'
import { setState, toast } from '../state'
import { IconBranch, IconCopy, IconOpinion, IconRetry, IconSwitch } from '../icons'
import { ProviderDot } from './ui'
import { AttachmentList } from './Attachments'

function shortModel(model?: string): string {
  if (!model) return ''
  const m = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

const Prose = memo(function Prose({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
})

function Tools({ tools }: { tools: ToolCall[] }) {
  return (
    <div className="tools">
      {tools.map((t) => (
        <details className="tool" key={t.id}>
          <summary>
            <span className="tool-name">{t.name}</span>
            <span className="tool-summary">{t.summary}</span>
            {t.status === 'running' ? <span className="spinner" /> : <span className={`tool-state ${t.status}`}>{t.status === 'done' ? '' : t.status === 'denied' ? 'not allowed' : 'failed'}</span>}
          </summary>
          {t.output && <pre>{t.output}</pre>}
        </details>
      ))}
    </div>
  )
}

function Who({ m }: { m: Message }) {
  const p = m.provider ?? 'local'
  return (
    <div className="msg-who">
      <ProviderDot provider={p} />
      <span className="name">{PROVIDER_LABEL[p]}</span>
      {m.model && <span>{shortModel(m.model)}</span>}
    </div>
  )
}

function AssistantBody({ m }: { m: Message }) {
  const waiting = m.status === 'streaming' && !m.text && !(m.tools ?? []).some((t) => t.status === 'running')
  return (
    <>
      {m.thinking && (
        <details className="thinking">
          <summary>{m.status === 'streaming' && !m.text ? 'Thinking…' : 'Thought process'}</summary>
          <div className="thinking-body">{m.thinking}</div>
        </details>
      )}
      {!!m.tools?.length && <Tools tools={m.tools} />}
      {m.text && <Prose text={m.text} />}
      {waiting && (
        <span className="typing" aria-label="Working">
          <i />
          <i />
          <i />
        </span>
      )}
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
}

function AssistantMessage({ m, focus, onRetry, onSwitch, onBranch, onSecondOpinion, isLast }: { m: Message; focus: boolean; isLast: boolean } & Actions) {
  return (
    <div className={`msg msg-assistant ${focus ? 'focus' : ''}`} data-testid="assistant-message" data-provider={m.provider} data-message-id={m.id}>
      <Who m={m} />
      <AssistantBody m={m} />
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

export function MessageList({ messages, focusId, onRetry, onSwitch, onBranch, onSecondOpinion }: { messages: Message[]; focusId?: string } & Actions) {
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

  return (
    <>
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
        if (m.role === 'user') {
          return (
            <div className={`msg msg-user ${m.id === focusId ? 'focus' : ''}`} key={m.id} data-testid="user-message" data-message-id={m.id}>
              {!!m.attachments?.length && <AttachmentList items={m.attachments} />}
              {m.text && <div className="bubble">{m.text}</div>}
            </div>
          )
        }
        return <AssistantMessage key={m.id} m={m} focus={m.id === focusId} onRetry={onRetry} onSwitch={onSwitch} onBranch={onBranch} onSecondOpinion={onSecondOpinion} isLast={m.id === lastAssistantId && m.id === lastId} />
      })}
    </>
  )
}
