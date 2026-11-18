// Local AI. Any server that speaks the OpenAI chat completions API works:
// Ollama, LM Studio, llama.cpp, vLLM and others. A model can live on this
// machine (direct) or on the hub PC, in which case requests go through the hub.

import type { LocalEndpoint, LocalModel, ProviderStatus, RunEvent, Settings } from '@shared/types'
import type { ChatTurn } from '@shared/context'
import type { Provider, RunHandle, RunRequest } from './types'

export interface HubLink {
  /** Base URL and token of the hub when this machine is a connected client. */
  current(): { url: string; token: string } | undefined
}

/** Model ids are stored as "endpointId/modelId" so they mean the same on every machine. */
export function splitModelRef(ref: string): { endpointId: string; modelId: string } | undefined {
  const idx = ref.indexOf('/')
  if (idx <= 0) return undefined
  return { endpointId: ref.slice(0, idx), modelId: ref.slice(idx + 1) }
}

export function modelRef(m: { endpointId: string; id: string }): string {
  return `${m.endpointId}/${m.id}`
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

/** Models served by one runtime on this machine. Empty when it is not running. */
export async function endpointModels(endpoint: LocalEndpoint): Promise<string[]> {
  try {
    const body = await fetchJson(`${endpoint.baseUrl.replace(/\/$/, '')}/models`, {}, 1500)
    const ids = (body.data ?? []).map((m: any) => String(m.id)).filter(Boolean)
    // Embedding models cannot chat.
    return ids.filter((id: string) => !/embed/i.test(id))
  } catch {
    return []
  }
}

export async function directModels(settings: Settings): Promise<LocalModel[]> {
  const enabled = settings.local.endpoints.filter((e) => e.enabled)
  const lists = await Promise.all(enabled.map(endpointModels))
  return enabled.flatMap((e, i) => lists[i].map((id) => ({ id, endpointId: e.id, endpointName: e.name, via: 'direct' as const })))
}

/**
 * Read an OpenAI style server-sent event stream and report text as it arrives.
 * Works for a runtime directly and for the hub's pass-through.
 */
export async function streamChat(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  emit: (event: RunEvent) => void
): Promise<void> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal })
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`The local model server answered ${res.status}. ${detail.slice(0, 300)}`.trim())
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let inThink = false
  const handle = (data: string) => {
    if (data === '[DONE]') return
    let json: any
    try {
      json = JSON.parse(data)
    } catch {
      return
    }
    if (json.error) throw new Error(typeof json.error === 'string' ? json.error : (json.error.message ?? 'The local model reported an error.'))
    const delta = json.choices?.[0]?.delta ?? {}
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoning === 'string' && reasoning) emit({ type: 'thinking', delta: reasoning })
    if (typeof delta.content === 'string' && delta.content) {
      // Some models put their reasoning inline between <think> tags.
      let rest: string = delta.content
      while (rest) {
        const tag = inThink ? '</think>' : '<think>'
        const at = rest.indexOf(tag)
        const piece = at < 0 ? rest : rest.slice(0, at)
        if (piece) emit(inThink ? { type: 'thinking', delta: piece } : { type: 'text', delta: piece })
        if (at < 0) break
        inThink = !inThink
        rest = rest.slice(at + tag.length)
      }
    }
    if (json.usage) emit({ type: 'usage', usage: { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 } })
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line.startsWith('data:')) handle(line.slice(5).trim())
    }
  }
}

export class LocalProvider implements Provider {
  private cache: { at: number; models: LocalModel[] } = { at: 0, models: [] }

  constructor(
    private settings: () => Settings,
    private hub: HubLink
  ) {}

  /** Every local model this machine can reach: its own first, then the hub's. */
  async models(force = false): Promise<LocalModel[]> {
    if (!force && Date.now() - this.cache.at < 5000) return this.cache.models
    const direct = await directModels(this.settings())
    let remote: LocalModel[] = []
    const hub = this.hub.current()
    if (hub) {
      try {
        const body = await fetchJson(`${hub.url}/api/local/models`, { headers: { authorization: `Bearer ${hub.token}` } }, 4000)
        remote = (body.models ?? []).map((m: LocalModel) => ({ ...m, via: 'hub' as const }))
      } catch {
        remote = []
      }
    }
    const seen = new Set(direct.map(modelRef))
    this.cache = { at: Date.now(), models: [...direct, ...remote.filter((m) => !seen.has(modelRef(m)))] }
    return this.cache.models
  }

  async status(): Promise<ProviderStatus> {
    const models = await this.models(true)
    const refs = models.map(modelRef)
    if (!models.length) {
      const hub = this.hub.current()
      const detail = hub ? 'The hub is connected but has no local models running.' : 'No local model server found. Start Ollama or LM Studio here, or connect to your hub PC.'
      return { provider: 'local', installed: false, ready: false, detail, models: [] }
    }
    const onHub = models.filter((m) => m.via === 'hub').length
    const here = models.length - onHub
    const parts = [here ? `${here} on this machine` : '', onHub ? `${onHub} on the hub` : ''].filter(Boolean)
    return { provider: 'local', installed: true, ready: true, detail: `${models.length} ${models.length === 1 ? 'model' : 'models'} (${parts.join(', ')})`, models: refs }
  }

  /** Pick the model to use: the requested one if reachable, otherwise the default or first. */
  async resolve(ref: string): Promise<LocalModel | undefined> {
    const models = await this.models()
    const wanted = ref || this.settings().local.defaultModel
    return models.find((m) => modelRef(m) === wanted) ?? models.find((m) => m.id === wanted) ?? models[0]
  }

  private async chat(model: LocalModel, messages: ChatTurn[], signal: AbortSignal, emit: (e: RunEvent) => void): Promise<void> {
    const payload = { model: model.id, messages, stream: true, stream_options: { include_usage: true } }
    if (model.via === 'hub') {
      const hub = this.hub.current()
      if (!hub) throw new Error('The hub is not connected.')
      await streamChat(`${hub.url}/api/local/chat`, { authorization: `Bearer ${hub.token}` }, { endpointId: model.endpointId, ...payload }, signal, emit)
      return
    }
    const endpoint = this.settings().local.endpoints.find((e) => e.id === model.endpointId)
    if (!endpoint) throw new Error('That local runtime is no longer configured.')
    await streamChat(`${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`, {}, payload, signal, emit)
  }

  run(request: RunRequest, emit: (event: RunEvent) => void): RunHandle {
    const controller = new AbortController()
    const done = (async () => {
      try {
        const model = await this.resolve(request.model)
        if (!model) {
          emit({ type: 'error', code: 'unreachable', message: 'No local model is reachable. Start Ollama or LM Studio, or connect to your hub PC.' })
          return
        }
        emit({ type: 'model', model: modelRef(model) })
        const messages = request.messages ?? [{ role: 'user' as const, content: request.prompt }]
        await this.chat(model, messages, controller.signal, emit)
      } catch (e) {
        if (controller.signal.aborted) emit({ type: 'error', code: 'aborted', message: 'Stopped.' })
        else emit({ type: 'error', code: 'unreachable', message: e instanceof Error ? e.message : String(e) })
      } finally {
        emit({ type: 'done' })
      }
    })()
    return { done, stop: () => controller.abort() }
  }

  /** One-shot completion without streaming, used for summaries. */
  async complete(messages: ChatTurn[], timeoutMs = 120000): Promise<string | undefined> {
    const model = await this.resolve('')
    if (!model) return undefined
    let text = ''
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      await this.chat(model, messages, controller.signal, (e) => {
        if (e.type === 'text') text += e.delta
      })
      return text.trim() || undefined
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
}
