// When a message was sent, and which sent messages fold.

import { describe, expect, it } from 'vitest'
import { isLong, sentAt } from '../src/shared/steps'

describe('message times and long messages', () => {
  it('shows the time for today and the day before that, with the year only when it differs', () => {
    const now = new Date(2026, 10, 21, 18, 0).getTime()
    expect(sentAt(new Date(2026, 10, 21, 9, 5).getTime(), now)).not.toMatch(/Nov/)
    expect(sentAt(new Date(2026, 10, 20, 9, 5).getTime(), now)).toMatch(/Nov/)
    expect(sentAt(new Date(2025, 0, 3, 9, 5).getTime(), now)).toMatch(/2025/)
    expect(sentAt(new Date(2026, 0, 3, 9, 5).getTime(), now)).not.toMatch(/2026/)
  })

  it('folds a long paste but not a normal question', () => {
    expect(isLong('Fix the login bug.')).toBe(false)
    expect(isLong('x'.repeat(1300))).toBe(true)
    expect(isLong(Array(20).fill('line').join('\n'))).toBe(true)
  })
})
