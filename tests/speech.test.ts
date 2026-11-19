import { describe, expect, it } from 'vitest'
import { speakableText } from '@shared/speech'

describe('reading replies aloud', () => {
  it('reads the words and leaves out code, formulas and markup', () => {
    const text = ['# Plan', '', 'Use **bold** ideas and `npm test`. See [the docs](https://example.com).', '', '- one', '- two', '', '```js', 'console.log(1)', '```', '', '$$x^2$$', '', 'More at https://example.com/x'].join('\n')
    const spoken = speakableText(text)
    expect(spoken).toContain('Plan')
    expect(spoken).toContain('Use bold ideas and npm test. See the docs.')
    expect(spoken).toContain('one\ntwo')
    expect(spoken).toContain('(A block of code is left out here.)')
    expect(spoken).toContain('(A formula is left out here.)')
    expect(spoken).toContain('More at a link')
    expect(spoken).not.toMatch(/console\.log|\*\*|#|```|https/)
  })
})
