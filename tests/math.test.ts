import { describe, expect, it } from 'vitest'
import { Marked } from 'marked'
import { mathExtensions, renderTex } from '../src/renderer/src/math'

const md = (text: string) => new Marked({ gfm: true, extensions: mathExtensions }).parse(text, { async: false }) as string
const count = (html: string) => (html.match(/<math/g) ?? []).length

describe('math in replies', () => {
  it('turns TeX into MathML without its source text', () => {
    const html = renderTex('\\frac{1}{3}', false)
    expect(html).toContain('<math')
    expect(html).toContain('<mfrac>')
    expect(html).not.toContain('annotation')
    expect(renderTex('x', true)).toContain('display="block"')
  })

  it('reads every way the assistants write math', () => {
    expect(count(md('Area is $A = \\pi r^2$ here.'))).toBe(1)
    expect(count(md('Area is \\(A = \\pi r^2\\) here.'))).toBe(1)
    expect(md('$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$')).toContain('class="math-block"')
    expect(md('\\[\n\\sum_{n=1}^{\\infty} \\frac{1}{n^2}\n\\]')).toContain('class="math-block"')
    expect(md('Inline display \\[x+1\\] works.')).toContain('display="block"')
  })

  it('leaves prices, code and escaped dollars alone', () => {
    expect(count(md('It costs $5 and $10 in total.'))).toBe(0)
    expect(count(md('Between $ 5 and 6 $ is not math.'))).toBe(0)
    expect(count(md('Code: `$x$` and\n\n```\n$$y$$\n```'))).toBe(0)
    expect(count(md('Pay \\$5 or \\$6.'))).toBe(0)
  })

  it('shows a formula it cannot read instead of failing', () => {
    expect(() => md('Broken $\\frac{1}{$ here')).not.toThrow()
  })
})
