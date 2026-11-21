import { useEffect, useState } from 'react'
import type { Message, ProviderId, ToolKind } from '@shared/types'

const VERB: Record<ToolKind, string> = {
  command: 'Running',
  read: 'Reading',
  search: 'Searching',
  edit: 'Editing',
  web: 'Looking on the web:',
  agent: 'Handing off:',
  tool: 'Using',
  other: 'Using'
}

/** What the assistant is doing right now, in a few words. */
export function workStatus(m: Message): string {
  const tool = [...(m.tools ?? [])].reverse().find((t) => t.status === 'running')
  if (tool) {
    const what = (tool.summary || tool.name).split('\n')[0].trim()
    return `${VERB[tool.kind ?? 'other']} ${what.length > 70 ? `${what.slice(0, 69)}…` : what}`
  }
  const step = m.plan?.find((s) => s.status === 'active')
  if (step) return step.text
  if (m.text) return 'Writing'
  if (m.thinking) return 'Thinking'
  return (m.tools?.length ?? 0) > 0 ? 'Working' : 'Getting started'
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** The moving mark that says an assistant is at work, in that assistant's color. */
export function WorkMark({ provider, size = 16 }: { provider?: ProviderId; size?: number }) {
  return (
    <span className="work-mark" style={{ ['--work' as string]: `var(--${provider ?? 'auto'})`, width: size, height: size }} aria-hidden>
      <i />
      <i />
      <i />
    </span>
  )
}

/** Shown under an answer while it is being written: what is happening and for how long. */
export function Working({ m }: { m: Message }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const status = workStatus(m)
  return (
    <div className="working" data-testid="working" role="status" aria-label={status}>
      <WorkMark provider={m.provider} />
      <span className="working-text" title={status}>
        {status}
      </span>
      <span className="working-time">{elapsed(now - m.createdAt)}</span>
    </div>
  )
}
