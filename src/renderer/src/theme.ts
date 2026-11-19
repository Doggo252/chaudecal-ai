import { accentVars, textScale } from '@shared/theme'

/** Puts the chosen accent color on the page, or takes it off again for the default look. */
export function applyAccent(accent: string | undefined): void {
  const root = document.documentElement
  const vars = accentVars(accent)
  if (!vars) {
    root.removeAttribute('data-accent')
    root.style.removeProperty('--accent')
    root.style.removeProperty('--accent-text')
    return
  }
  root.setAttribute('data-accent', vars['--accent'])
  root.style.setProperty('--accent', vars['--accent'])
  root.style.setProperty('--accent-text', vars['--accent-text'])
}

/** Sets how large the text is drawn. The default takes the setting off again. */
export function applyTextSize(size: string | undefined): void {
  const root = document.documentElement
  const scale = textScale(size)
  if (scale === 1) root.style.removeProperty('--text-scale')
  else root.style.setProperty('--text-scale', String(scale))
}
