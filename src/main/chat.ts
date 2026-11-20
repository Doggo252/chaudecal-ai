// The conversation engine. It owns the one thread a conversation has, decides
// which provider answers each turn, catches that provider up on anything it has
// not seen, records usage, and keeps the running context files current.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  Blob,
  Conversation,
  HandoffVariant,
  McpServer,
  MemoryNote,
  Message,
  PermissionDenial,
  Profile,
  Project,
  ProviderChoice,
  ProviderId,
  ProviderStatus,
  ProviderUsage,
  RouteDecision,
  RunEvent,
  RunMode,
  Settings
} from '@shared/types'
import { MAX_ATTACHMENTS, newId, PROVIDER_LABEL } from '@shared/types'
import { FORM_GUIDE } from '@shared/forms'
import {
  buildHandoff,
  composeChatMessages,
  composePrompt,
  messageBody,
  planTurn,
  providerBudget,
  sharedSystemText,
  projectSystemText,
  ARTIFACT_GUIDE,
  RESEARCH_GUIDE,
  threadMessages,
  titleFromText,
  type HandoffResult,
  type SessionState,
  type TurnPlan
} from '@shared/context'
import { activeMcpServers } from '@shared/mcp'
import { estimateTokens } from '@shared/tokens'
import { route, switchTarget } from '@shared/router'
import { addTokens, applyLimits, emptyUsage, expireWindows } from '@shared/usage'
import type { SendInput } from '@shared/ipc'
import type { Store } from './store'
import type { Provider, RunHandle, RunImage } from './providers/types'
import { imageFile } from './attachments'
import { normalizeMcpServer } from './mcp'
import type { Summarizer } from './summarizer'

export interface ChatEvents {
  /** A message changed while streaming. Not yet saved. */
  stream(message: Message): void
  route(conversationId: string, decision: RouteDecision): void
  /** With `settled`, the request was answered or withdrawn and its card should go away. */
  approval(conversationId: string, messageId: string, request: ApprovalRequest, settled?: boolean): void
  denials(conversationId: string, messageId: string, denials: PermissionDenial[]): void
  busy(conversationId: string, busy: boolean): void
}

/** Images from earlier in the conversation that are sent again when a provider is caught up. */
const EARLIER_IMAGES = 4

interface Active {
  handles: RunHandle[]
  /** message id to run handle, for approvals. */
  byMessage: Map<string, RunHandle>
  /** Approval requests still waiting for an answer, by request id. */
  approvals: Map<string, ApprovalRequest>
}

export class ChatEngine {
  private active = new Map<string, Active>()

  constructor(
    private store: Store,
    private settings: () => Settings,
    private providers: Record<ProviderId, Provider>,
    private statuses: () => Partial<Record<ProviderId, ProviderStatus>>,
    private events: ChatEvents,
    private dirs: { context: string; scratch: string; attachments: string },
    private summarizer: Summarizer
  ) {
    mkdirSync(dirs.context, { recursive: true })
    mkdirSync(dirs.scratch, { recursive: true })
  }

  /** The tool servers that are switched on for this device. */
  mcpServers(): McpServer[] {
    return activeMcpServers(
      this.store.list<Partial<McpServer> & { id: string }>('mcp').map(normalizeMcpServer),
      this.store.deviceId
    )
  }

  // ----- conversations -----

  /** Adds a message of the user's without asking for a reply, for example an edited artifact. */
  addUserMessage(conversationId: string, text: string): Message {
    if (!this.store.get<Conversation>('conversation', conversationId)) throw new Error('That conversation no longer exists.')
    if (this.active.has(conversationId)) throw new Error('This conversation is still answering.')
    const message: Message = { id: newId(), conversationId, role: 'user', text: text.slice(0, 2_000_000), createdAt: Date.now(), deviceId: this.store.deviceId, status: 'complete' }
    this.store.put('message', message.id, message)
    this.updateConversation(conversationId, { updatedAt: Date.now() })
    this.writeContextFiles(conversationId)
    return message
  }

  createConversation(partial: Partial<Conversation> = {}): Conversation {
    const s = this.settings()
    const now = Date.now()
    const conv: Conversation = {
      id: newId(),
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      provider: s.defaultProvider,
      models: {},
      mode: s.defaultMode,
      ...partial
    }
    this.store.put('conversation', conv.id, conv)
    return conv
  }

