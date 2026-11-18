import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, Message, ProviderId } from '@shared/types'
import { PROVIDER_LABEL } from '@shared/types'
import { messageBody, SECOND_OPINION_PROMPT, threadMessages } from '@shared/context'
import { estimateTokens, formatTokens } from '@shared/tokens'
import { formatReset, limitWarning } from '@shared/usage'
import { switchTarget } from '@shared/router'
import { createFromDraft, dismissRemoved, getState, loadMessages, openChat, setState, toast, useUi } from '../state'
import { IconColumns, IconFolder, IconLock, IconMore, IconSwitch } from '../icons'
import { Composer } from './Composer'
import { ApprovalCard, DenialCard, MessageList } from './Messages'
import { MenuItem, Popover, ProviderDot } from './ui'

const EMPTY: Message[] = []

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Still up? Where should we start?'
  if (h < 12) return 'Good morning. Where should we start?'
  if (h < 18) return 'Good afternoon. Where should we start?'
  return 'Good evening. Where should we start?'
}

export function ChatView({ conversationId, focusMessageId }: { conversationId?: string; focusMessageId?: string }) {
  const app = useUi((s) => s.app)!
  const stored = useUi((s) => (conversationId ? s.messages[conversationId] : undefined)) ?? EMPTY
  const streaming = useUi((s) => s.streaming)
  const routeNote = useUi((s) => (conversationId ? s.routes[conversationId] : undefined))
  const approvals = useUi((s) => (conversationId ? s.approvals[conversationId] : undefined))
  const denial = useUi((s) => (conversationId ? s.denials[conversationId] : undefined))
  const dismissed = useUi((s) => s.dismissed)
  const conversation = app.conversations.find((c) => c.id === conversationId)
  const [renaming, setRenaming] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    if (conversationId) void loadMessages(conversationId)
    stick.current = true
    setRenaming(false)
  }, [conversationId])

  const messages = useMemo(() => {
    const live = Object.values(streaming).filter((m) => m.conversationId === conversationId && !stored.some((s) => s.id === m.id))
    return live.length ? [...stored, ...live].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)) : stored
  }, [stored, streaming, conversationId])

  // A question holds up the whole turn, so it is always brought into view.
  const asked = useRef(0)
  useLayoutEffect(() => {
    const el = scroller.current
    const waiting = approvals?.length ?? 0
    if (waiting > asked.current) stick.current = true
    asked.current = waiting
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages, approvals, denial])

  useEffect(() => {
    if (!focusMessageId) return
    const el = scroller.current?.querySelector(`[data-message-id="${CSS.escape(focusMessageId)}"]`)
    if (el) {
      stick.current = false
      el.scrollIntoView({ block: 'center' })
    }
  }, [focusMessageId, stored])

  const busy = conversation ? app.busy.includes(conversation.id) : false
  const thread = useMemo(() => threadMessages(stored), [stored])
  const contextTokens = useMemo(() => thread.reduce((n, m) => n + estimateTokens(m.role === 'user' ? messageBody(m) : m.text) + 6, 0), [thread])

  const send = async (text: string, compare?: ProviderId[], attachments?: Attachment[]) => {
    try {
      const conv = conversation ?? (await createFromDraft())
      stick.current = true
      dismissRemoved(conv.id)
      const variant = getState().variants[conv.id]
      await window.api.send({ conversationId: conv.id, text, compare, variant, attachments })
    } catch (e) {
      toast(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    }
  }

  const retry = () => {
    if (!conversation || busy) return
    stick.current = true
    void window.api.send({ conversationId: conversation.id, text: '', retry: true, variant: getState().variants[conversation.id] }).catch((e) => toast(String(e.message ?? e)))
  }

  const openSwitch = (target?: ProviderId) => conversation && setState({ dialog: { kind: 'switch', conversationId: conversation.id, target } })

  // Which provider is this conversation leaning on right now?
  const lastProvider = [...stored].reverse().find((m) => m.role === 'assistant' && m.provider && !m.variantGroup)?.provider
  const current: ProviderId | undefined = conversation?.private ? 'local' : conversation && conversation.provider !== 'auto' ? conversation.provider : lastProvider
  const warning = current ? limitWarning(app.usage[current]) : undefined
  const warningKey = warning && conversation ? `${conversation.id}:${warning.provider}:${warning.window}:${warning.status}` : ''
  // For a conversation that runs on the hub, what matters is which assistants are ready there.
  const where = conversation?.runOnHub && app.remote?.enabled ? app.remote.providers : app.providers
  const available = { claude: !!where.claude?.ready, chatgpt: !!where.chatgpt?.ready, local: !!where.local?.ready }
  const target = warning ? switchTarget(warning.provider, available, app.usage) : undefined

  const branch = async (messageId: string) => {
    if (!conversation) return
    const copy = await window.api.branchConversation(conversation.id, messageId)
    if (!copy) return
    openChat(copy.id)
    toast('Branched. This is a separate conversation from here on.')
  }

  // A second opinion comes from whichever other assistant has room. Private chats never leave local AI.
  const opinionFrom = !conversation || conversation.private || !lastProvider ? undefined : switchTarget(lastProvider, available, app.usage)
  const secondOpinion = () => {
    if (!conversation || busy || !opinionFrom) return
    stick.current = true
    void window.api.send({ conversationId: conversation.id, text: SECOND_OPINION_PROMPT, provider: opinionFrom }).catch((e) => toast(String(e.message ?? e)))
  }

  const empty = !messages.length
  const composer = <Composer conversation={conversation} onSend={(t, c, a) => void send(t, c, a)} />

  return (
    <>
      <header className="topbar drag">
        {conversation && !empty ? (
          <>
            <div className="topbar-title no-drag" onDoubleClick={() => setRenaming(true)} title="Double-click to rename">
              {renaming ? (
                <input
                  autoFocus
                  defaultValue={conversation.title}
                  onBlur={(e) => {
                    const title = e.target.value.trim()
                    if (title && title !== conversation.title) void window.api.updateConversation(conversation.id, { title })
                    setRenaming(false)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') setRenaming(false)
                  }}
                />
              ) : (
                conversation.title
              )}
            </div>
            <span className="topbar-spacer" />
            <span className="ctx-meter" title="Size of this conversation against your context budget" data-testid="context-meter">
              {formatTokens(contextTokens)} / {formatTokens(app.settings.contextBudgetTokens)} tokens
            </span>
            <button type="button" className="chip" data-testid="open-switch" disabled={busy} onClick={() => openSwitch()} title="Continue this conversation with a different assistant">
              <IconSwitch size={15} /> Switch
            </button>
            <Popover align="right" className="icon-btn" title="More" label={<IconMore />} testId="conversation-menu">
              {(close) => (
                <>
                  <MenuItem
                    onClick={() => {
                      setRenaming(true)
                      close()
                    }}
                  >
                    Rename
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      void window.api.updateConversation(conversation.id, { pinned: !conversation.pinned })
                      close()
                    }}
                  >
                    {conversation.pinned ? 'Unpin' : 'Pin to top'}
                  </MenuItem>
                  <div className="menu-sep" />
                  <MenuItem
                    hint="Summary and full transcript, always up to date"
                    testId="reveal-context"
                    onClick={() => {
                      void window.api.revealContext(conversation.id)
                      close()
                    }}
                  >
                    Show context files
                  </MenuItem>
                  <MenuItem
                    hint="Paste it into any other AI tool"
                    onClick={() => {
                      void window.api.copyContext(conversation.id, 'summary').then(() => toast('Context summary copied'))
                      close()
                    }}
                  >
                    Copy context summary
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      void window.api.copyContext(conversation.id, 'full').then(() => toast('Full transcript copied'))
                      close()
                    }}
                  >
                    Copy full transcript
                  </MenuItem>
                  <div className="menu-sep" />
                  <MenuItem
                    danger
                    testId="delete-conversation"
                    onClick={() => {
                      close()
                      if (confirm(`Delete "${conversation.title}"? It will be removed from every synced device.`)) {
                        void window.api.deleteConversation(conversation.id)
                        openChat(undefined)
                      }
                    }}
                  >
                    Delete conversation
                  </MenuItem>
                </>
              )}
            </Popover>
          </>
        ) : (
          <span className="topbar-spacer" />
        )}
      </header>

      {empty ? (
        <div className="empty">
          <h1>{greeting()}</h1>
          {composer}
          <div className="starter-row">
            <button type="button" className="starter" onClick={() => setState((s) => ({ draft: { ...s.draft, provider: 'auto', private: false } }))}>
              <ProviderDot provider="auto" /> Let the app pick the assistant
            </button>
            <button type="button" className="starter" onClick={() => setState((s) => ({ draft: { ...s.draft, mode: 'edit', private: false } }))}>
              <IconFolder size={14} /> Work in a folder
            </button>
            <button type="button" className="starter" onClick={() => setState((s) => ({ draft: { ...s.draft, private: true } }))}>
              <IconLock size={14} /> Keep it on local AI
            </button>
            <button type="button" className="starter" onClick={() => toast('Use the columns button in the message box to ask several assistants at once.')}>
              <IconColumns size={14} /> Compare answers
            </button>
          </div>
        </div>
      ) : (
        <>
          <div
            className="scroll"
            ref={scroller}
            data-testid="message-scroll"
            onScroll={(e) => {
              const el = e.currentTarget
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
          >
            <div className="column">
              <MessageList messages={messages} focusId={focusMessageId} onRetry={retry} onSwitch={() => openSwitch()} onBranch={(id) => void branch(id)} onSecondOpinion={opinionFrom ? secondOpinion : undefined} />
              {conversation &&
                approvals?.map((a) => (
                  <ApprovalCard
                    key={a.request.id}
                    provider={a.request.provider ?? 'chatgpt'}
                    request={a.request}
                    onDecision={(d) => {
                      void window.api.respondApproval(conversation.id, a.messageId, a.request.id, d)
                      setState((s) => ({ approvals: { ...s.approvals, [conversation.id]: (s.approvals[conversation.id] ?? []).filter((x) => x.request.id !== a.request.id) } }))
                    }}
                  />
                ))}
              {conversation && denial && !busy && (
                <DenialCard
                  denials={denial.denials}
                  onDismiss={() => dismissRemoved(conversation.id)}
                  onAllow={() => {
                    const allow = [...new Set(denial.denials.map((d) => d.rule))]
                    dismissRemoved(conversation.id)
                    stick.current = true
                    void window.api
                      .send({ conversationId: conversation.id, text: 'You now have permission for the actions that were blocked. Please continue.', allow, provider: 'claude' })
                      .catch((e) => toast(String(e.message ?? e)))
                  }}
                />
              )}
            </div>
          </div>
          <div className="composer-wrap" style={{ paddingBottom: 0 }}>
            <div className="composer-col">
              {warning && conversation && !dismissed[warningKey] && (
                <div className={`banner ${warning.status === 'exhausted' ? 'exhausted' : ''}`} data-testid="limit-banner">
                  <div className="banner-text">
                    <b>
                      {PROVIDER_LABEL[warning.provider]}'s {warning.window === 'fiveHour' ? '5-hour' : 'weekly'} limit {warning.status === 'exhausted' ? 'is used up' : 'is running low'}
                      {typeof warning.usedPct === 'number' && warning.status !== 'exhausted' ? ` (${Math.round(warning.usedPct)}% used)` : ''}.
                    </b>{' '}
                    {formatReset(warning.resetsAt, Date.now()) ? `It ${formatReset(warning.resetsAt, Date.now())}. ` : ''}
                    {target ? 'The context file is ready to hand over.' : 'No other assistant is available right now.'}
                  </div>
                  {target && (
                    <button type="button" className="btn btn-small btn-primary" data-testid="banner-switch" onClick={() => openSwitch(target)}>
                      Continue on {PROVIDER_LABEL[target]}
                    </button>
                  )}
                  <button type="button" className="btn btn-small" onClick={() => setState((s) => ({ dismissed: { ...s.dismissed, [warningKey]: true } }))}>
                    Not now
                  </button>
                </div>
              )}
              {routeNote && conversation?.provider === 'auto' && !conversation.private && (
                <div className="route-note" data-testid="route-note">
                  <ProviderDot provider={routeNote.provider} /> Auto chose {PROVIDER_LABEL[routeNote.provider]}. {routeNote.reason}
                </div>
              )}
            </div>
          </div>
          {composer}
        </>
      )}
    </>
  )
}
