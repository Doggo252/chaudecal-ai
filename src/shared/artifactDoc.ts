// Turns an artifact into the web page its preview frame shows. Web pages are
// shown as written. Images and diagrams are placed on a page. React components
// are turned into plain JavaScript here (with sucrase) and load React and any
// npm packages they import from esm.sh. Pure.

import { transform } from 'sucrase'
import { DIAGRAM_CSS, usesDiagramClasses, type ArtifactKind } from './artifacts'
import { ERROR_MESSAGE_TYPE, LINK_MESSAGE_TYPE } from './artifactPolicy'

export const REACT_VERSION = '19.3.1'
const REACT_URL = `https://esm.sh/react@${REACT_VERSION}`
const REACT_DOM_URL = `https://esm.sh/react-dom@${REACT_VERSION}`
const TAILWIND_URL = 'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4'
const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'

/** Where React's own modules come from. Packages from esm.sh leave React to this map, so a page has one copy of it. */
export const REACT_IMPORTS: Record<string, string> = {
  react: REACT_URL,
  'react/jsx-runtime': `${REACT_URL}/jsx-runtime`,
  'react/jsx-dev-runtime': `${REACT_URL}/jsx-dev-runtime`,
  'react-dom': `${REACT_DOM_URL}?external=react`,
  'react-dom/client': `${REACT_DOM_URL}/client?external=react`
}


function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** A string as a script literal that cannot end the script element it sits in. */
function scriptLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

// Tells the app about errors on the page, so the panel can show them and offer
// to ask the assistant for a fix. It only ever sends a short line of text.
const REPORTER = `<script>(function () {
  var sent = 0;
  function say(message) {
    var text = String(message || 'The preview ran into an error.');
    if (/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(text)) {
      text = 'Could not load a library from the internet. Previews of components and diagrams need a connection.';
    }
    if (sent++ < 5) parent.postMessage({ type: ${scriptLiteral(ERROR_MESSAGE_TYPE)}, message: text.slice(0, 500) }, '*');
  }
  window.__reportArtifactError = say;
  addEventListener('error', function (e) { say(e.message || (e.error && e.error.message)); });
  addEventListener('unhandledrejection', function (e) { say(e.reason && e.reason.message ? e.reason.message : e.reason); });
  // A preview stays on its own page. Links within the page still work.
  addEventListener('click', function (e) {
    var link = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (href.charAt(0) === '#') return;
    e.preventDefault();
    parent.postMessage({ type: ${scriptLiteral(LINK_MESSAGE_TYPE)} }, '*');
  }, true);
})();</script>`

const BASE_STYLE = `<style>
  html { color-scheme: light; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Roboto, sans-serif; }
</style>`