  updateConversation(id: string, patch: Partial<Conversation>): Conversation | undefined {
    const conv = this.store.get<Conversation>('conversation', id)
    if (!conv) return undefined
    const next = { ...conv, ...patch, id: conv.id }
    this.store.put('conversation', id, next)
    return next
  }

  isBusy(conversationId: string): boolean {
    return this.active.has(conversationId)
  }

  // ----- per machine state -----

  private sessionKey(conversationId: string, provider: ProviderId): string {
    return `session:${conversationId}:${provider}`
  }

  workspace(conversationId: string): string {
    return this.store.kvGet<string>(`cwd:${conversationId}`) ?? ''
  }

  setWorkspace(conversationId: string, path: string): void {
    if (path) this.store.kvSet(`cwd:${conversationId}`, path)
    else this.store.kvDelete(`cwd:${conversationId}`)
    // A session is tied to its folder. A new folder means a new session, caught up from the context file.
    this.store.kvDeletePrefix(`session:${conversationId}:`)
    // Permission given for one folder does not carry over to another.
    this.store.kvDelete(`grants:${conversationId}`)
  }

  /** Rules the user allowed "for this chat". They stay on this device and apply to Claude's later turns. */
  private grants(conversationId: string): string[] {
    return this.store.kvGet<string[]>(`grants:${conversationId}`) ?? []
  }

  // ----- usage -----

  usage(provider: ProviderId): ProviderUsage {
    const now = Date.now()
    return expireWindows(this.store.get<ProviderUsage>('usage', provider) ?? emptyUsage(provider, now), now)
  }

  allUsage(): Record<ProviderId, ProviderUsage> {
    return { claude: this.usage('claude'), chatgpt: this.usage('chatgpt'), local: this.usage('local') }
  }

  recordLimits(provider: ProviderId, patch: Parameters<typeof applyLimits>[1]): void {
    const next = applyLimits(this.usage(provider), patch, this.settings().warnThresholdPct, Date.now())
    this.store.put('usage', provider, next)
  }

  private recordTokens(provider: ProviderId, tokens: number): void {
    this.store.put('usage', provider, addTokens(this.usage(provider), tokens, Date.now()))
  }

  // ----- shared instructions -----

  private profileText(): string {
    return this.store.get<Profile>('profile', 'profile')?.instructions ?? ''
  }

  private systemText(conv?: Conversation, provider?: ProviderId): string {
    const notes = this.store
      .list<MemoryNote>('note')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((n) => n.text)
    const shared = sharedSystemText(this.profileText(), notes)
    const project = conv?.projectId ? this.store.get<Project>('project', conv.projectId) : undefined
    // A local model's window is small. Its files get about a quarter of it: as many characters as the window has tokens.
    const room = provider === 'local' ? Math.max(2000, providerBudget('local', this.settings())) : 400_000
    const projectText = projectSystemText(project, room)
    return [shared, projectText, this.settings().artifacts === false ? '' : `${ARTIFACT_GUIDE}\n\n${FORM_GUIDE}`].filter(Boolean).join('\n\n')
  }

  // ----- context files -----

  handoff(conversationId: string, variant: HandoffVariant, target?: ProviderId): HandoffResult | undefined {
    const conv = this.store.get<Conversation>('conversation', conversationId)
    if (!conv) return undefined
    const s = this.settings()
    const budget = target ? providerBudget(target, s, conv.models[target]) : 400_000
    return buildHandoff({ conversation: conv, messages: threadMessages(this.store.messages(conversationId)), variant, budgetTokens: budget, profile: this.profileText() })
  }

  contextDir(conversationId: string): string {
    return join(this.dirs.context, conversationId)
  }

  /** Rewrite both context files so they are ready the moment a switch is wanted. */
  writeContextFiles(conversationId: string): void {
    try {
      const dir = this.contextDir(conversationId)
      mkdirSync(dir, { recursive: true })
      for (const variant of ['summary', 'full'] as const) {
        const h = this.handoff(conversationId, variant)
        if (h) writeFileSync(join(dir, `${variant}.md`), h.text, 'utf8')
      }
    } catch {
      // The files are a convenience copy. The database is the source of truth.
    }
  }

  // ----- routing -----

  private availability(): Record<ProviderId, boolean> {
    const st = this.statuses()
    return { claude: !!st.claude?.ready, chatgpt: !!st.chatgpt?.ready, local: !!st.local?.ready }
  }

