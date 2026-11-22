// Artifacts: standalone pieces of work inside a reply (a web page, a React
// component, an image, a diagram, a document, a program) that open in a side
// panel with a live preview. They are found in the reply's own text, so they
// work for every assistant and sync with the messages. Pure.
//
// An assistant marks one by giving a fenced code block a title:
//
//   ```html title="Pricing page"
//   <!doctype html>...
//   ```
//
// A full web page, an SVG image, a Mermaid diagram and a React component with a
// default export count even without a title. Writing the same title again later
// in the conversation makes a new version of the same artifact.

import { Lexer, type Token } from 'marked'

export type ArtifactKind = 'html' | 'react' | 'svg' | 'mermaid' | 'markdown' | 'code'

export const ARTIFACT_KIND_LABEL: Record<ArtifactKind, string> = {
  html: 'Web page',
  react: 'Component',
  svg: 'Image',
  mermaid: 'Diagram',
  markdown: 'Document',
  code: 'Code'
}

/** Kinds that have a live preview. A document is shown formatted, and code only as code. */
export function hasPreview(kind: ArtifactKind): boolean {
  return kind === 'html' || kind === 'react' || kind === 'svg' || kind === 'mermaid'
}

export interface FenceInfo {
  /** The language named first on the fence, in lower case. Empty when none. */
  language: string
  title?: string
}

/** Reads the line that opens a fence, such as `html title="Pricing page"`. */
export function parseFenceInfo(info: string | undefined): FenceInfo {
  const text = (info ?? '').trim()
  const first = text.split(/\s+/)[0] ?? ''
  const language = first.includes('=') ? '' : first.toLowerCase()
  let title: string | undefined
  const attr = /(?:^|\s)title\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/i.exec(text)
  if (attr) title = (attr[1] ?? attr[2] ?? attr[3] ?? '').trim() || undefined
  return { language, title }
}

export interface ArtifactSpec {
  kind: ArtifactKind
  /** The language as written on the fence, used for highlighting and file names. */
  language: string
  title: string
  /** The assistant gave it a title. Only titled artifacts gather versions. */
  titled: boolean
}

const HTML_LANGS = new Set(['html', 'htm', 'xhtml'])
const REACT_LANGS = new Set(['jsx', 'tsx', 'react'])
const SCRIPT_LANGS = new Set(['js', 'javascript', 'ts', 'typescript', 'mjs'])
const MARKDOWN_LANGS = new Set(['markdown', 'md'])

function firstMatch(text: string, re: RegExp): string | undefined {
  const m = re.exec(text)
  return m?.[1]?.replace(/\s+/g, ' ').trim() || undefined
}

/** An untitled picture or flowchart is named by its first few labels, so two of them do not both read "Image". */
function labelsOf(code: string, re: RegExp, count: number): string | undefined {
  const labels = [...new Set([...code.matchAll(re)].map((m) => m[1].replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean))]
  return labels.slice(0, count).join(', ') || undefined
}

function looksLikeReact(code: string): boolean {
  return /export\s+default\b/.test(code) && (/from\s+['"]react['"]/.test(code) || /<[A-Za-z][\w.]*[\s/>]/.test(code) || /\buse(State|Effect|Ref|Memo)\b/.test(code))
}

function defaultTitle(kind: ArtifactKind, code: string): string {
  if (kind === 'html') return firstMatch(code, /<title[^>]*>([^<]*)<\/title>/i) ?? 'Web page'
  if (kind === 'svg') return firstMatch(code, /<svg[\s\S]*?<title[^>]*>([^<]*)<\/title>/i) ?? firstMatch(code, /<svg\b[^>]*\saria-label="([^"]+)"/i) ?? labelsOf(code, /<text\b[^>]*>([^<]+)</g, 3) ?? 'Image'
  if (kind === 'react') return firstMatch(code, /export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/) ?? firstMatch(code, /export\s+default\s+([A-Z][\w$]*)\s*;?\s*$/m) ?? 'Component'
  if (kind === 'mermaid') return firstMatch(code, /^\s*title:?\s+(.+)$/m) ?? labelsOf(code, /\w\s*[[({]+"?([^"\])}]+?)"?[\])}]/g, 2) ?? 'Diagram'
  return ARTIFACT_KIND_LABEL[kind]
}

