import { useEffect, useMemo, useRef, useState } from 'react'
import type { HandoffInfo, SearchHit } from '@shared/ipc'
import type { HandoffVariant, ProviderId } from '@shared/types'
import { PROVIDER_LABEL } from '@shared/types'
import { threadMessages } from '@shared/context'
import { formatTokens } from '@shared/tokens'
import { headroom } from '@shared/usage'
import { switchTarget } from '@shared/router'
import { chatShown, openSearchHit, setState, toast, useUi } from '../state'
import { Modal, ProviderDot, PROVIDERS, SourceTag } from './ui'

function Snippet({ text }: { text: string }) {
  // The backend marks matches with [[ and ]].
  const parts = text.split(/(\[\[.*?\]\])/g)
  return (
    <>
      {parts.map((p, i) => (p.startsWith('[[') && p.endsWith(']]') ? <mark key={i}>{p.slice(2, -2)}</mark> : <span key={i}>{p}</span>))}
    </>
  )
}

export function SearchDialog() {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [active, setActive] = useState(0)
  const show = useUi((s) => s.show)
  const all = useUi((s) => s.app?.conversations)
  // With one assistant shown, search only finds its chats.
  const conversations = useMemo(() => (all ?? []).filter((c) => chatShown(c, show)), [all, show])
  const shownIds = useMemo(() => new Set(conversations.map((c) => c.id)), [conversations])
  const seq = useRef(0)

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setHits([])
      return
    }
    const mine = ++seq.current
    const timer = setTimeout(() => {
      void window.api.search(q).then((res) => {
        if (mine === seq.current) {
          setHits(res.filter((h) => shownIds.has(h.conversationId)))
          setActive(0)
        }
      })
    }, 120)
    return () => clearTimeout(timer)
  }, [query, shownIds])

  const recent = useMemo(
    () =>
      conversations
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 8)
        .map((c): SearchHit => ({ conversationId: c.id, title: c.title, snippet: '', createdAt: c.updatedAt })),
    [conversations]
  )
  const list = query.trim() ? hits : recent
  const close = () => setState({ dialog: null })

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="Search chats" data-testid="search-dialog">
        <input
          className="search-input"
          autoFocus
          placeholder={show === 'all' ? 'Search every chat, from every assistant' : `Search your ${PROVIDER_LABEL[show]} chats`}
          value={query}
          data-testid="search-input"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close()
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(a + 1, list.length - 1))
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            }
            if (e.key === 'Enter' && list[active]) openSearchHit(list[active])
          }}
        />
        <div className="search-results">
          {!query.trim() && recent.length > 0 && <div className="menu-title">Recent</div>}
          {list.map((h, i) => (
            <button type="button" key={`${h.conversationId}:${h.messageId ?? 't'}:${i}`} className={`hit ${i === active ? 'active' : ''}`} data-testid="search-hit" onMouseEnter={() => setActive(i)} onClick={() => openSearchHit(h)}>
              <div className="hit-title">
                <span className="hit-name">{h.title}</span>
                {h.source && <SourceTag service={h.source} />}
                {(h.matches ?? 0) > 1 && <span className="hit-count">{h.matches} matches</span>}
              </div>
              {h.snippet && (
                <div className="hit-snippet">
                  <Snippet text={h.snippet} />
                </div>
              )}
            </button>
          ))}
          {query.trim() && !hits.length && <div className="muted pad">No chats match that.</div>}
          {!query.trim() && !recent.length && <div className="muted pad">Nothing to search yet.</div>}
        </div>
      </div>
    </div>
  )
}

