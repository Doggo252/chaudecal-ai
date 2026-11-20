import { describe, expect, it } from 'vitest'
import { claudeResetTime, limitsFromClaudeUsageText } from '../src/shared/usage'


describe("Claude Code's /usage text", () => {
  const text =
    "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 75% used · resets Nov 19, 8:09pm (America/Los_Angeles) Current week (all models): 22% used · resets Nov 26, 4:59am (America/Los_Angeles)\n\nWhat's contributing to your limits usage? Approximate"
  const now = new Date(2026, 10, 19, 18, 0).getTime()
  it('reads both windows and their reset times', () => {
    const limits = limitsFromClaudeUsageText(text, now)
    expect(limits.fiveHour?.usedPct).toBe(75)
    expect(limits.weekly?.usedPct).toBe(22)
    expect(new Date(limits.fiveHour!.resetsAt!).getHours()).toBe(20)
    expect(new Date(limits.weekly!.resetsAt!).getDate()).toBe(26)
  })
  it('gives nothing when the account could not be read', () => {
    expect(limitsFromClaudeUsageText('You are currently using your subscription to power your Claude Code usage', now)).toEqual({})
  })
  it('reads a reset time with no date as later today or tomorrow', () => {
    expect(new Date(claudeResetTime('9:30pm', now)!).getDate()).toBe(19)
    expect(new Date(claudeResetTime('5am', now)!).getDate()).toBe(20)
  })
})
