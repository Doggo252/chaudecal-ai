import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Attachment, Conversation, ProviderChoice, ProviderId, RunMode } from '@shared/types'
import { MAX_ATTACHMENTS, PROVIDER_LABEL } from '@shared/types'
import { headroom } from '@shared/usage'
import type { AttachResult } from '@shared/ipc'
import { createFromDraft, getState, setState, toast, useUi, type Draft } from '../state'
import { IconBook, IconChevron, IconClip, IconColumns, IconFolder, IconLock, IconSend, IconStop } from '../icons'
import { AttachmentList, fileToBase64 } from './Attachments'
import { MenuItem, Popover, ProviderDot, PROVIDERS, providerName } from './ui'

const MODES: { id: RunMode; label: string; hint: string }[] = [
  { id: 'chat', label: 'Chat', hint: 'Conversation only. Nothing on this computer is read or changed.' },
  { id: 'plan', label: 'Plan', hint: 'Can read files in the folder you choose, changes nothing.' },
  { id: 'edit', label: 'Edit', hint: 'Can read and edit files in the folder. Other actions ask first.' },
  { id: 'auto', label: 'Auto', hint: 'Can also run commands in the folder without asking.' }
]

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

export function Composer({ conversation, onSend }: { conversation?: Conversation; onSend: (text: string, compare?: ProviderId[], attachments?: Attachment[]) => void }) {
  const app = useUi((s) => s.app)!
  const draft = useUi((s) => s.draft)
  const [text, setText] = useState('')
  const [compare, setCompare] = useState<ProviderId[] | null>(null)
  const [workspace, setWorkspace] = useState('')
  const [attached, setAttachedState] = useState<Attachment[]>([])
  // Files can arrive several at a time (a drop, a paste), so the latest list is also kept outside React state.
  const attachedRef = useRef<Attachment[]>([])
  const setAttached = (list: Attachment[]) => {
    attachedRef.current = list
    setAttachedState(list)
  }
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const busy = conversation ? app.busy.includes(conversation.id) : false

  const provider: ProviderChoice = conversation?.provider ?? draft.provider
  const mode: RunMode = conversation?.mode ?? draft.mode
  const isPrivate = conversation?.private ?? draft.private
  const models = conversation?.models ?? draft.models
  const effective: ProviderChoice = isPrivate ? 'local' : provider

  const change = (patch: Partial<Draft>) => {
    if (!conversation) {
      setState((s) => ({ draft: { ...s.draft, ...patch } }))
      return
    }
    if (patch.provider !== undefined && patch.provider !== conversation.provider) {
      void window.api.switchProvider(conversation.id, patch.provider)
      const { provider: _p, ...rest } = patch
      if (Object.keys(rest).length) void window.api.updateConversation(conversation.id, rest)
      return
    }
    void window.api.updateConversation(conversation.id, patch)
  }

  const lastId = useRef<string | undefined>(conversation?.id)
  useEffect(() => {
    // Keep what was typed when a new chat becomes a saved conversation.
    const created = lastId.current === undefined && conversation !== undefined
    lastId.current = conversation?.id
    if (!created) {
      setText('')
      setAttached([])
    }
    setCompare(null)
    setWorkspace('')
    if (conversation) void window.api.getWorkspace(conversation.id).then(setWorkspace)
    ref.current?.focus()
  }, [conversation?.id])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
  }, [text])

  const ready = (p: ProviderId) => !!app.providers[p]?.ready
  const readyProviders = PROVIDERS.filter(ready)

  const submit = () => {
    const value = text.trim()
    if ((!value && !attached.length) || busy) return
    setText('')
    setAttached([])
    onSend(value, compare && compare.length > 1 ? compare : undefined, attached.length ? attached : undefined)
  }

  const addAttached = (result: AttachResult) => {
    if (result.errors.length) toast(result.errors.join(' '))
    if (!result.attachments.length) return
    const next = [...attachedRef.current, ...result.attachments]
    if (next.length > MAX_ATTACHMENTS) toast(`A message can carry up to ${MAX_ATTACHMENTS} files.`)
    for (const extra of next.slice(MAX_ATTACHMENTS)) void window.api.discardAttachment(extra.id)
    setAttached(next.slice(0, MAX_ATTACHMENTS))
    ref.current?.focus()
  }

  const addFiles = async (files: File[]) => {
    for (const file of files) addAttached(await window.api.addAttachment({ name: file.name || 'pasted image', base64: await fileToBase64(file) }))
  }

  const removeAttached = (a: Attachment) => {
    setAttached(attachedRef.current.filter((x) => x.id !== a.id))
    void window.api.discardAttachment(a.id)
  }

  const pickFolder = async () => {
    const conv = conversation ?? (await createFromDraft())
    setWorkspace(await window.api.pickWorkspace(conv.id))
  }

  const modelList = (p: ProviderId): string[] => {
    if (p === 'local') return app.localModels.map((m) => `${m.endpointId}/${m.id}`)
    const fromStatus = app.providers[p]?.models ?? []
    const configured = p === 'claude' ? app.settings.claude.models : app.settings.chatgpt.models
    return [...new Set([...fromStatus, ...configured])]
  }

  const modelProvider: ProviderId | undefined = effective === 'auto' ? undefined : effective
  const currentModel = modelProvider ? (models[modelProvider] ?? '') : ''
  const modelLabel = (m: string) => (m ? (m.includes('/') ? m.slice(m.indexOf('/') + 1) : m) : 'Default model')

  return (
    <div className="composer-wrap">
      <div className="composer-col">
        <div
          className={`composer ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            setDragging(false)
            if (!e.dataTransfer.files.length) return
            e.preventDefault()
            void addFiles([...e.dataTransfer.files])
          }}
        >
          <AttachmentList items={attached} onRemove={removeAttached} />
          <textarea
            ref={ref}
            rows={1}
            value={text}
            data-testid="composer-input"
            placeholder={compare ? 'Ask all selected assistants at once' : effective === 'auto' ? 'Ask anything' : `Message ${providerName(effective)}`}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              // A pasted screenshot or copied file becomes an attachment. Pasted text is left alone.
              const files = [...e.clipboardData.files]
              if (!files.length) return
              e.preventDefault()
              void addFiles(files)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <div className="composer-row">
            <Popover
              up
              testId="provider-picker"
              disabled={isPrivate || !!compare}
              title="Which assistant answers"
              label={
                <>
                  <ProviderDot provider={effective} /> {providerName(effective)} <IconChevron size={13} />
                </>
              }
            >
              {(close) => (
                <>
                  <MenuItem
                    selected={provider === 'auto'}
                    hint="Picks for each message from task type and remaining limits"
                    testId="provider-auto"
                    onClick={() => {
                      change({ provider: 'auto' })
                      close()
                    }}
                  >
                    <ProviderDot provider="auto" /> Auto
                  </MenuItem>
                  <div className="menu-sep" />
                  {PROVIDERS.map((p) => {
                    const st = app.providers[p]
                    const room = headroom(app.usage[p])
                    const hint = !st ? 'Checking…' : !st.ready ? st.detail : room === 'none' ? 'Limit reached' : room === 'low' ? 'Running low' : st.detail
                    return (
                      <MenuItem
                        key={p}
                        selected={provider === p}
                        hint={hint}
                        testId={`provider-${p}`}
                        onClick={() => {
                          change({ provider: p })
                          close()
                        }}
                      >
                        <ProviderDot provider={p} /> {PROVIDER_LABEL[p]}
                      </MenuItem>
                    )
                  })}
                </>
              )}
            </Popover>

            {modelProvider && !compare && (
              <Popover
                up
                testId="model-picker"
                title="Model"
                label={
                  <>
                    <span className="chip-path">{modelLabel(currentModel)}</span> <IconChevron size={13} />
                  </>
                }
              >
                {(close) => (
                  <>
                    <MenuItem
                      selected={!currentModel}
                      hint={modelProvider === 'local' ? 'First available local model' : 'Whatever the service picks for your plan'}
                      onClick={() => {
                        change({ models: { ...models, [modelProvider]: '' } })
                        close()
                      }}
                    >
                      Default model
                    </MenuItem>
                    {modelList(modelProvider).map((m) => (
                      <MenuItem
                        key={m}
                        selected={currentModel === m}
                        hint={modelProvider === 'local' ? app.localModels.find((x) => `${x.endpointId}/${x.id}` === m)?.endpointName + (app.localModels.find((x) => `${x.endpointId}/${x.id}` === m)?.via === 'hub' ? ', on the hub' : ', on this machine') : undefined}
                        onClick={() => {
                          change({ models: { ...models, [modelProvider]: m } })
                          close()
                        }}
                      >
                        {modelLabel(m)}
                      </MenuItem>
                    ))}
                    {!modelList(modelProvider).length && <div className="menu-title">No models found yet</div>}
                  </>
                )}
              </Popover>
            )}

            {!compare && effective !== 'local' && (
              <Popover
                up
                testId="mode-picker"
                title="What the assistant may do on this computer"
                label={
                  <>
                    {MODES.find((m) => m.id === mode)?.label} <IconChevron size={13} />
                  </>
                }
              >
                {(close) => (
                  <>
                    {MODES.map((m) => (
                      <MenuItem
                        key={m.id}
                        selected={mode === m.id}
                        hint={m.hint}
                        testId={`mode-${m.id}`}
                        onClick={() => {
                          change({ mode: m.id })
                          close()
                        }}
                      >
                        {m.label}
                      </MenuItem>
                    ))}
                  </>
                )}
              </Popover>
            )}

            {!compare && effective !== 'local' && mode !== 'chat' && (
              <button type="button" className="chip" title={workspace || 'Choose the folder the assistant works in'} data-testid="folder-picker" onClick={() => void pickFolder()}>
                <IconFolder size={15} /> <span className="chip-path">{workspace ? shortPath(workspace) : 'Choose folder'}</span>
              </button>
            )}

            <span className="spacer" />

            <button type="button" className="icon-btn" title="Attach images or text files" data-testid="attach" onClick={() => void window.api.pickAttachments().then(addAttached)}>
              <IconClip />
            </button>

            {app.prompts.length > 0 && (
              <Popover up align="right" className="icon-btn" title="Saved prompts" label={<IconBook />}>
                {(close) => (
                  <>
                    <div className="menu-title">Saved prompts</div>
                    {app.prompts.map((p) => (
                      <MenuItem
                        key={p.id}
                        hint={p.text.slice(0, 90)}
                        onClick={() => {
                          setText((t) => (t ? `${t}\n${p.text}` : p.text))
                          close()
                          ref.current?.focus()
                        }}
                      >
                        {p.title}
                      </MenuItem>
                    ))}
                  </>
                )}
              </Popover>
            )}

            <button
              type="button"
              className={`icon-btn ${isPrivate ? 'chip on' : ''}`}
              title={isPrivate ? 'Private: this conversation stays on local AI' : 'Make private (local AI only)'}
              aria-pressed={isPrivate}
              data-testid="private-toggle"
              onClick={() => change({ private: !isPrivate })}
            >
              <IconLock />
            </button>

            <Popover
              up
              align="right"
              className={`icon-btn ${compare ? 'chip on' : ''}`}
              title="Compare: ask several assistants at once"
              testId="compare-toggle"
              disabled={isPrivate}
              label={<IconColumns />}
            >
              {() => (
                <>
                  <div className="menu-title">Ask side by side</div>
                  {PROVIDERS.map((p) => {
                    const on = !!compare?.includes(p)
                    return (
                      <MenuItem
                        key={p}
                        selected={on}
                        disabled={!ready(p)}
                        hint={ready(p) ? undefined : 'Not available right now'}
                        testId={`compare-${p}`}
                        onClick={() => {
                          const next = on ? (compare ?? []).filter((x) => x !== p) : [...(compare ?? []), p]
                          setCompare(next.length ? next : null)
                        }}
                      >
                        <ProviderDot provider={p} /> {PROVIDER_LABEL[p]}
                      </MenuItem>
                    )
                  })}
                  <div className="menu-sep" />
                  <MenuItem
                    disabled={readyProviders.length < 2}
                    onClick={() => setCompare(compare && compare.length === readyProviders.length ? null : readyProviders)}
                    hint="Answers appear in columns. Keep the one you like."
                  >
                    {compare && compare.length === readyProviders.length ? 'Turn compare off' : 'Select all available'}
                  </MenuItem>
                </>
              )}
            </Popover>

            {busy ? (
              <button type="button" className="send" title="Stop" data-testid="stop" onClick={() => conversation && void window.api.stop(conversation.id)}>
                <IconStop />
              </button>
            ) : (
              <button type="button" className="send" title="Send" data-testid="send" disabled={(!text.trim() && !attached.length) || (!!compare && compare.length < 2)} onClick={submit}>
                <IconSend />
              </button>
            )}
          </div>
        </div>
        <div className="composer-foot">
          {compare
            ? compare.length > 1
              ? `Comparing ${compare.map((p) => PROVIDER_LABEL[p]).join(', ')}`
              : 'Pick at least two assistants to compare'
            : isPrivate
              ? 'Private conversation. Nothing leaves your own machines.'
              : 'One conversation, any assistant. Switch at any time and the context comes with you.'}
        </div>
      </div>
    </div>
  )
}

/** Read without subscribing, for callers outside React. */
export function currentDraft(): Draft {
  return getState().draft
}
