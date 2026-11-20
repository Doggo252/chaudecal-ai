// Usage tracking: turning what each provider reports about its limits into one
// shape, and deciding when to offer a switch.

import type { LimitStatus, LimitWindow, ProviderId, ProviderUsage } from './types'

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000

export function emptyUsage(provider: ProviderId, now: number): ProviderUsage {
  return {
    id: provider,
    provider,
    fiveHour: { status: 'unknown' },
    weekly: { status: 'unknown' },
    tokensInWindow: 0,
    windowStartedAt: now,
    updatedAt: now
  }
}

function statusFromPct(pct: number, warnPct: number): LimitStatus {
  if (pct >= 100) return 'exhausted'
  if (pct >= warnPct) return 'warning'
  return 'ok'
}

/** Drop numbers that belong to a window that has already reset. */
export function expireWindows(usage: ProviderUsage, now: number): ProviderUsage {
  const fix = (w: LimitWindow): LimitWindow => (w.resetsAt && w.resetsAt <= now ? { status: 'ok', usedPct: 0 } : w)
  const next = { ...usage, fiveHour: fix(usage.fiveHour), weekly: fix(usage.weekly) }
  if (now - usage.windowStartedAt >= FIVE_HOURS_MS) {
    next.tokensInWindow = 0
    next.windowStartedAt = now
  }
  return next
}

export function mergeWindow(prev: LimitWindow, patch: Partial<LimitWindow> | undefined, warnPct: number): LimitWindow {
  if (!patch) return prev
  const next: LimitWindow = { ...prev, ...patch }
  if (patch.usedPct !== undefined && patch.status === undefined) next.status = statusFromPct(patch.usedPct, warnPct)
  if (next.usedPct !== undefined) next.usedPct = Math.max(0, Math.min(100, next.usedPct))
  return next
}

export function applyLimits(
  usage: ProviderUsage,
  patch: { fiveHour?: Partial<LimitWindow>; weekly?: Partial<LimitWindow> },
  warnPct: number,
  now: number
): ProviderUsage {
  return {
    ...usage,
    fiveHour: mergeWindow(usage.fiveHour, patch.fiveHour, warnPct),
    weekly: mergeWindow(usage.weekly, patch.weekly, warnPct),
    updatedAt: now
  }
}

export function addTokens(usage: ProviderUsage, tokens: number, now: number): ProviderUsage {
  const fresh = expireWindows(usage, now)
  return { ...fresh, tokensInWindow: fresh.tokensInWindow + Math.max(0, tokens), updatedAt: now }
}

// ----- Claude Code: the /usage command's text -----

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** A reset time as Claude Code writes it, "Nov 19, 8:09pm" or "8:09pm", in this computer's time. */
export function claudeResetTime(text: string, now: number): number | undefined {
  const m = /(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text)
  if (!m) return undefined
  const today = new Date(now)
  let hour = Number(m[3]) % 12
  if (m[5].toLowerCase() === 'pm') hour += 12
  const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : today.getMonth()
  if (month < 0) return undefined
  const day = m[2] ? Number(m[2]) : today.getDate()
  const at = new Date(today.getFullYear(), month, day, hour, Number(m[4] ?? 0)).getTime()
  // A time with no date that has passed today is tomorrow; a date that has passed is next year.
  if (at < now - 60_000) return m[1] ? new Date(today.getFullYear() + 1, month, day, hour, Number(m[4] ?? 0)).getTime() : at + 24 * 3600_000
  return at
}

/**
 * Reads what Claude Code's /usage command prints, for example
 * "Current session: 75% used · resets Nov 19, 8:09pm (America/Los_Angeles)
 *  Current week (all models): 22% used · resets Nov 26, 4:59am (America/Los_Angeles)".
 * The command answers from the account without asking the model, so it costs nothing.
 */
export function limitsFromClaudeUsageText(text: string, now: number): { fiveHour?: Partial<LimitWindow>; weekly?: Partial<LimitWindow> } {
  const out: { fiveHour?: Partial<LimitWindow>; weekly?: Partial<LimitWindow> } = {}
  const read = (label: RegExp): Partial<LimitWindow> | undefined => {
    const m = new RegExp(`${label.source}[^\\d%]*?(\\d+(?:\\.\\d+)?)%\\s*used([^\\n]*?)(?=Current |What's|$|\\n)`, 'i').exec(text)
    if (!m) return undefined
    const window: Partial<LimitWindow> = { usedPct: Number(m[1]) }
    const reset = /resets\s+([^()\n]+)/i.exec(m[2])
    const at = reset ? claudeResetTime(reset[1], now) : undefined
    if (at) window.resetsAt = at
    return window
  }
  const session = read(/Current session/)
  const week = read(/Current week \(all models\)/)
  if (session) out.fiveHour = session
  if (week) out.weekly = week
  return out
}

