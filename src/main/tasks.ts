// Runs scheduled tasks: each one's prompt goes into its own chat when it is due.
// A task runs on one machine only (a chosen device, or whichever is the hub), so
// two devices never both run it. A run missed while the app was closed happens
// once when it starts again.

import type { Conversation, ProviderChoice, ScheduledTask } from '@shared/types'
import type { SendInput } from '@shared/ipc'
import { nextRun } from '@shared/schedule'
import type { Store } from './store'

export interface TaskEngine {
  createConversation(partial: Partial<Conversation>): Conversation
  send(input: SendInput): Promise<void>
  isBusy(conversationId: string): boolean
}

export class TaskRunner {
  private running = new Set<string>()

  constructor(
    private store: Store,
    private engine: TaskEngine,
    private isHub: () => boolean
  ) {}

  /** This machine runs the task. */
  mine(task: ScheduledTask): boolean {
    return task.runOn === this.store.deviceId || (task.runOn === 'hub' && this.isHub())
  }

  /** Runs every task of this machine that is due. */
  async tick(now = Date.now()): Promise<string[]> {
    const due = this.store.list<ScheduledTask>('task').filter((t) => t.enabled && this.mine(t) && t.nextRun !== undefined && t.nextRun <= now && !this.running.has(t.id))
    await Promise.all(due.map((t) => this.run(t, now)))
    return due.map((t) => t.id)
  }

  /** Runs a task now, whatever its schedule. */
  async run(task: ScheduledTask, now = Date.now()): Promise<void> {
    if (this.running.has(task.id)) return
    this.running.add(task.id)
    try {
      let conv = task.conversationId ? this.store.get<Conversation>('conversation', task.conversationId) : undefined
      if (!conv) conv = this.engine.createConversation({ title: task.title, provider: task.provider as ProviderChoice, mode: 'chat' })
      const next = nextRun(task.schedule, now)
      this.store.put('task', task.id, {
        ...task,
        conversationId: conv.id,
        lastRun: now,
        nextRun: next,
        enabled: task.schedule.every === 'once' ? false : task.enabled,
        updatedAt: now
      } satisfies ScheduledTask)
      if (this.engine.isBusy(conv.id)) return
      await this.engine.send({ conversationId: conv.id, text: task.prompt }).catch(() => {})
    } finally {
      this.running.delete(task.id)
    }
  }
}