/** Whether a fenced code block is an artifact, and which kind. Undefined for an ordinary code block. */
export function classifyFence(info: string | undefined, code: string): ArtifactSpec | undefined {
  const { language, title } = parseFenceInfo(info)
  if (language === 'form') return undefined
  const titled = !!title
  const body = code.trimStart()
  let kind: ArtifactKind | undefined
  if (language === 'mermaid' || language === 'mmd') kind = 'mermaid'
  else if (language === 'svg' || ((language === 'xml' || HTML_LANGS.has(language)) && /^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(body))) kind = 'svg'
  else if (HTML_LANGS.has(language)) kind = titled || /<!doctype\s+html|<html[\s>]/i.test(code) ? 'html' : undefined
  else if (REACT_LANGS.has(language)) kind = titled || /export\s+default\b/.test(code) ? 'react' : undefined
  else if (SCRIPT_LANGS.has(language) && titled) kind = looksLikeReact(code) ? 'react' : 'code'
  else if (MARKDOWN_LANGS.has(language)) kind = titled ? 'markdown' : undefined
  else if (titled) kind = 'code'
  if (!kind) return undefined
  return { kind, language: language || (kind === 'code' ? 'text' : kind), title: title ?? defaultTitle(kind, code), titled }
}

export interface ArtifactBlock extends ArtifactSpec {
  content: string
  /** The fence was closed. While a reply is still being written the last one may be open. */
  closed: boolean
  /** Position among the artifacts of the same message, from 0. */
  index: number
}

function walk(tokens: Token[], out: Token[]): Token[] {
  for (const t of tokens) {
    if (t.type === 'code') out.push(t)
    const nested = t as { tokens?: Token[]; items?: Token[] }
    if (nested.tokens) walk(nested.tokens, out)
    if (nested.items) walk(nested.items, out)
  }
  return out
}

const CLOSING_FENCE = /\n[ \t]*(`{3,}|~{3,})[ \t]*$/

/** Whether a fenced code block's source ends with its closing fence. */
export function fenceClosed(raw: string): boolean {
  return CLOSING_FENCE.test(raw.trimEnd())
}

/** The artifacts in one message's text, in the order they appear. */
export function artifactBlocks(text: string): ArtifactBlock[] {
  if (!/```|~~~/.test(text)) return []
  const out: ArtifactBlock[] = []
  for (const t of walk(new Lexer({ gfm: true }).lex(text), [])) {
    if (t.type !== 'code') continue
    const code = t as Token & { lang?: string; text: string; raw: string; codeBlockStyle?: string }
    if (code.codeBlockStyle === 'indented') continue
    const spec = classifyFence(code.lang, code.text)
    if (spec) out.push({ ...spec, content: code.text, closed: fenceClosed(code.raw), index: out.length })
  }
  return out
}

export interface ArtifactVersion {
  messageId: string
  index: number
  kind: ArtifactKind
  language: string
  title: string
  content: string
  /** Finished: the fence was closed, or the message is no longer being written. */
  complete: boolean
  createdAt: number
}

export interface Artifact {
  key: string
  title: string
  versions: ArtifactVersion[]
}

export interface ArtifactSource {
  id: string
  role: string
  text: string
  status?: string
  createdAt: number
}

/** Titled artifacts with the same title are one artifact with several versions. Untitled ones stand alone. */
export function artifactKey(block: Pick<ArtifactBlock, 'title' | 'titled' | 'index'>, messageId: string): string {
  return block.titled ? `title:${block.title.toLowerCase().replace(/\s+/g, ' ').trim()}` : `message:${messageId}:${block.index}`
}

/** Every artifact in a conversation, oldest first, each with its versions in order. */
export function collectArtifacts(messages: ArtifactSource[]): Artifact[] {
  const byKey = new Map<string, Artifact>()
  for (const m of messages) {
    if ((m.role !== 'assistant' && m.role !== 'user') || !m.text) continue
    for (const block of artifactBlocks(m.text)) {
      const key = artifactKey(block, m.id)
      let artifact = byKey.get(key)
      if (!artifact) {
        artifact = { key, title: block.title, versions: [] }
        byKey.set(key, artifact)
      }
      artifact.title = block.title
      artifact.versions.push({
        messageId: m.id,
        index: block.index,
        kind: block.kind,
        language: block.language,
        title: block.title,
        content: block.content,
        complete: block.closed || m.status !== 'streaming',
        createdAt: m.createdAt
      })
    }
  }
  return [...byKey.values()]
}

/** The artifact and version shown for a card: the one written at that place in that message. */
export function findArtifact(artifacts: Artifact[], messageId: string, index: number): { artifact: Artifact; version: number } | undefined {
  for (const artifact of artifacts) {
    const version = artifact.versions.findIndex((v) => v.messageId === messageId && v.index === index)
    if (version >= 0) return { artifact, version }
  }
  return undefined
}

