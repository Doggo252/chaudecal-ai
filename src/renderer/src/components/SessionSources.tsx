// Which computers the Claude Code and Codex sessions came from, and a way to look
// for new ones on all of them at once.

import { useMemo, useState } from 'react'
import type { Conversation } from '@shared/types'
import { toast, useUi } from '../state'

export interface SessionSource {
  device: string
  claudeCode: number
  codex: number
}

/** Sessions counted by the computer they were started on, this computer first. */
export function sessionSources(conversations: Conversation[], thisDevice: string): SessionSource[] {
  const by = new Map<string, SessionSource>()
  for (const c of conversations) {
    if (!c.origin) continue
    const row = by.get(c.origin.device) ?? { device: c.origin.device, claudeCode: 0, codex: 0 }
    if (c.origin.tool === 'codex') row.codex++
    else row.claudeCode++
    by.set(c.origin.device, row)
  }
  return [...by.values()].sort((a, b) => Number(b.device === thisDevice) - Number(a.device === thisDevice) || a.device.localeCompare(b.device))
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}

export function SessionSources() {
  const conversations = useUi((x) => x.app!.conversations)
  const settings = useUi((x) => x.app!.settings)
  const synced = settings.hub.hostEnabled || !!settings.hub.remoteUrl.trim()
  const rows = useMemo(() => sessionSources(conversations, settings.deviceName), [conversations, settings.deviceName])
  const [looking, setLooking] = useState(false)
  const look = (): void => {
    setLooking(true)
    window.api
      .lookForSessions()
      .then((r) => toast(r.others ? 'Looking on all your computers. New sessions arrive in a moment.' : r.here ? `Found ${plural(r.here, 'new session')}` : 'Nothing new on this computer'))
      .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)))
      .finally(() => setLooking(false))
  }
  return (
    <div className="session-sources" data-testid="session-sources">
      {rows.length ? (
        rows.map((r) => (
          <div className="session-source" key={r.device} data-testid="session-source">
            <span className="session-source-name">
              {r.device}
              {r.device === settings.deviceName ? <span className="session-source-here"> (this computer)</span> : null}
            </span>
            <span className="session-source-count">
              {[r.claudeCode ? `${plural(r.claudeCode, 'Claude Code session')}` : '', r.codex ? `${plural(r.codex, 'Codex session')}` : ''].filter(Boolean).join(', ')}
            </span>
          </div>
        ))
      ) : (
        <div className="session-source-empty">No sessions yet.</div>
      )}
      <p className="session-source-note">
        {synced
          ? 'Each computer with Chaude open brings in its own sessions, and they sync here. To bring in the sessions from another computer, install Chaude there and pair it with your hub.'
          : 'Only this computer so far. To bring in the sessions from another computer, install Chaude there and pair both with a hub under Sync and hub.'}
      </p>
      <button type="button" className="btn btn-small" disabled={looking} data-testid="look-for-sessions" onClick={look}>
        {synced ? 'Look again on all my computers' : 'Look again'}
      </button>
    </div>
  )
}