function page(head: string, body: string, scheme = 'light'): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${scheme}">
${REPORTER}
${head}
</head>
<body>
${body}
</body>
</html>`
}

// Interactive pieces made in Claude's own app are bits of a page that lean on the
// host for their look: colour and size names, plain buttons and fields, and a
// hidden heading for screen readers. These give them that look here, in light and
// dark. Element rules use :where() so the piece's own styles always win.
const WIDGET_STYLE = `<style>
  :root {
    --color-text-primary: #1f1e1d; --color-text-secondary: #5e5d59; --color-text-tertiary: #8b8a85;
    --color-text-info: #2563c9; --color-text-success: #2f7a3e; --color-text-warning: #9a6200; --color-text-danger: #b3261e;
    --color-background-primary: #ffffff; --color-background-secondary: #f6f5f1; --color-background-tertiary: #eeede8;
    --color-background-info: #e9f0fc; --color-background-success: #eaf4ec; --color-background-warning: #fbf2e0; --color-background-danger: #fbeae8;
    --color-border-primary: rgba(31, 30, 29, 0.4); --color-border-secondary: rgba(31, 30, 29, 0.25); --color-border-tertiary: rgba(31, 30, 29, 0.14);
    --color-border-info: #8fb0e6; --color-border-success: #8cc29a; --color-border-warning: #e2bd73; --color-border-danger: #e39c95;
    --color-accent: #c96442;
    --border-radius-sm: 6px; --border-radius-md: 8px; --border-radius-lg: 12px; --border-radius-xl: 16px;
    --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Roboto, sans-serif;
    --font-mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    --font-serif: Georgia, 'Times New Roman', serif;
    --text-primary: var(--color-text-primary); --text-secondary: var(--color-text-secondary); --text-muted: var(--color-text-tertiary);
    --text-info: var(--color-text-info); --text-success: var(--color-text-success); --text-warning: var(--color-text-warning); --text-danger: var(--color-text-danger);
    --surface-0: var(--color-background-primary); --surface-1: var(--color-background-secondary); --surface-2: var(--color-background-tertiary);
    --bg-info: var(--color-background-info); --bg-success: var(--color-background-success); --bg-warning: var(--color-background-warning); --bg-danger: var(--color-background-danger);
    --border: var(--color-border-tertiary); --border-strong: var(--color-border-secondary); --border-stronger: var(--color-border-primary);
    --border-info: var(--color-border-info); --border-success: var(--color-border-success); --border-warning: var(--color-border-warning); --border-danger: var(--color-border-danger);
    --border-accent: var(--color-accent); --fill-accent: var(--color-accent); --radius: var(--border-radius-md);
  }
  @media (prefers-color-scheme: dark) {
    :root.follows-theme {
      --color-text-primary: #f3f1ea; --color-text-secondary: #b8b5ab; --color-text-tertiary: #8d8a81;
      --color-text-info: #8ab4f8; --color-text-success: #7fc98f; --color-text-warning: #e8b85c; --color-text-danger: #f08a80;
      --color-background-primary: #262624; --color-background-secondary: #30302d; --color-background-tertiary: #3a3a36;
      --color-background-info: #1f2b40; --color-background-success: #1f3325; --color-background-warning: #3a2f1a; --color-background-danger: #3d2220;
      --color-border-primary: rgba(243, 241, 234, 0.4); --color-border-secondary: rgba(243, 241, 234, 0.25); --color-border-tertiary: rgba(243, 241, 234, 0.14);
      --color-border-info: #4a6fa8; --color-border-success: #4b8a5a; --color-border-warning: #a07d36; --color-border-danger: #a85048;
      --color-accent: #d97757;
    }
  }
  :root.follows-theme { color-scheme: light dark; }
  html { background: var(--color-background-primary); color: var(--color-text-primary); }
  body { font-family: var(--font-sans); font-size: 15px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  :where(h1, h2, h3, h4) { font-weight: 500; line-height: 1.3; }
  :where(button) {
    font: inherit; font-size: 14px; color: var(--color-text-primary); background: transparent;
    border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-md);
    padding: 6px 14px; cursor: pointer; transition: background-color 0.15s, border-color 0.15s;
  }
  :where(button):hover { background: var(--color-background-secondary); }
  :where(button):active { transform: scale(0.98); }
  :where(button):disabled { opacity: 0.5; cursor: default; }
  :where(input:not([type=range], [type=checkbox], [type=radio], [type=color]), select, textarea) {
    font: inherit; font-size: 14px; color: var(--color-text-primary); background: var(--color-background-primary);
    border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-md); padding: 6px 10px; box-sizing: border-box;
  }
  :where(input, select, textarea):focus-visible { outline: 2px solid var(--color-border-info); outline-offset: 1px; }
  :where(input[type=range], input[type=checkbox], input[type=radio]) { accent-color: var(--color-accent); }
  :where(table) { border-collapse: collapse; }
  :where(th, td) { border-bottom: 0.5px solid var(--color-border-tertiary); padding: 6px 8px; text-align: left; }
  :where(code, pre, kbd) { font-family: var(--font-mono); }
</style>`

/** Whether a piece of a page uses the colour names of Claude's own app, so it can follow the light or dark look. */
function followsTheme(content: string): boolean {
  return /var\(--(?:color-|text-|surface-|bg-|border-|fill-)/.test(content)
}

const ICONS_URL = 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3/dist/tabler-icons.min.css'

/** A page written by the assistant, with the error reporter put in front of its own scripts. */
export function htmlDocument(content: string): string {
  if (!/<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(content)) {
    const icons = /class="[^"]*\bti ti-/.test(content) ? `<link rel="stylesheet" href="${ICONS_URL}">` : ''
    const theme = followsTheme(content)
    const diagram = /<svg\b/i.test(content) && usesDiagramClasses(content) ? `<style>${DIAGRAM_CSS}</style>` : ''
    const built = page(`${BASE_STYLE}${WIDGET_STYLE}${diagram}${icons}<style>body { margin: 16px 20px; }</style>`, content, theme ? 'light dark' : 'light')
    return theme ? built.replace('<html lang="en">', '<html lang="en" class="follows-theme">') : built
  }
  const head = /<head(\s[^>]*)?>/i.exec(content)
  if (head) return content.slice(0, head.index + head[0].length) + REPORTER + content.slice(head.index + head[0].length)
  const html = /<html(\s[^>]*)?>/i.exec(content)
  if (html) return content.slice(0, html.index + html[0].length) + REPORTER + content.slice(html.index + html[0].length)
  const doctype = /<!doctype[^>]*>/i.exec(content)
  if (doctype) return content.slice(0, doctype.index + doctype[0].length) + REPORTER + content.slice(doctype.index + doctype[0].length)
  return REPORTER + content
}

export function svgDocument(content: string): string {
  const diagram = usesDiagramClasses(content) ? `<style>${DIAGRAM_CSS}</style>` : ''
  return page(
    `${BASE_STYLE}${diagram}<style>
  html, body { height: 100%; }
  body { display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; }
  svg { max-width: 100%; max-height: 100%; height: auto; }
