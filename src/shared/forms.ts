// Forms in the chat: an assistant that needs several answers, or wants the user
// to choose, writes a small form instead of a list of questions:
//
//   ```form title="Trip details"
//   {"fields": [{"name": "when", "label": "When are you going?", "type": "text"},
//               {"name": "pace", "label": "Pace", "type": "choice", "options": ["Relaxed", "Busy"]}],
//    "submit": "Plan my trip"}
//   ```
//
// The app shows it as a form, and the answers go back as the user's next message.
// Like artifacts, forms are found in the reply's text, so every assistant can use them. Pure.

export type FieldType = 'text' | 'longtext' | 'number' | 'date' | 'choice' | 'multi'

export interface FormField {
  name: string
  label: string
  type: FieldType
  options?: string[]
  required?: boolean
  placeholder?: string
}

export interface ChatForm {
  title: string
  fields: FormField[]
  submit: string
}

const TYPES: FieldType[] = ['text', 'longtext', 'number', 'date', 'choice', 'multi']

/** Reads a form block's text. Undefined when it is not a usable form. */
export function parseForm(json: string, title?: string): ChatForm | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return undefined
  }
  const o = (raw ?? {}) as Record<string, unknown>
  const list = Array.isArray(raw) ? raw : Array.isArray(o.fields) ? o.fields : []
  const fields: FormField[] = []
  for (const [i, f] of (list as Record<string, unknown>[]).slice(0, 20).entries()) {
    if (!f || typeof f !== 'object') continue
    const label = String(f.label ?? f.question ?? f.name ?? '').trim()
    if (!label) continue
    const options = Array.isArray(f.options) ? f.options.map(String).filter(Boolean).slice(0, 30) : undefined
    let type = TYPES.includes(f.type as FieldType) ? (f.type as FieldType) : options?.length ? 'choice' : 'text'
    if ((type === 'choice' || type === 'multi') && !options?.length) type = 'text'
    fields.push({
      name: String(f.name ?? `field${i + 1}`),
      label: label.slice(0, 300),
      type,
      ...(options?.length && (type === 'choice' || type === 'multi') ? { options } : {}),
      ...(f.required === true ? { required: true } : {}),
      ...(typeof f.placeholder === 'string' ? { placeholder: f.placeholder.slice(0, 200) } : {})
    })
  }
  if (!fields.length) return undefined
  return { title: (title ?? String(o.title ?? '')).trim().slice(0, 120) || 'A few questions', fields, submit: typeof o.submit === 'string' && o.submit.trim() ? o.submit.trim().slice(0, 60) : 'Send' }
}

export type FormValues = Record<string, string | string[]>

/** Whether every required question has an answer. */
export function formComplete(form: ChatForm, values: FormValues): boolean {
  return form.fields.every((f) => !f.required || (Array.isArray(values[f.name]) ? (values[f.name] as string[]).length > 0 : String(values[f.name] ?? '').trim() !== ''))
}

/** The answers as the message the user sends back. */
export function formAnswerText(form: ChatForm, values: FormValues): string {
  const lines = form.fields.map((f) => {
    const v = values[f.name]
    const answer = Array.isArray(v) ? v.join(', ') : String(v ?? '').trim()
    return `- ${f.label} ${answer || '(no answer)'}`
  })
  return `My answers to "${form.title}":\n${lines.join('\n')}`
}

/** Added to the system text with the artifact guide: how to ask with a form. */
export const FORM_GUIDE = `When you need several answers from the user at once, or want them to choose between options, you can ask with a form instead of a list of questions. Write one fenced code block with the language "form", a title, and JSON:

\`\`\`form title="Trip details"
{"fields": [{"name": "when", "label": "When are you going?", "type": "text"}, {"name": "pace", "label": "Pace", "type": "choice", "options": ["Relaxed", "Busy"]}], "submit": "Plan my trip"}
\`\`\`

Field types: text, longtext, number, date, choice (one of the options), multi (any of the options). Add "required": true where an answer is needed. The user's answers come back as their next message. Use a form only when it saves the user effort.`
