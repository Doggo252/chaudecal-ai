// Code chats are sorted by the folder they work in, the way the Claude Code and
// Codex apps list them. Each folder name gets one code project, kept apart from
// the chat projects. A folder project the user deleted is not made again.

import type { Conversation, Project } from '@shared/types'
import { folderName, folderProjectId, kindOf, projectKindOf } from '@shared/types'
import type { Store } from './store'

/**
 * The folder a code chat belongs under: a git worktree counts as its repository, and
 * the throwaway folder Codex or the Claude app makes when no folder was picked counts as none.
 */
export function projectFolder(folder: string): string {
  if (/[\\/]Documents[\\/]Codex[\\/]\d{4}-\d{2}-\d{2}[\\/][^\\/]+[\\/]?$/i.test(folder) || /[\\/]Claude[\\/]scratch-workspaces[\\/]/i.test(folder)) return ''
  return folder.split(/[\\/]\.claude[\\/]worktrees[\\/]/)[0]
}

/** The code project for this folder, made if it is not there yet. Nothing if the user deleted it, or for no real folder. */
export function ensureFolderProject(store: Store, folder: string): string | undefined {
  folder = projectFolder(folder)
  if (!folder) return undefined
  const id = folderProjectId(folder)
  if (!id || store.isDeleted('project', id)) return undefined
  const existing = store.get<Project>('project', id)
  if (existing) return id
  const now = Date.now()
  store.put('project', id, { id, name: folderName(folder), instructions: '', files: [], createdAt: now, updatedAt: now, kind: 'code', folder } satisfies Project)
  return id
}

/** Gives projects made before chat and code projects were apart a kind, once: a project that only holds code chats is a code project. */
export function sortProjectKinds(store: Store): number {
  if (store.kvGet<boolean>('projects:kinds')) return 0
  const convs = store.list<Conversation>('conversation')
  let n = 0
  for (const p of store.list<Project>('project')) {
    if (p.kind || p.id.startsWith('web-')) continue
    const chats = convs.filter((c) => c.projectId === p.id)
    const kind = chats.length && chats.every((c) => kindOf(c) === 'code') ? 'code' : projectKindOf(p)
    store.put('project', p.id, { ...p, kind } satisfies Project)
    n++
  }
  store.kvSet('projects:kinds', true)
  return n
}

/** A code chat given a folder goes in that folder's project, unless it is already in one. */
export function fileUnderFolder(store: Store, conversationId: string, folder: string): void {
  const conv = store.get<Conversation>('conversation', conversationId)
  if (!conv || !folder || kindOf(conv) !== 'code' || conv.projectId) return
  const projectId = ensureFolderProject(store, folder)
  if (projectId) store.put('conversation', conv.id, { ...conv, projectId } satisfies Conversation)
}

/** Moves code chats out of the projects that throwaway folders and worktrees made before, once, and drops those projects. */
export function refileFolderProjects(store: Store): number {
  if (store.kvGet<boolean>('projects:refile1')) return 0
  let n = 0
  const projects = store.list<Project>('project').filter((p) => p.kind === 'code' && p.folder && p.id === folderProjectId(p.folder) && projectFolder(p.folder) !== p.folder)
  for (const p of projects) {
    const to = ensureFolderProject(store, p.folder!)
    for (const c of store.list<Conversation>('conversation').filter((c) => c.projectId === p.id)) {
      const { projectId: _old, ...rest } = c
      store.put('conversation', c.id, (to ? { ...rest, projectId: to } : rest) satisfies Conversation)
      n++
    }
    store.remove('project', p.id)
  }
  store.kvSet('projects:refile1', true)
  return n
}