  private choose(conv: Conversation, text: string, prior: Message[], override?: ProviderId, research?: boolean): RouteDecision {
    // Private comes first: nothing may send a private conversation to a cloud service.
    if (conv.private) return { provider: 'local', reason: 'This conversation is private, so it stays on local AI.' }
    if (override) return { provider: override, reason: '' }
    if (conv.provider !== 'auto') return { provider: conv.provider, reason: '' }
    // Research needs the web, which local models do not have here.
    if (research) {
      const can = this.availability()
      const pick = (['claude', 'chatgpt'] as const).find((p) => can[p])
      if (pick) return { provider: pick, reason: `Auto chose ${PROVIDER_LABEL[pick]} for research, because it can search the web.` }
    }
    const s = this.settings()
    const last = [...prior].reverse().find((m) => m.role === 'assistant' && m.provider)?.provider
    return route({
      text,
      mode: conv.mode,
      hasWorkspace: !!this.workspace(conv.id),
      private: !!conv.private,
      available: this.availability(),
      usage: this.allUsage(),
      lastProvider: last,
      contextTokens: prior.reduce((n, m) => n + estimateTokens(m.text), 0),
      localContextTokens: s.local.contextTokens,
      preferLocalForShort: s.routing.preferLocalForShort
    })
  }

  // ----- sending -----

  async send(input: SendInput): Promise<void> {
    const conv = this.store.get<Conversation>('conversation', input.conversationId)
    if (!conv) throw new Error('That conversation no longer exists.')
    if (this.active.has(conv.id)) throw new Error('This conversation is still answering.')

    const all = this.store.messages(conv.id)
    let prior = threadMessages(all)
    let userText = input.text.trim()
    let userMessage: Message | undefined
    const attachments = this.cleanAttachments(input.attachments)

    if (input.edit) {
      // An earlier question, changed. What came after it no longer fits, so it goes, and the question is answered again.
      const idx = all.findIndex((m) => m.id === input.edit)
      const original = all[idx]
      if (!original || original.role !== 'user') throw new Error('That question can no longer be changed.')
      if (!userText && !original.attachments?.length) throw new Error('Write something to ask.')
      for (const m of all.slice(idx + 1)) this.store.remove('message', m.id)
      userMessage = { ...original, text: userText }
      this.store.put('message', userMessage.id, userMessage)
      this.updateConversation(conv.id, { updatedAt: Date.now(), ...(idx === 0 && conv.title === titleFromText(original.text) ? { title: titleFromText(userText) } : {}) })
      // An assistant that saw the old version is caught up from scratch, because the message it last saw is gone.
      prior = threadMessages(all.slice(0, idx))
      userText = messageBody(userMessage)
    } else if (input.retry) {
      // Answer the last user message again. Failed or stopped replies after it are removed.
      const lastUserIdx = all.map((m) => m.role).lastIndexOf('user')
      if (lastUserIdx < 0) throw new Error('There is nothing to retry.')
      userMessage = all[lastUserIdx]
      userText = messageBody(userMessage)
      for (const m of all.slice(lastUserIdx + 1)) if (m.role !== 'user') this.store.remove('message', m.id)
      prior = threadMessages(all.slice(0, lastUserIdx))
    } else {
      if (!userText && !attachments.length) return
      userMessage = { id: newId(), conversationId: conv.id, role: 'user', text: userText, createdAt: Date.now(), deviceId: this.store.deviceId, status: 'complete', ...(input.research ? { research: true } : {}) }
      if (attachments.length) userMessage.attachments = attachments
      this.store.put('message', userMessage.id, userMessage)
      const patch: Partial<Conversation> = { updatedAt: Date.now() }
      if (!prior.length && (conv.title === 'New chat' || !conv.title)) patch.title = titleFromText(userText || attachments[0].name)
      this.updateConversation(conv.id, patch)
      // From here on the text is what an assistant reads: the message plus its attached files.
      userText = messageBody(userMessage)
    }

    const active: Active = { handles: [], byMessage: new Map(), approvals: new Map() }
    this.active.set(conv.id, active)
    this.events.busy(conv.id, true)

    try {
      if (input.compare && input.compare.length > 1) {
        const group = newId()
        await Promise.all(input.compare.map((p, i) => this.runTurn({ conv, provider: p, prior, userText, userMessage: userMessage!, active, variant: 'summary', compareGroup: group, order: i })))
      } else {
        const decision = this.choose(conv, userText, prior, input.provider, !!userMessage.research)
        if (decision.reason) this.events.route(conv.id, decision)
        const variant = input.variant ?? 'summary'
        const reply = await this.runTurn({ conv, provider: decision.provider, prior, userText, userMessage, active, variant, allow: input.allow })
        const next = this.failoverTarget(conv, decision.provider, reply)
        if (next) {
          const from = decision.provider
          // A reply that got part of the way stays in the thread, and the next assistant carries on from it.
          const partial = !!reply.text.trim()
          if (!partial) this.store.remove('message', reply.id)
          const note: Message = { id: newId(), conversationId: conv.id, role: 'note', text: `${PROVIDER_LABEL[from]} reached its limit. Continued on ${PROVIDER_LABEL[next]}.`, createdAt: Date.now(), deviceId: this.store.deviceId, status: 'complete' }
          this.store.put('message', note.id, note)
          if (conv.provider === from) this.updateConversation(conv.id, { provider: next })
          await this.runTurn({
            conv,
            provider: next,
            prior: partial ? threadMessages(this.store.messages(conv.id)) : prior,
            userText: partial ? 'The previous assistant ran out of usage before it finished. Continue from where it stopped.' : userText,
            userMessage,
            active,
            variant
          })
        }
      }
    } finally {
      this.active.delete(conv.id)
      this.events.busy(conv.id, false)
      this.writeContextFiles(conv.id)
      void this.summarizer.maybeSummarize(conv.id)
    }
  }

