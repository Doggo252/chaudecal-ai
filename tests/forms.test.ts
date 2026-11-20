import { describe, expect, it } from 'vitest'
import { classifyFence, formBlocks } from '@shared/artifacts'
import { formAnswerText, formComplete, parseForm } from '@shared/forms'

const JSON_FORM = JSON.stringify({ fields: [{ name: 'when', label: 'When are you going?', type: 'text', required: true }, { name: 'pace', label: 'Pace', type: 'choice', options: ['Relaxed', 'Busy'] }, { name: 'likes', label: 'Interests', type: 'multi', options: ['Food', 'Art'] }, { label: 'Odd one', type: 'choice' }, { nope: true }], submit: 'Plan my trip' })

describe('forms in the chat', () => {
  it('reads a form, and fixes what it can', () => {
    const form = parseForm(JSON_FORM, 'Trip details')!
    expect(form.title).toBe('Trip details')
    expect(form.submit).toBe('Plan my trip')
    expect(form.fields.map((f) => [f.label, f.type])).toEqual([
      ['When are you going?', 'text'],
      ['Pace', 'choice'],
      ['Interests', 'multi'],
      ['Odd one', 'text']
    ])
    expect(parseForm('not json')).toBeUndefined()
    expect(parseForm('{"fields": []}')).toBeUndefined()
    expect(parseForm('[{"label": "Just one"}]')).toMatchObject({ title: 'A few questions', submit: 'Send', fields: [{ label: 'Just one' }] })
  })

  it('waits for required answers, and writes the answers as a message', () => {
    const form = parseForm(JSON_FORM, 'Trip details')!
    expect(formComplete(form, { pace: 'Busy' })).toBe(false)
    const values = { when: 'Next week', pace: 'Relaxed', likes: ['Food', 'Art'] }
    expect(formComplete(form, values)).toBe(true)
    expect(formAnswerText(form, values)).toBe('My answers to "Trip details":\n- When are you going? Next week\n- Pace Relaxed\n- Interests Food, Art\n- Odd one (no answer)')
  })

  it('finds form blocks in order, and never takes one for an artifact', () => {
    const text = `Hi\n\n\`\`\`form title="A"\n{"fields":[{"label":"x"}]}\n\`\`\`\n\n\`\`\`html title="Page"\n<p>x</p>\n\`\`\`\n\n\`\`\`form\n[{"label":"y"}]\n\`\`\``
    expect(formBlocks(text)).toEqual([
      { title: 'A', json: '{"fields":[{"label":"x"}]}' },
      { title: undefined, json: '[{"label":"y"}]' }
    ])
    expect(classifyFence('form title="A"', '{}')).toBeUndefined()
  })
})
