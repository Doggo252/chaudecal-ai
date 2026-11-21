// Code chats are sorted by the folder they work in, the way the Claude Code and
// Codex apps list them. Each folder name gets one code project, kept apart from
// the chat projects. A folder project the user deleted is not made again.

import type { Conversation, Project } from '@shared/types'
import { folderName, folderProjectId, kindOf, projectKindOf } from '@shared/types'
import type { Store } from './store'

/** The code project for this folder, made if it is not there yet. Nothing if the user deleted it. */
export function ensureFolderProject(store: Store, folder: string): string | undefined {
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
