// Code projects sorted by folder, kept apart from chat projects, and the choice to
// show only one assistant.

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureFolderProject, fileUnderFolder, sortProjectKinds } from '../src/main/codeProjects'
import { Store } from '../src/main/store'
import { chatShown, projectShown } from '../src/renderer/src/state'
import { sessionSources } from '../src/renderer/src/components/SessionSources'
import { folderName, folderProjectId, type Conversation, type Project } from '@shared/types'
import { tempDir } from './helpers'

function newStore(): Store {
  return new Store(join(tempDir(), 'app.db'))
}

function conv(id: string, patch: Partial<Conversation> = {}): Conversation {
  return { id, title: id, provider: 'claude', createdAt: 1, updatedAt: 1, ...patch } as Conversation
}

function project(id: string, patch: Partial<Project> = {}): Project {
  return { id, name: id, instructions: '', files: [], createdAt: 1, updatedAt: 1, ...patch }
}

describe('code projects by folder', () => {
  it('names a folder the same way on a Mac and on Windows', () => {
    expect(folderName('/Users/me/Coding/My App/')).toBe('My App')
    expect(folderName('C:\\Users\\me\\Coding\\My App')).toBe('My App')
    expect(folderProjectId('/Users/me/Coding/My App')).toBe(folderProjectId('C:\\Users\\me\\Coding\\My App'))
    expect(folderProjectId('/')).toBe('')
  })

  it('files a code chat under its folder project, once, and never remakes one the user deleted', () => {
    const store = newStore()
    store.put('conversation', 'c1', conv('c1', { kind: 'code' }))
    store.put('conversation', 'c2', conv('c2', { kind: 'code' }))
    store.put('conversation', 'chat', conv('chat', { kind: 'chat' }))
    fileUnderFolder(store, 'c1', '/work/site')
    fileUnderFolder(store, 'c2', 'D:\\work\\site')
    fileUnderFolder(store, 'chat', '/work/site')
    const projects = store.list<Project>('project')
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ name: 'site', kind: 'code', folder: '/work/site' })
    expect(store.get<Conversation>('conversation', 'c1')!.projectId).toBe(projects[0].id)
    expect(store.get<Conversation>('conversation', 'c2')!.projectId).toBe(projects[0].id)
    expect(store.get<Conversation>('conversation', 'chat')!.projectId).toBeUndefined()

    store.remove('project', projects[0].id)
    expect(ensureFolderProject(store, '/work/site')).toBeUndefined()
    store.put('conversation', 'c3', conv('c3', { kind: 'code' }))
    fileUnderFolder(store, 'c3', '/work/site')
    expect(store.get<Conversation>('conversation', 'c3')!.projectId).toBeUndefined()
  })

  it('leaves a code chat that is already in a project where it is', () => {
    const store = newStore()
    store.put('conversation', 'c1', conv('c1', { kind: 'code', projectId: 'mine' }))
    fileUnderFolder(store, 'c1', '/work/site')
    expect(store.get<Conversation>('conversation', 'c1')!.projectId).toBe('mine')
    expect(store.list('project')).toHaveLength(0)
  })

  it('sorts older projects into chat and code projects once', () => {
    const store = newStore()
    store.put('project', 'p-code', project('p-code'))
    store.put('project', 'p-chat', project('p-chat'))
    store.put('project', 'p-empty', project('p-empty'))
    store.put('project', 'web-claude-p-1', project('web-claude-p-1'))
    store.put('conversation', 'a', conv('a', { kind: 'code', projectId: 'p-code' }))
    store.put('conversation', 'b', conv('b', { kind: 'code', projectId: 'p-chat' }))
    store.put('conversation', 'c', conv('c', { kind: 'chat', projectId: 'p-chat' }))
    expect(sortProjectKinds(store)).toBe(3)
    expect(store.get<Project>('project', 'p-code')!.kind).toBe('code')
    expect(store.get<Project>('project', 'p-chat')!.kind).toBe('chat')
    expect(store.get<Project>('project', 'p-empty')!.kind).toBe('chat')
    expect(store.get<Project>('project', 'web-claude-p-1')!.kind).toBeUndefined()
    store.put('project', 'p-new', project('p-new'))
    expect(sortProjectKinds(store)).toBe(0)
  })
})

describe('showing one assistant only', () => {
  it('shows the chats of that assistant, with auto chats for Claude and ChatGPT', () => {
    const claude = conv('a', { provider: 'claude' })
    const site = conv('b', { provider: 'auto', source: { service: 'chatgpt', id: 'x' } } as unknown as Partial<Conversation>)
    const auto = conv('c', { provider: 'auto' })
    const local = conv('d', { provider: 'local' })
    expect([claude, site, auto, local].filter((c) => chatShown(c, 'all'))).toHaveLength(4)
    expect([claude, site, auto, local].filter((c) => chatShown(c, 'claude')).map((c) => c.id)).toEqual(['a', 'c'])
    expect([claude, site, auto, local].filter((c) => chatShown(c, 'chatgpt')).map((c) => c.id)).toEqual(['b', 'c'])
    expect([claude, site, auto, local].filter((c) => chatShown(c, 'local')).map((c) => c.id)).toEqual(['d'])
  })

  it("shows a site's projects with its assistant, and the app's own projects always", () => {
    const own = project('p1')
    const fromClaude = project('web-claude-p-9')
    const fromChatgpt = project('web-chatgpt-p-g')
    expect([own, fromClaude, fromChatgpt].filter((p) => projectShown(p, 'claude')).map((p) => p.id)).toEqual(['p1', 'web-claude-p-9'])
    expect([own, fromClaude, fromChatgpt].filter((p) => projectShown(p, 'local')).map((p) => p.id)).toEqual(['p1'])
  })
})

describe('where sessions came from', () => {
  it('counts Claude Code and Codex sessions by computer, this computer first', () => {
    const list = [
      conv('1', { origin: { tool: 'claude-code', sessionId: 's1', device: 'Mac' } } as Partial<Conversation>),
      conv('2', { origin: { tool: 'codex', sessionId: 's2', device: 'Mac' } } as Partial<Conversation>),
      conv('3', { origin: { tool: 'claude-code', sessionId: 's3', device: 'Hub PC' } } as Partial<Conversation>),
      conv('4', { origin: { tool: 'claude-code', sessionId: 's4', device: 'Hub PC' } } as Partial<Conversation>),
      conv('5')
    ]
    expect(sessionSources(list, 'Mac')).toEqual([
      { device: 'Mac', claudeCode: 1, codex: 1 },
      { device: 'Hub PC', claudeCode: 2, codex: 0 }
    ])
  })
})
