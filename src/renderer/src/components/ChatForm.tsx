import { useState } from 'react'
import { formAnswerText, formComplete, type ChatForm, type FormValues } from '@shared/forms'

/** A form an assistant sent. Its answers go back as the user's next message. */
export function ChatFormView({ form, answerable }: { form: ChatForm; answerable: boolean }) {
  const [values, setValues] = useState<FormValues>({})
  const [sent, setSent] = useState(false)
  const set = (name: string, value: string | string[]) => setValues((v) => ({ ...v, [name]: value }))
  const locked = sent || !answerable
  return (
    <form
      className="chat-form"
      data-testid="chat-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (locked || !formComplete(form, values)) return
        setSent(true)
        window.dispatchEvent(new CustomEvent('chaude-form-answer', { detail: formAnswerText(form, values) }))
      }}
    >
      <div className="chat-form-title">{form.title}</div>
      {form.fields.map((f) => (
        <label className="chat-form-field" key={f.name}>
          <span className="chat-form-label">
            {f.label}
            {f.required && <span className="chat-form-required"> *</span>}
          </span>
          {f.type === 'choice' ? (
            <span className="chat-form-options">
              {f.options!.map((o) => (
                <button type="button" key={o} disabled={locked} className={`chip ${values[f.name] === o ? 'on' : ''}`} aria-pressed={values[f.name] === o} onClick={() => set(f.name, o)}>
                  {o}
                </button>
              ))}
            </span>
          ) : f.type === 'multi' ? (
            <span className="chat-form-options">
              {f.options!.map((o) => {
                const list = (values[f.name] as string[] | undefined) ?? []
                const on = list.includes(o)
                return (
                  <button type="button" key={o} disabled={locked} className={`chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => set(f.name, on ? list.filter((x) => x !== o) : [...list, o])}>
                    {o}
                  </button>
                )
              })}
            </span>
          ) : f.type === 'longtext' ? (
            <textarea className="input" rows={3} disabled={locked} placeholder={f.placeholder} value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)} />
          ) : (
            <input className="input" disabled={locked} type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} placeholder={f.placeholder} value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)} />
          )}
        </label>
      ))}
      <div className="chat-form-foot">
        {sent ? (
          <span className="muted tiny">Sent</span>
        ) : !answerable ? (
          <span className="muted tiny">This form is from earlier in the conversation.</span>
        ) : (
          <button type="submit" className="btn btn-small btn-primary" data-testid="chat-form-send" disabled={!formComplete(form, values)}>
            {form.submit}
          </button>
        )}
      </div>
    </form>
  )
}
