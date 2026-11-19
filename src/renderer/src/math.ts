// Math in replies, written in TeX: $...$ or \(...\) in a line, $$...$$ or \[...\]
// on their own. KaTeX turns it into MathML, which the window draws itself, so no
// fonts or styles are needed. Prices such as "$5 and $10" are left alone.

import katex from 'katex'
import type { TokenizerAndRendererExtension } from 'marked'

/** TeX as MathML. A formula that cannot be read is shown in red with its source, never as an error. */
export function renderTex(tex: string, display: boolean): string {
  const html = katex.renderToString(tex.trim(), { displayMode: display, output: 'mathml', throwOnError: false, strict: 'ignore', trust: false })
  // The TeX source travels inside the MathML too. It is dropped here, so it never shows as text.
  return html.replace(/<annotation[\s\S]*?<\/annotation>/g, '').replace(/<\/?semantics>/g, '')
}

const BLOCK = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/
// A dollar sign opens math only when the next character is not a space, and closes it only
// when the one before is not a space and no digit follows. That keeps prices as text.
const INLINE = /^(?:\$\$([^$]+?)\$\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\$(?![\s$])((?:\\\$|[^$\n])+?)(?<![\s\\])\$(?!\d))/

const block: TokenizerAndRendererExtension = {
  name: 'mathBlock',
  level: 'block',
  start: (src) => {
    const m = /\$\$|\\\[/.exec(src)
    return m ? m.index : undefined
  },
  tokenizer(src) {
    const m = BLOCK.exec(src)
    if (m) return { type: 'mathBlock', raw: m[0], text: m[1] ?? m[2] ?? '' }
    return undefined
  },
  renderer: (token) => `<div class="math-block">${renderTex(String(token.text), true)}</div>\n`
}

const inline: TokenizerAndRendererExtension = {
  name: 'mathInline',
  level: 'inline',
  start: (src) => {
    const m = /\$|\\\(|\\\[/.exec(src)
    return m ? m.index : undefined
  },
  tokenizer(src) {
    const m = INLINE.exec(src)
    if (!m) return undefined
    const display = m[1] !== undefined || m[3] !== undefined
    return { type: 'mathInline', raw: m[0], text: m[1] ?? m[2] ?? m[3] ?? m[4] ?? '', display }
  },
  renderer: (token) => renderTex(String(token.text), !!(token as { display?: boolean }).display)
}

export const mathExtensions = [block, inline]
