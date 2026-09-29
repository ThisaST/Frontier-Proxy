// Live appearance switching (family, scheme, dock, density, text size, effects). The
// before-paint choice is made by `public/theme-init.js`, which cannot import this module —
// see theme-model.ts for the shared, pure resolution — and this module takes over afterwards
// so a change applies without a reload. Renderer-only preference: never sent to the main process.
import {
  APPEARANCE_KEYS, platformAttribute, resolveAppearance,
  type Appearance, type Density, type DockLabels, type DockPosition, type Effects, type Family, type FontSize, type Scheme
} from './theme-model'

export * from './theme-model'

function readStorage(key: string): string | undefined {
  try { return localStorage.getItem(key) ?? undefined } catch { return undefined }
}

function writeStorage(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* private mode / disabled storage */ }
}

function media(query: string): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(query).matches
}

function resolveNow() {
  const stored = Object.fromEntries(Object.values(APPEARANCE_KEYS).map((key) => [key, readStorage(key)]))
  return resolveAppearance(stored, media('(prefers-color-scheme: dark)'), media('(prefers-reduced-motion: reduce)'))
}

export function currentAppearance(): Appearance { return resolveNow().appearance }

const listeners: Array<() => void> = []
/** Called after every apply (a setter, the palette, or an OS scheme / reduced-motion change). */
export function onAppearanceChange(listener: () => void): void { listeners.push(listener) }

export function applyAppearance(): void {
  const root = document.documentElement
  for (const [name, value] of Object.entries(resolveNow().attributes)) root.setAttribute(name, value)
  root.setAttribute('data-platform', platformAttribute(navigator as Navigator & { userAgentData?: { platform?: string } }))
  listeners.forEach((listener) => listener())
}

function set(key: string, value: string): void { writeStorage(key, value); applyAppearance() }

export const setFamily = (family: Family): void => set(APPEARANCE_KEYS.family, family)
export const setScheme = (scheme: Scheme): void => set(APPEARANCE_KEYS.scheme, scheme)
export const setDock = (dock: DockPosition): void => set(APPEARANCE_KEYS.dock, dock)
export const setDockLabels = (labels: DockLabels): void => set(APPEARANCE_KEYS.dockLabels, labels)
export const setDensity = (density: Density): void => set(APPEARANCE_KEYS.density, density)
export const setFontSize = (size: FontSize): void => set(APPEARANCE_KEYS.fontSize, size)
export const setEffects = (effects: Effects): void => set(APPEARANCE_KEYS.effects, effects)

export function initTheme(): void {
  // One-time migration of the v1 key. Only the scheme is carried over; `fp-family` is deliberately
  // NOT written from DEFAULT_FAMILY, or the P6 default flip would never reach these users.
  const legacy = readStorage(APPEARANCE_KEYS.legacyTheme)
  if (readStorage(APPEARANCE_KEYS.family) === undefined && readStorage(APPEARANCE_KEYS.scheme) === undefined && legacy !== undefined) {
    const { scheme } = currentAppearance()
    if (scheme !== 'system') writeStorage(APPEARANCE_KEYS.scheme, scheme)
  }
  applyAppearance()
  if (typeof window.matchMedia !== 'function') return
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyAppearance)
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', applyAppearance)
}

// Effects keep their v1 names; Settings → Appearance and the palette call these.
export type EffectsPreference = Effects
export const effectsPreference = (): EffectsPreference => currentAppearance().effects
export const setEffectsPreference = (effects: EffectsPreference): void => setEffects(effects)
