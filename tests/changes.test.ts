import { describe, expect, it } from 'vitest'
import { collectChanges, diffTexts, shortPath } from '../src/shared/diff'

describe('collectChanges', () => {
  it('sums the edits to each file, the latest file first, and skips steps that did nothing', () => {
    const a1 = diffTexts('/w/a.ts', 'x\n', 'y\n')
    const b = diffTexts('/w/b.ts', '', 'new\n', { created: true })
    const a2 = diffTexts('/w/a.ts', 'y\n', 'y\nz\n')
    const failed = diffTexts('/w/c.ts', 'q\n', 'r\n')
    const files = collectChanges([
      { status: 'done', diff: [a1] },
      { status: 'done', diff: [b] },
      { status: 'error', diff: [failed] },
      { status: 'done', diff: [a2] },
      { status: 'done' }
    ])
    expect(files.map((f) => f.path)).toEqual(['/w/a.ts', '/w/b.ts'])
    expect(files[0]).toMatchObject({ added: 2, removed: 1, created: false, deleted: false })
    expect(files[0].edits).toHaveLength(2)
    expect(files[1].created).toBe(true)
  })

  it('marks a file the chat deleted last', () => {
    const files = collectChanges([
      { status: 'done', diff: [diffTexts('C:\\w\\a.ts', 'x\n', 'y\n')] },
      { status: 'done', diff: [diffTexts('C:/w/a.ts', 'y\n', '', { deleted: true })] }
    ])
    expect(files).toHaveLength(1)
    expect(files[0].deleted).toBe(true)
  })
})

describe('shortPath', () => {
  it('shows a path inside the folder relative to it', () => {
    expect(shortPath('/Users/me/app/src/a.ts', '/Users/me/app')).toBe('src/a.ts')
    expect(shortPath('C:\\Code\\App\\src\\a.ts', 'C:\\code\\app\\')).toBe('src/a.ts')
    expect(shortPath('/etc/hosts', '/Users/me/app')).toBe('/etc/hosts')
    expect(shortPath('src/a.ts', '')).toBe('src/a.ts')
    expect(shortPath('C:\\Users\\me\\Coding\\My App\\src\\main\\index.ts', '/Users/me/Coding/My App')).toBe('src/main/index.ts')
  })
})
