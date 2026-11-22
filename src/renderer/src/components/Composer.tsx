import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Attachment, Conversation, ProviderChoice, ProviderId, RunMode } from '@shared/types'
import { kindOf, MAX_ATTACHMENTS, PROVIDER_LABEL } from '@shared/types'
import { headroom } from '@shared/usage'
import { insertMention, mentionAt, rankFiles } from '@shared/mention'
import type { AttachResult } from '@shared/ipc'
import type { ModelInfo } from '@shared/models'
import { createFromDraft, getState, openChat, sendQueued, setState, stopChat, toast, unqueue, useUi, type Draft } from '../state'
import { DictationButton } from './Speech'
import { CaptureButton } from './Capture'
import { isWeb } from '../webApi'
import { draftKey, loadDraft, saveDraft } from '../drafts'
import { IconBook, IconChevron, IconClip, IconClose, IconColumns, IconComputer, IconFolder, IconLock, IconSearch, IconSend, IconStop } from '../icons'
import { AttachmentList, fileToBase64 } from './Attachments'
import { HubFolder } from './HubFolder'
import { MenuItem, Popover, ProviderDot, PROVIDERS, providerName } from './ui'

const MODES: { id: RunMode; label: string; hint: string }[] = [
  { id: 'chat', label: 'Chat', hint: 'Conversation only. Nothing on this computer is read or changed.' },
  { id: 'plan', label: 'Plan', hint: 'Can read files in the folder you choose, changes nothing.' },
  { id: 'edit', label: 'Edit', hint: 'Can read and edit files in the folder. Other actions ask first.' },
  { id: 'auto', label: 'Auto', hint: 'Can also run commands in the folder without asking.' }
]

interface SlashCommand {
  name: string
  description: string
}

/** Commands Chaude runs itself, in any chat. */
const APP_COMMANDS: SlashCommand[] = [
  { name: 'usage', description: 'How much of your Claude and ChatGPT plans is used, and when it resets' },
  { name: 'new', description: 'Start a new chat' },
  { name: 'search', description: 'Search your chats' },
  { name: 'settings', description: 'Open settings' }
]

function runAppCommand(name: string): void {
  if (name === 'usage') {
    setState({ dialog: { kind: 'usage' } })
    void window.api.refreshProviders()
  } else if (name === 'new') openChat(undefined)
  else if (name === 'search') setState({ dialog: { kind: 'search' } })
  else if (name === 'settings') setState({ view: { kind: 'settings' } })
}

/** Thinking levels in plain words, lightest first. */
const EFFORT_LABEL: Record<string, { name: string; hint: string }> = {
  low: { name: 'Quick', hint: 'Answers fastest, thinks briefly' },
  medium: { name: 'Balanced', hint: 'Thinks enough for everyday work' },
  high: { name: 'Deep', hint: 'Thinks longer for harder problems' },
  xhigh: { name: 'Deeper', hint: 'Thinks a lot. Slower, uses more of your plan' },
  max: { name: 'Deepest', hint: 'Thinks as long as it needs. Slowest, uses the most' },
  ultra: { name: 'Ultra', hint: 'Deepest thinking, and hands parts of the task to helpers' }
}

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