  private async runTurn(args: {
    conv: Conversation
    provider: ProviderId
    prior: Message[]
    userText: string
    userMessage: Message
    active: Active
    variant: HandoffVariant
    compareGroup?: string
    order?: number
    allow?: string[]
  }): Promise<Message> {
    const { conv, provider, prior, userText } = args
    const s = this.settings()
    const compare = !!args.compareGroup
    const mode: RunMode = compare ? 'chat' : conv.mode
    const model = conv.models[provider] ?? (provider === 'claude' ? s.claude.defaultModel : provider === 'chatgpt' ? s.chatgpt.defaultModel : s.local.defaultModel)
    // A research question gets its instructions on top of the usual ones.
    const system = [this.systemText(conv, provider), args.userMessage.research ? RESEARCH_GUIDE : ''].filter(Boolean).join('\n\n')
    const budget = providerBudget(provider, s, model)
    const cwd = this.workspace(conv.id) || this.dirs.scratch

    // Compare answers are one-off: they never continue or create a provider session.
    const session = compare ? undefined : this.store.kvGet<SessionState>(this.sessionKey(conv.id, provider))
    const plan = planTurn(prior, session)
    const prompt = composePrompt({ plan, userText, conversation: conv, variant: args.variant, budgetTokens: budget, profile: this.profileText() })
    const messages = provider === 'local' ? composeChatMessages({ conversation: conv, prior, userText, budgetTokens: budget, system }) : undefined
    const images = this.imagesFor(plan, args.userMessage)

    const message: Message = {
      id: newId(),
      conversationId: conv.id,
      role: 'assistant',
      text: '',
      // Keep compare answers in a stable order, right after the question.
      createdAt: Math.max(Date.now(), args.userMessage.createdAt + 1) + (args.order ?? 0),
      deviceId: this.store.deviceId,
      provider,
      model: model || undefined,
      status: 'streaming',
      variantGroup: args.compareGroup,
      selected: compare ? false : undefined
    }
    this.events.stream(message)

    let sessionId = plan.kind === 'resume' || plan.kind === 'catchup' ? plan.sessionId : undefined
    let lastFlush = 0
    const flush = (force = false) => {
      const now = Date.now()
      if (!force && now - lastFlush < 60) return
      lastFlush = now
      this.events.stream({ ...message, tools: message.tools ? [...message.tools] : undefined })
    }

    const onEvent = (event: RunEvent) => {
      switch (event.type) {
        case 'text':
          message.text += event.delta
          flush()
          break
        case 'thinking':
          message.thinking = (message.thinking ?? '') + event.delta
          flush()
          break
        case 'tool': {
          const tools = message.tools ?? (message.tools = [])
          const idx = tools.findIndex((t) => t.id === event.tool.id)
          if (idx >= 0) tools[idx] = event.tool
          else tools.push(event.tool)
          flush(true)
          break
        }
        case 'plan':
          message.plan = event.steps
          flush(true)
          break
        case 'image': {
          const id = newId()
          const name = `image-${(message.images?.length ?? 0) + 1}.${event.mime === 'image/jpeg' ? 'jpg' : 'png'}`
          this.store.put('blob', id, { id, name, mime: event.mime, base64: event.base64 } satisfies Blob)
          message.images = [...(message.images ?? []), { id, name, mime: event.mime, size: Math.round((event.base64.length * 3) / 4), kind: 'image' }]
          flush(true)
          break
        }
        case 'session':
          sessionId = event.sessionId
          break
        case 'model':
          if (event.model) message.model = event.model
          break
        case 'usage':
          message.usage = event.usage
          break
        case 'limits':
          this.recordLimits(provider, event)
          break
        case 'approval':
          {
            const request = { ...event.request, provider }
            if (event.settled) args.active.approvals.delete(request.id)
            else args.active.approvals.set(request.id, request)
            this.events.approval(conv.id, message.id, request, event.settled)
          }
          break
        case 'grant':
          if (!compare) this.store.kvSet(`grants:${conv.id}`, [...new Set([...this.grants(conv.id), ...event.rules])].slice(-100))
          break
        case 'denials':
          this.events.denials(conv.id, message.id, event.denials)
          break
        case 'error':
          if (event.code === 'aborted') message.status = 'stopped'
          else {
            message.status = 'error'
            message.error = { code: event.code, message: event.message }
            if (event.code === 'rate_limit') this.recordLimits(provider, { fiveHour: { status: 'exhausted', usedPct: 100 } })
          }
          break
        case 'done':
          break
      }
    }

    const allow = compare ? args.allow : [...(args.allow ?? []), ...this.grants(conv.id)]
    // Local models cannot call tools, so the tool servers only go to Claude and ChatGPT.
    const mcp = provider === 'local' ? [] : this.mcpServers()
    const handle = this.providers[provider].run(
      { prompt, messages, system, model, mode, cwd, sessionId: plan.kind === 'resume' || plan.kind === 'catchup' ? plan.sessionId : undefined, ephemeral: compare, allow, images, mcp },
      onEvent
    )
    args.active.handles.push(handle)
    args.active.byMessage.set(message.id, handle)
    await handle.done

    if (message.status === 'streaming') message.status = 'complete'
    message.text = message.text.trim()
    for (const t of message.tools ?? []) if (t.status === 'running') t.status = message.status === 'complete' ? 'done' : 'error'

    const answered = message.status === 'complete' || (message.status === 'stopped' && !!message.text)
    // Stopped before anything arrived: leave no empty bubble behind.
    const empty = message.status === 'stopped' && !message.text && !(message.tools ?? []).length
    if (!empty) this.store.put('message', message.id, message)

    const used = message.usage ? message.usage.inputTokens + message.usage.outputTokens : estimateTokens(prompt) + estimateTokens(message.text)
    if (message.status !== 'error') this.recordTokens(provider, used)

    if (!compare && answered && sessionId && provider !== 'local') {
      this.store.kvSet(this.sessionKey(conv.id, provider), { sessionId, syncedMessageId: message.id } satisfies SessionState)
    }
    if (message.status === 'error' && message.error?.code === 'auth') {
      // The stored session cannot be trusted after a sign-in problem.
      this.store.kvDelete(this.sessionKey(conv.id, provider))
    }
    this.updateConversation(conv.id, { updatedAt: Date.now() })
    return message
  }

