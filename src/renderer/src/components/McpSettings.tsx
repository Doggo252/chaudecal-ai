import { useState } from 'react'
import type { McpInput } from '@shared/ipc'
import { cleanMcpName, describeMcpServer, formatPairs, joinCommandLine, parseMcpJson, parsePairs, splitCommandLine, type McpDraft } from '@shared/mcp'
import type { McpServer, McpTestResult } from '@shared/types'
import { toast, useUi } from '../state'
import { Toggle } from './ui'

/** The editor's fields, as the text the user types. */
interface Form {
  id?: string
  name: string
  kind: 'command' | 'url'
  commandLine: string
  env: string
  url: string
  headers: string
  trusted: boolean
}

const EMPTY: Form = { name: '', kind: 'command', commandLine: '', env: '', url: '', headers: '', trusted: false }

function formFrom(server: McpDraft & { id?: string; trusted?: boolean }): Form {
  return {
    id: server.id,
    name: server.name,
    kind: server.kind,
    commandLine: server.command ? joinCommandLine([server.command, ...server.args]) : '',
    env: formatPairs(server.env, '='),
    url: server.url,
    headers: formatPairs(server.headers, ':'),
    trusted: server.trusted ?? false
  }
}

function inputFrom(form: Form): McpInput {
  const [command = '', ...args] = splitCommandLine(form.commandLine)
  return {
    id: form.id,
    name: cleanMcpName(form.name),
    kind: form.kind,
    command,
    args,
    env: parsePairs(form.env, '='),
    url: form.url.trim(),
    headers: parsePairs(form.headers, ':'),
    trusted: form.trusted
  }
}

function TestLine({ result, testing }: { result?: McpTestResult; testing: boolean }) {
  if (testing) return <div className="mcp-test muted">Connecting…</div>
  if (!result) return null
  if (!result.ok)
    return (
      <div className="mcp-test bad" data-testid="mcp-test-result">
        {result.error}
      </div>
    )
  const names = result.tools.map((t) => t.name)
  return (
    <div className="mcp-test ok" data-testid="mcp-test-result">
      Connected{result.serverName ? ` to ${result.serverName}` : ''}. {names.length === 1 ? '1 tool' : `${names.length} tools`}
      {names.length ? `: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ` and ${names.length - 8} more` : ''}` : ''}
    </div>
  )
}

