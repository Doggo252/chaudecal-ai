// Smart routing: when the provider is set to Auto, pick one for this message and
// say why. Rules only, no model call, so the choice is instant and explainable.

import type { ProviderId, ProviderUsage, RouteDecision, RunMode } from './types'
import { PROVIDER_LABEL } from './types'
import { headroom, tightestPct } from './usage'

export interface RouteInput {
  text: string
  mode: RunMode
  hasWorkspace: boolean
  /** The conversation is marked private: it must stay on local AI. */
  private: boolean
  available: Record<ProviderId, boolean>
  usage: Partial<Record<ProviderId, ProviderUsage>>
  /** Provider that answered the previous turn, to avoid needless switching. */
  lastProvider?: ProviderId
  /** Tokens of history that would have to be sent along. */
  contextTokens: number
  localContextTokens: number
  preferLocalForShort: boolean
}

const CODE_HINT = /```|\b(function|class|import|const|def|return|npm|git|stack trace|exception|compile|refactor|bug|unit test|typescript|python|javascript|rust|sql|regex|api|endpoint)\b/i

export function looksLikeCode(text: string): boolean {
  return CODE_HINT.test(text)
}

export function route(input: RouteInput): RouteDecision {
  const { available, usage } = input
  const paid = (['claude', 'chatgpt'] as const).filter((p) => available[p])
  const room = (p: ProviderId) => headroom(usage[p])
  const usable = paid.filter((p) => room(p) !== 'none')

  if (input.private) {
    if (available.local) return { provider: 'local', reason: 'This conversation is private, so it stays on local AI.' }
    return { provider: 'local', reason: 'This conversation is private, but local AI is not reachable right now.' }
  }

  if (!usable.length) {
    if (available.local) {
      const why = paid.length ? 'Both paid limits are used up' : 'Neither Claude nor ChatGPT is set up'
      return { provider: 'local', reason: `${why}, so this goes to local AI.` }
    }
    // Nothing is in good shape. Send it to whatever exists so the error is visible.
    const any = paid[0] ?? 'claude'
    return { provider: any, reason: `${PROVIDER_LABEL[any]} is the only provider configured.` }
  }

  const agentWork = input.mode !== 'chat' || input.hasWorkspace
  const localFits = available.local && input.contextTokens <= input.localContextTokens
  if (!agentWork && input.preferLocalForShort && localFits && input.text.length < 240 && !looksLikeCode(input.text)) {
    return { provider: 'local', reason: 'Short question, answered locally to save your paid limits.' }
  }

  if (usable.length === 1) {
    const only = usable[0]
    const other = paid.find((p) => p !== only)
    const reason = other ? `${PROVIDER_LABEL[other]} has reached its limit.` : `${PROVIDER_LABEL[only]} is the only paid provider set up.`
    return { provider: only, reason }
  }

  // Both paid providers are usable. Prefer staying put unless the current one is running low.
  const low = usable.filter((p) => room(p) === 'low')
  const healthy = usable.filter((p) => room(p) !== 'low')
  if (input.lastProvider && input.lastProvider !== 'local' && healthy.includes(input.lastProvider)) {
    return { provider: input.lastProvider, reason: `Continuing with ${PROVIDER_LABEL[input.lastProvider]}.` }
  }
  if (low.length === 1 && healthy.length === 1) {
    return { provider: healthy[0], reason: `${PROVIDER_LABEL[low[0]]} is running low, so this goes to ${PROVIDER_LABEL[healthy[0]]}.` }
  }

  // No history to respect: balance by headroom, with a mild preference by task type.
  const pct = (p: ProviderId) => tightestPct(usage[p]) ?? 0
  const [a, b] = usable
  if (Math.abs(pct(a) - pct(b)) >= 20) {
    const pick = pct(a) < pct(b) ? a : b
    return { provider: pick, reason: `${PROVIDER_LABEL[pick]} has more of its limit left.` }
  }
  if (agentWork || looksLikeCode(input.text)) {
    return { provider: 'claude', reason: 'Coding or file work, and Claude has room.' }
  }
  return { provider: 'chatgpt', reason: 'General question, and ChatGPT has room.' }
}

/** Where to continue when the current provider is running out. */
export function switchTarget(
  from: ProviderId,
  available: Record<ProviderId, boolean>,
  usage: Partial<Record<ProviderId, ProviderUsage>>
): ProviderId | undefined {
  const order: ProviderId[] = from === 'claude' ? ['chatgpt', 'local'] : from === 'chatgpt' ? ['claude', 'local'] : ['claude', 'chatgpt']
  return order.find((p) => available[p] && headroom(usage[p]) !== 'none')
}
