import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Message } from '@shared/types'
import { ARTIFACT_KIND_LABEL, artifactFileName, artifactLabel, collectArtifacts, findArtifact, hasPreview, type ArtifactVersion } from '@shared/artifacts'
import { ERROR_MESSAGE_TYPE, LINK_MESSAGE_TYPE } from '@shared/artifactPolicy'
import { highlightCode, renderMarkdown } from '../markdown'
import { setState, toast, type OpenArtifact } from '../state'
import { IconBack, IconClose, IconCopy, IconDownload, IconExpand, IconForward, IconReload, IconShrink } from '../icons'

/** Closes the panel. A reply still being written stops pulling it open again. */
export function closeArtifact(): void {
  setState((s) => {
    if (s.artifact?.follow) declined.add(s.artifact.messageId)
    return { artifact: null }
  })
}

/** The window is too narrow to show the panel beside the conversation, so it covers it. Matches the stylesheet. */
export const PANEL_COVERS = '(max-width: 1080px)'

/** Replies whose artifacts the user turned away from while they were being written. */
export const declined = new Set<string>()

function update(patch: Partial<OpenArtifact>): void {
  setState((s) => (s.artifact ? { artifact: { ...s.artifact, ...patch } } : {}))
}

const CodeView = memo(function CodeView({ v }: { v: ArtifactVersion }) {
  const html = useMemo(() => highlightCode(v.content, v.language === 'react' ? 'jsx' : v.language), [v.content, v.language])
  const box = useRef<HTMLPreElement>(null)
  // While it is being written, the newest lines stay in view.
  useLayoutEffect(() => {
    if (!v.complete && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [html, v.complete])
  return (
    <pre className="artifact-code" ref={box} data-testid="artifact-code">
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  )
})

function PreviewFrame({ v, run, onError }: { v: ArtifactVersion; run: number; onError: (message: string) => void }) {
  const [url, setUrl] = useState<string>()
  const [problem, setProblem] = useState<string>()
  const frame = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    let live = true
    setUrl(undefined)
    setProblem(undefined)
    // The page builder includes a JavaScript compiler, so it is only loaded once a preview is wanted.
    import('@shared/artifactDoc')
      .then(async ({ artifactDocument }) => {
        const built = artifactDocument(v.kind, v.content, v.language)
        if (built.error !== undefined) {
          if (live) setProblem(built.error)
          return
        }
        const u = await window.api.artifactView(built.html)
        if (live) setUrl(u)
      })
      .catch((e: unknown) => live && setProblem(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)))
    return () => {
      live = false
    }
  }, [v.kind, v.content, v.language, run])

  // The preview can only tell the app about errors, as one short line of text.
  useEffect(() => {
    const listen = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const data = e.data as { type?: unknown; message?: unknown } | null
      if (data && data.type === ERROR_MESSAGE_TYPE && typeof data.message === 'string') onError(data.message.slice(0, 500))
      if (data && data.type === LINK_MESSAGE_TYPE) toast('Links in a preview do not open. Download the artifact to use it outside the app.')
    }
    window.addEventListener('message', listen)
    return () => window.removeEventListener('message', listen)
  }, [onError])

  if (problem)
    return (
      <div className="artifact-problem" data-testid="artifact-problem">
        {problem}
      </div>
    )
  if (!url) return <div className="artifact-loading">Preparing the preview</div>
  return <iframe ref={frame} key={url} className={`artifact-frame kind-${v.kind}`} src={url} sandbox="allow-scripts" title={v.title} data-testid="artifact-frame" />
}