  /** Where to carry on when a reply failed on a usage limit and the user asked not to be stopped by that. */
  private failoverTarget(conv: Conversation, from: ProviderId, reply: Message): ProviderId | undefined {
    if (!this.settings().autoFailover || conv.private) return undefined
    if (reply.status !== 'error' || reply.error?.code !== 'rate_limit') return undefined
    return switchTarget(from, this.availability(), this.allUsage())
  }

  // ----- attachments -----

  /** Keep only well formed attachments whose image bytes are actually stored here. */
  private cleanAttachments(input: Attachment[] | undefined): Attachment[] {
    const out: Attachment[] = []
    for (const a of input ?? []) {
      if (!a || typeof a.id !== 'string' || typeof a.name !== 'string') continue
      if (a.kind === 'image') {
        if (!this.store.get<Blob>('blob', a.id)) continue
        out.push({ id: a.id, name: a.name, mime: String(a.mime), size: Number(a.size) || 0, kind: 'image' })
      } else if (a.kind === 'text' && typeof a.text === 'string') {
        const file: Attachment = { id: a.id, name: a.name, mime: 'text/plain', size: Number(a.size) || 0, kind: 'text', text: a.text }
        // A PDF was read into text, and keeps its page count for display.
        const pages = Math.floor(Number(a.pages))
        if (a.mime === 'application/pdf' && pages > 0) Object.assign(file, { mime: 'application/pdf', pages })
        out.push(file)
      }
      if (out.length >= MAX_ATTACHMENTS) break
    }
    return out
  }

