// Turns an artifact into the web page its preview frame shows. Web pages are
// shown as written. Images and diagrams are placed on a page. React components
// are turned into plain JavaScript here (with sucrase) and load React and any
// npm packages they import from esm.sh. Pure.

import { transform } from 'sucrase'
import type { ArtifactKind } from './artifacts'
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

/** A page written by the assistant, with the error reporter put in front of its own scripts. */
export function htmlDocument(content: string): string {
  if (!/<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(content)) {
    return page(`${BASE_STYLE}<style>body { margin: 16px; }</style>`, content)
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
  return page(
    `${BASE_STYLE}<style>
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
