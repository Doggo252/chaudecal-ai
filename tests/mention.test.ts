import { describe, expect, it } from 'vitest'
import { insertMention, mentionAt, rankFiles } from '../src/shared/mention'

describe('mentioning a file with @', () => {
  it('finds the @word just before the caret', () => {
    expect(mentionAt('look at @src/ma', 15)).toEqual({ start: 8, query: 'src/ma' })
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionAt('mail me@home', 12)).toBeUndefined()
    expect(mentionAt('@a b', 4)).toBeUndefined()
  })

  it('ranks names before folders and shorter paths first', () => {
    const files = ['src/main/index.ts', 'src/renderer/src/main.tsx', 'docs/domain.md', 'main.go', 'README.md']
    expect(rankFiles(files, 'main')).toEqual(['main.go', 'src/renderer/src/main.tsx', 'docs/domain.md', 'src/main/index.ts'])
    expect(rankFiles(files, 'zzz')).toEqual([])
    expect(rankFiles(files, '', 2)).toEqual(['main.go', 'README.md'])
  })

  it('puts the file in place of the @word', () => {
    const text = 'fix @ind please'
    expect(insertMention(text, { start: 4, query: 'ind' }, 'src/index.ts')).toEqual({ text: 'fix @src/index.ts please', caret: 18 })
    expect(insertMention('see @', { start: 4, query: '' }, 'my file.md')).toEqual({ text: 'see @"my file.md" ', caret: 18 })
  })
})
