import { useEffect, useState } from 'react'
import type { ProviderChoice, ScheduledTask } from '@shared/types'
import { describeSchedule, type TaskSchedule } from '@shared/schedule'
import { openChat, toast, useUi } from '../state'
import { Toggle } from './ui'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function when(at: number | undefined): string {
  return at ? new Date(at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'not planned'
}

function localInput(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function TaskCard({ task }: { task: ScheduledTask }) {
  const app = useUi((s) => s.app!)
  const [title, setTitle] = useState(task.title)
  const [prompt, setPrompt] = useState(task.prompt)
  useEffect(() => {
    setTitle(task.title)
    setPrompt(task.prompt)
  }, [task.id])
  const save = (patch: Parameters<typeof window.api.saveTask>[0]) => void window.api.saveTask({ id: task.id, ...patch })
  const s = task.schedule
  const time = 'time' in s ? s.time : '09:00'
  const setSchedule = (next: TaskSchedule) => save({ schedule: next })
  const mine = task.runOn === app.deviceId || (task.runOn === 'hub' && app.hub.role === 'host')
  const hubKnown = app.hub.role !== 'off'

  return (
    <div className="group task-card" data-testid="task" data-title={task.title}>
      <div className="row row-stack">
        <input className="input wide task-title" data-testid="task-title" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() !== task.title && save({ title })} />
        <textarea className="input wide" rows={3} data-testid="task-prompt" placeholder="What should the assistant do each time? For example: summarise the news about electric cars from the last day." value={prompt} onChange={(e) => setPrompt(e.target.value)} onBlur={() => prompt !== task.prompt && save({ prompt })} />
      </div>
      <div className="row task-when">
        <select className="select" data-testid="task-every" value={s.every} onChange={(e) => {
          const every = e.target.value
          setSchedule(every === 'hour' ? { every: 'hour' } : every === 'once' ? { every: 'once', at: Date.now() + 3600_000 } : every === 'week' ? { every: 'week', day: 1, time } : { every: every as 'day' | 'weekday', time })
        }}>
          <option value="hour">Every hour</option>
          <option value="day">Every day</option>
          <option value="weekday">Every weekday</option>
          <option value="week">Every week</option>
          <option value="once">Once</option>
        </select>
        {s.every === 'week' && (
          <select className="select" value={s.day} onChange={(e) => setSchedule({ every: 'week', day: Number(e.target.value), time })}>
            {DAYS.map((d, i) => (
              <option key={d} value={i}>
                on {d}
              </option>
            ))}
          </select>
        )}
        {(s.every === 'day' || s.every === 'weekday' || s.every === 'week') && <input type="time" className="input" data-testid="task-time" value={time} onChange={(e) => e.target.value && setSchedule({ ...s, time: e.target.value })} />}
        {s.every === 'once' && <input type="datetime-local" className="input" value={localInput(s.at)} onChange={(e) => e.target.value && setSchedule({ every: 'once', at: new Date(e.target.value).getTime() })} />}
        <select className="select" title="Assistant" value={task.provider} onChange={(e) => save({ provider: e.target.value as ProviderChoice })}>
          <option value="auto">Auto</option>
          <option value="claude">Claude</option>
          <option value="chatgpt">ChatGPT</option>
          <option value="local">Local AI</option>
        </select>
        <select className="select" title="Which machine runs it" data-testid="task-run-on" value={task.runOn === 'hub' ? 'hub' : task.runOn === app.deviceId ? 'here' : 'other'} onChange={(e) => save({ runOn: e.target.value === 'hub' ? 'hub' : app.deviceId })}>
          <option value="here">On this machine</option>
          {hubKnown && <option value="hub">On the hub</option>}
          {task.runOn !== 'hub' && task.runOn !== app.deviceId && <option value="other">On another device</option>}
        </select>
      </div>
      <div className="row">
        <div className="row-main">
          <div className="row-sub" data-testid="task-status">
            {describeSchedule(s)}. {task.enabled ? `Next run: ${when(task.nextRun)}.` : 'Paused.'} {task.lastRun ? `Last ran ${when(task.lastRun)}.` : ''}
            {!mine && task.enabled ? ' Another machine runs it, so it only runs while that one is on.' : ''}
          </div>
        </div>
        <Toggle checked={task.enabled} onChange={(v) => save({ enabled: v })} label="Run on schedule" testId="task-enabled" />
      </div>
      <div className="row task-actions">
        <button
          type="button"
          className="btn btn-small"
          data-testid="task-run-now"
          disabled={!prompt.trim()}
          onClick={() =>
            void window.api.runTaskNow(task.id).then((id) => {
              if (id) openChat(id)
            })
          }
        >
          Run now
        </button>
        {task.conversationId && (
          <button type="button" className="btn btn-small" onClick={() => openChat(task.conversationId)}>
            Open its chat
          </button>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-small btn-danger"
          onClick={() => {
            if (confirm(`Delete the task "${task.title}"? Its chat stays.`)) void window.api.deleteTask(task.id).then(() => toast('Task deleted'))
          }}
        >
          Delete
        </button>
      </div>
    </div>
  )
}

export function TaskSettings() {
  const tasks = useUi((s) => s.app?.tasks)
  return (
    <>
      <h2>Scheduled tasks</h2>
      <p className="lead">A prompt that runs by itself, every hour, day or week, or once. Each task has its own chat where its answers collect. A task runs on one machine: choose the hub to have it run while your other devices are off.</p>
      {(tasks ?? []).map((t) => (
        <TaskCard key={t.id} task={t} />
      ))}
      <button type="button" className="btn btn-primary" data-testid="new-task" onClick={() => void window.api.saveTask({ title: 'New task', prompt: '', schedule: { every: 'day', time: '09:00' } })}>
        Add a task
      </button>
    </>
  )
}
