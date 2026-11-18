import { describe, expect, it } from 'vitest'
import { addTokens, applyLimits, emptyUsage, expireWindows, FIVE_HOURS_MS, headroom, limitsFromClaude, limitsFromCodex, limitWarning } from '@shared/usage'
import { route, switchTarget, type RouteInput } from '@shared/router'
import type { ProviderUsage } from '@shared/types'

const now = 1_800_000_000_000

function usage(provider: 'claude' | 'chatgpt' | 'local', fivePct?: number, weekPct?: number): ProviderUsage {
  let u = emptyUsage(provider, now)
  u = applyLimits(u, { fiveHour: fivePct === undefined ? undefined : { usedPct: fivePct }, weekly: weekPct === undefined ? undefined : { usedPct: weekPct } }, 80, now)
  return u
}

describe('limits from Claude', () => {
  it('reads the 5-hour window with a fraction', () => {
    const l = limitsFromClaude({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.86, resetsAt: 1_800_003_600 })
    expect(l.fiveHour).toEqual({ status: 'warning', usedPct: 86, resetsAt: 1_800_003_600_000 })
  })
  it('treats a rejection as a full window', () => {
    expect(limitsFromClaude({ status: 'rejected', rateLimitType: 'five_hour' }).fiveHour).toMatchObject({ status: 'exhausted', usedPct: 100 })
  })
  it('files the weekly variants under weekly and ignores overage', () => {
    expect(limitsFromClaude({ status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 0.4 }).weekly?.usedPct).toBe(40)
    expect(limitsFromClaude({ status: 'allowed', rateLimitType: 'overage' })).toEqual({})
  })
})

describe('limits from Codex', () => {
  it('maps the short window to 5-hour and the long one to weekly', () => {
    const l = limitsFromCodex({ primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_100 }, secondary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: null } })
    expect(l.fiveHour).toEqual({ usedPct: 12, resetsAt: 1_800_000_100_000 })
    expect(l.weekly).toEqual({ usedPct: 31, resetsAt: undefined })
  })
  it('copes with only a weekly window', () => {
    const l = limitsFromCodex({ primary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: null }, secondary: null })
    expect(l.fiveHour).toBeUndefined()
    expect(l.weekly?.usedPct).toBe(50)
  })
})

describe('usage state', () => {
  it('derives status from the threshold', () => {
    expect(usage('claude', 50).fiveHour.status).toBe('ok')
    expect(usage('claude', 80).fiveHour.status).toBe('warning')
    expect(usage('claude', 100).fiveHour.status).toBe('exhausted')
  })
  it('warns on the tighter window and prefers exhausted over warning', () => {
    expect(limitWarning(usage('claude', 30, 90))).toMatchObject({ window: 'weekly', status: 'warning' })
    expect(limitWarning(usage('claude', 85, 100))).toMatchObject({ window: 'weekly', status: 'exhausted' })
    expect(limitWarning(usage('claude', 10, 10))).toBeUndefined()
    expect(limitWarning(usage('local', 100))).toBeUndefined()
  })
  it('clears a window once its reset time has passed', () => {
    const u = applyLimits(emptyUsage('claude', now), { fiveHour: { usedPct: 100, resetsAt: now + 1000 } }, 80, now)
    expect(headroom(u)).toBe('none')
    expect(headroom(expireWindows(u, now + 2000))).toBe('plenty')
  })
  it('counts tokens per 5-hour window', () => {
    let u = addTokens(emptyUsage('claude', now), 500, now)
    u = addTokens(u, 250, now + 1000)
    expect(u.tokensInWindow).toBe(750)
    expect(addTokens(u, 10, now + FIVE_HOURS_MS + 1).tokensInWindow).toBe(10)
  })
})

describe('route', () => {
  const base: RouteInput = {
    text: 'What is a good name for a cat?',
    mode: 'chat',
    hasWorkspace: false,
    private: false,
    available: { claude: true, chatgpt: true, local: true },
    usage: { claude: usage('claude', 10, 10), chatgpt: usage('chatgpt', 10, 10) },
    contextTokens: 100,
    localContextTokens: 16000,
    preferLocalForShort: false
  }
  it('keeps private conversations local', () => {
    expect(route({ ...base, private: true }).provider).toBe('local')
  })
  it('sends coding work to Claude and general questions to ChatGPT when both are fresh', () => {
    expect(route({ ...base, text: 'Refactor this function to use async/await' }).provider).toBe('claude')
    expect(route({ ...base, mode: 'edit', hasWorkspace: true }).provider).toBe('claude')
    expect(route(base).provider).toBe('chatgpt')
  })
  it('stays with the provider that answered last while it has room', () => {
    expect(route({ ...base, lastProvider: 'claude' }).provider).toBe('claude')
  })
  it('moves away from a provider that is running low', () => {
    const d = route({ ...base, lastProvider: 'claude', usage: { claude: usage('claude', 90), chatgpt: usage('chatgpt', 10) } })
    expect(d.provider).toBe('chatgpt')
    expect(d.reason).toMatch(/Claude is running low/)
  })
  it('skips an exhausted provider and falls back to local when both are out', () => {
    expect(route({ ...base, text: 'fix this bug in my code', usage: { claude: usage('claude', 100), chatgpt: usage('chatgpt', 10) } }).provider).toBe('chatgpt')
    expect(route({ ...base, usage: { claude: usage('claude', 100), chatgpt: usage('chatgpt', 100) } }).provider).toBe('local')
  })
  it('prefers the provider with clearly more headroom', () => {
    expect(route({ ...base, text: 'Refactor this function', usage: { claude: usage('claude', 60), chatgpt: usage('chatgpt', 20) } }).provider).toBe('chatgpt')
  })
  it('only uses local for short questions when asked to', () => {
    expect(route({ ...base, preferLocalForShort: true }).provider).toBe('local')
    expect(route({ ...base, preferLocalForShort: true, contextTokens: 50_000 }).provider).toBe('chatgpt')
  })
  it('uses whichever paid provider is set up', () => {
    expect(route({ ...base, available: { claude: true, chatgpt: false, local: false } }).provider).toBe('claude')
  })
})

describe('switchTarget', () => {
  const all = { claude: true, chatgpt: true, local: true }
  it('offers the other paid provider first, then local', () => {
    expect(switchTarget('claude', all, {})).toBe('chatgpt')
    expect(switchTarget('chatgpt', all, {})).toBe('claude')
    expect(switchTarget('claude', all, { chatgpt: usage('chatgpt', 100) })).toBe('local')
    expect(switchTarget('claude', { claude: true, chatgpt: false, local: false }, {})).toBeUndefined()
  })
})
