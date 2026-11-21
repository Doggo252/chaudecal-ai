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
 * Claude Code's list (from its initialize answer). Older versions name the model
 * in the description: { value: 'opus', displayName: 'Opus', description: 'Opus 4.7 · Most capable…' }.
 * Newer ones put the version in the display name: { value: 'opus', displayName: 'Opus 5.5',
 * description: 'Best for everyday, complex tasks' }. Either way the versioned name is used.
 * Pinned models ('claude-opus-4-7' and so on) of a family that also has a plain entry
 * ('opus') are older ones, kept under "More models".
 */
export function claudeCatalog(models: unknown): ModelInfo[] {
  if (!Array.isArray(models)) return []
  const out: ModelInfo[] = []
  // Families with a plain entry such as 'opus' or 'sonnet[1m]'.
  const families = new Set(
    (models as Json[])
      .map((m) => str(m?.value))
      .filter((v) => v && v !== 'default' && !v.startsWith('claude-'))
      .map((v) => v.replace(/\[.*\]$/, ''))
  )
  for (const raw of models as Json[]) {
    const id = str(raw?.value)
    if (!id) continue
    const parts = str(raw.description)
      .split('·')
      .map((p) => p.trim())
      .filter(Boolean)
    const display = str(raw.displayName)
    // The description may start with the versioned name, as in "Opus 4.7 · …".
    const leadsWithName = /^[A-Z][a-z]+ \d/.test(parts[0] ?? '')
    const versioned = /\d/.test(display) ? display : (leadsWithName && parts[0]) || display || id
    const rest = leadsWithName ? parts.slice(1) : parts
    const isDefault = id === 'default'
    const info: ModelInfo = {
      id,
      name: isDefault ? `Default (${(leadsWithName && parts[0]) || 'recommended'})` : versioned,
      description: rest.join(' · ') || (isDefault ? 'What Claude recommends for your plan' : '')
    }
    if (isDefault) info.isDefault = true
    const pinned = /^claude-([a-z]+)/.exec(id)
    if (pinned && families.has(pinned[1])) info.legacy = true
    // Newer Claude Code says only whether a model takes a thinking level, not which ones.
    const efforts = Array.isArray(raw.supportedEffortLevels)
      ? (raw.supportedEffortLevels as unknown[]).map(str).filter(Boolean)
      : raw.supportsEffort === true
        ? CLAUDE_EFFORTS
        : []
    if (efforts.length) info.efforts = [...efforts]
    out.push(info)
  }
  return out
}

/** The thinking levels Claude Code's --effort takes, lightest first. */
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

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