  /**
   * The images that go with a turn: the ones on the new message, plus the most
   * recent ones from messages the provider has not seen, so that pictures
   * survive a switch as well as text does.
   */
  private imagesFor(plan: TurnPlan, current: Message): RunImage[] {
    const isImage = (a: Attachment) => a.kind === 'image'
    const unseen = plan.kind === 'handoff' || plan.kind === 'catchup' ? plan.unseen : []
    const earlier = unseen.flatMap((m) => (m.id === current.id ? [] : (m.attachments ?? []).filter(isImage))).slice(-EARLIER_IMAGES)
    const out: RunImage[] = []
    for (const a of [...earlier, ...(current.attachments ?? []).filter(isImage)]) {
      const blob = this.store.get<Blob>('blob', a.id)
      if (!blob?.base64) continue
      try {
        out.push({ name: blob.name, mime: blob.mime, base64: blob.base64, path: imageFile(this.dirs.attachments, blob) })
      } catch {
        // An image that cannot be written out is skipped. The message still names it.
      }
    }
    return out
  }

  // ----- branching -----

  /** Copy the conversation up to and including a message into a new one, to try another direction. */
  branch(conversationId: string, messageId: string): Conversation | undefined {
    const conv = this.store.get<Conversation>('conversation', conversationId)
    if (!conv) return undefined
    const thread = threadMessages(this.store.messages(conversationId))
    const idx = thread.findIndex((m) => m.id === messageId)
    if (idx < 0) return undefined
    const copy = this.createConversation({ title: `${conv.title} (branch)`, provider: conv.provider, models: { ...conv.models }, mode: conv.mode, private: conv.private })
    for (const m of thread.slice(0, idx + 1)) {
      const id = newId()
      this.store.put('message', id, { ...m, id, conversationId: copy.id, variantGroup: undefined, selected: undefined } satisfies Message)
    }
    const cwd = this.workspace(conversationId)
    if (cwd) this.store.kvSet(`cwd:${copy.id}`, cwd)
    this.writeContextFiles(copy.id)
    return copy
  }

  stop(conversationId: string): void {
    for (const h of this.active.get(conversationId)?.handles ?? []) h.stop()
  }

  respondApproval(conversationId: string, messageId: string, approvalId: string, decision: ApprovalDecision): void {
    const active = this.active.get(conversationId)
    active?.byMessage.get(messageId)?.respondApproval?.(approvalId, decision)
    // Tell every window, so a card answered on one device goes away on the others.
    const request = active?.approvals.get(approvalId)
    if (request) {
      active!.approvals.delete(approvalId)
      this.events.approval(conversationId, messageId, request, true)
    }
  }

  /** In compare mode, keep one answer as the conversation's reply. */
  selectVariant(messageId: string): void {
    const chosen = this.store.get<Message>('message', messageId)
    if (!chosen?.variantGroup) return
    for (const m of this.store.messages(chosen.conversationId)) {
      if (m.variantGroup !== chosen.variantGroup) continue
      const selected = m.id === messageId
      if (m.selected !== selected) this.store.put('message', m.id, { ...m, selected })
    }
    this.writeContextFiles(chosen.conversationId)
  }

  /** Move the conversation to another provider from now on. */
  switchProvider(conversationId: string, to: ProviderChoice): void {
    const conv = this.store.get<Conversation>('conversation', conversationId)
    if (!conv || conv.provider === to) return
    this.updateConversation(conversationId, { provider: to })
    if (to !== 'auto') {
      const note: Message = {
        id: newId(),
        conversationId,
        role: 'note',
        text: `Continued on ${PROVIDER_LABEL[to]}`,
        createdAt: Date.now(),
        deviceId: this.store.deviceId,
        status: 'complete'
      }
      const hasHistory = threadMessages(this.store.messages(conversationId)).length > 0
      if (hasHistory) this.store.put('message', note.id, note)
    }
  }
}
