import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { Marked } from 'marked'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = (lang ?? '').trim().split(/\s+/)[0]
      let body: string
      try {
        body = language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : escapeHtml(text)
      } catch {
        body = escapeHtml(text)
      }
      return `<div class="code-block"><div class="code-head"><span>${escapeHtml(language || 'text')}</span><button class="code-copy" type="button">Copy</button></div><pre><code class="hljs">${body}</code></pre></div>`
    }
  }
})

// Links leave the app and open in the system browser.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noreferrer noopener')
  }
})

const cache = new Map<string, string>()

export function renderMarkdown(text: string): string {
  const hit = cache.get(text)
  if (hit !== undefined) return hit
  const html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { FORBID_TAGS: ['style', 'form', 'input', 'iframe'], FORBID_ATTR: ['style'] })
  if (cache.size > 400) cache.clear()
  cache.set(text, html)
  return html
}

/** One click handler for every "Copy" button inside rendered messages. */
export function installCopyHandler(): void {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null
    if (!target?.classList.contains('code-copy')) return
    const code = target.closest('.code-block')?.querySelector('code')
    if (!code) return
    void navigator.clipboard.writeText(code.textContent ?? '')
    target.textContent = 'Copied'
    setTimeout(() => (target.textContent = 'Copy'), 1400)
  })
}
