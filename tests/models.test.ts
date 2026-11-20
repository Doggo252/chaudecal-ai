import { describe, expect, it } from 'vitest'
import { claudeCatalog, codexCatalog } from '../src/shared/models'

describe('model lists', () => {
  it("reads Claude Code's list with versioned names and short descriptions", () => {
    const list = claudeCatalog([
      { value: 'default', displayName: 'Default (recommended)', description: 'Sonnet 4.6 · Best for everyday tasks', supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
      { value: 'opus', displayName: 'Opus', description: 'Opus 4.7 · Most capable for complex work · ~2× usage vs Sonnet' },
      { value: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
      { value: 'claude-fable-5-2[1m]', displayName: 'Fable', description: 'Fable 5.2 · Most capable for your hardest and longest-running tasks' },
      { value: 'opus[1m]', displayName: 'Opus 4.7 (1M context)', description: 'Opus 4.7 with 1M context · Most capable for complex work' }
    ])
    expect(list.map((m) => m.name)).toEqual(['Default (Sonnet 4.6)', 'Opus 4.7', 'Haiku 4.5', 'Fable 5.2', 'Opus 4.7 (1M context)'])
    expect(list[1].description).toBe('Most capable for complex work · ~2× usage vs Sonnet')
    expect(list[0]).toMatchObject({ isDefault: true, efforts: ['low', 'medium', 'high', 'max'] })
    expect(list[4].description).toBe('Most capable for complex work')
  })
  it("reads Codex's list and keeps older models apart", () => {
    const list = codexCatalog([
      { model: 'gpt-6.2-sol', displayName: 'GPT-6.2-Sol', description: 'Fast, go-to model for coding and everyday work.', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
      { model: 'gpt-6-sol', displayName: 'GPT-6-Sol', description: 'Legacy model for coding and everyday work.' },
      { model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', description: 'Previous generation model for coding and everyday work.' }
    ])
    expect(list[0]).toMatchObject({ name: 'GPT-6.2-Sol', isDefault: true, efforts: ['low', 'high'] })
    expect(list[0].legacy).toBeUndefined()
    expect(list[1].legacy).toBe(true)
    expect(list[2].legacy).toBe(true)
  })
})
