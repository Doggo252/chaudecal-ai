import { useState } from 'react'
import type { AttachResult } from '@shared/ipc'
import { toast } from '../state'
import { IconScreen } from '../icons'
import { Popover } from './ui'

type Source = { id: string; name: string; kind: 'screen' | 'window'; thumb: string }

/** Attaches a screenshot of the whole screen or of one window. */
export function CaptureButton({ onAttached }: { onAttached: (r: AttachResult) => void }) {
  const [sources, setSources] = useState<Source[] | undefined>()
  const capture = async (id: string, close: () => void) => {
    close()
    const res = await window.api.captureSource(id)
    if (res.errors.length) toast(res.errors[0])
    onAttached(res)
  }
  return (
    <span onMouseDown={() => void window.api.captureSources().then(setSources)}>
      <Popover up align="right" className="icon-btn" title="Attach a screenshot" label={<IconScreen />} testId="capture">
        {(close) => (
          <div className="capture-menu">
            <div className="menu-title">Attach a screenshot</div>
            {!sources && <div className="muted tiny">Looking for screens and windows</div>}
            {sources && !sources.length && <div className="muted tiny">Nothing to capture. On a Mac, allow Chaude under System Settings, Privacy &amp; Security, Screen Recording.</div>}
            <div className="capture-grid">
              {sources?.map((s) => (
                <button type="button" key={s.id} className="capture-item" data-testid="capture-source" title={s.name} onClick={() => void capture(s.id, close)}>
                  {s.thumb ? <img src={s.thumb} alt="" /> : <span className="capture-blank" />}
                  <span>{s.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </Popover>
    </span>
  )
}
