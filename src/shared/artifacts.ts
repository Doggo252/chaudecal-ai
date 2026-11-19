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

function looksLikeReact(code: string): boolean {
  return /export\s+default\b/.test(code) && (/from\s+['"]react['"]/.test(code) || /<[A-Za-z][\w.]*[\s/>]/.test(code) || /\buse(State|Effect|Ref|Memo)\b/.test(code))
}

function defaultTitle(kind: ArtifactKind, code: string): string {
  if (kind === 'html') return firstMatch(code, /<title[^>]*>([^<]*)<\/title>/i) ?? 'Web page'
  if (kind === 'svg') return firstMatch(code, /<svg[\s\S]*?<title[^>]*>([^<]*)<\/title>/i) ?? 'Image'
  if (kind === 'react') return firstMatch(code, /export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/) ?? firstMatch(code, /export\s+default\s+([A-Z][\w$]*)\s*;?\s*$/m) ?? 'Component'
  if (kind === 'mermaid') return 'Diagram'
  return ARTIFACT_KIND_LABEL[kind]
}

/** Whether a fenced code block is an artifact, and which kind. Undefined for an ordinary code block. */
export function classifyFence(info: string | undefined, code: string): ArtifactSpec | undefined {
  const { language, title } = parseFenceInfo(info)
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
    if (m.role !== 'assistant' || !m.text) continue
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