export function Composer({ conversation, onSend }: { conversation?: Conversation; onSend: (text: string, compare?: ProviderId[], attachments?: Attachment[], research?: boolean, computer?: boolean) => void }) {
  const app = useUi((s) => s.app)!
  const draft = useUi((s) => s.draft)
  // What was typed and attached stays with the chat until it is sent.
  const key = draftKey(conversation?.id, draft.kind)
  const [text, setText] = useState(() => loadDraft(key).text)
  const [compare, setCompare] = useState<ProviderId[] | null>(null)
  const [research, setResearch] = useState(false)
  // In a regular chat: do the next message on this computer instead of on the website.
  const [computer, setComputer] = useState(false)
  const [workspace, setWorkspace] = useState('')
  const [attached, setAttachedState] = useState<Attachment[]>(() => loadDraft(key).attached)
  // Files can arrive several at a time (a drop, a paste), so the latest list is also kept outside React state.
  const attachedRef = useRef<Attachment[]>(attached)
  const setAttached = (list: Attachment[]) => {
    attachedRef.current = list
    setAttachedState(list)
  }
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const busy = conversation ? app.busy.includes(conversation.id) : false
  const queued = useUi((s) => (conversation ? s.queued[conversation.id] : undefined))
  const held = useUi((s) => !!conversation && !!s.held[conversation.id])

  // A regular chat goes through claude.ai or chatgpt.com, so only the choices that make sense there are shown.
  const web = (conversation ? kindOf(conversation) : draft.kind) === 'chat'
  const onSite = !!conversation?.source
  const provider: ProviderChoice = conversation?.provider ?? draft.provider
  const mode: RunMode = conversation?.mode ?? draft.mode
  // With one assistant shown, a new chat always uses it.
  const showOnly = useUi((x) => x.show) !== 'all'
  const isPrivate = conversation?.private ?? draft.private
  const models = conversation?.models ?? draft.models
  const effective: ProviderChoice = isPrivate ? 'local' : provider
  // When the hub allows it, a conversation can run there instead of on this computer.
  const remote = app.remote?.enabled ? app.remote : undefined
  // On the hub itself such a conversation simply runs here, so there is nothing to choose.
  const onHub = !app.settings.hub.hostEnabled && !!(conversation?.runOnHub ?? draft.runOnHub)
  const hubName = remote?.deviceName ?? 'the hub'
  const providers = onHub && remote ? remote.providers : app.providers

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
  const lastKey = useRef(key)
  useEffect(() => {
    // Keep what was typed when a new chat becomes a saved conversation.
    const created = lastId.current === undefined && conversation !== undefined
    lastId.current = conversation?.id
    if (lastKey.current !== key) {
      if (created) {
        saveDraft(lastKey.current, { text: '', attached: [] })
        saveDraft(key, { text, attached: attachedRef.current })
      } else {
        const d = loadDraft(key)
        setText(d.text)
        setAttached(d.attached)
      }
      lastKey.current = key
    }
    setCompare(null)
    setWorkspace('')
    if (conversation) void window.api.getWorkspace(conversation.id).then(setWorkspace)
    ref.current?.focus()
    // The folder is kept per machine, so it is looked up again when the conversation moves to or from the hub.
  }, [key, conversation?.runOnHub])

  // Only a change made in this box is written, under the chat it belongs to.
  useEffect(() => {
    if (lastKey.current === key) saveDraft(key, { text, attached })
  }, [text, attached])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
  }, [text])

  const ready = (p: ProviderId) => !!providers[p]?.ready
  const readyProviders = PROVIDERS.filter(ready)

  // Commands typed with a slash. Chaude's own run here; the assistant's own (like /compact) are sent to it.
  const [slashActive, setSlashActive] = useState(0)
  const slashWord = /^\/([\w:-]*)$/.exec(text)?.[1]
  const toolCommands = !web && effective === 'claude' ? (providers.claude?.commands ?? []) : []
  const slashAll: (SlashCommand & { app?: boolean })[] = [
    ...APP_COMMANDS.map((c) => ({ ...c, app: true })),
    ...toolCommands.filter((c) => !APP_COMMANDS.some((a) => a.name === c.name))
  ]
  const slashList = slashWord === undefined ? [] : slashAll.filter((c) => c.name.toLowerCase().startsWith(slashWord.toLowerCase())).slice(0, 8)
  useEffect(() => setSlashActive(0), [slashWord])
  const pickSlash = (c: SlashCommand & { app?: boolean }) => {
    if (c.app) {
      setText('')
      runAppCommand(c.name)
      return
    }
    setText(`/${c.name} `)
    ref.current?.focus()
  }

  // In a code chat on this computer, @ mentions a file of its folder.
  const [caret, setCaret] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const [mentionActive, setMentionActive] = useState(0)
  // Escape closes the list for that one @.
  const [mentionShut, setMentionShut] = useState(-1)
  const canMention = !web && !onHub && !isWeb()
  const typed = canMention && slashWord === undefined ? mentionAt(text, caret) : undefined
  const mention = typed && typed.start !== mentionShut ? typed : undefined
  const wantFiles = mention !== undefined
  useEffect(() => {
    if (!wantFiles || !workspace) return
    let live = true
    void window.api.listFolderFiles(workspace).then((list) => live && setFiles(list), () => live && setFiles([]))
    return () => {
      live = false
    }
  }, [wantFiles, workspace])
  const mentionList = mention && workspace ? rankFiles(files, mention.query) : []
  // Without a folder there are no files to offer, so @ says how to get some.
  const folderHint = !!mention && !workspace
  useEffect(() => setMentionActive(0), [mention?.query])
  const pickMention = (file: string) => {
    if (!mention) return
    const next = insertMention(text, mention, file)
    setText(next.text)
    setCaret(next.caret)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(next.caret, next.caret)
    })
  }
  const trackCaret = (e: { currentTarget: HTMLTextAreaElement }) => setCaret(e.currentTarget.selectionStart ?? 0)

  const submit = () => {
    const value = text.trim()
    // Chaude's own commands run here and are not sent.
    const own = /^\/([\w-]+)$/.exec(value)?.[1]
    if (own && APP_COMMANDS.some((c) => c.name === own)) {
      setText('')
      runAppCommand(own)
      return
    }
    if (!value && !attached.length) return
    setText('')
    setAttached([])
    onSend(value, compare && compare.length > 1 ? compare : undefined, attached.length ? attached : undefined, research || undefined, (web && computer) || undefined)
    setResearch(false)
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

  /** Sets the folder on the hub. The hub checks it, and its complaint is returned if it has one. */
  const setHubFolder = async (path: string): Promise<string | undefined> => {
    const conv = conversation ?? (await createFromDraft())
    const result = await window.api.setWorkspacePath(conv.id, path)
    if (result.error) return result.error
    setWorkspace(result.path)
    return undefined
  }

  const modelList = (p: ProviderId): string[] => {
    if (p === 'local') return app.localModels.map((m) => `${m.endpointId}/${m.id}`)
    const fromStatus = providers[p]?.models ?? []
    const configured = p === 'claude' ? app.settings.claude.models : app.settings.chatgpt.models
    return [...new Set([...fromStatus, ...configured])]
  }

  const modelProvider: ProviderId | undefined = effective === 'auto' ? undefined : effective
  const currentModel = modelProvider ? (models[modelProvider] ?? '') : ''
  // The plan's models as the tool describes them: a versioned name, one line on what each is for, older ones apart.
  const catalog = modelProvider && modelProvider !== 'local' ? (providers[modelProvider]?.catalog ?? []) : []
  const catalogDefault = catalog.find((m) => m.isDefault)
  // A ChatGPT website chat offers the site's own models.
  const [webCatalog, setWebCatalog] = useState<ModelInfo[]>([])
  useEffect(() => {
    if (!web || provider !== 'chatgpt' || isWeb()) return
    let live = true
    void window.api.webModels('chatgpt').then((list) => live && setWebCatalog(list))
    return () => {
      live = false
    }
  }, [web, provider])
  const webModel = web ? (models.chatgpt ?? '') : ''

  // How hard the chosen model thinks, when the tool offers levels for it.
  const currentInfo = catalog.find((x) => x.id === currentModel) ?? catalogDefault
  const efforts = currentInfo?.efforts ?? []
  const effort = conversation?.effort ?? draft.effort ?? ''
  const modelLabel = (m: string) => {
    if (!m) return catalogDefault ? (modelProvider === 'claude' ? catalogDefault.name : `Default (${catalogDefault.name})`) : 'Default model'
    const known = catalog.find((x) => x.id === m)
    return known ? known.name : m.includes('/') ? m.slice(m.indexOf('/') + 1) : m
  }

  return (
    <div className="composer-wrap">
      <div className="composer-col">
        {conversation && !!queued?.length && (
          <div className="queue" data-testid="queue">
            <div className="queue-head">
              <span>{held ? 'Waiting. The answer was stopped.' : busy ? 'Sends when this answer finishes' : 'Sending'}</span>
              {held && !busy && (
                <button type="button" className="btn btn-small" data-testid="queue-send" onClick={() => sendQueued(conversation.id, true)}>
                  Send now
                </button>
              )}
            </div>
            {queued.map((q) => (
              <div key={q.id} className="queue-item" data-testid="queued-message">
                <span className="queue-text">{q.text || 'Files only'}</span>
                {!!q.attachments?.length && <span className="queue-files">{q.attachments.length === 1 ? '1 file' : `${q.attachments.length} files`}</span>}
                <button
                  type="button"
                  className="icon-btn queue-edit"
                  title="Edit"
                  onClick={() => {
                    // Back into the message box, after anything already typed there.
                    setText(text.trim() ? `${text.trimEnd()}\n${q.text}` : q.text)
                    setAttached([...attachedRef.current, ...(q.attachments ?? [])].slice(0, MAX_ATTACHMENTS))
                    setState((s) => ({ queued: { ...s.queued, [conversation.id]: (s.queued[conversation.id] ?? []).filter((x) => x.id !== q.id) } }))
                    ref.current?.focus()
                  }}
                >
                  Edit
                </button>
                <button type="button" className="icon-btn" title="Remove" data-testid="unqueue" onClick={() => unqueue(conversation.id, q.id)}>
                  <IconClose size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          className={`composer ${dragging ? 'dragging' : ''} ${busy ? 'working' : ''}`}
          style={busy ? { ['--work' as string]: `var(--${effective})` } : undefined}
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
          {slashList.length > 0 && (
            <div className="slash-menu" role="listbox" data-testid="slash-menu">
              {slashList.map((c, i) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={i === slashActive}
                  key={`${c.app ? 'app' : 'tool'}-${c.name}`}
                  className={`slash-item ${i === slashActive ? 'active' : ''}`}
                  data-testid="slash-item"
                  onMouseMove={() => setSlashActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickSlash(c)
                  }}
                >
                  <span className="slash-name">/{c.name}</span>
                  <span className="slash-hint">{c.description}</span>
                  {!c.app && <span className="slash-where">{providerName(effective)}</span>}
                </button>
              ))}
            </div>
          )}
          {mentionList.length > 0 && (
            <div className="slash-menu" role="listbox" data-testid="mention-menu">
              {mentionList.map((f, i) => {
                const slash = f.lastIndexOf('/')
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === mentionActive}
                    key={f}
                    className={`slash-item ${i === mentionActive ? 'active' : ''}`}
                    data-testid="mention-item"
                    onMouseMove={() => setMentionActive(i)}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      pickMention(f)
                    }}
                  >
                    <span className="slash-name">{slash >= 0 ? f.slice(slash + 1) : f}</span>
                    <span className="slash-hint">{slash >= 0 ? f.slice(0, slash) : ''}</span>
                  </button>
                )
              })}
            </div>
          )}
          {folderHint && (
            <div className="slash-menu" data-testid="mention-menu">
              <button
                type="button"
                className="slash-item active"
                data-testid="mention-choose-folder"
                onMouseDown={(e) => {
                  e.preventDefault()
                  void pickFolder()
                }}
              >
                <span className="slash-name">Choose a folder</span>
                <span className="slash-hint">to mention its files with @</span>
              </button>
            </div>
          )}
          <textarea
            ref={ref}
            rows={1}
            value={text}
            data-testid="composer-input"
            placeholder={compare ? 'Ask all selected assistants at once' : effective === 'auto' ? 'Ask anything' : `Message ${providerName(effective)}`}
            onChange={(e) => {
              setText(e.target.value)
              trackCaret(e)
            }}
            onSelect={trackCaret}
            onClick={trackCaret}
            onPaste={(e) => {
              // A pasted screenshot or copied file becomes an attachment. Pasted text is left alone.
              const files = [...e.clipboardData.files]
              if (!files.length) return
              e.preventDefault()
              void addFiles(files)
            }}
            onKeyDown={(e) => {
              if (mentionList.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault()
                setMentionActive((i) => (i + (e.key === 'ArrowDown' ? 1 : mentionList.length - 1)) % mentionList.length)
                return
              }
              if (mentionList.length && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
                e.preventDefault()
                pickMention(mentionList[Math.min(mentionActive, mentionList.length - 1)])
                return
              }
              if ((mentionList.length || folderHint) && e.key === 'Escape') {
                e.preventDefault()
                setMentionShut(mention!.start)
                return
              }
              if (slashList.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault()
                setSlashActive((i) => (i + (e.key === 'ArrowDown' ? 1 : slashList.length - 1)) % slashList.length)
                return
              }
              if (slashList.length && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
                e.preventDefault()
                pickSlash(slashList[Math.min(slashActive, slashList.length - 1)])
                return
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <div className="composer-row">
            {web ? (
              <Popover
                up
                testId="provider-picker"
                disabled={onSite || showOnly}
                title={onSite ? `This chat lives on ${provider === 'chatgpt' ? 'chatgpt.com' : 'claude.ai'}` : 'Where this chat lives'}
                label={
                  <>
                    <ProviderDot provider={provider === 'chatgpt' ? 'chatgpt' : 'claude'} /> {provider === 'chatgpt' ? 'ChatGPT' : 'Claude'} {!onSite && !showOnly && <IconChevron size={13} />}
                  </>
                }
              >
                {(close) => (
                  <>
                    {(['claude', 'chatgpt'] as const).map((p) => (
                      <MenuItem
                        key={p}
                        selected={provider === p}
                        hint={p === 'claude' ? 'On claude.ai: shows up in the Claude apps too' : 'On chatgpt.com: shows up in the ChatGPT apps too'}
                        testId={`provider-${p}`}
                        onClick={() => {
                          change({ provider: p })
                          close()
                        }}
                      >
                        <ProviderDot provider={p} /> {PROVIDER_LABEL[p]}
                      </MenuItem>
                    ))}
                  </>
                )}
              </Popover>
            ) : (
            <Popover
              up
              testId="provider-picker"
              disabled={isPrivate || !!compare || showOnly}
              title={showOnly ? 'The app shows one assistant only. Change it from the app name at the top of the sidebar.' : 'Which assistant answers'}
              label={
                <>
                  <ProviderDot provider={effective} /> {providerName(effective)} {!showOnly && <IconChevron size={13} />}
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
                    const st = providers[p]
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
            )}

            {modelProvider && !compare && !web && (
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
                      hint={modelProvider === 'local' ? 'First available local model' : catalogDefault ? catalogDefault.description || 'What the service recommends for your plan' : 'Whatever the service picks for your plan'}
                      onClick={() => {
                        change({ models: { ...models, [modelProvider]: '' } })
                        close()
                      }}
                    >
                      {modelLabel('')}
                    </MenuItem>
                    {catalog.length > 0 &&
                      (() => {
                        const pick = (id: string) => {
                          // A thinking level the new model does not have goes back to its default.
                          const keeps = !effort || !!catalog.find((m) => m.id === id)?.efforts?.includes(effort)
                          change({ models: { ...models, [modelProvider]: id }, ...(keeps ? {} : { effort: '' }) })
                          close()
                        }
                        // Claude's own "default" entry is the same as the first item above.
                        const listed = catalog.filter((m) => !(modelProvider === 'claude' && m.id === 'default'))
                        const current = listed.filter((m) => !m.legacy)
                        const older = listed.filter((m) => m.legacy)
                        return (
                          <>
                            {current.map((m) => (
                              <MenuItem key={m.id} selected={currentModel === m.id} hint={m.description} testId="model-option" onClick={() => pick(m.id)}>
                                {m.name}
                              </MenuItem>
                            ))}
                            {older.length > 0 && (
                              <details className="menu-more" open={older.some((m) => m.id === currentModel)}>
                                <summary data-testid="more-models">More models</summary>
                                {older.map((m) => (
                                  <MenuItem key={m.id} selected={currentModel === m.id} hint={m.description} testId="model-option" onClick={() => pick(m.id)}>
                                    {m.name}
                                  </MenuItem>
                                ))}
                              </details>
                            )}
                          </>
                        )
                      })()}
                    {!catalog.length && modelList(modelProvider).map((m) => (
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
                    {!catalog.length && !modelList(modelProvider).length && <div className="menu-title">No models found yet</div>}
                  </>
                )}
              </Popover>
            )}

            {web && provider === 'chatgpt' && webCatalog.length > 0 && (
              <Popover
                up
                testId="model-picker"
                title="Model"
                label={
                  <>
                    <span className="chip-path">{webCatalog.find((m) => m.id === webModel)?.name ?? 'Default model'}</span> <IconChevron size={13} />
                  </>
                }
              >
                {(close) => {
                  const pick = (id: string) => {
                    change({ models: { ...models, chatgpt: id } })
                    close()
                  }
                  const older = webCatalog.filter((m) => m.legacy)
                  return (
                    <>
                      <MenuItem selected={!webModel} hint="What chatgpt.com picks for your plan" onClick={() => pick('')}>
                        Default model
                      </MenuItem>
                      {webCatalog
                        .filter((m) => !m.legacy)
                        .map((m) => (
                          <MenuItem key={m.id} selected={webModel === m.id} hint={m.description} testId="model-option" onClick={() => pick(m.id)}>
                            {m.name}
                          </MenuItem>
                        ))}
                      {older.length > 0 && (
                        <details className="menu-more" open={older.some((m) => m.id === webModel)}>
                          <summary data-testid="more-models">More models</summary>
                          {older.map((m) => (
                            <MenuItem key={m.id} selected={webModel === m.id} hint={m.description} testId="model-option" onClick={() => pick(m.id)}>
                              {m.name}
                            </MenuItem>
                          ))}
                        </details>
                      )}
                    </>
                  )
                }}
              </Popover>
            )}

            {!compare && !web && efforts.length > 0 && (
              <Popover
                up
                testId="effort-picker"
                title="How hard the model thinks before answering"
                label={
                  <>
                    {effort ? EFFORT_LABEL[effort]?.name ?? effort : 'Thinking'} <IconChevron size={13} />
                  </>
                }
              >
                {(close) => (
                  <>
                    <MenuItem
                      selected={!effort}
                      hint="The model's own choice"
                      onClick={() => {
                        change({ effort: '' })
                        close()
                      }}
                    >
                      Default thinking
                    </MenuItem>
                    {efforts.map((e) => (
                      <MenuItem
                        key={e}
                        selected={effort === e}
                        hint={EFFORT_LABEL[e]?.hint}
                        testId={`effort-${e}`}
                        onClick={() => {
                          change({ effort: e })
                          close()
                        }}
                      >
                        {EFFORT_LABEL[e]?.name ?? e}
                      </MenuItem>
                    ))}
                  </>
                )}
              </Popover>
            )}

            {!compare && !web && effective !== 'local' && (
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

            {!compare && effective !== 'local' && mode !== 'chat' && !onHub && (
              <button type="button" className="chip" title={workspace || 'Choose the folder the assistant works in'} data-testid="folder-picker" onClick={() => void pickFolder()}>
                <IconFolder size={15} /> <span className="chip-path">{workspace ? shortPath(workspace) : 'Choose folder'}</span>
              </button>
            )}

            {!compare && effective !== 'local' && mode !== 'chat' && onHub && (
              <Popover
                up
                testId="hub-folder-picker"
                title={workspace || `Choose the folder on ${hubName} the assistant works in`}
                label={
                  <>
                    <IconFolder size={15} /> <span className="chip-path">{workspace ? shortPath(workspace) : 'Choose folder'}</span>
                  </>
                }
              >
                {(close) => (
                  <HubFolder
                    hubName={hubName}
                    platform={remote?.platform}
                    current={workspace}
                    onUse={async (path) => {
                      const error = await setHubFolder(path)
                      if (!error) close()
                      return error
                    }}
                  />
                )}
              </Popover>
            )}

            {(remote || onHub) && !app.settings.hub.hostEnabled && !compare && !web && (
              <Popover
                up
                testId="runs-on-picker"
                title="Which computer does the work"
                label={
                  <>
                    <IconComputer size={15} /> <span className="chip-path">{onHub ? hubName : 'This computer'}</span> <IconChevron size={13} />
                  </>
                }
              >
                {(close) => (
                  <>
                    <div className="menu-title">Runs on</div>
                    <MenuItem
                      selected={!onHub}
                      hint="Uses the assistants signed in here"
                      testId="runs-on-here"
                      onClick={() => {
                        change({ runOnHub: false })
                        close()
                      }}
                    >
                      This computer
                    </MenuItem>
                    <MenuItem
                      selected={onHub}
                      disabled={!remote}
                      hint={remote ? "Uses the hub's sign-ins and files, and keeps going if this computer sleeps" : 'Not reachable right now, or not allowed by the hub'}
                      testId="runs-on-hub"
                      onClick={() => {
                        change({ runOnHub: true })
                        close()
                      }}
                    >
                      {hubName}
                    </MenuItem>
                  </>
                )}
              </Popover>
            )}

            <span className="spacer" />
            <div className="composer-actions">

            <DictationButton onText={(t) => setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${t}` : t))} />

            {web && !isWeb() && (
              <button
                type="button"
                className={`icon-btn ${computer ? 'chip on' : ''}`}
                title={computer ? 'Use this computer is on: this message runs here, with access to your files and apps' : 'Use this computer for this message: files, commands and apps'}
                aria-pressed={computer}
                data-testid="computer-toggle"
                onClick={() => setComputer((c) => !c)}
              >
                <IconComputer />
              </button>
            )}

            {web && computer && (
              <button type="button" className="chip" title={workspace || 'Choose the folder it works in'} data-testid="folder-picker" onClick={() => void pickFolder()}>
                <IconFolder size={14} /> {workspace ? shortPath(workspace) : 'Choose folder'}
              </button>
            )}

            {!isWeb() && <CaptureButton onAttached={addAttached} />}

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

            {!web && (
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
            )}

            {!web && (
            <button
              type="button"
              className={`icon-btn ${research ? 'chip on' : ''}`}
              title={research ? 'Research is on: the assistant searches widely and writes a report with sources' : 'Research: search widely and write a report with sources'}
              aria-pressed={research}
              data-testid="research-toggle"
              disabled={isPrivate}
              onClick={() => setResearch((r) => !r)}
            >
              <IconSearch />
            </button>
            )}

            {!web && (
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
            )}

            {busy && (
              <button type="button" className="send stop" title="Stop" data-testid="stop" onClick={() => conversation && stopChat(conversation.id)}>
                <IconStop />
              </button>
            )}
            {(!busy || !!text.trim() || !!attached.length) && (
              <button type="button" className="send" title={busy ? 'Send when this answer finishes' : 'Send'} data-testid="send" disabled={(!text.trim() && !attached.length) || (!!compare && compare.length < 2)} onClick={submit}>
                <IconSend />
              </button>
            )}
            </div>
          </div>
        </div>
        <div className="composer-foot">
          {web && computer
            ? `This message runs on this computer with ${provider === 'chatgpt' ? 'Codex' : 'Claude Code'}. It asks before changing anything outside the folder, and the website hears about it with your next message.`
            : web
            ? provider === 'chatgpt'
              ? 'This chat lives on chatgpt.com, so it shows up in the ChatGPT apps too.'
              : 'This chat lives on claude.ai, so it shows up in the Claude apps too.'
            : compare
            ? compare.length > 1
              ? `Comparing ${compare.map((p) => PROVIDER_LABEL[p]).join(', ')}`
              : 'Pick at least two assistants to compare'
            : isPrivate
              ? 'Private conversation. Nothing leaves your own machines.'
              : onHub
                ? remote
                  ? `Runs on ${hubName}. You can close this computer and the work carries on.`
                  : 'Set to run on the hub, which is not reachable right now. Use "Runs on" to continue on this computer.'
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
