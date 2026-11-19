import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { applyAccent, applyTextSize } from '../theme'
import { useUi } from '../state'

/** The small box from the quick ask shortcut: one question, sent to a new chat in the main window. */
export function QuickAsk() {
  const settings = useUi((s) => s.app?.settings)
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    applyAccent(settings?.accent)
    applyTextSize(settings?.textSize)
  }, [settings?.accent, settings?.textSize])
  useEffect(() => {
    document.documentElement.classList.add('quick-window')
    input.current?.focus()
    return window.api.on('command', (c) => {
      if (c === 'quick-focus') {
        input.current?.focus()
        input.current?.select()
      }
    })
  }, [])
  return (
    <div className="quick-box">
      <input
        ref={input}
        className="quick-input"
        data-testid="quick-input"
        placeholder="Ask anything"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') void window.api.hideQuick()
          if (e.key === 'Enter' && !e.nativeEvent.isComposing && text.trim()) {
            void window.api.quickAsk(text)
            setText('')
          }
        }}
      />
      <span className="quick-hint">Enter to ask, Esc to close</span>
    </div>
  )
}