export function ArtifactPanel({ open, messages, onAskFix, onSaveEdit }: { open: OpenArtifact; messages: Message[]; onAskFix?: (title: string, error: string) => void; onSaveEdit?: (v: ArtifactVersion, content: string) => void }) {
  const [draft, setDraft] = useState<string>()
  const artifacts = useMemo(() => collectArtifacts(messages), [messages])
  const found = findArtifact(artifacts, open.messageId, open.index)
  const [run, setRun] = useState(0)
  const [error, setError] = useState<string>()
  const v = found ? found.artifact.versions[found.version] : undefined
  const versionKey = v ? `${v.messageId}:${v.index}` : ''
  useEffect(() => setError(undefined), [versionKey, run])
  useEffect(() => setDraft(undefined), [versionKey])

  if (!found || !v) {
    return (
      <aside className="artifact-panel" data-testid="artifact-panel">
        <div className="artifact-head">
          <div className="artifact-title">Artifact</div>
          <span className="topbar-spacer" />
          <button type="button" className="icon-btn" title="Close" onClick={closeArtifact}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="artifact-problem">This artifact is no longer in the conversation.</div>
      </aside>
    )
  }

  const { artifact, version } = found
  const formatted = hasPreview(v.kind) || v.kind === 'markdown'
  const tab = !formatted ? 'code' : (open.tab ?? (v.complete ? 'preview' : 'code'))
  const showPreview = tab === 'preview' && v.complete
  const pick = (i: number) => {
    const other = artifact.versions[i]
    if (other) update({ messageId: other.messageId, index: other.index, follow: false })
  }

  return (
    <aside className="artifact-panel" data-testid="artifact-panel" data-kind={v.kind}>
      <div className="artifact-head">
        <div className="artifact-heading">
          <div className="artifact-title" data-testid="artifact-title" title={artifact.title}>
            {artifactLabel(v.title)}
          </div>
          <div className="artifact-sub">
            {ARTIFACT_KIND_LABEL[v.kind]}
            {v.kind === 'code' && v.language !== 'text' ? `, ${v.language}` : ''}
            {!v.complete && ', being written'}
          </div>
        </div>
        {artifact.versions.length > 1 && (
          <div className="artifact-versions" data-testid="artifact-versions">
            <button type="button" className="icon-btn" title="Earlier version" disabled={version === 0} onClick={() => pick(version - 1)} data-testid="artifact-prev">
              <IconBack size={15} />
            </button>
            <span data-testid="artifact-version" title={`Version ${version + 1} of ${artifact.versions.length}`}>
              {version + 1} of {artifact.versions.length}
            </span>
            <button type="button" className="icon-btn" title="Later version" disabled={version === artifact.versions.length - 1} onClick={() => pick(version + 1)} data-testid="artifact-next">
              <IconForward size={15} />
            </button>
          </div>
        )}
        <span className="topbar-spacer" />
        {formatted && (
          <div className="seg" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'preview'} className={tab === 'preview' ? 'on' : ''} data-testid="artifact-tab-preview" onClick={() => update({ tab: 'preview' })}>
              Preview
            </button>
            <button type="button" role="tab" aria-selected={tab === 'code'} className={tab === 'code' ? 'on' : ''} data-testid="artifact-tab-code" onClick={() => update({ tab: 'code' })}>
              Code
            </button>
          </div>
        )}
        {!showPreview && v.complete && onSaveEdit && draft === undefined && (
          <button type="button" className="btn btn-small" data-testid="artifact-edit" onClick={() => setDraft(v.content)}>
            Edit
          </button>
        )}
        {draft !== undefined && (
          <>
            <button type="button" className="btn btn-small" onClick={() => setDraft(undefined)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-small btn-primary"
              data-testid="artifact-save-edit"
              disabled={draft === v.content}
              onClick={() => {
                onSaveEdit?.(v, draft)
                setDraft(undefined)
              }}
            >
              Save as new version
            </button>
          </>
        )}
        {showPreview && hasPreview(v.kind) && (
          <button type="button" className="icon-btn" title="Run the preview again" data-testid="artifact-reload" onClick={() => setRun((n) => n + 1)}>
            <IconReload size={15} />
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          title="Copy"
          data-testid="artifact-copy"
          onClick={() => {
            void navigator.clipboard.writeText(v.content)
            toast('Copied')
          }}
        >
          <IconCopy size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Download"
          data-testid="artifact-download"
          disabled={!v.complete}
          onClick={() => {
            void window.api.saveArtifact(artifactFileName(v), v.content).then((path) => path && toast(`Saved ${path.split(/[\\/]/).pop()}`))
          }}
        >
          <IconDownload size={15} />
        </button>
        <button type="button" className="icon-btn artifact-wide-btn" title={open.wide ? 'Show the conversation' : 'Fill the window'} data-testid="artifact-wide" onClick={() => update({ wide: !open.wide })}>
          {open.wide ? <IconShrink size={15} /> : <IconExpand size={15} />}
        </button>
        <button type="button" className="icon-btn" title="Close" data-testid="artifact-close" onClick={closeArtifact}>
          <IconClose size={16} />
        </button>
      </div>
      {error && showPreview && (
        <div className="artifact-error" data-testid="artifact-error">
          <div className="artifact-error-text">
            <b>The preview ran into a problem.</b> <span title={error}>{error}</span>
          </div>
          {onAskFix && (
            <button type="button" className="btn btn-small" data-testid="artifact-fix" onClick={() => onAskFix(v.title, error)}>
              Ask to fix
            </button>
          )}
          <button type="button" className="icon-btn" title="Dismiss" onClick={() => setError(undefined)}>
            <IconClose size={14} />
          </button>
        </div>
      )}
      <div className="artifact-body">
        {draft !== undefined ? (
          <textarea className="artifact-editor" data-testid="artifact-editor" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} />
        ) : !showPreview ? (
          <CodeView v={v} />
        ) : v.kind === 'markdown' ? (
          <div className="artifact-doc">
            <div className="prose" data-testid="artifact-document" dangerouslySetInnerHTML={{ __html: renderMarkdown(v.content, { artifacts: false }) }} />
          </div>
        ) : (
          <PreviewFrame key={versionKey} v={v} run={run} onError={setError} />
        )}
      </div>
    </aside>
  )
}
