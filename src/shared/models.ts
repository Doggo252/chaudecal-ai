// The models a plan offers, as Claude Code and Codex describe them, turned into
// one shape for the model picker: a clear name with its version, one line on what
// it is good for, and whether it is an older model kept under "More models". Pure.

export interface ModelInfo {
  /** What the command line tool is given to pick the model. */
  id: string
  /** The name with its version, for example "Opus 4.7" or "GPT-6.2-Sol". */
  name: string
  /** One short line on what the model is for. */
  description: string
  /** An older model, kept under "More models". */
  legacy?: boolean
  /** The service's own default. */
  isDefault?: boolean
  /** Thinking levels the model takes, lightest first. */
  efforts?: string[]
}

type Json = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * Claude Code's list (from its initialize answer), for example
 * { value: 'opus', displayName: 'Opus', description: 'Opus 4.7 · Most capable for complex work · ~2× usage vs Sonnet' }.
 * The description starts with the versioned name, which is clearer than "Opus".
 */
export function claudeCatalog(models: unknown): ModelInfo[] {
  if (!Array.isArray(models)) return []
  const out: ModelInfo[] = []
  for (const raw of models as Json[]) {
    const id = str(raw?.value)
    if (!id) continue
    const parts = str(raw.description)
      .split('·')
      .map((p) => p.trim())
      .filter(Boolean)
    const display = str(raw.displayName)
    const versioned = /\d/.test(display) ? display : parts[0] || display || id
    const rest = /\d/.test(display) ? parts.slice(1) : parts.slice(1)
    const isDefault = id === 'default'
    const info: ModelInfo = {
      id,
      name: isDefault ? `Default (${parts[0] || 'recommended'})` : versioned,
      description: rest.join(' · ') || (isDefault ? 'What Claude recommends for your plan' : '')
    }
    if (isDefault) info.isDefault = true
    const efforts = Array.isArray(raw.supportedEffortLevels) ? (raw.supportedEffortLevels as unknown[]).map(str).filter(Boolean) : []
    if (efforts.length) info.efforts = efforts
    out.push(info)
  }
  return out
}

/** Codex's model/list answer: display names and descriptions come with it. */
export function codexCatalog(data: unknown): ModelInfo[] {
  if (!Array.isArray(data)) return []
  const out: ModelInfo[] = []
  for (const raw of data as Json[]) {
    const id = str(raw?.model) || str(raw?.id)
    if (!id) continue
    const description = str(raw.description)
    const info: ModelInfo = { id, name: str(raw.displayName) || id, description }
    if (raw.hidden || /legacy|previous generation/i.test(description)) info.legacy = true
    if (raw.isDefault) info.isDefault = true
    const efforts = Array.isArray(raw.supportedReasoningEfforts) ? (raw.supportedReasoningEfforts as Json[]).map((e) => str(e?.reasoningEffort)).filter(Boolean) : []
    if (efforts.length) info.efforts = efforts
    out.push(info)
  }
  return out
}
