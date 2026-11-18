import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultSettings, type Settings } from '@shared/types'

export const FAKE_CLAUDE = resolve(import.meta.dirname, 'fakes/fake-claude.mjs')
export const FAKE_CODEX = resolve(import.meta.dirname, 'fakes/fake-codex.mjs')

export function tempDir(prefix = 'chaudecal-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function testSettings(patch: (s: Settings) => void = () => {}): Settings {
  const s = defaultSettings('test-machine')
  s.claude.cliPath = FAKE_CLAUDE
  s.chatgpt.cliPath = FAKE_CODEX
  s.local.endpoints = []
  s.local.summarize = false
  patch(s)
  return s
}

export async function until(check: () => boolean, timeoutMs = 8000, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** The fakes are scripts, which Windows cannot start directly. */
export const canRunFakes = process.platform !== 'win32'