export function SwitchDialog({ conversationId, target: initial }: { conversationId: string; target?: ProviderId }) {
  const app = useUi((s) => s.app)!
  const stored = useUi((s) => s.messages[conversationId])
  const conversation = app.conversations.find((c) => c.id === conversationId)
  const available = { claude: !!app.providers.claude?.ready, chatgpt: !!app.providers.chatgpt?.ready, local: !!app.providers.local?.ready }

  const lastProvider = [...(stored ?? [])].reverse().find((m) => m.role === 'assistant' && m.provider && !m.variantGroup)?.provider
  const current: ProviderId | undefined = conversation && conversation.provider !== 'auto' ? conversation.provider : lastProvider
  const [target, setTarget] = useState<ProviderId | undefined>(() => {
    if (initial) return initial
    if (current) return switchTarget(current, available, app.usage) ?? PROVIDERS.find((p) => p !== current && available[p])
    return PROVIDERS.find((p) => available[p])
  })
  const [variant, setVariant] = useState<HandoffVariant>('summary')
  const [info, setInfo] = useState<Partial<Record<HandoffVariant, HandoffInfo>>>({})
  const [showPreview, setShowPreview] = useState(false)

  useEffect(() => {
    let alive = true
    setInfo({})
    if (!target) return
    void Promise.all([window.api.handoffPreview(conversationId, 'summary', target), window.api.handoffPreview(conversationId, 'full', target)]).then(([summary, full]) => {
      if (alive) setInfo({ summary, full })
    })
    return () => {
      alive = false
    }
  }, [conversationId, target])

  if (!conversation) return null
  const close = () => setState({ dialog: null })
  const thread = threadMessages(stored ?? [])
  const all = stored ?? []
  const lastReal = [...all].reverse().find((m) => m.role !== 'note')
  // The last question has no usable answer yet, so the new assistant can pick it up directly.
  const unanswered = !!lastReal && (lastReal.role === 'user' || lastReal.status === 'error')

  const apply = async (answerNow: boolean) => {
    if (!target) return
    await window.api.switchProvider(conversationId, target)
    setState((s) => ({ variants: { ...s.variants, [conversationId]: variant }, dialog: null }))
    if (answerNow) {
      void window.api.send({ conversationId, text: '', retry: true, provider: target, variant }).catch((e) => toast(String(e.message ?? e)))
    } else {
      toast(`Your next message goes to ${PROVIDER_LABEL[target]}, with the conversation so far.`)
    }
  }

  const variantRow = (v: HandoffVariant, title: string, sub: string) => {
    const i = info[v]
    return (
      <button type="button" className={`choice ${variant === v ? 'selected' : ''}`} data-testid={`variant-${v}`} onClick={() => setVariant(v)}>
        <div className="choice-main">
          <div className="choice-title">{title}</div>
          <div className="choice-sub">
            {sub}
            {i && v === 'full' && i.condensed ? ' The oldest part was trimmed to fit this assistant.' : ''}
            {i && v === 'summary' && i.condensed ? (i.summarySource === 'local' ? ' Summary written by your local model.' : ' Summary built from the conversation outline.') : ''}
          </div>
        </div>
        <div className="choice-right">{i ? `${formatTokens(i.tokens)} tokens` : ''}</div>
      </button>
    )
  }

  return (
    <Modal title="Continue with a different assistant" onClose={close} wide testId="switch-dialog">
      <div className="modal-body">
        <div className="section-label" style={{ marginTop: 0 }}>
          Continue on
        </div>
        {PROVIDERS.map((p) => {
          const st = app.providers[p]
          const room = headroom(app.usage[p])
          const sub = !st?.ready ? (st?.detail ?? 'Checking') : room === 'none' ? 'Limit reached' : room === 'low' ? 'Running low on its limit' : st.detail
          return (
            <button type="button" key={p} className={`choice ${target === p ? 'selected' : ''}`} disabled={!st?.ready} data-testid={`target-${p}`} onClick={() => setTarget(p)}>
              <div className="choice-main">
                <div className="choice-title">
                  <ProviderDot provider={p} /> {PROVIDER_LABEL[p]}
                  {p === current && <span className="badge">current</span>}
                </div>
                <div className="choice-sub">{sub}</div>
              </div>
            </button>
          )
        })}

        <div className="section-label">What to hand over</div>
        {variantRow('summary', 'Summary plus recent messages', 'A digest of the earlier conversation, then the latest messages word for word. Uses less of the limit.')}
        {variantRow('full', 'Full transcript', 'Every message word for word. Most faithful, uses more of the limit.')}

        <div className="muted tiny">
          {thread.length} {thread.length === 1 ? 'message' : 'messages'} in this conversation.{' '}
          <button type="button" className="linkish" onClick={() => setShowPreview((s) => !s)}>
            {showPreview ? 'Hide the file' : 'Preview the file'}
          </button>
        </div>
        {showPreview && <div className="preview">{info[variant]?.text ?? 'Building…'}</div>}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        {unanswered && (
          <button type="button" className="btn" disabled={!target} data-testid="switch-only" onClick={() => void apply(false)}>
            Just switch
          </button>
        )}
        <button type="button" className="btn btn-primary" disabled={!target} data-testid="switch-confirm" onClick={() => void apply(unanswered)}>
          {target ? (unanswered ? `Switch and answer on ${PROVIDER_LABEL[target]}` : `Switch to ${PROVIDER_LABEL[target]}`) : 'Choose an assistant'}
        </button>
      </div>
    </Modal>
  )
}