const EXTENSIONS: Record<string, string> = {
  javascript: 'js',
  js: 'js',
  mjs: 'mjs',
  typescript: 'ts',
  ts: 'ts',
  jsx: 'jsx',
  tsx: 'tsx',
  python: 'py',
  py: 'py',
  ruby: 'rb',
  rust: 'rs',
  go: 'go',
  golang: 'go',
  java: 'java',
  kotlin: 'kt',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  csharp: 'cs',
  'c#': 'cs',
  cs: 'cs',
  php: 'php',
  bash: 'sh',
  sh: 'sh',
  shell: 'sh',
  zsh: 'sh',
  powershell: 'ps1',
  ps1: 'ps1',
  sql: 'sql',
  json: 'json',
  yaml: 'yml',
  yml: 'yml',
  toml: 'toml',
  css: 'css',
  scss: 'scss',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  scala: 'scala',
  xml: 'xml'
}

/** A title for people to read. A snake_case name like "study_guide_part_2" reads as "Study guide part 2". */
export function artifactLabel(title: string): string {
  if (!/^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/.test(title)) return title
  const words = title.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A file name to save a version under, made from its title. */
export function artifactFileName(v: Pick<ArtifactVersion, 'kind' | 'language' | 'title'>): string {
  const base =
    v.title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 60) || 'artifact'
  const ext =
    v.kind === 'html' ? 'html' : v.kind === 'svg' ? 'svg' : v.kind === 'mermaid' ? 'mmd' : v.kind === 'markdown' ? 'md' : v.kind === 'react' ? (v.language === 'tsx' || v.language === 'ts' || v.language === 'typescript' ? 'tsx' : 'jsx') : (EXTENSIONS[v.language] ?? 'txt')
  return `${base}.${ext}`
}

/** The form blocks in a message's text, in order, as their language "form" fences. An unreadable one is undefined. */
export function formBlocks(text: string): ({ title?: string; json: string } | undefined)[] {
  if (!/(```|~~~)\s*form/.test(text)) return []
  return walk(new Lexer({ gfm: true }).lex(text), [])
    .map((t) => t as Token & { lang?: string; text: string; codeBlockStyle?: string })
    .filter((t) => t.codeBlockStyle !== 'indented' && parseFenceInfo(t.lang).language === 'form')
    .map((t) => ({ title: parseFenceInfo(t.lang).title, json: t.text }))
}

/** One artifact on the Artifacts page: its newest version, and the chat it was written in. */
export interface ArtifactEntry {
  conversationId: string
  conversationTitle: string
  title: string
  kind: ArtifactKind
  language: string
  /** Where the newest version was written, to open it. */
  messageId: string
  index: number
  versions: number
  updatedAt: number
  /** What the card shows of the newest version, read as `look` says. */
  excerpt: string
  /** Words to read, an SVG picture, or the start of the code. */
  look: ArtifactLook
}

export type ArtifactLook = 'words' | 'picture' | 'code'

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? whole
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
  })
}

/** Tidies words pulled out of markup: one space between words, one break between blocks. */
function tidyWords(text: string): string {
  return text
    .replace(/[ \t\r\f\v\u00a0]+/g, ' ')
    .replace(/ ?\n[\s]*/g, '\n')
    .trim()
}

/** The words a web page shows, without its tags, styles and scripts. */
function pageWords(html: string): string {
  const text = html
    .replace(/<(script|style|head|svg|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:br|\/p|\/h[1-6]|\/li|\/div|\/tr|\/section|\/header|\/button|\/label)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
  return tidyWords(decodeEntities(text))
}

/** The words written between a component's tags, without its code. */
function componentWords(code: string): string {
  const out: string[] = []
  for (const m of code.matchAll(/>([^<>{}]+)</g)) {
    const words = m[1].trim()
    if (/[A-Za-z]/.test(words) && !/[;=()]|&&|\|\||=>/.test(words)) out.push(words)
  }
  return tidyWords(decodeEntities(out.join('\n')))
}

/** A document's words, without the marks that format them. */
function documentWords(text: string): string {
  return tidyWords(
    text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
      .replace(/^\s*(?:[-*_]\s*){3,}$/gm, '')
      .replace(/(\*\*|__|\*|~~|`)(?=\S)([^\n]*?\S)\1/g, '$2')
  )
}

/** The largest image the Artifacts page draws on a card. Bigger ones show their code. */
const PICTURE_MAX = 60_000

// Diagram pictures drawn in Claude's own app name their colours by class (box, arr,
// c-purple and the rest) and leave the look to the page around them. These give
// those names a look here. Each colour is a fill, an edge, a title and small text.
const DIAGRAM_COLORS: Record<string, [string, string, string, string]> = {
  purple: ['#efecfb', '#6f62c9', '#352c80', '#5b50b0'],
  teal: ['#e3f4ef', '#22806a', '#0c4a3d', '#1f6e5b'],
  coral: ['#fbebe5', '#c0532e', '#6e2913', '#a0441f'],
  pink: ['#fbe9f0', '#b8476f', '#6b1f3a', '#9a3a5c'],
  gray: ['#f2f1ec', '#8a8880', '#3e3d3a', '#64625d'],
  blue: ['#e8f1fb', '#3a78c2', '#123f70', '#2d65a6'],
  green: ['#ecf4e2', '#5a8f2a', '#2a4d0e', '#4a7a21'],
  amber: ['#fbf0dc', '#b07a1f', '#5e3a08', '#8d5c10'],
  red: ['#fcebea', '#c24141', '#701c1c', '#a33333']
}

