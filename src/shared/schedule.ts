// When a scheduled task runs next. Times are in the local time of the machine
// that runs it. Pure.

export type TaskSchedule =
  | { every: 'hour' }
  | { every: 'day'; time: string }
  | { every: 'weekday'; time: string }
  | { every: 'week'; day: number; time: string }
  | { every: 'once'; at: number }

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** "08:30" as hours and minutes. Anything unreadable is 9:00. */
export function parseTime(time: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  const h = m ? Number(m[1]) : 9
  const min = m ? Number(m[2]) : 0
  return h < 24 && min < 60 ? { h, m: min } : { h: 9, m: 0 }
}

/** The first time after `after` (milliseconds) that the task should run, or undefined when it never will again. */
export function nextRun(schedule: TaskSchedule, after: number): number | undefined {
  if (schedule.every === 'once') return schedule.at > after ? schedule.at : undefined
  if (schedule.every === 'hour') {
    const d = new Date(after)
    d.setMinutes(0, 0, 0)
    d.setHours(d.getHours() + 1)
    return d.getTime()
  }
  const { h, m } = parseTime(schedule.time)
  const d = new Date(after)
  d.setHours(h, m, 0, 0)
  if (d.getTime() <= after) d.setDate(d.getDate() + 1)
  for (let i = 0; i < 8; i++) {
    const day = d.getDay()
    const fits = schedule.every === 'day' || (schedule.every === 'weekday' && day !== 0 && day !== 6) || (schedule.every === 'week' && day === schedule.day)
    if (fits) return d.getTime()
    d.setDate(d.getDate() + 1)
  }
  return undefined
}

/** The schedule in words, for example "Every weekday at 08:30". */
export function describeSchedule(schedule: TaskSchedule): string {
  switch (schedule.every) {
    case 'hour':
      return 'Every hour'
    case 'day':
      return `Every day at ${schedule.time}`
    case 'weekday':
      return `Every weekday at ${schedule.time}`
    case 'week':
      return `Every ${DAYS[schedule.day] ?? 'Monday'} at ${schedule.time}`
    case 'once':
      return `Once, on ${new Date(schedule.at).toLocaleString()}`
  }
}

/** A schedule made safe from whatever was sent. */
export function cleanSchedule(raw: unknown): TaskSchedule {
  const s = (raw ?? {}) as Record<string, unknown>
  const time = typeof s.time === 'string' && /^\d{1,2}:\d{2}$/.test(s.time) ? s.time.padStart(5, '0') : '09:00'
  if (s.every === 'hour') return { every: 'hour' }
  if (s.every === 'weekday') return { every: 'weekday', time }
  if (s.every === 'week') return { every: 'week', day: Number.isInteger(s.day) && (s.day as number) >= 0 && (s.day as number) < 7 ? (s.day as number) : 1, time }
  if (s.every === 'once' && typeof s.at === 'number' && Number.isFinite(s.at)) return { every: 'once', at: s.at }
  return { every: 'day', time }
}
