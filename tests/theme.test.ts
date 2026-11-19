import { describe, expect, it } from 'vitest'
import { defaultSettings } from '@shared/types'
import { ACCENT_PRESETS, TEXT_SIZES, accentColor, accentVars, normalizeAccent, normalizeTextSize, textOn, textScale } from '@shared/theme'

describe('accent color', () => {
  it('starts on the default look, which sets no color', () => {
    expect(defaultSettings('x').accent).toBe('default')
    expect(accentColor('default')).toBeUndefined()
    expect(accentVars('default')).toBeUndefined()
    expect(accentVars(undefined)).toBeUndefined()
  })

  it('gives each preset its color, and takes any color written as #rrggbb', () => {
    expect(ACCENT_PRESETS.map((p) => p.id)).toEqual(['default', 'blue', 'green', 'yellow', 'pink', 'orange', 'purple'])
    expect(accentColor('blue')).toBe('#2f7fe6')
    expect(accentColor('#AB12CD')).toBe('#ab12cd')
    expect(accentColor('ab12cd')).toBeUndefined()
    expect(accentColor('#abc')).toBeUndefined()
  })

  it('stores only a preset or a color, and falls back to the default for anything else', () => {
    expect(normalizeAccent('Purple')).toBe('purple')
    expect(normalizeAccent(' #AB12CD ')).toBe('#ab12cd')
    expect(normalizeAccent('red; background: url(x)')).toBe('default')
    expect(normalizeAccent('teal')).toBe('default')
    expect(normalizeAccent(undefined)).toBe('default')
    expect(normalizeAccent(42)).toBe('default')
  })

  it('puts readable text on the color', () => {
    expect(textOn('#000000')).toBe('#ffffff')
    expect(textOn('#ffffff')).toBe('#1b1a18')
    expect(textOn('#1c2f6b')).toBe('#ffffff')
    expect(textOn('#ffe45c')).toBe('#1b1a18')
    // Every preset gets one of the two, and the result is always legible (contrast of at least 3 to 1).
    const lum = (hex: string) => {
      const c = (i: number) => {
        const v = parseInt(hex.slice(i, i + 2), 16) / 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * c(1) + 0.7152 * c(3) + 0.0722 * c(5)
    }
    for (const preset of ACCENT_PRESETS.filter((p) => p.color)) {
      const [a, b] = [lum(preset.color), lum(textOn(preset.color))].sort((x, y) => y - x)
      expect((a + 0.05) / (b + 0.05), preset.name).toBeGreaterThanOrEqual(3)
    }
    expect(accentVars('yellow')).toEqual({ '--accent': '#d9a316', '--accent-text': '#1b1a18' })
    expect(accentVars('#1c2f6b')).toEqual({ '--accent': '#1c2f6b', '--accent-text': '#ffffff' })
  })
})

describe('text size', () => {
  it('starts on the default size, which changes nothing', () => {
    expect(defaultSettings('x').textSize).toBe('default')
    expect(textScale('default')).toBe(1)
    expect(textScale(undefined)).toBe(1)
  })

  it('has steps that grow from small to extra large', () => {
    expect(TEXT_SIZES.map((t) => t.id)).toEqual(['small', 'default', 'large', 'larger'])
    const scales = TEXT_SIZES.map((t) => t.scale)
    expect([...scales].sort((a, b) => a - b)).toEqual(scales)
    expect(textScale('small')).toBeLessThan(1)
    expect(textScale('larger')).toBeGreaterThan(textScale('large'))
  })

  it('stores only one of the steps', () => {
    expect(normalizeTextSize('large')).toBe('large')
    expect(normalizeTextSize('huge')).toBe('default')
    expect(normalizeTextSize(2)).toBe('default')
    expect(textScale('huge')).toBe(1)
  })
})
