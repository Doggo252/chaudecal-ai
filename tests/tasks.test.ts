import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { Conversation, ScheduledTask } from '@shared/types'
import type { SendInput } from '@shared/ipc'
import { cleanSchedule, describeSchedule, nextRun } from '@shared/schedule'
import { Store } from '../src/main/store'
import { TaskRunner } from '../src/main/tasks'
import { tempDir } from './helpers'

// Wednesday 5 March 2025, 10:15 local time.
const at = (d: number, h: number, m = 0) => new Date(2025, 2, d, h, m, 0, 0).getTime()
const NOW = at(5, 10, 15)

describe('when a task runs next', () => {
  it('works out the next time for each kind of schedule', () => {
    expect(nextRun({ every: 'hour' }, NOW)).toBe(at(5, 11))
    expect(nextRun({ every: 'day', time: '09:00' }, NOW)).toBe(at(6, 9))
    expect(nextRun({ every: 'day', time: '18:30' }, NOW)).toBe(at(5, 18, 30))
    // Friday 7 March, then the weekend is skipped.
    expect(nextRun({ every: 'weekday', time: '08:00' }, at(7, 9))).toBe(at(10, 8))
    expect(nextRun({ every: 'week', day: 1, time: '07:00' }, NOW)).toBe(at(10, 7))
    expect(nextRun({ every: 'once', at: NOW + 1000 }, NOW)).toBe(NOW + 1000)
    expect(nextRun({ every: 'once', at: NOW - 1000 }, NOW)).toBeUndefined()
  })

  it('says the schedule in words and cleans what it is sent', () => {
    expect(describeSchedule({ every: 'weekday', time: '08:30' })).toBe('Every weekday at 08:30')
    expect(describeSchedule({ every: 'week', day: 5, time: '17:00' })).toBe('Every Friday at 17:00')
    expect(cleanSchedule({ every: 'week', day: 9, time: 'soon' })).toEqual({ every: 'week', day: 1, time: '09:00' })
    expect(cleanSchedule({ every: 'day', time: '7:05' })).toEqual({ every: 'day', time: '07:05' })
    expect(cleanSchedule('nonsense')).toEqual({ every: 'day', time: '09:00' })
  })
})

describe('running tasks', () => {
  function setup(isHub = false) {
    const store = new Store(join(tempDir(), 'app.db'))
    const sent: SendInput[] = []
    const engine = {
      createConversation: (p: Partial<Conversation>) => {
        const c = { id: `c${sent.length}-${Math.random()}`, title: 'x', createdAt: 1, updatedAt: 1, provider: 'auto', models: {}, mode: 'chat', ...p } as Conversation
        store.put('conversation', c.id, c)
        return c
      },
      send: async (input: SendInput) => void sent.push(input),
      isBusy: () => false
    }
    const runner = new TaskRunner(store, engine, () => isHub)
    const task = (id: string, extra: Partial<ScheduledTask> = {}): ScheduledTask => {
      const t: ScheduledTask = { id, title: `Task ${id}`, prompt: `Do ${id}`, provider: 'claude', schedule: { every: 'day', time: '09:00' }, runOn: store.deviceId, enabled: true, nextRun: NOW - 1, createdAt: 1, updatedAt: 1, ...extra }
      store.put('task', id, t)
      return t
    }
    return { store, sent, runner, task }
  }

  it("runs this machine's due tasks into their own chat, and plans the next run", async () => {
    const { store, sent, runner, task } = setup()
    task('a')
    task('later', { nextRun: NOW + 60_000 })
    task('off', { enabled: false })
    task('elsewhere', { runOn: 'another-device' })
    task('hub', { runOn: 'hub' })
    expect(await runner.tick(NOW)).toEqual(['a'])
    const a = store.get<ScheduledTask>('task', 'a')!
    expect(sent).toEqual([{ conversationId: a.conversationId, text: 'Do a' }])
    expect(store.get<Conversation>('conversation', a.conversationId!)).toMatchObject({ title: 'Task a', provider: 'claude' })
    expect(a).toMatchObject({ lastRun: NOW, nextRun: at(6, 9) })
    // The next run goes into the same chat.
    await runner.run(a, NOW + 1)
    expect(sent[1].conversationId).toBe(a.conversationId)
  })

  it('runs "hub" tasks on the hub, and a one-off task only once', async () => {
    const { store, runner, task } = setup(true)
    task('hub', { runOn: 'hub' })
    task('once', { schedule: { every: 'once', at: NOW - 1 } })
    expect((await runner.tick(NOW)).sort()).toEqual(['hub', 'once'])
    expect(store.get<ScheduledTask>('task', 'once')?.enabled).toBe(false)
    expect(store.get<ScheduledTask>('task', 'once')?.nextRun).toBeUndefined()
    expect(await runner.tick(NOW + 1000)).toEqual([])
  })
})
