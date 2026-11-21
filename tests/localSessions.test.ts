import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LocalSessions, appOwnFolder, parseClaudeSession, parseCodexSession } from '../src/main/localSessions'
import { Store } from '../src/main/store'
import { tempDir } from './helpers'
import { HANDOFF_OPENING } from '../src/shared/context'

const line = (o: unknown) => JSON.stringify(o)
const claudeFile = (sessionId: string, cwd: string) =>
  [
    line({ type: 'user', uuid: 'u1', sessionId, cwd, timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: 'Fix the login bug.' } }),
    line({ type: 'assistant', uuid: 'a1', sessionId, cwd, timestamp: '2026-11-01T10:00:05Z', message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Looking at it.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
    line({ type: 'user', uuid: 'r1', sessionId, cwd, timestamp: '2026-11-01T10:00:09Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
    line({ type: 'assistant', uuid: 'a2', sessionId, cwd, timestamp: '2026-11-01T10:00:12Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }] } }),
    line({ type: 'user', uuid: 'u2', sessionId, cwd, timestamp: '2026-11-01T10:01:00Z', message: { role: 'user', content: '<command-name>/usage</command-name>\n<command-args></command-args>' } }),
    line({ type: 'user', uuid: 'u3', sessionId, cwd, isMeta: true, timestamp: '2026-11-01T10:01:01Z', message: { role: 'user', content: 'Caveat: ignore' } }),
    line({ type: 'assistant', uuid: 's1', isSidechain: true, sessionId, cwd, timestamp: '2026-11-01T10:01:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'A helper agent' }] } }),
    line({ type: 'custom-title', customTitle: 'Login bug', sessionId })
  ].join('\n')

describe('Claude Code and Codex sessions on this computer', () => {
  it('reads a Claude Code session: what was typed, one answer per turn with its steps, and the title', () => {
    const s = parseClaudeSession(claudeFile('s-1', '/work/app'))!
    expect(s).toMatchObject({ tool: 'claude-code', sessionId: 's-1', cwd: '/work/app', title: 'Login bug' })
    expect(s.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Fix the login bug.'],
      ['assistant', 'Looking at it.\n\nFixed.'],
      ['user', '/usage']
    ])
    expect(s.messages[1].tools).toEqual([expect.objectContaining({ summary: 'npm test', kind: 'command' })])
    expect(s.messages[1].model).toBe('claude-opus-4-7')
  })

  it('reads a Codex session without the context Codex adds itself', () => {
    const s = parseCodexSession(
      [
        line({ timestamp: '2026-11-01T10:00:00Z', type: 'session_meta', payload: { id: 'th-9', cwd: '/work/site' } }),
        line({ timestamp: '2026-11-01T10:00:00Z', type: 'turn_context', payload: { model: 'gpt-6.2-sol' } }),
        line({ timestamp: '2026-11-01T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } }),
        line({ timestamp: '2026-11-01T10:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add a footer.' }] } }),
        line({ timestamp: '2026-11-01T10:00:03Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['ls', '-la'] }), call_id: 'c1' } }),
        line({ timestamp: '2026-11-01T10:00:04Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added.' }] } })
      ].join('\n')
    )!
    expect(s).toMatchObject({ tool: 'codex', sessionId: 'th-9', cwd: '/work/site', title: 'Add a footer.' })
    expect(s.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Add a footer.'],
      ['assistant', 'Added.']
    ])
    expect(s.messages[1].tools?.[0]).toMatchObject({ summary: 'ls -la', kind: 'command' })
  })

  it('brings sessions in as code chats that continue the same session, skips its own, and never doubles a continued chat', () => {
    const home = tempDir()
    const appData = join(home, 'appdata')
    mkdirSync(join(home, '.claude', 'projects', '-work-app'), { recursive: true })
    writeFileSync(join(home, '.claude', 'projects', '-work-app', 's-1.jsonl'), claudeFile('s-1', '/work/app'))
    writeFileSync(join(home, '.claude', 'projects', '-work-app', 's-2.jsonl'), claudeFile('s-2', join(appData, 'workspace')))
    const store = new Store(join(home, 'db.sqlite'))
    const cwd = new Map<string, string>()
    const sessions = new LocalSessions(store, { home, appData, deviceName: 'Mac' }, (id, p) => cwd.set(id, p), (id) => cwd.get(id) ?? '')
    expect(sessions.scan()).toBe(1)
    const conv = store.get<any>('conversation', 'local-claude-s-1')
    expect(conv).toMatchObject({ kind: 'code', provider: 'claude', title: 'Login bug', origin: { tool: 'claude-code', sessionId: 's-1', device: 'Mac' } })
    expect(store.get('conversation', 'local-claude-s-2')).toBeUndefined()
    expect(cwd.get('local-claude-s-1')).toBe('/work/app')
    expect(store.kvGet<any>('session:local-claude-s-1:claude')).toMatchObject({ sessionId: 's-1' })
    expect(sessions.scan()).toBe(0)
    // Once continued here, the session file is not read into the chat again.
    store.put('message', 'mine', { id: 'mine', conversationId: 'local-claude-s-1', role: 'user', text: 'More', createdAt: Date.now(), deviceId: 'd', status: 'complete' })
    writeFileSync(join(home, '.claude', 'projects', '-work-app', 's-1.jsonl'), `${claudeFile('s-1', '/work/app')}\n${line({ type: 'user', uuid: 'u9', sessionId: 's-1', cwd: '/work/app', timestamp: '2026-11-02T10:00:00Z', message: { role: 'user', content: 'More' } })}`)
    sessions.scan()
    expect(store.messages('local-claude-s-1').filter((m) => m.text === 'More')).toHaveLength(1)
    store.close()
  })
  it('follows a rename in Claude Code, unless the chat was renamed in the app', () => {
    const home = tempDir()
    const dir = join(home, '.claude', 'projects', '-work-app')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 's-1.jsonl')
    writeFileSync(file, claudeFile('s-1', '/work/app'))
    const store = new Store(join(home, 'db.sqlite'))
    const sessions = new LocalSessions(store, { home, appData: join(home, 'appdata'), deviceName: 'Mac' }, () => {}, () => '')
    sessions.scan()
    const rename = (name: string) => writeFileSync(file, `${claudeFile('s-1', '/work/app')}\n${line({ type: 'custom-title', customTitle: name, sessionId: 's-1' })}`)
    rename('Login bug, fixed')
    sessions.scan()
    expect(store.get<any>('conversation', 'local-claude-s-1').title).toBe('Login bug, fixed')
    store.put('conversation', 'local-claude-s-1', { ...store.get<any>('conversation', 'local-claude-s-1'), title: 'My name for it' })
    rename('Login bug again')
    sessions.scan()
    expect(store.get<any>('conversation', 'local-claude-s-1')).toMatchObject({ title: 'My name for it', origin: { toolTitle: 'Login bug again' } })
    store.close()
  })
  it('knows the folders the app and its tests make for themselves, on a Mac or a PC', () => {
    expect(appOwnFolder('/private/var/folders/w_/x/T/chaudecal-test-GDGYPT')).toBe(true)
    expect(appOwnFolder('C:\\Users\\me\\AppData\\Local\\Temp\\chaudecal-test-0GjFtg')).toBe(true)
    expect(appOwnFolder('/Users/me/Library/Application Support/Chaudecal AI/workspace')).toBe(true)
    expect(appOwnFolder('C:\\Users\\me\\AppData\\Roaming\\Chaudecal AI\\workspace')).toBe(true)
    expect(appOwnFolder('/var/folders/w_/x/T/chaudecal-e2e-hub-HonlVa/workspace')).toBe(true)
    expect(appOwnFolder('/var/folders/w_/x/T/chaudecal-e2e-home-Ab12/projects/website')).toBe(false)
    expect(appOwnFolder('/Users/me/Coding/Chaudecal AI')).toBe(false)
    expect(appOwnFolder('/Users/me/code/workspace')).toBe(false)
    expect(appOwnFolder('/private/tmp/claude-502/-Users-me-Coding-App/af14dba5/scratchpad/cltest')).toBe(true)
    expect(appOwnFolder('/Users/me/code/claude-2/notes')).toBe(false)
  })
  it('skips sessions from its tests and takes out ones an earlier version brought in, unless carried on', () => {
    const home = tempDir()
    const testDir = '/private/var/folders/T/chaudecal-test-abc'
    const dir = join(home, '.claude', 'projects', '-test')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 's-t.jsonl'), claudeFile('s-t', testDir))
    const store = new Store(join(home, 'db.sqlite'))
    const sessions = new LocalSessions(store, { home, appData: join(home, 'appdata'), deviceName: 'Mac' }, () => {}, () => '')
    expect(sessions.scan()).toBe(0)
    expect(store.get('conversation', 'local-claude-s-t')).toBeUndefined()
    // What an earlier version left behind, from this computer and from a PC, with their folder projects.
    sessions.save({ ...parseClaudeSession(claudeFile('s-old', testDir))!, sessionId: 's-old' })
    sessions.save({ ...parseClaudeSession(claudeFile('s-pc', 'C:\\Users\\me\\AppData\\Roaming\\Chaudecal AI\\workspace'))!, sessionId: 's-pc' })
    sessions.save({ ...parseClaudeSession(claudeFile('s-kept', testDir))!, sessionId: 's-kept' })
    store.put('message', 'mine', { id: 'mine', conversationId: 'local-claude-s-kept', role: 'user', text: 'More', createdAt: Date.now(), deviceId: 'd', status: 'complete' })
    sessions.save({ ...parseClaudeSession(claudeFile('s-real', '/work/app'))!, sessionId: 's-real' })
    expect(store.get('project', 'code-folder-workspace')).toBeTruthy()
    sessions.tidy()
    expect(store.get('conversation', 'local-claude-s-old')).toBeUndefined()
    expect(store.get('conversation', 'local-claude-s-pc')).toBeUndefined()
    expect(store.get('conversation', 'local-claude-s-kept')).toBeTruthy()
    expect(store.get('conversation', 'local-claude-s-real')).toBeTruthy()
    expect(store.get('project', 'code-folder-workspace')).toBeUndefined()
    expect(store.get('project', 'code-folder-chaudecal-test-abc')).toBeTruthy()
    expect(store.get('project', 'code-folder-app')).toBeTruthy()
    store.close()
  })
  it('does not show the sessions a chat goes on in after a handoff as chats of their own', () => {
    const home = tempDir()
    const dir = join(home, '.claude', 'projects', '-work-app')
    mkdirSync(dir, { recursive: true })
    const handoffFile = (sessionId: string) =>
      [
        line({ type: 'user', uuid: 'h1', sessionId, cwd: '/work/app', timestamp: '2026-11-03T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: `${HANDOFF_OPENING}\n\n<context_file>\n\n# Context file: Login bug\n</context_file>\n\nNew message from the user:\n\nAnd the logout?` }] } }),
        line({ type: 'assistant', uuid: 'h2', sessionId, cwd: '/work/app', timestamp: '2026-11-03T10:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } }),
        line({ type: 'custom-title', customTitle: 'Login bug', sessionId })
      ].join('\n')
    writeFileSync(join(dir, 's-1.jsonl'), claudeFile('s-1', '/work/app'))
    writeFileSync(join(dir, 's-new.jsonl'), claudeFile('s-new', '/work/app'))
    const store = new Store(join(home, 'db.sqlite'))
    const sessions = new LocalSessions(store, { home, appData: join(home, 'appdata'), deviceName: 'Mac' }, () => {}, () => '')
    sessions.scan()
    expect(store.get('conversation', 'local-claude-s-new')).toBeTruthy()
    // The chat from s-1 went on here, in s-new (a turn after a sign-in problem, say).
    store.put('message', 'mine', { id: 'mine', conversationId: 'local-claude-s-1', role: 'user', text: 'And the logout?', createdAt: Date.now(), deviceId: 'd', status: 'complete' })
    store.kvSet('session:local-claude-s-1:claude', { sessionId: 's-new', syncedMessageId: 'mine' })
    // And an earlier try that was stopped, which opens with the app's context file.
    writeFileSync(join(dir, 's-try.jsonl'), handoffFile('s-try'))
    sessions.scan()
    expect(store.get('conversation', 'local-claude-s-new')).toBeUndefined()
    expect(store.get('conversation', 'local-claude-s-try')).toBeUndefined()
    expect(store.get('conversation', 'local-claude-s-1')).toBeTruthy()
    store.close()
  })
  it('shows a finished background task as a step in the answer it led to, not as something typed', () => {
    const note = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "Run the tests" completed (exit code 0)</summary>\n</task-notification>'
    const s = parseClaudeSession([
      line({ type: 'user', uuid: 'u1', sessionId: 's', cwd: '/w', timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: 'Run the tests.' } }),
      line({ type: 'assistant', uuid: 'a1', sessionId: 's', cwd: '/w', timestamp: '2026-11-01T10:00:01Z', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Started.' }] } }),
      line({ type: 'user', uuid: 'n1', sessionId: 's', cwd: '/w', timestamp: '2026-11-01T10:05:00Z', message: { role: 'user', content: note } }),
      line({ type: 'assistant', uuid: 'a2', sessionId: 's', cwd: '/w', timestamp: '2026-11-01T10:05:01Z', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'They pass.' }] } })
    ].join('\n'))!
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(s.messages[2]).toMatchObject({ text: 'They pass.', model: 'claude-opus-5-5', tools: [{ name: 'Background task', summary: '"Run the tests" completed (exit code 0)', status: 'done' }] })
    expect(s.messages.some((m) => m.text.includes('task-notification'))).toBe(false)
  })
})