// ----- Claude Code: rate_limit_event.rate_limit_info -----

export interface ClaudeRateLimitInfo {
  status?: 'allowed' | 'allowed_warning' | 'rejected'
  /** Unix seconds. */
  resetsAt?: number
  rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage'
  /** 0 to 1. */
  utilization?: number
}

export function limitsFromClaude(info: ClaudeRateLimitInfo): { fiveHour?: Partial<LimitWindow>; weekly?: Partial<LimitWindow> } {
  const window: Partial<LimitWindow> = {}
  if (info.status === 'rejected') window.status = 'exhausted'
  else if (info.status === 'allowed_warning') window.status = 'warning'
  else if (info.status === 'allowed') window.status = 'ok'
  if (typeof info.utilization === 'number') {
    // Reported as a fraction. Tolerate a percentage in case that ever changes.
    window.usedPct = info.utilization <= 1.5 ? info.utilization * 100 : info.utilization
    if (info.status === 'rejected') window.usedPct = 100
  } else if (info.status === 'rejected') {
    window.usedPct = 100
  }
  if (typeof info.resetsAt === 'number') window.resetsAt = info.resetsAt * 1000
  if (info.rateLimitType === 'five_hour' || info.rateLimitType === undefined) return { fiveHour: window }
  if (info.rateLimitType === 'overage') return {}
  return { weekly: window }
}

// ----- Codex app-server: RateLimitSnapshot -----

export interface CodexRateLimitWindow {
  usedPercent: number
  windowDurationMins: number | null
  /** Unix seconds. */
  resetsAt: number | null
}

export interface CodexRateLimitSnapshot {
  primary?: CodexRateLimitWindow | null
  secondary?: CodexRateLimitWindow | null
}

export function limitsFromCodex(snapshot: CodexRateLimitSnapshot): { fiveHour?: Partial<LimitWindow>; weekly?: Partial<LimitWindow> } {
  const out: { fiveHour?: Partial<LimitWindow>; weekly?: Partial<LimitWindow> } = {}
  const convert = (w: CodexRateLimitWindow): Partial<LimitWindow> => ({
    usedPct: w.usedPercent,
    resetsAt: w.resetsAt ? w.resetsAt * 1000 : undefined
  })
  for (const w of [snapshot.primary, snapshot.secondary]) {
    if (!w) continue
    // The short window is the 5-hour one, whichever slot it arrives in.
    const isShort = w.windowDurationMins !== null && w.windowDurationMins <= 24 * 60
    if (isShort || (w === snapshot.primary && w.windowDurationMins === null)) out.fiveHour = convert(w)
    else out.weekly = convert(w)
  }
  return out
}

// ----- Decisions -----

export type Headroom = 'plenty' | 'low' | 'none' | 'unknown'

/** The tighter of the two windows decides how much room a provider has left. */
export function headroom(usage: ProviderUsage | undefined): Headroom {
  if (!usage) return 'unknown'
  const s = [usage.fiveHour.status, usage.weekly.status]
  if (s.includes('exhausted')) return 'none'
  if (s.includes('warning')) return 'low'
  if (s.every((x) => x === 'unknown')) return 'unknown'
  return 'plenty'
}

/** Percent used in the tighter window, when known. */
export function tightestPct(usage: ProviderUsage | undefined): number | undefined {
  if (!usage) return undefined
  const pcts = [usage.fiveHour.usedPct, usage.weekly.usedPct].filter((p): p is number => typeof p === 'number')
  return pcts.length ? Math.max(...pcts) : undefined
}

export interface LimitWarning {
  provider: ProviderId
  window: 'fiveHour' | 'weekly'
  status: 'warning' | 'exhausted'
  usedPct?: number
  resetsAt?: number
}

export function limitWarning(usage: ProviderUsage | undefined): LimitWarning | undefined {
  if (!usage || usage.provider === 'local') return undefined
  for (const key of ['fiveHour', 'weekly'] as const) {
    const w = usage[key]
    if (w.status === 'exhausted') return { provider: usage.provider, window: key, status: 'exhausted', usedPct: w.usedPct, resetsAt: w.resetsAt }
  }
  for (const key of ['fiveHour', 'weekly'] as const) {
    const w = usage[key]
    if (w.status === 'warning') return { provider: usage.provider, window: key, status: 'warning', usedPct: w.usedPct, resetsAt: w.resetsAt }
  }
  return undefined
}

export function formatReset(resetsAt: number | undefined, now: number): string {
  if (!resetsAt) return ''
  const ms = resetsAt - now
  if (ms <= 0) return 'resets now'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `resets in ${mins} min`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `resets in ${hours} h ${mins % 60} min`
  const days = Math.floor(hours / 24)
  return `resets in ${days} d ${hours % 24} h`
}