</style>`,
    content.replace(/^\s*<\?xml[^>]*>\s*/i, '')
  )
}

export function mermaidDocument(content: string): string {
  return page(
    `<style>
  html { color-scheme: light dark; }
  body { margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: transparent; }
  .mermaid { display: flex; justify-content: center; margin: 0; }
  .mermaid:not([data-processed]) { visibility: hidden; }
</style>`,
    `<pre class="mermaid">${escapeHtml(content.trim())}</pre>
<script type="module">
  try {
    const { default: mermaid } = await import(${scriptLiteral(MERMAID_URL)});
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
    await mermaid.run({ querySelector: '.mermaid' });
  } catch (e) {
    window.__reportArtifactError(e && e.message ? e.message : e);
  }
</script>`,
    'light dark'
  )
}

export class ArtifactBuildError extends Error {}

function isBare(spec: string): boolean {
  return !/^(\.{0,2}\/|[a-z][a-z0-9+.-]*:)/i.test(spec)
}

/** Where a module named in an import comes from. */
export function moduleUrl(spec: string): string {
  if (REACT_IMPORTS[spec]) return REACT_IMPORTS[spec]
  if (/^(\.{1,2}\/|\/|@\/|~\/)/.test(spec)) {
    throw new ArtifactBuildError(`The component imports "${spec}", a file of a project. A preview has only this one file, so ask for a version that keeps everything in it.`)
  }
  if (!isBare(spec)) return spec
  return `https://esm.sh/${spec}?external=react,react-dom`
}

/** Points every import at a module address the preview can load. */
export function rewriteImports(code: string): string {
  const swap = (_m: string, before: string, quote: string, spec: string) => `${before}${quote}${moduleUrl(spec)}${quote}`
  return code
    .replace(/((?:^|[;\n])[ \t]*(?:import|export)\b[^'"`;]*?\bfrom\s*)(['"])([^'"\n]+)\2/g, swap)
    .replace(/((?:^|[;\n])[ \t]*import\s*)(['"])([^'"\n]+)\2/g, swap)
    .replace(/(\bimport\s*\(\s*)(['"])([^'"\n]+)\2/g, swap)
}

/** A React component as plain JavaScript, ready to load as a module. Throws ArtifactBuildError when it cannot be read. */
export function compileComponent(content: string, language: string): string {
  const typed = language === 'tsx' || language === 'ts' || language === 'typescript'
  let code: string
  try {
    code = transform(content, { transforms: typed ? ['jsx', 'typescript'] : ['jsx'], jsxRuntime: 'automatic', production: true, filePath: typed ? 'App.tsx' : 'App.jsx' }).code
  } catch (e) {
    throw new ArtifactBuildError(`The component could not be read: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!/export\s+default\b|export\s*\{[^}]*\bas\s+default\b/.test(code)) {
    throw new ArtifactBuildError('The component has no default export, so there is nothing to show.')
  }
  return rewriteImports(code)
}

export function reactDocument(content: string, language: string): string {
  const code = compileComponent(content, language)
  return page(
    `<script type="importmap">${JSON.stringify({ imports: REACT_IMPORTS })}</script>
<script src="${TAILWIND_URL}"></script>
${BASE_STYLE}`,
    `<div id="root"></div>
<script type="module">
  try {
    const [React, ReactDOM] = await Promise.all([import(${scriptLiteral(REACT_IMPORTS.react)}), import(${scriptLiteral(REACT_IMPORTS['react-dom/client'])})]);
    const url = URL.createObjectURL(new Blob([${scriptLiteral(code)}], { type: 'text/javascript' }));
    const mod = await import(url);
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(mod.default));
  } catch (e) {
    window.__reportArtifactError(e && e.message ? e.message : e);
  }
</script>`
  )
}

export type BuiltDocument = { html: string; error?: undefined } | { html?: undefined; error: string }

/** The page for a preview, or why there cannot be one. */
export function artifactDocument(kind: ArtifactKind, content: string, language: string): BuiltDocument {
  try {
    if (kind === 'html') return { html: htmlDocument(content) }
    if (kind === 'svg') return { html: svgDocument(content) }
    if (kind === 'mermaid') return { html: mermaidDocument(content) }
    if (kind === 'react') return { html: reactDocument(content, language) }
    return { error: 'This kind has no preview.' }
  } catch (e) {
    if (e instanceof ArtifactBuildError) return { error: e.message }
    throw e
  }
}
