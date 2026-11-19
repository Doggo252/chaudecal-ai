import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { Marked, type Tokens } from 'marked'
import { ARTIFACT_KIND_LABEL, classifyFence, fenceClosed } from '@shared/artifacts'
import { mathExtensions } from './math'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Code as highlighted HTML. Safe to insert: the text is escaped. */
export function highlightCode(text: string, lang: string | undefined): string {
  const language = (lang ?? '').trim().split(/\s+/)[0]
  try {
    return language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : escapeHtml(text)
  } catch {
    return escapeHtml(text)
  }
}

function codeBlock({ text, lang }: Tokens.Code): string {
  const language = (lang ?? '').trim().split(/\s+/)[0]
  return `<div class="code-block"><div class="code-head"><span>${escapeHtml(language || 'text')}</span><button class="code-copy" type="button">Copy</button></div><pre><code class="hljs">${highlightCode(text, language)}</code></pre></div>`
}

const ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M14 4v16"/><path d="M6.5 9h4M6.5 12.5h4M6.5 16h2.5"/></svg>'

// Artifacts are numbered in the order they appear, the same way the panel finds them.
let artifactCount = 0

/** An artifact's code block becomes a card that opens it in the side panel. */
function artifactCard(token: Tokens.Code): string {
  const spec = classifyFence(token.lang, token.text)
  if (!spec) return codeBlock(token)
  const index = artifactCount++
  const writing = !fenceClosed(token.raw)
  const sub = `${ARTIFACT_KIND_LABEL[spec.kind]}${spec.kind === 'code' && spec.language !== 'text' ? `, ${escapeHtml(spec.language)}` : ''}`
  return `<button type="button" class="artifact-card" data-testid="artifact-card" data-artifact-index="${index}" data-kind="${spec.kind}"${writing ? ' data-writing="1"' : ''}><span class="artifact-card-icon">${ICON}</span><span class="artifact-card-text"><span class="artifact-card-title">${escapeHtml(spec.title)}</span><span class="artifact-card-sub">${sub}</span></span><span class="artifact-card-open">${writing ? 'Writing' : 'Open'}</span></button>`
}

const marked = new Marked({ gfm: true, breaks: false, renderer: { code: artifactCard }, extensions: mathExtensions })
/** For documents shown in the panel, where code blocks stay code blocks. */
const plain = new Marked({ gfm: true, breaks: false, renderer: { code: codeBlock }, extensions: mathExtensions })

// Links leave the app and open in the system browser.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noreferrer noopener')
  }
})

const cache = new Map<string, string>()

/** Markdown as safe HTML. Artifacts become cards, unless `artifacts` is false. */
export function renderMarkdown(text: string, { artifacts = true }: { artifacts?: boolean } = {}): string {
  const key = artifacts ? text : `plain:${text}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  artifactCount = 0
  const raw = (artifacts ? marked : plain).parse(text, { async: false }) as string
  const html = DOMPurify.sanitize(raw, { FORBID_TAGS: ['style', 'form', 'input', 'iframe'], FORBID_ATTR: ['style'] })
  if (cache.size > 400) cache.clear()
  cache.set(key, html)
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
