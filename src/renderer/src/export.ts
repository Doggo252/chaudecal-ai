// A conversation as a file to keep or send: Markdown, or one web page that opens
// in any browser with its formatting and formulas.

import type { Conversation, Message } from '@shared/types'
import { PROVIDER_LABEL } from '@shared/types'
import { threadMessages } from '@shared/context'
import { renderMarkdown } from './markdown'

function who(m: Message): string {
  if (m.role === 'user') return 'You'
  const name = PROVIDER_LABEL[m.provider ?? 'local']
  return m.model ? `${name} (${m.model})` : name
}

const fileName = (title: string, ext: string) =>
  `${
    title
      .replace(/[^A-Za-z0-9 _-]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'conversation'
  }.${ext}`

/** The conversation as it reads in the app: the kept answers, with the switches between assistants. */
function shown(messages: Message[]): Message[] {
  const thread = new Set(threadMessages(messages).map((m) => m.id))
  return messages.filter((m) => m.role === 'note' || thread.has(m.id))
}

export function conversationMarkdown(conv: Conversation, messages: Message[]): { name: string; text: string } {
  const parts = [`# ${conv.title}`, `Exported from Chaude on ${new Date().toLocaleString()}.`]
  for (const m of shown(messages)) {
    if (m.role === 'note') {
      parts.push(`*${m.text}*`)
      continue
    }
    const files = (m.attachments ?? []).map((a) => `[Attached: ${a.name}]`).join('\n')
    parts.push(`## ${who(m)}`, [m.text, files].filter(Boolean).join('\n\n'))
  }
  return { name: fileName(conv.title, 'md'), text: `${parts.join('\n\n')}\n` }
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function conversationHtml(conv: Conversation, messages: Message[]): { name: string; text: string } {
  const body = shown(messages)
    .map((m) => {
      if (m.role === 'note') return `<p class="note">${escape(m.text)}</p>`
      const files = (m.attachments ?? []).map((a) => `<div class="file">Attached: ${escape(a.name)}</div>`).join('')
      const content = m.role === 'user' ? `<div class="bubble">${escape(m.text)}</div>` : `<div class="prose">${renderMarkdown(m.text, { artifacts: false })}</div>`
      return `<section class="${m.role}"><div class="who">${escape(who(m))}</div>${files}${content}</section>`
    })
    .join('\n')
  const text = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(conv.title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #faf9f6; --text: #2a2825; --muted: #8a857c; --bubble: #efece5; --code: #f4f2ed; --border: #e4e0d8; }
  @media (prefers-color-scheme: dark) { :root { --bg: #201f1d; --text: #e8e6e1; --muted: #8f8a82; --bubble: #302f2c; --code: #191817; --border: #3a3835; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 24px 64px; }
  h1 { font-family: 'Iowan Old Style', Palatino, Georgia, serif; font-weight: 500; }
  .meta, .note, .who { color: var(--muted); font-size: 13px; }
  .note { text-align: center; margin: 24px 0; }
  section { margin: 22px 0; }
  section.user { display: flex; flex-direction: column; align-items: flex-end; }
  .bubble { background: var(--bubble); border-radius: 18px; padding: 10px 16px; white-space: pre-wrap; max-width: 82%; }
  .who { margin-bottom: 4px; font-weight: 600; }
  .file { color: var(--muted); font-size: 13px; }
  pre { background: var(--code); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; overflow-x: auto; }
  code { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 13px; }
  .code-head { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; padding: 0 4px 4px; }
  .code-copy { display: none; }
  table { border-collapse: collapse; } td, th { border: 1px solid var(--border); padding: 4px 8px; }
  math { font-family: 'STIX Two Math', 'Cambria Math', math; }
  .math-block { overflow-x: auto; margin: 0.5em 0 1em; }
</style>
</head>
<body>
<main>
<h1>${escape(conv.title)}</h1>
<p class="meta">Exported from Chaude on ${escape(new Date().toLocaleString())}.</p>
${body}
</main>
</body>
</html>
`
  return { name: fileName(conv.title, 'html'), text }
}
