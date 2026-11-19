// The accent color: the one color the user picks, used for the main buttons,
// the switches, the text selection and a tint on their own messages. Pure.

export interface AccentPreset {
  /** What is stored in the settings. */
  id: string
  name: string
  /** Empty for the default look, which uses the theme's own ink color. */
  color: string
}

/** Mid-tone colors, chosen to read well on both the light and the dark background. */
export const ACCENT_PRESETS: AccentPreset[] = [
  { id: 'default', name: 'Default', color: '' },
  { id: 'blue', name: 'Blue', color: '#2f7fe6' },
  { id: 'green', name: 'Green', color: '#2e9e6b' },
  { id: 'yellow', name: 'Yellow', color: '#d9a316' },
  { id: 'pink', name: 'Pink', color: '#e0569c' },
  { id: 'orange', name: 'Orange', color: '#e8772e' },
  { id: 'purple', name: 'Purple', color: '#8b5cf6' }
]

const HEX = /^#[0-9a-f]{6}$/i

/** The color for a stored accent: a preset's, or the stored value itself when it is a color. Undefined for the default look. */
export function accentColor(accent: string | undefined): string | undefined {
  const value = (accent ?? '').trim()
  const preset = ACCENT_PRESETS.find((p) => p.id === value.toLowerCase())
  if (preset) return preset.color || undefined
  return HEX.test(value) ? value.toLowerCase() : undefined
}

/** What to store for whatever was asked for. Anything that is not a preset or a color becomes the default. */
export function normalizeAccent(accent: unknown): string {
  if (typeof accent !== 'string') return 'default'
  const value = accent.trim().toLowerCase()
  if (ACCENT_PRESETS.some((p) => p.id === value)) return value
  return HEX.test(value) ? value : 'default'
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

const LIGHT_TEXT = '#ffffff'
const DARK_TEXT = '#1b1a18'

/** White or near-black, whichever is easier to read on the color. */
export function textOn(hex: string): string {
  const l = luminance(hex)
  const withLight = (luminance(LIGHT_TEXT) + 0.05) / (l + 0.05)
  const withDark = (l + 0.05) / (luminance(DARK_TEXT) + 0.05)
  return withLight >= withDark ? LIGHT_TEXT : DARK_TEXT
}

/** The CSS variables for an accent. Undefined for the default look, which sets none. */
export function accentVars(accent: string | undefined): { '--accent': string; '--accent-text': string } | undefined {
  const color = accentColor(accent)
  return color ? { '--accent': color, '--accent-text': textOn(color) } : undefined
}
