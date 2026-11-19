import { useEffect, useRef, useState } from 'react'
import type { DeepPartial, WebImportStatus } from '@shared/ipc'
import type { DiscoveredHub, LocalEndpoint, ProviderChoice, ProviderId, RunMode, Settings } from '@shared/types'
import { PROVIDER_LABEL, newId } from '@shared/types'
import { formatTokens } from '@shared/tokens'
import { ACCENT_PRESETS, TEXT_SIZES, accentColor } from '@shared/theme'
import { formatReset } from '@shared/usage'
import { setState, toast, useUi } from '../state'
import { applyAccent } from '../theme'
import { McpSettings } from './McpSettings'
import { limitText, Meter, ProviderDot, Toggle } from './ui'

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'accounts', label: 'Claude and ChatGPT' },
  { id: 'local', label: 'Local AI' },
  { id: 'sync', label: 'Sync and hub' },
  { id: 'memory', label: 'Memory and prompts' },
  { id: 'tools', label: 'Tools' },
  { id: 'usage', label: 'Usage' }
]

function save(patch: DeepPartial<Settings>): void {
  void window.api.updateSettings(patch)
}

/** Text input that saves when the user leaves it or presses Enter. */
function Field(props: { value: string; onCommit: (v: string) => void; placeholder?: string; className?: string; type?: string; testId?: string }) {
  const [v, setV] = useState(props.value)
  useEffect(() => setV(props.value), [props.value])
  return (
    <input
      className={props.className ?? 'input'}
      type={props.type ?? 'text'}
      value={v}
      placeholder={props.placeholder}
      data-testid={props.testId}
      spellCheck={false}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== props.value && props.onCommit(v)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

function NumberField({ value, onCommit, min, max }: { value: number; onCommit: (n: number) => void; min: number; max: number }) {
  return (
    <Field
      className="input num"
      value={String(value)}
      onCommit={(v) => {
        const n = Math.round(Number(v.replace(/[, _]/g, '').replace(/k$/i, '000')))
        if (Number.isFinite(n)) onCommit(Math.max(min, Math.min(max, n)))
      }}
    />
  )
}

function Row({ title, sub, children, stack }: { title: string; sub?: string; children?: React.ReactNode; stack?: boolean }) {
  return (
    <div className={`row ${stack ? 'row-stack' : ''}`}>
      <div className="row-main">
        <div className="row-title">{title}</div>
        {sub && <div className="row-sub">{sub}</div>}
      </div>
      {children && <div className={stack ? 'row-control' : ''}>{children}</div>}
    </div>
  )
}

const THEMES: { id: Settings['theme']; label: string }[] = [
  { id: 'system', label: 'Match system' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' }
]

function Appearance() {
  const s = useUi((x) => x.app!.settings)
  const chosen = accentColor(s.accent)
  const isPreset = ACCENT_PRESETS.some((p) => p.id === s.accent)
  const saving = useRef<ReturnType<typeof setTimeout>>(undefined)
  // The color picker reports every step of a drag. The page follows at once, and the setting is saved when it settles.
  const pickCustom = (color: string) => {
    applyAccent(color)
    clearTimeout(saving.current)
    saving.current = setTimeout(() => save({ accent: color }), 200)
  }
  return (
    <div className="group">
      <Row title="Theme" sub="Match system follows the light or dark setting of this computer.">
        <div className="inline">
          {THEMES.map((t) => (
            <button type="button" key={t.id} className={`chip ${s.theme === t.id ? 'on' : ''}`} aria-pressed={s.theme === t.id} data-testid={`theme-${t.id}`} onClick={() => save({ theme: t.id })}>
              {t.label}
            </button>
          ))}
        </div>
      </Row>
      <Row title="Accent color" sub="Used for the main buttons, the switches and your own messages.">
        <div className="swatches" role="radiogroup" aria-label="Accent color">
          {ACCENT_PRESETS.map((p) => (
            <button
              type="button"
              key={p.id}
              role="radio"
              aria-checked={s.accent === p.id}
              aria-label={p.name}
              title={p.name}
              className={`swatch ${p.color ? '' : 'swatch-default'} ${s.accent === p.id ? 'selected' : ''}`}
              style={p.color ? ({ '--swatch': p.color } as React.CSSProperties) : undefined}
              data-testid={`accent-${p.id}`}
              onClick={() => save({ accent: p.id })}
            />
          ))}
          <label className={`swatch swatch-custom ${!isPreset && chosen ? 'selected' : ''}`} title="Choose any color" style={!isPreset && chosen ? ({ '--swatch': chosen } as React.CSSProperties) : undefined}>
            <input type="color" aria-label="Choose any color" data-testid="accent-custom" value={chosen ?? '#2f7fe6'} onChange={(e) => pickCustom(e.target.value)} />
          </label>
        </div>
      </Row>
      <Row title="Text size" sub="For messages, menus and everything else you read in the app.">
        <div className="inline">
          {TEXT_SIZES.map((t) => (
            <button type="button" key={t.id} className={`chip ${s.textSize === t.id ? 'on' : ''}`} aria-pressed={s.textSize === t.id} data-testid={`text-${t.id}`} onClick={() => save({ textSize: t.id })}>
              {t.name}
            </button>
          ))}
        </div>
      </Row>
      <Row title="Preview" sub="How a message of yours and a main button look.">
        <div className="theme-preview" data-testid="theme-preview">
          <div className="bubble">Hello there</div>
          <button type="button" className="btn btn-small btn-primary" tabIndex={-1}>
            Button
          </button>
        </div>
      </Row>
    </div>
  )
}

function General() {
  const s = useUi((x) => x.app!.settings)
  return (
    <>
      <h2>General</h2>
      <p className="lead">How the app looks and behaves on this machine.</p>
      <div className="group-title">Appearance</div>
      <Appearance />

      <div className="group-title">This machine</div>
      <div className="group">
        <Row title="Name of this machine" sub="Shown to your other devices.">
          <Field value={s.deviceName} onCommit={(v) => save({ deviceName: v.trim() || s.deviceName })} />
        </Row>
      </div>

      <div className="group-title">New conversations</div>
      <div className="group">
        <Row title="Assistant" sub="Auto picks for each message from the task and your remaining limits.">
          <select className="select" value={s.defaultProvider} onChange={(e) => save({ defaultProvider: e.target.value as ProviderChoice })}>
            <option value="auto">Auto</option>
            <option value="claude">Claude</option>
            <option value="chatgpt">ChatGPT</option>
            <option value="local">Local AI</option>
          </select>
        </Row>
        <Row title="What the assistant may do" sub="Chat touches nothing on this computer. The others work inside a folder you choose.">
          <select className="select" value={s.defaultMode} onChange={(e) => save({ defaultMode: e.target.value as RunMode })}>
            <option value="chat">Chat</option>
            <option value="plan">Plan (read only)</option>
            <option value="edit">Edit files</option>
            <option value="auto">Edit and run commands</option>
          </select>
        </Row>
        <Row title="Answer short questions locally" sub="In Auto, quick questions go to local AI to save your paid limits.">
          <Toggle checked={s.routing.preferLocalForShort} onChange={(v) => save({ routing: { preferLocalForShort: v } })} label="Answer short questions locally" />
        </Row>
        <Row title="Artifacts" sub="Assistants are asked to put web pages, components, diagrams, images and longer documents in a panel beside the conversation, with a live preview. Off stops asking. Artifacts already written still open.">
          <Toggle checked={s.artifacts} onChange={(v) => save({ artifacts: v })} label="Artifacts" testId="artifacts-toggle" />
        </Row>
      </div>

      <div className="group-title">Context and limits</div>
      <div className="group">
        <Row title="Context budget" sub="Largest running context file, in tokens. A handoff never sends more than the receiving model can take.">
          <NumberField value={s.contextBudgetTokens} min={4000} max={2_000_000} onCommit={(n) => save({ contextBudgetTokens: n })} />
        </Row>
        <Row title="Offer to switch at" sub="Percent of a 5-hour or weekly limit used before the app suggests continuing elsewhere.">
          <NumberField value={s.warnThresholdPct} min={10} max={99} onCommit={(n) => save({ warnThresholdPct: n })} />
        </Row>
        <Row title="Switch automatically at a limit" sub="If an assistant hits its limit in the middle of a reply, carry on with another one without asking. Off means you are asked first.">
          <Toggle checked={s.autoFailover} onChange={(v) => save({ autoFailover: v })} label="Switch automatically at a limit" testId="auto-failover-toggle" />
        </Row>
      </div>

      <div className="group-title">Background and updates</div>
      <div className="group">
        <Row title="Notify me when I am in another app" sub="Shows a notification when a reply is ready or an assistant has stopped to ask for permission. Only for messages sent from this computer, and only while this window is not in front.">
          <Toggle checked={s.notifications} onChange={(v) => save({ notifications: v })} label="Notify me when I am in another app" testId="notifications-toggle" />
        </Row>
        <Row title="Keep running when the window is closed" sub="When this machine is the hub, closing the window leaves the app in the system tray so your other devices can still sync. A Mac keeps the app running either way.">
          <Toggle checked={s.keepRunningInBackground} onChange={(v) => save({ keepRunningInBackground: v })} label="Keep running when the window is closed" />
        </Row>
        <Row title="Start when I sign in to this computer" sub="Starts quietly in the background. Useful on the hub PC.">
          <Toggle checked={s.startAtLogin} onChange={(v) => save({ startAtLogin: v })} label="Start when I sign in to this computer" />
        </Row>
        <Row title="Tell me about new versions" sub="Checks the project's GitHub page a few times a day.">
          <Toggle checked={s.checkForUpdates} onChange={(v) => save({ checkForUpdates: v })} label="Tell me about new versions" />
        </Row>
        <Row title="Download updates automatically" sub="A new version is downloaded in the background and checked against the release. Then &quot;Restart to update&quot; appears in the sidebar. Nothing is installed until you click it.">
          <Toggle checked={s.autoUpdate} onChange={(v) => save({ autoUpdate: v })} label="Download updates automatically" testId="auto-update" />
        </Row>
      </div>
    </>
  )
}

function ago(at: number): string {
  const min = Math.round((Date.now() - at) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  return h < 24 ? `${h} h ago` : new Date(at).toLocaleDateString()
}

function importText(st: WebImportStatus | undefined, web: string): string {
  if (!st) return ''
  const chats = (n: number) => `${n} ${n === 1 ? 'chat' : 'chats'}`
  if (st.state === 'running') return st.of ? `Bringing in chats: ${st.done ?? 0} of ${st.of} checked, ${st.changed ?? 0} new or changed.` : 'Looking for your chats.'
  if (st.state === 'signed-out' || st.state === 'error') return st.message ?? 'Something went wrong.'
  if (st.state === 'done') return `${chats(st.count)} from ${web} in the app. ${st.changed ? `${chats(st.changed)} new or changed` : 'Nothing new'} when checked ${ago(st.lastRun ?? Date.now())}.`
  return st.count ? `${chats(st.count)} from ${web} in the app.` : `Brings in your chats from ${web} with the sign-in in its tab in this app. Sign in there first.`
}

function WebHistory({ provider }: { provider: 'claude' | 'chatgpt' }) {
  const app = useUi((x) => x.app!)
  const st = app.webImport?.[provider]
  const web = provider === 'claude' ? 'claude.ai' : 'chatgpt.com'
  const running = st?.state === 'running'
  return (
    <>
      <Row title={`Your chats on ${web}`} sub={importText(st, web)}>
        <div className="inline" data-testid={`web-import-${provider}`} data-state={st?.state ?? 'idle'}>
          {st?.state === 'signed-out' && (
            <button type="button" className="btn btn-small" onClick={() => setState({ view: { kind: 'web', service: provider } })}>
              Open {web}
            </button>
          )}
          <button type="button" className="btn btn-small btn-primary" disabled={running} data-testid={`web-import-now-${provider}`} onClick={() => void window.api.webImport(provider)}>
            {running ? 'Importing' : 'Import now'}
          </button>
        </div>
      </Row>
      <Row title="Keep up to date" sub={`Checks ${web} every 30 minutes while the app is open and brings in new and changed chats. Your other devices get them through sync.`}>
        <Toggle checked={!!app.settings.webImport?.[provider]} onChange={(v) => save({ webImport: { [provider]: v } })} label={`Keep chats from ${web} up to date`} testId={`web-import-auto-${provider}`} />
      </Row>
    </>
  )
}

function Account({ provider }: { provider: 'claude' | 'chatgpt' }) {
  const app = useUi((x) => x.app!)
  const s = app.settings[provider]
  const st = app.providers[provider]
  const [signing, setSigning] = useState(false)
  const web = provider === 'claude' ? 'claude.ai' : 'chatgpt.com'
  return (
    <>
      <div className="group-title">{PROVIDER_LABEL[provider]}</div>
      <div className="group">
        <Row title={provider === 'claude' ? 'Claude Code sign-in' : 'Codex sign-in'} sub={st ? `${st.detail}${st.version ? `. ${st.version}` : ''}` : 'Checking'}>
          <div className="inline">
            <span className={`badge ${st?.ready ? 'ok' : 'bad'}`} data-testid={`status-${provider}`}>
              {st?.ready ? 'Ready' : st?.installed ? 'Sign in needed' : 'Not installed'}
            </span>
            {st?.installed && !st.ready && (
              <button
                type="button"
                className="btn btn-small btn-primary"
                disabled={signing}
                onClick={() => {
                  setSigning(true)
                  toast('Finish signing in in your browser.')
                  void window.api.providerLogin(provider).then((r) => {
                    setSigning(false)
                    toast(r.detail)
                  })
                }}
              >
                {signing ? 'Waiting for browser' : 'Sign in'}
              </button>
            )}
          </div>
        </Row>
        <Row title="Models" sub="Shown in the model picker. Separate with commas. Leave the picker on Default to let the service choose." stack>
          <Field className="input wide" value={s.models.join(', ')} placeholder={provider === 'chatgpt' ? 'Filled in from your account when signed in' : ''} onCommit={(v) => save({ [provider]: { models: v.split(',').map((m) => m.trim()).filter(Boolean) } })} />
        </Row>
        <Row title="Model context window" sub="Tokens the model accepts. Raise it only if your plan's model really takes more.">
          <NumberField value={s.contextTokens} min={8000} max={2_000_000} onCommit={(n) => save({ [provider]: { contextTokens: n } })} />
        </Row>
        <Row title="Command line tool location" sub="Leave empty to find it automatically." stack>
          <Field className="input wide" value={s.cliPath} placeholder="Found automatically" onCommit={(v) => save({ [provider]: { cliPath: v.trim() } })} />
        </Row>
        <WebHistory provider={provider} />
        <Row title={provider === 'claude' ? 'Plugins, MCP servers and settings' : 'Configuration'} sub={provider === 'claude' ? 'Your Claude Code plugins, MCP servers, skills and settings apply to Claude here automatically.' : 'Your Codex configuration applies to ChatGPT here automatically.'}>
          <div className="inline">
            <button type="button" className="btn btn-small" onClick={() => void window.api.openConfig(provider)}>
              Open config
            </button>
            <button type="button" className="btn btn-small" onClick={() => setState({ view: { kind: 'web', service: provider } })}>
              Open {web}
            </button>
          </div>
        </Row>
      </div>
    </>
  )
}

function Accounts() {
  return (
    <>
      <h2>Claude and ChatGPT</h2>
      <p className="lead">
        Both use the official command line tools signed in with your own subscription, so chats here count against your normal plan limits. Everything else the services offer is in the claude.ai and chatgpt.com tabs in the sidebar.
      </p>
      <Account provider="claude" />
      <Account provider="chatgpt" />
      <button type="button" className="btn" onClick={() => void window.api.refreshProviders().then(() => toast('Checked again'))}>
        Check again
      </button>
    </>
  )
}

function LocalAi() {
  const app = useUi((x) => x.app!)
  const s = app.settings.local
  const setEndpoints = (endpoints: LocalEndpoint[]) => save({ local: { endpoints } })
  const here = app.localModels.filter((m) => m.via === 'direct')
  const onHub = app.localModels.filter((m) => m.via === 'hub')
  return (
    <>
      <h2>Local AI</h2>
      <p className="lead">
        Models that run on your own hardware. Any server that speaks the OpenAI chat API works. Run them on the hub PC and every device can use them, with the PC doing the processing.
      </p>
      <div className="group-title">Runtimes on this machine</div>
      <div className="group">
        {s.endpoints.map((e) => {
          const count = here.filter((m) => m.endpointId === e.id).length
          return (
            <div className="row row-stack" key={e.id}>
              <div className="inline" style={{ justifyContent: 'space-between' }}>
                <div className="inline">
                  <Field value={e.name} onCommit={(v) => setEndpoints(s.endpoints.map((x) => (x.id === e.id ? { ...x, name: v.trim() || x.name } : x)))} />
                  <span className={`badge ${count ? 'ok' : ''}`}>{count ? `${count} ${count === 1 ? 'model' : 'models'} running` : 'Not running'}</span>
                </div>
                <div className="inline">
                  <Toggle checked={e.enabled} label={`Use ${e.name}`} onChange={(v) => setEndpoints(s.endpoints.map((x) => (x.id === e.id ? { ...x, enabled: v } : x)))} />
                  <button type="button" className="btn btn-small btn-danger" onClick={() => setEndpoints(s.endpoints.filter((x) => x.id !== e.id))}>
                    Remove
                  </button>
                </div>
              </div>
              <div className="row-control">
                <Field className="input wide" value={e.baseUrl} testId={`endpoint-url-${e.id}`} onCommit={(v) => setEndpoints(s.endpoints.map((x) => (x.id === e.id ? { ...x, baseUrl: v.trim() } : x)))} />
              </div>
            </div>
          )
        })}
        <div className="row">
          <div className="inline">
            <button type="button" className="btn btn-small" onClick={() => setEndpoints([...s.endpoints, { id: `custom-${newId().slice(-6)}`, name: 'Custom server', baseUrl: 'http://127.0.0.1:8080/v1', enabled: true }])}>
              Add a server
            </button>
            <button type="button" className="btn btn-small" onClick={() => void window.api.refreshProviders().then(() => toast('Looked for models again'))}>
              Look for models
            </button>
          </div>
        </div>
      </div>

      <div className="group-title">Models you can use</div>
      <div className="group">
        {!app.localModels.length && <Row title="None found" sub="Start Ollama or LM Studio and load a model, or connect to your hub PC under Sync and hub." />}
        {[...here, ...onHub].map((m) => (
          <div className="list-item" key={`${m.via}:${m.endpointId}/${m.id}`}>
            <div className="list-item-main">
              <ProviderDot provider="local" /> {m.id}
            </div>
            <span className="badge">
              {m.endpointName}, {m.via === 'hub' ? 'on the hub' : 'this machine'}
            </span>
          </div>
        ))}
      </div>

      <div className="group-title">Behavior</div>
      <div className="group">
        <Row title="Default model" sub="Used when a conversation has no specific local model.">
          <select className="select" value={s.defaultModel} onChange={(e) => save({ local: { defaultModel: e.target.value } })}>
            <option value="">First available</option>
            {app.localModels.map((m) => (
              <option key={`${m.endpointId}/${m.id}`} value={`${m.endpointId}/${m.id}`}>
                {m.id}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Context window" sub="Tokens your local models are loaded with. Match the value set in Ollama or LM Studio.">
          <NumberField value={s.contextTokens} min={2000} max={1_000_000} onCommit={(n) => save({ local: { contextTokens: n } })} />
        </Row>
        <Row title="Keep summaries up to date with local AI" sub="Conversation summaries for handoffs are written by a local model, so they never spend a paid limit.">
          <Toggle checked={s.summarize} label="Summarize with local AI" onChange={(v) => save({ local: { summarize: v } })} />
        </Row>
        <Row title="Speech to text for dictation" sub="The address of a speech-to-text server that works like OpenAI's, for example one running Whisper on this computer. Leave it empty to use your computer's own dictation instead." stack>
          <Field className="input wide" value={s.speechUrl ?? ''} placeholder="http://127.0.0.1:8000/v1" testId="speech-url" onCommit={(v) => save({ local: { speechUrl: v.trim() } })} />
        </Row>
      </div>
    </>
  )
}

function Sync() {
  const app = useUi((x) => x.app!)
  const s = app.settings.hub
  const hub = app.hub
  const remote = app.remote
  const runOnHubByDefault = app.settings.runOnHubByDefault
  const [found, setFound] = useState<DiscoveredHub[] | null>(null)
  const [looking, setLooking] = useState(false)
  return (
    <>
      <h2>Sync and hub</h2>
      <p className="lead">
        One machine is the hub, normally the Windows PC. It keeps the master copy of your chats and shares its local AI. Other devices keep their own full copy, work offline, and catch up when the hub is reachable.
      </p>
      <div className="group">
        <Row title="This machine is the hub" sub="Turn on for the PC that stays on. Leave off everywhere else.">
          <Toggle checked={s.hostEnabled} label="This machine is the hub" testId="hub-host-toggle" onChange={(v) => save({ hub: { hostEnabled: v } })} />
        </Row>
      </div>

      {s.hostEnabled ? (
        <>
          <div className="group-title">Connect your other devices</div>
          <div className="group">
            <Row title="Status" sub={hub.detail}>
              <span className={`badge ${hub.connected ? 'ok' : 'bad'}`} data-testid="hub-status">
                {hub.connected ? 'Running' : 'Not running'}
              </span>
            </Row>
            <Row title="Pairing code" sub="Enter this on the other device. Anyone with the code and network access to this PC can read your chats, so treat it like a password." stack>
              <div className="inline">
                <span className="code-line" data-testid="hub-token">
                  {s.token}
                </span>
                <button type="button" className="btn btn-small" onClick={() => void navigator.clipboard.writeText(s.token).then(() => toast('Pairing code copied'))}>
                  Copy
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    if (confirm('Make a new pairing code? Devices using the old one will need the new code.')) void window.api.hubNewToken()
                  }}
                >
                  New code
                </button>
              </div>
            </Row>
            <Row title="Addresses" sub="On your home network use the first. Away from home use this PC's Tailscale name or its 100.x address." stack>
              <div style={{ display: 'grid', gap: 6 }}>
                {(hub.addresses ?? []).map((a) => (
                  <span className="code-line" key={a}>
                    {a}
                    {/\/\/100\./.test(a) ? '   (Tailscale)' : ''}
                  </span>
                ))}
                {!hub.addresses?.length && <span className="muted">No network address found.</span>}
              </div>
            </Row>
            <Row title="Port">
              <NumberField value={s.port} min={1024} max={65535} onCommit={(n) => save({ hub: { port: n } })} />
            </Row>
          </div>

          <div className="group-title">Remote work</div>
          <div className="group">
            <Row
              title="Let my other devices run assistants on this machine"
              sub="Your Mac can then start Claude or ChatGPT work that runs here, in a folder on this machine, and keeps going while the Mac sleeps. Anyone with the pairing code could then edit files and run commands on this machine, so only turn it on if the code is safe."
            >
              <Toggle checked={s.allowRemoteRuns} label="Let my other devices run assistants on this machine" testId="allow-remote-runs" onChange={(v) => save({ hub: { allowRemoteRuns: v } })} />
            </Row>
          </div>
        </>
      ) : (
        <>
          <div className="group-title">Remote work</div>
          <div className="group">
            <Row
              title="Run new conversations on the hub"
              sub={
                remote?.enabled
                  ? `${remote.deviceName} allows this. Each conversation can still be switched with "Runs on" in the message box.`
                  : hub.connected
                    ? 'The hub does not allow this yet. Turn on "Let my other devices run assistants on this machine" in its settings. It can take a minute to show up here.'
                    : 'Available once this device is connected to a hub that allows it.'
              }
            >
              <Toggle checked={runOnHubByDefault} label="Run new conversations on the hub" testId="run-on-hub-default" onChange={(v) => save({ runOnHubByDefault: v })} />
            </Row>
          </div>

          <div className="group-title">Connect to your hub</div>
          <div className="group">
            <Row title="Hub address" sub="For example my-pc:47600, or the PC's Tailscale name so it also works away from home." stack>
              <div className="inline">
                <Field className="input wide" value={s.remoteUrl} placeholder="my-pc:47600" testId="hub-url" onCommit={(v) => save({ hub: { remoteUrl: v.trim() } })} />
              </div>
            </Row>
            <Row title="Pairing code" sub="Shown on the hub under Sync and hub." stack>
              <Field className="input wide" value={s.remoteToken} testId="hub-remote-token" onCommit={(v) => save({ hub: { remoteToken: v.trim() } })} />
            </Row>
            <Row title="Status" sub={hub.detail + (hub.lastSyncAt ? `. Last synced ${new Date(hub.lastSyncAt).toLocaleTimeString()}` : '')}>
              <div className="inline">
                <span className={`badge ${hub.connected ? 'ok' : hub.role === 'off' ? '' : 'bad'}`} data-testid="hub-status">
                  {hub.connected ? 'Connected' : hub.role === 'off' ? 'Not set up' : 'Offline'}
                </span>
                <button type="button" className="btn btn-small" disabled={hub.role === 'off'} onClick={() => void window.api.hubSyncNow()}>
                  Sync now
                </button>
              </div>
            </Row>
            <Row title="Find the hub on this network" sub="Works at home. Away from home, type the Tailscale address instead." stack>
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
                  {looking ? 'Looking' : 'Look now'}
                </button>
                {found?.map((h) => (
                  <button type="button" className="btn btn-small" key={h.url} onClick={() => save({ hub: { remoteUrl: h.url } })}>
                    Use {h.name}
                  </button>
                ))}
                {found && !found.length && <span className="muted">No hub answered.</span>}
              </div>
            </Row>
          </div>
        </>
      )}
    </>
  )
}

function Memory() {
  const app = useUi((x) => x.app!)
  const [profile, setProfile] = useState(app.profile.instructions)
  const [note, setNote] = useState('')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  useEffect(() => setProfile(app.profile.instructions), [app.profile.instructions])
  return (
    <>
      <h2>Memory and prompts</h2>
      <p className="lead">Shared by Claude, ChatGPT and local AI, and synced to all your devices, so every assistant knows the same things about you.</p>

      <div className="group-title">Your instructions</div>
      <div className="group">
        <div className="row row-stack">
          <div className="row-sub" style={{ marginBottom: 8 }}>
            How you want every assistant to work with you: your role, tone, things to always or never do.
          </div>
          <textarea className="textarea" value={profile} data-testid="profile-input" placeholder="For example: I am a product manager. Be direct. Use British spelling." onChange={(e) => setProfile(e.target.value)} onBlur={() => profile !== app.profile.instructions && void window.api.saveProfile(profile)} />
        </div>
      </div>

      <div className="group-title">Things to remember</div>
      <div className="group">
        {app.notes
          .slice()
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((n) => (
            <div className="list-item" key={n.id}>
              <div className="list-item-main">{n.text}</div>
              <button type="button" className="btn btn-small btn-danger" onClick={() => void window.api.deleteNote(n.id)}>
                Forget
              </button>
            </div>
          ))}
        <div className="row">
          <input className="input wide" style={{ flex: 1 }} value={note} placeholder="Add a fact, for example: my main project is written in Swift" data-testid="note-input" onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && note.trim() && (void window.api.saveNote({ text: note.trim() }), setNote(''))} />
          <button type="button" className="btn btn-small" disabled={!note.trim()} data-testid="note-add" onClick={() => (void window.api.saveNote({ text: note.trim() }), setNote(''))}>
            Add
          </button>
        </div>
      </div>

      <div className="group-title">Saved prompts</div>
      <div className="group">
        {app.prompts.map((p) => (
          <div className="list-item" key={p.id}>
            <div className="list-item-main">
              <b>{p.title}</b>
              <div className="muted">{p.text}</div>
            </div>
            <button type="button" className="btn btn-small btn-danger" onClick={() => void window.api.deletePrompt(p.id)}>
              Delete
            </button>
          </div>
        ))}
        <div className="row row-stack">
          <input className="input wide" value={title} placeholder="Name, for example: Code review" onChange={(e) => setTitle(e.target.value)} />
          <textarea className="textarea" style={{ marginTop: 8 }} value={text} placeholder="The prompt text. Insert it from the book button in the message box." onChange={(e) => setText(e.target.value)} />
          <div className="row-control">
            <button
              type="button"
              className="btn btn-small"
              disabled={!title.trim() || !text.trim()}
              onClick={() => {
                void window.api.savePrompt({ title: title.trim(), text: text.trim() })
                setTitle('')
                setText('')
              }}
            >
              Save prompt
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

function Usage() {
  const app = useUi((x) => x.app!)
  const now = Date.now()
  return (
    <>
      <h2>Usage</h2>
      <p className="lead">
        Limits as reported by each service while you use it here. Use on other apps or devices counts too, and shows up the next time the service reports. Numbers are shared across your synced devices.
      </p>
      <div className="group">
        {(['claude', 'chatgpt', 'local'] as ProviderId[]).map((p) => {
          const u = app.usage[p]
          return (
            <div className="usage-card" key={p} data-testid={`usage-${p}`}>
              <div className="usage-card-head">
                <ProviderDot provider={p} /> {PROVIDER_LABEL[p]}
                <span className="muted tiny" style={{ fontWeight: 400, marginLeft: 'auto' }}>
                  {app.providers[p]?.detail ?? ''}
                </span>
              </div>
              {p === 'local' ? (
                <div className="muted">No limits. Runs on your own hardware.</div>
              ) : (
                <>
                  <div className="usage-line">
                    <span>5-hour limit</span>
                    <Meter window={u.fiveHour} />
                    <span className="right">
                      {limitText(u.fiveHour)}
                      {u.fiveHour.resetsAt ? `, ${formatReset(u.fiveHour.resetsAt, now)}` : ''}
                    </span>
                  </div>
                  <div className="usage-line">
                    <span>Weekly limit</span>
                    <Meter window={u.weekly} />
                    <span className="right">
                      {limitText(u.weekly)}
                      {u.weekly.resetsAt ? `, ${formatReset(u.weekly.resetsAt, now)}` : ''}
                    </span>
                  </div>
                </>
              )}
              <div className="muted tiny" style={{ marginTop: 8 }}>
                {formatTokens(u.tokensInWindow)} tokens through this app in the last 5 hours
              </div>
            </div>
          )
        })}
      </div>
      <div className="inline">
        <button type="button" className="btn" onClick={() => void window.api.refreshProviders().then(() => toast('Usage refreshed'))}>
          Refresh
        </button>
        <button type="button" className="btn" onClick={() => setState({ view: { kind: 'web', service: 'claude' } })}>
          Claude usage page
        </button>
        <button type="button" className="btn" onClick={() => setState({ view: { kind: 'web', service: 'chatgpt' } })}>
          ChatGPT usage page
        </button>
      </div>
    </>
  )
}

export function SettingsView({ tab }: { tab?: string }) {
  const active = TABS.some((t) => t.id === tab) ? tab! : 'general'
  return (
    <>
      <header className="topbar drag">
        <div className="topbar-title">Settings</div>
        <span className="topbar-spacer" />
      </header>
      <div className="settings" data-testid="settings">
        <nav className="settings-nav">
          {TABS.map((t) => (
            <button type="button" key={t.id} className={`side-btn ${active === t.id ? 'active' : ''}`} data-testid={`settings-tab-${t.id}`} onClick={() => setState({ view: { kind: 'settings', tab: t.id } })}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <div className="settings-inner">
            {active === 'general' && <General />}
            {active === 'accounts' && <Accounts />}
            {active === 'local' && <LocalAi />}
            {active === 'sync' && <Sync />}
            {active === 'memory' && <Memory />}
            {active === 'tools' && <McpSettings />}
            {active === 'usage' && <Usage />}
          </div>
        </div>
      </div>
    </>
  )
}