const SHAPES = ['rect', 'circle', 'ellipse', 'polygon']

/** Styles for the class names diagram pictures use without defining. Every rule has no weight, so a picture's own styles win. */
export const DIAGRAM_CSS = [
  ":where(svg .t, svg .ts, svg .th) { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; fill: #1f1e1d; }",
  ':where(svg .t, svg .th) { font-size: 14px; }',
  ':where(svg .th) { font-weight: 600; }',
  ':where(svg .ts) { font-size: 12px; fill: #5e5d59; }',
  ':where(svg .box) { fill: #f6f5f1; stroke: #b9b7ae; }',
  ':where(svg .bg) { fill: #faf9f6; }',
  ':where(svg .arr) { fill: none; stroke: #7a7870; stroke-width: 1.5; }',
  ':where(svg .leader) { fill: none; stroke: #9a988f; stroke-width: 0.5; stroke-dasharray: 3 3; }',
  ...Object.entries(DIAGRAM_COLORS).flatMap(([name, [fill, edge, title, small]]) => [
    `:where(${SHAPES.map((s) => `svg .c-${name} > ${s}, svg ${s}.c-${name}`).join(', ')}) { fill: ${fill}; stroke: ${edge}; }`,
    `:where(svg .c-${name} .t, svg .c-${name} .th) { fill: ${title}; }`,
    `:where(svg .c-${name} .ts) { fill: ${small}; }`
  ])
].join('\n')

/** Whether a picture uses any of the class names that DIAGRAM_CSS gives a look. */
export function usesDiagramClasses(content: string): boolean {
  return /\bclass\s*=\s*["'](?:[^"']*\s)?(?:t|ts|th|box|bg|arr|leader|c-[a-z]+)(?:\s[^"']*)?["']/.test(content)
}

/** An SVG ready to draw from a data address: with its namespace, and with the diagram look it leans on. */
function pictureOf(content: string): string | null {
  if (content.length > PICTURE_MAX || !/<svg\b/i.test(content)) return null
  // An image without its namespace does not draw from a data address.
  let svg = /<svg\b[^>]*\bxmlns\s*=/i.test(content) ? content : content.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  if (usesDiagramClasses(svg)) svg = svg.replace(/<svg\b[^>]*>/i, (open) => `${open}<style>${DIAGRAM_CSS}</style>`)
  return svg
}

/** What an artifact's card on the Artifacts page shows: its words, its picture, or the start of its code. */
export function artifactPeek(kind: ArtifactKind, content: string): { excerpt: string; look: ArtifactLook } {
  const code = { excerpt: content.slice(0, 400), look: 'code' as const }
  // A widget can be one picture and nothing else; show that the same way.
  if (kind === 'svg' || (kind === 'html' && /^\s*<svg\b/i.test(content) && /<\/svg>\s*$/i.test(content))) {
    const svg = pictureOf(content)
    return svg ? { excerpt: svg, look: 'picture' } : code
  }
  const words = kind === 'html' ? pageWords(content) : kind === 'react' ? componentWords(content) : kind === 'markdown' ? documentWords(content) : ''
  return words ? { excerpt: words.slice(0, 400), look: 'words' } : code
}

/** Every finished artifact in every chat, the most recently changed first. */
export function listArtifacts(conversations: { id: string; title: string }[], messages: (ArtifactSource & { conversationId: string })[]): ArtifactEntry[] {
  const byChat = new Map<string, (ArtifactSource & { conversationId: string })[]>()
  for (const m of messages) {
    const list = byChat.get(m.conversationId)
    if (list) list.push(m)
    else byChat.set(m.conversationId, [m])
  }
  const out: ArtifactEntry[] = []
  for (const c of conversations) {
    const list = byChat.get(c.id)
    if (!list) continue
    list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    for (const a of collectArtifacts(list)) {
      const done = a.versions.filter((v) => v.complete)
      const v = done[done.length - 1]
      if (!v) continue
      out.push({
        conversationId: c.id,
        conversationTitle: c.title,
        title: a.title,
        kind: v.kind,
        language: v.language,
        messageId: v.messageId,
        index: v.index,
        versions: done.length,
        updatedAt: v.createdAt,
        ...artifactPeek(v.kind, v.content)
      })
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}
