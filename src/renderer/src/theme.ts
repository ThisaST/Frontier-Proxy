// Live theme/effects switching for the Settings → Appearance card. The
// before-paint choice itself is made by `public/theme-init.js` (which cannot
// import this module — see its own comment); this module takes over afterwards
// so a change applies immediately, without a reload. Renderer-only preference:
// never sent to the main process.
const THEME_KEY = 'fp-theme'
const EFFECTS_KEY = 'fp-effects'

export type ThemePreference = 'system' | 'console' | 'daylight'
export type EffectsPreference = 'on' | 'off'

function readStorage(key: string): string | undefined {
  try { return localStorage.getItem(key) ?? undefined } catch { return undefined }
}

function writeStorage(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* private mode / disabled storage */ }
}

export function themePreference(): ThemePreference {
  const stored = readStorage(THEME_KEY)
  return stored === 'console' || stored === 'daylight' ? stored : 'system'
}

export function effectsPreference(): EffectsPreference {
  return readStorage(EFFECTS_KEY) === 'off' ? 'off' : 'on'
}

function prefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function applyTheme(): void {
  const theme = themePreference()
  const resolved = theme === 'system' ? (prefersDark() ? 'console' : 'daylight') : theme
  const effects = effectsPreference() === 'off' || prefersReducedMotion() ? 'off' : 'on'
  document.documentElement.setAttribute('data-theme', resolved)
  document.documentElement.setAttribute('data-effects', effects)
}

export function setThemePreference(theme: ThemePreference): void {
  writeStorage(THEME_KEY, theme)
  applyTheme()
}

export function setEffectsPreference(effects: EffectsPreference): void {
  writeStorage(EFFECTS_KEY, effects)
  applyTheme()
}

export function initTheme(): void {
  applyTheme()
  if (typeof window.matchMedia !== 'function') return
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themePreference() === 'system') applyTheme() })
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', applyTheme)
}
