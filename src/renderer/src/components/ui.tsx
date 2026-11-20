import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { LimitWindow, ProviderChoice, ProviderId } from '@shared/types'
import { PROVIDER_LABEL } from '@shared/types'
import { IconCheck, IconClose } from '../icons'

export function providerName(p: ProviderChoice): string {
  return p === 'auto' ? 'Auto' : PROVIDER_LABEL[p]
}

export function ProviderDot({ provider }: { provider: ProviderChoice }) {
  return <span className={`dot dot-${provider}`} aria-hidden="true" />
}

/** Marks a chat that lives on claude.ai or chatgpt.com. */
export function SourceTag({ service }: { service: 'claude' | 'chatgpt' }) {
  return (
    <span className={`source-tag source-${service}`} title={service === 'claude' ? 'A claude.ai chat' : 'A chatgpt.com chat'}>
      <span className={`dot dot-${service}`} aria-hidden="true" />
      {service === 'claude' ? 'Claude' : 'ChatGPT'}
    </span>
  )
}

/** A button with a small menu that closes on outside click or Escape. */
export function Popover(props: {
  label: ReactNode
  title?: string
  className?: string
  align?: 'left' | 'right'
  up?: boolean
  disabled?: boolean
  testId?: string
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="popover" ref={ref}>
      <button type="button" className={props.className ?? 'chip'} title={props.title} disabled={props.disabled} aria-haspopup="menu" aria-expanded={open} data-testid={props.testId} onClick={() => setOpen((o) => !o)}>
        {props.label}
      </button>
      {open && (
        <div className={`menu ${props.align === 'right' ? 'menu-right' : ''} ${props.up ? 'menu-up' : ''}`} role="menu">
          {props.children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

export function MenuItem(props: { onClick: () => void; selected?: boolean; disabled?: boolean; danger?: boolean; children: ReactNode; hint?: ReactNode; testId?: string }) {
  return (
    <button type="button" role="menuitem" className={`menu-item ${props.danger ? 'danger' : ''}`} disabled={props.disabled} data-testid={props.testId} onClick={props.onClick}>
      <span className="menu-item-main">
        <span className="menu-item-label">{props.children}</span>
        {props.hint && <span className="menu-item-hint">{props.hint}</span>}
      </span>
      {props.selected && <IconCheck size={15} />}
    </button>
  )
}

export function Meter({ window: w, compact }: { window: LimitWindow; compact?: boolean }) {
  const pct = w.usedPct
  const known = typeof pct === 'number'
  const width = known ? Math.max(2, Math.min(100, pct)) : w.status === 'exhausted' ? 100 : w.status === 'warning' ? 85 : 0
  return (
    <div className={`meter meter-${w.status} ${compact ? 'meter-compact' : ''}`} role="img" aria-label={known ? `${Math.round(pct)} percent used` : `status ${w.status}`}>
      <div className="meter-fill" style={{ width: `${width}%` }} />
    </div>
  )
}

export function limitText(w: LimitWindow): string {
  if (typeof w.usedPct === 'number') return `${Math.round(w.usedPct)}% used`
  if (w.status === 'exhausted') return 'Limit reached'
  if (w.status === 'warning') return 'Running low'
  if (w.status === 'ok') return 'Within limit'
  return 'No data yet'
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; testId?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props.onClose])
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title} data-testid={props.testId}>
        <div className="modal-head">
          <h2>{props.title}</h2>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        {props.children}
      </div>
    </div>
  )
}

export function Toggle({ checked, onChange, label, testId }: { checked: boolean; onChange: (v: boolean) => void; label: string; testId?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`toggle ${checked ? 'on' : ''}`} data-testid={testId} onClick={() => onChange(!checked)}>
      <span />
    </button>
  )
}

export const PROVIDERS: ProviderId[] = ['claude', 'chatgpt', 'local']
