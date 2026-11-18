import { useEffect, useRef, useState } from 'react'
import type { WebService } from '@shared/ipc'
import { openChat, toast, useUi } from '../state'
import { IconBack, IconForward, IconHome, IconReload } from '../icons'

const LINKS: Record<WebService, { label: string; url: string }[]> = {
  claude: [
    { label: 'Chats', url: 'https://claude.ai/recents' },
    { label: 'Projects', url: 'https://claude.ai/projects' },
    { label: 'Code', url: 'https://claude.ai/code' },
    { label: 'Usage', url: 'https://claude.ai/settings/usage' },
    { label: 'Settings', url: 'https://claude.ai/settings/general' }
  ],
  chatgpt: [
    { label: 'Chats', url: 'https://chatgpt.com/' },
    { label: 'Codex', url: 'https://chatgpt.com/codex' },
    { label: 'Images', url: 'https://chatgpt.com/images' },
    { label: 'Usage', url: 'https://chatgpt.com/codex/settings/usage' },
    { label: 'Settings', url: 'https://chatgpt.com/#settings' }
  ]
}

/**
 * The real claude.ai or chatgpt.com. The page itself is drawn by the backend
 * on top of the window, inside the rectangle this component reports.
 */
export function WebView({ service }: { service: WebService }) {
  const state = useUi((s) => s.web[service])
  const covered = useUi((s) => s.dialog !== null)
  const host = useRef<HTMLDivElement>(null)
  const [capturing, setCapturing] = useState(false)

  useEffect(() => {
    const el = host.current
    if (!el) return
    if (covered) {
      // A dialog needs the space: the embedded page would otherwise draw over it.
      void window.api.webHide()
      return
    }
    const report = () => {
      const r = el.getBoundingClientRect()
      void window.api.webShow(service, { x: r.left, y: r.top, width: r.width, height: r.height })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [service, covered])

  useEffect(() => () => void window.api.webHide(), [])

  const name = service === 'claude' ? 'claude.ai' : 'chatgpt.com'
  let shownUrl = state?.url ?? ''
  try {
    const u = new URL(shownUrl)
    shownUrl = u.hostname + (u.pathname === '/' ? '' : u.pathname)
  } catch {
    // keep as is
  }

  return (
    <>
      <div className="webbar drag">
        <button type="button" className="icon-btn" title="Back" disabled={!state?.canGoBack} onClick={() => void window.api.webAction(service, 'back')}>
          <IconBack />
        </button>
        <button type="button" className="icon-btn" title="Forward" disabled={!state?.canGoForward} onClick={() => void window.api.webAction(service, 'forward')}>
          <IconForward />
        </button>
        <button type="button" className="icon-btn" title="Reload" onClick={() => void window.api.webAction(service, 'reload')}>
          {state?.loading ? <span className="spinner" /> : <IconReload />}
        </button>
        <button type="button" className="icon-btn" title="Home" onClick={() => void window.api.webAction(service, 'home')}>
          <IconHome />
        </button>
        {LINKS[service].map((l) => (
          <button type="button" className="chip" key={l.label} onClick={() => void window.api.webNavigate(service, l.url)}>
            {l.label}
          </button>
        ))}
        <span className="web-url" title={state?.url}>
          {shownUrl}
        </span>
        <button
          type="button"
          className="btn btn-small"
          disabled={capturing}
          title={`Copy the chat open on ${name} into this app, so it can continue with any assistant`}
          data-testid="web-capture"
          onClick={() => {
            setCapturing(true)
            void window.api.webCapture(service).then((res) => {
              setCapturing(false)
              if (res.conversationId) {
                toast('Chat copied in. You can continue it with any assistant.')
                openChat(res.conversationId)
              } else toast(res.error ?? 'Could not read that page.')
            })
          }}
        >
          Bring this chat in
        </button>
        <button type="button" className="btn btn-small" title="Open this page in your normal browser" onClick={() => state?.url && void window.api.openExternal(state.url)}>
          Open in browser
        </button>
      </div>
      <div className="web-host" ref={host} data-testid="web-host">
        <div className="web-cover">{covered ? '' : `Loading ${name}`}</div>
      </div>
    </>
  )
}