function Editor(props: { start: Form; onDone: () => void }) {
  const [form, setForm] = useState(props.start)
  const [error, setError] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<McpTestResult>()
  const set = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }))
    setError('')
    setResult(undefined)
  }
  const save = async () => {
    const saved = await window.api.saveMcpServer(inputFrom(form))
    if (saved.error) setError(saved.error)
    else props.onDone()
  }
  const test = async () => {
    setTesting(true)
    setResult(undefined)
    setResult(await window.api.testMcpServer(inputFrom(form)))
    setTesting(false)
  }
  return (
    <div className="row row-stack mcp-editor" data-testid="mcp-editor">
      <div className="mcp-field">
        <label htmlFor="mcp-name">Name</label>
        <input id="mcp-name" className="input wide" data-testid="mcp-name" value={form.name} placeholder="For example: github" spellCheck={false} onChange={(e) => set({ name: e.target.value })} onBlur={() => set({ name: cleanMcpName(form.name) })} />
      </div>
      <div className="mcp-field">
        <label>Where it runs</label>
        <div className="inline">
          <button type="button" className={`chip ${form.kind === 'command' ? 'on' : ''}`} data-testid="mcp-kind-command" aria-pressed={form.kind === 'command'} onClick={() => set({ kind: 'command' })}>
            A program on the computer
          </button>
          <button type="button" className={`chip ${form.kind === 'url' ? 'on' : ''}`} data-testid="mcp-kind-url" aria-pressed={form.kind === 'url'} onClick={() => set({ kind: 'url' })}>
            A web address
          </button>
        </div>
      </div>
      {form.kind === 'command' ? (
        <>
          <div className="mcp-field">
            <label htmlFor="mcp-command">Command</label>
            <input id="mcp-command" className="input wide mono" data-testid="mcp-command" value={form.commandLine} placeholder="npx -y @modelcontextprotocol/server-filesystem ~/Documents" spellCheck={false} onChange={(e) => set({ commandLine: e.target.value })} />
            <div className="row-sub">The program has to be installed on every device that should use this server.</div>
          </div>
          <div className="mcp-field">
            <label htmlFor="mcp-env">Settings it needs (optional)</label>
            <textarea id="mcp-env" className="textarea mono" data-testid="mcp-env" value={form.env} placeholder="GITHUB_TOKEN=your-token" spellCheck={false} onChange={(e) => set({ env: e.target.value })} />
            <div className="row-sub">Environment variables, one per line, written NAME=value.</div>
          </div>
        </>
      ) : (
        <>
          <div className="mcp-field">
            <label htmlFor="mcp-url">Address</label>
            <input id="mcp-url" className="input wide mono" data-testid="mcp-url" value={form.url} placeholder="https://example.com/mcp" spellCheck={false} onChange={(e) => set({ url: e.target.value })} />
          </div>
          <div className="mcp-field">
            <label htmlFor="mcp-headers">Headers (optional)</label>
            <textarea id="mcp-headers" className="textarea mono" data-testid="mcp-headers" value={form.headers} placeholder="Authorization: Bearer your-token" spellCheck={false} onChange={(e) => set({ headers: e.target.value })} />
            <div className="row-sub">One per line, written Name: value. Servers that sign in through a browser page are not supported yet.</div>
          </div>
        </>
      )}
      <div className="inline mcp-trust">
        <Toggle checked={form.trusted} label="Let its tools run without asking" testId="mcp-trusted" onChange={(v) => set({ trusted: v })} />
        <div>
          <div>Let its tools run without asking</div>
          <div className="row-sub">When this is off, you are asked first. Claude asks about every tool, ChatGPT about the ones that change something.</div>
        </div>
      </div>
      <TestLine result={result} testing={testing} />
      {error && (
        <div className="menu-error" data-testid="mcp-error">
          {error}
        </div>
      )}
      <div className="inline">
        <button type="button" className="btn btn-small btn-primary" data-testid="mcp-save" onClick={() => void save()}>
          Save
        </button>
        <button type="button" className="btn btn-small" data-testid="mcp-test" disabled={testing} onClick={() => void test()}>
          Test on this device
        </button>
        <button type="button" className="btn btn-small" onClick={props.onDone}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function PasteJson(props: { existing: McpServer[]; onDone: () => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const add = async () => {
    const parsed = parseMcpJson(text)
    if (parsed.error) return setError(parsed.error)
    const taken = new Set(props.existing.map((s) => s.name.toLowerCase()))
    const problems: string[] = []
    let added = 0
    for (const draft of parsed.servers) {
      // A server without a name of its own, or with one that is taken, gets a free one.
      let name = draft.name || 'server'
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${draft.name || 'server'}-${n}`
      const saved = await window.api.saveMcpServer({ ...draft, name })
      if (saved.error) problems.push(`${name}: ${saved.error}`)
      else {
        taken.add(name.toLowerCase())
        added++
      }
    }
    if (problems.length) setError(problems.join(' '))
    if (added) toast(added === 1 ? 'Added 1 tool server' : `Added ${added} tool servers`)
    if (added && !problems.length) props.onDone()
  }
  return (
    <div className="row row-stack mcp-editor" data-testid="mcp-paste">
      <div className="mcp-field">
        <label htmlFor="mcp-json">Paste the JSON from the server's instructions</label>
        <textarea
          id="mcp-json"
          className="textarea mono mcp-json"
          data-testid="mcp-json"
          value={text}
          spellCheck={false}
          placeholder={'{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  }\n}'}
          onChange={(e) => {
            setText(e.target.value)
            setError('')
          }}
        />
      </div>
      {error && (
        <div className="menu-error" data-testid="mcp-error">
          {error}
        </div>
      )}
      <div className="inline">
        <button type="button" className="btn btn-small btn-primary" data-testid="mcp-json-add" disabled={!text.trim()} onClick={() => void add()}>
          Add
        </button>
        <button type="button" className="btn btn-small" onClick={props.onDone}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function ServerRow({ server, deviceId, onEdit }: { server: McpServer; deviceId: string; onEdit: () => void }) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<McpTestResult>()
  const here = server.enabled && !server.offOn.includes(deviceId)
  const setHere = (on: boolean) => {
    const offOn = on ? server.offOn.filter((d) => d !== deviceId) : [...new Set([...server.offOn, deviceId])]
    void window.api.saveMcpServer({ ...server, enabled: true, offOn })
  }
  const test = async () => {
    setTesting(true)
    setResult(undefined)
    setResult(await window.api.testMcpServer(server))
    setTesting(false)
  }
  return (
    <div className="row row-stack" data-testid="mcp-server" data-name={server.name}>
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <div className="mcp-title">
          <b>{server.name}</b>
          {server.trusted && <span className="badge">Runs without asking</span>}
          {!here && <span className="badge">Off on this device</span>}
        </div>
        <div className="inline">
          <Toggle checked={here} label={`Use ${server.name} on this device`} testId="mcp-toggle" onChange={setHere} />
          <button type="button" className="btn btn-small" data-testid="mcp-row-test" disabled={testing} onClick={() => void test()}>
            Test
          </button>
          <button type="button" className="btn btn-small" data-testid="mcp-edit" onClick={onEdit}>
            Edit
          </button>
          <button type="button" className="btn btn-small btn-danger" data-testid="mcp-remove" onClick={() => void window.api.deleteMcpServer(server.id)}>
            Remove
          </button>
        </div>
      </div>
      <div className="muted mono mcp-what">{describeMcpServer(server)}</div>
      <TestLine result={result} testing={testing} />
    </div>
  )
}

export function McpSettings() {
  const app = useUi((x) => x.app!)
  /** What is open below the list: nothing, the editor for one server ('new' for a new one), or the JSON box. */
  const [open, setOpen] = useState<string>()
  const editing = open && open !== 'new' && open !== 'json' ? app.mcp.find((s) => s.id === open) : undefined
  return (
    <>
      <h2>Tools</h2>
      <p className="lead">
        Tool servers give the assistants new abilities, such as reading your GitHub issues, your notes or a database. They speak the Model Context Protocol (MCP). Add one here and both Claude and ChatGPT can use it, in every
        conversation.
      </p>

      <div className="group-title">Your tool servers</div>
      <div className="group">
        {!app.mcp.length && !open && (
          <div className="row">
            <div className="row-sub">None yet. Most tool servers come with a short piece of JSON in their instructions, which you can paste here.</div>
          </div>
        )}
        {app.mcp.map((s) => (editing?.id === s.id ? <Editor key={s.id} start={formFrom(s)} onDone={() => setOpen(undefined)} /> : <ServerRow key={s.id} server={s} deviceId={app.deviceId} onEdit={() => setOpen(s.id)} />))}
        {open === 'new' && <Editor start={EMPTY} onDone={() => setOpen(undefined)} />}
        {open === 'json' && <PasteJson existing={app.mcp} onDone={() => setOpen(undefined)} />}
        {!open && (
          <div className="row">
            <div className="inline">
              <button type="button" className="btn btn-small" data-testid="mcp-add" onClick={() => setOpen('new')}>
                Add a tool server
              </button>
              <button type="button" className="btn btn-small" data-testid="mcp-add-json" onClick={() => setOpen('json')}>
                Paste JSON
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="group-title">Good to know</div>
      <div className="group">
        <div className="row row-stack">
          <div className="row-sub">
            The list is synced to all your devices, including any tokens you type into it, in the same way your conversations are. A server runs on the device that runs the assistant: for a conversation that runs on the hub, that is
            the hub. Use the switch to turn a server off on a device where its program is not installed.
          </div>
          <div className="row-sub" style={{ marginTop: 8 }}>
            Tool servers that you set up in Claude Code or Codex themselves keep working as before, each in its own assistant. Local AI cannot use tools yet.
          </div>
        </div>
      </div>
    </>
  )
}
