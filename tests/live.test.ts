// Checks against the real services, using the sign-ins on this machine.
// Skipped unless CHAUDECAL_LIVE names what to check, for example:
//   CHAUDECAL_LIVE=chatgpt,claude npx vitest run tests/live.test.ts
// Add chatgpt-image or claude-image to check that an attached image is really seen.
// Add claude-ask to check that Claude really stops and asks before it runs a command.
// Each check sends one very short message, so it uses a little of your plan.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { RunEvent } from '@shared/types'
import { defaultSettings } from '@shared/types'
import { loadShellPath } from '../src/main/env'
import { ClaudeProvider } from '../src/main/providers/claude'
import { CodexProvider } from '../src/main/providers/codex'
import type { RunImage } from '../src/main/providers/types'
import { tempDir } from './helpers'

// The app icon: three overlapping circles.
const iconPath = resolve(import.meta.dirname, '../build/icon.png')
const icon = (): RunImage => ({ name: 'icon.png', mime: 'image/png', base64: readFileSync(iconPath).toString('base64'), path: iconPath })
const IMAGE_QUESTION = 'How many circles are in this image? Reply with a single digit and nothing else.'

const live = (process.env.CHAUDECAL_LIVE ?? '').split(',').map((s) => s.trim())
const settings = defaultSettings('live-test')

function collect() {
  const events: RunEvent[] = []
  return { events, emit: (e: RunEvent) => void events.push(e), text: () => events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('') }
}

describe.skipIf(!live.includes('chatgpt'))('live: ChatGPT through Codex', () => {
  it('signs in, lists models, reads limits, answers and resumes', async () => {
    await loadShellPath()
    const limits: unknown[] = []
    const codex = new CodexProvider(() => settings, '0.0.0-live', (l) => limits.push(l))
    try {
      const status = await codex.status()
      console.log('status', status)
      expect(status.ready).toBe(true)
      expect(status.models.length).toBeGreaterThan(0)
      await codex.refreshLimits()
      console.log('limits', JSON.stringify(limits[limits.length - 1]))
      expect(limits.length).toBeGreaterThan(0)

      const first = collect()
      await codex.run({ prompt: 'Reply with exactly this and nothing else: The code word is maple.', system: '', model: '', mode: 'chat', cwd: tempDir() }, first.emit).done
      console.log('first', first.text(), first.events.filter((e) => e.type !== 'text' && e.type !== 'thinking'))
      expect(first.events.filter((e) => e.type === 'error')).toEqual([])
      expect(first.text().toLowerCase()).toContain('maple')
      // Streaming, not one lump.
      expect(first.events.filter((e) => e.type === 'text').length).toBeGreaterThan(1)

      const session = first.events.find((e) => e.type === 'session') as { sessionId: string }
      const second = collect()
      await codex.run({ prompt: 'What was the code word? Answer with the single word.', system: '', model: '', mode: 'chat', cwd: tempDir(), sessionId: session.sessionId }, second.emit).done
      console.log('second', second.text())
      expect(second.text().toLowerCase()).toContain('maple')
    } finally {
      codex.dispose()
    }
  }, 180_000)
})

describe.skipIf(!live.includes('claude'))('live: Claude through Claude Code', () => {
  it('reports status and either answers or says clearly that sign-in is needed', async () => {
    await loadShellPath()
    const claude = new ClaudeProvider(() => settings, join(tempDir(), 'tmp'))
    const status = await claude.status()
    console.log('status', status)
    expect(status.installed).toBe(true)
    const c = collect()
    await claude.run({ prompt: 'Reply with exactly this and nothing else: The code word is maple.', system: '', model: 'haiku', mode: 'chat', cwd: tempDir() }, c.emit).done
    console.log('reply', c.text(), c.events.filter((e) => e.type !== 'text' && e.type !== 'thinking'))
    const errors = c.events.filter((e) => e.type === 'error')
    if (errors.length) expect(errors).toEqual([expect.objectContaining({ code: 'auth' })])
    else expect(c.text().toLowerCase()).toContain('maple')
  }, 180_000)
})

describe.skipIf(!live.includes('chatgpt-image'))('live: ChatGPT sees an attached image', () => {
  it('answers a question about the image', async () => {
    await loadShellPath()
    const codex = new CodexProvider(() => settings, '0.0.0-live', () => {})
    try {
      const c = collect()
      await codex.run({ prompt: IMAGE_QUESTION, system: '', model: '', mode: 'chat', cwd: tempDir(), images: [icon()] }, c.emit).done
      console.log('reply', c.text(), c.events.filter((e) => e.type === 'error'))
      expect(c.events.filter((e) => e.type === 'error')).toEqual([])
      expect(c.text()).toContain('3')
    } finally {
      codex.dispose()
    }
  }, 180_000)
})

describe.skipIf(!live.includes('claude-image'))('live: Claude sees an attached image', () => {
  it('answers a question about the image, or says clearly that sign-in is needed', async () => {
    await loadShellPath()
    const claude = new ClaudeProvider(() => settings, join(tempDir(), 'tmp'))
    const c = collect()
    await claude.run({ prompt: IMAGE_QUESTION, system: '', model: 'haiku', mode: 'chat', cwd: tempDir(), images: [icon()] }, c.emit).done
    console.log('reply', c.text(), c.events.filter((e) => e.type === 'error'))
    const errors = c.events.filter((e) => e.type === 'error')
    if (errors.length) expect(errors).toEqual([expect.objectContaining({ code: 'auth' })])
    else expect(c.text()).toContain('3')
  }, 180_000)
})

describe.skipIf(!live.includes('claude-ask'))('live: Claude asks before running a command', () => {
  it('stops for a question, runs the command once allowed, or says clearly that sign-in is needed', async () => {
    await loadShellPath()
    const claude = new ClaudeProvider(() => settings, join(tempDir(), 'tmp'))
    const c = collect()
    const prompt = 'Run this exact shell command and tell me the number it prints: node -e "console.log(123456 * 3)"'
    const handle = claude.run({ prompt, system: '', model: 'haiku', mode: 'edit', cwd: tempDir() }, c.emit)
    let finished = false
    void handle.done.then(() => (finished = true))
    const ask = () => c.events.find((e): e is Extract<RunEvent, { type: 'approval' }> => e.type === 'approval')
    while (!finished && !ask()) await new Promise((r) => setTimeout(r, 100))
    const asked = ask()
    console.log('question', asked?.request)
    if (asked) handle.respondApproval!(asked.request.id, 'accept')
    await handle.done
    console.log('reply', c.text(), c.events.filter((e) => e.type === 'error' || e.type === 'denials' || e.type === 'tool'))
    const errors = c.events.filter((e) => e.type === 'error')
    if (errors.length) {
      expect(errors).toEqual([expect.objectContaining({ code: 'auth' })])
      return
    }
    expect(asked?.request).toMatchObject({ kind: 'command' })
    expect(c.text()).toContain('370368')
    expect(c.events.some((e) => e.type === 'denials')).toBe(false)
  }, 180_000)
})
