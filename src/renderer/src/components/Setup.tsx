// Setup: shown on a new install and after everything was erased. Four short steps
// bring everything in: which computer this is, the chats and projects on claude.ai
// and chatgpt.com, the Claude Code and Codex sessions, and the other computers.
// Every step can be skipped, and setup can be run again from Settings.

import { useState } from 'react'
import type { DiscoveredHub } from '@shared/types'
import { setState, toast, useUi } from '../state'
import { IconChatgpt, IconCheck, IconClaude, IconComputer, IconSync } from '../icons'
import { Field, importText, save, WebAccount } from './Settings'
import { SessionSources } from './SessionSources'
import { Toggle } from './ui'

const STEPS = ['This computer', 'Chats and projects', 'Code sessions', 'Other computers'] as const

type Role = 'hub' | 'client' | 'alone'

function done(): void {
  void window.api.setSetupDone(true).then(() => setState((s) => (s.app ? { app: { ...s.app, setupDone: true } } : {})))
}

export function Setup() {
  const [step, setStep] = useState(0)
  const last = step === STEPS.length - 1
  return (
    <div className="setup" data-testid="setup">
      <div className="setup-card">
        <div className="setup-head">
          <ol className="setup-steps">
            {STEPS.map((name, i) => (
              <li key={name} className={i === step ? 'now' : i < step ? 'past' : ''}>
                <button type="button" onClick={() => setStep(i)} data-testid={`setup-step-${i}`}>
                  <span className="setup-dot">{i < step ? <IconCheck /> : i + 1}</span>
                  {name}
                </button>
              </li>
            ))}
          </ol>
          <button type="button" className="btn btn-small" data-testid="setup-skip" onClick={done}>
            Skip setup
          </button>
        </div>
        <div className="setup-body">
          {step === 0 && <ThisComputer />}
          {step === 1 && <ChatsAndProjects />}
          {step === 2 && <CodeSessions />}
          {step === 3 && <OtherComputers />}
        </div>
        <div className="setup-foot">
          {step > 0 && (
            <button type="button" className="btn" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <span className="topbar-spacer" />
          <button type="button" className="btn btn-primary" data-testid={last ? 'setup-done' : 'setup-next'} onClick={() => (last ? done() : setStep(step + 1))}>
            {last ? 'Start using Chaude' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}

function roleOf(hub: { hostEnabled: boolean; remoteUrl: string }): Role {
  return hub.hostEnabled ? 'hub' : hub.remoteUrl.trim() ? 'client' : 'alone'
}

function ThisComputer() {
  const settings = useUi((x) => x.app!.settings)
  const status = useUi((x) => x.app!.hub)
  const [role, setRole] = useState<Role>(roleOf(settings.hub))
  const [found, setFound] = useState<DiscoveredHub[] | null>(null)
  const [looking, setLooking] = useState(false)
  const choose = (r: Role): void => {
    setRole(r)
    if (r === 'hub') save({ hub: { hostEnabled: true } })
    else save({ hub: { hostEnabled: false, ...(r === 'alone' ? { remoteUrl: '' } : {}) } })
  }
  const choices: { id: Role; title: string; sub: string }[] = [
    { id: 'hub', title: 'My main computer', sub: 'It stays on and keeps the master copy. Your other computers and your phone connect to it.' },
    { id: 'client', title: 'Connect to my main computer', sub: 'Chaude is already set up on another computer. This one keeps its own copy in step with it.' },
    { id: 'alone', title: 'Only this computer', sub: 'No sync for now. You can connect computers later under Settings.' }
  ]
  return (
    <>
      <h1 className="setup-title">Welcome to Chaude</h1>
      <p className="setup-lead">Your Claude, ChatGPT and local AI chats in one place, on all your computers. First, what is this computer?</p>
      <label className="setup-label">
        Name of this computer
        <Field className="input wide" value={settings.deviceName} testId="setup-device-name" onCommit={(v) => v.trim() && save({ deviceName: v.trim() })} />
      </label>
      <div className="setup-choices" role="radiogroup">
        {choices.map((c) => (
          <button type="button" key={c.id} role="radio" aria-checked={role === c.id} className={`setup-choice ${role === c.id ? 'on' : ''}`} data-testid={`setup-role-${c.id}`} onClick={() => choose(c.id)}>
            <span className="setup-choice-icon">{c.id === 'alone' ? <IconComputer /> : <IconSync />}</span>
            <span>
              <span className="setup-choice-title">{c.title}</span>
              <span className="setup-choice-sub">{c.sub}</span>
            </span>
          </button>
        ))}
      </div>
      {role === 'client' && (
        <div className="setup-pair">
          <label className="setup-label">
            Address of the main computer
            <Field className="input wide" value={settings.hub.remoteUrl} placeholder="my-pc:47600" testId="setup-hub-url" onCommit={(v) => save({ hub: { remoteUrl: v.trim() } })} />
          </label>
          <div className="inline">
            <button
              type="button"
              className="btn btn-small"
              disabled={looking}
              onClick={() => {
                setLooking(true)
                void window.api.hubDiscover().then((list) => {
                  setFound(list)
                  setLooking(false)
                })
              }}
            >
              {looking ? 'Looking' : 'Find it on this network'}
            </button>
            {found?.map((h) => (
              <button type="button" className="btn btn-small" key={h.url} onClick={() => save({ hub: { remoteUrl: h.url } })}>
                Use {h.name}
              </button>
            ))}
            {found && !found.length && <span className="muted">Nothing answered. Type its address instead.</span>}
          </div>
          <label className="setup-label">
            Pairing code
            <Field className="input wide" value={settings.hub.remoteToken} placeholder="Shown on the main computer under Settings, Sync and hub" testId="setup-hub-token" onCommit={(v) => save({ hub: { remoteToken: v.trim() } })} />
          </label>
          <p className={`setup-status ${status.connected ? 'ok' : ''}`} data-testid="setup-hub-status">
            {status.connected ? 'Connected. Everything from the main computer is on its way.' : status.detail}
          </p>
        </div>
      )}
    </>
  )
}

function SiteImport({ provider }: { provider: 'claude' | 'chatgpt' }) {
  const st = useUi((x) => x.app!.webImport?.[provider])
  const keep = useUi((x) => !!x.app!.settings.webImport?.[provider])
  const web = provider === 'claude' ? 'claude.ai' : 'chatgpt.com'
  const running = st?.state === 'running'
  return (
    <div className="setup-site" data-testid={`setup-site-${provider}`}>
      <div className="setup-site-head">
        <span className="setup-choice-icon">{provider === 'claude' ? <IconClaude /> : <IconChatgpt />}</span>
        <span className="setup-choice-title">{web}</span>
      </div>
      <div className="group">
        <WebAccount provider={provider} />
      </div>
      <p className="setup-status" data-testid={`setup-import-text-${provider}`}>
        {importText(st, web)}
      </p>
      <div className="inline">
        <button
          type="button"
          className="btn btn-small btn-primary"
          disabled={running}
          data-testid={`setup-import-${provider}`}
          onClick={() => {
            // Bringing them in once means keeping them up to date too.
            if (!keep) save({ webImport: { [provider]: true } })
            void window.api.webImport(provider)
          }}
        >
          {running ? 'Bringing them in' : st?.state === 'done' ? 'Look again' : 'Bring in my chats and projects'}
        </button>
      </div>
    </div>
  )
}

function ChatsAndProjects() {
  const role = useUi((x) => roleOf(x.app!.settings.hub))
  return (
    <>
      <h1 className="setup-title">Your chats and projects</h1>
      <p className="setup-lead">
        Sign in to claude.ai and chatgpt.com in Chaude, then bring in every chat and every project, archived ones too. New chats go to the sites, so they also show up in the Claude and ChatGPT apps.
        {role === 'client' ? ' Your main computer may have brought them in already: they arrive through sync, so there is no need to do it twice.' : ''}
      </p>
      <div className="setup-sites">
        <SiteImport provider="claude" />
        <SiteImport provider="chatgpt" />
      </div>
    </>
  )
}

function CodeSessions() {
  const on = useUi((x) => x.app!.settings.localSessions)
  return (
    <>
      <h1 className="setup-title">Claude Code and Codex</h1>
      <p className="setup-lead">Sessions from Claude Code and Codex on this computer go in the Code tab, each folder as its own project. Every computer with Chaude brings in its own sessions, and they sync to the others.</p>
      <div className="group">
        <div className="row">
          <div className="row-main">
            <div className="row-title">Bring in this computer's sessions</div>
            <div className="row-sub">Keeps checking for new ones while Chaude is open.</div>
          </div>
          <Toggle checked={on} label="Bring in this computer's sessions" testId="setup-local-sessions" onChange={(v) => save({ localSessions: v })} />
        </div>
      </div>
      {on && <SessionSources />}
    </>
  )
}

function OtherComputers() {
  const settings = useUi((x) => x.app!.settings)
  const hub = useUi((x) => x.app!.hub)
  const role = roleOf(settings.hub)
  return (
    <>
      <h1 className="setup-title">Your other computers</h1>
      {role === 'hub' ? (
        <>
          <p className="setup-lead">On each of your other computers, install Chaude, choose "Connect to my main computer", and enter these. Their Claude Code and Codex sessions then come here too.</p>
          <div className="group">
            <div className="row row-stack">
              <div className="row-main">
                <div className="row-title">Address</div>
              </div>
              <div className="row-control setup-codes">
                {(hub.addresses ?? []).map((a) => (
                  <span className="code-line" key={a}>
                    {a}
                    {/\/\/100\./.test(a) ? '   (Tailscale, works away from home)' : ''}
                  </span>
                ))}
                {!hub.addresses?.length && <span className="muted">No network address found yet.</span>}
              </div>
            </div>
            <div className="row row-stack">
              <div className="row-main">
                <div className="row-title">Pairing code</div>
                <div className="row-sub">Treat it like a password.</div>
              </div>
              <div className="row-control inline">
                <span className="code-line" data-testid="setup-token">
                  {settings.hub.token}
                </span>
                <button type="button" className="btn btn-small" onClick={() => void navigator.clipboard.writeText(settings.hub.token).then(() => toast('Pairing code copied'))}>
                  Copy
                </button>
              </div>
            </div>
          </div>
        </>
      ) : role === 'client' ? (
        <p className="setup-lead">{hub.connected ? 'This computer is connected to your main computer. Chats, projects and sessions from all your computers come through it.' : 'This computer will connect to your main computer as soon as it can reach it.'}</p>
      ) : (
        <p className="setup-lead">This computer keeps everything to itself for now. To bring in chats and sessions from another computer, make one of them the main computer under Settings, Sync and hub, and connect the others to it.</p>
      )}
      <p className="setup-lead">You can run setup again any time from Settings.</p>
    </>
  )
}
