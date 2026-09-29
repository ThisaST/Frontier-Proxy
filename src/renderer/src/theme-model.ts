// The pure half of the appearance module (see theme.ts): types, the storage keys, and
// `resolveAppearance`, which turns whatever is in localStorage into the attribute values
// for <html>. No DOM, so it is unit-tested directly. `public/theme-init.js` is a plain
// script that cannot import this file and re-implements the same function by hand;
// tests/appearance.test.ts runs it against the same inputs so the two cannot drift.
export type Family = 'neutral' | 'mono' | 'phosphor'
export type Scheme = 'system' | 'light' | 'dark'
export type DockPosition = 'bottom' | 'left' | 'right'
export type DockLabels = 'hover' | 'always'
export type Density = 'comfortable' | 'compact'
export type FontSize = 'default' | 'large'
export type Effects = 'on' | 'off'

/** What the user chose. `scheme` may be `system`; `effects` is the stored preference, not the reduced-motion result. */
export interface Appearance { family: Family; scheme: Scheme; dock: DockPosition; dockLabels: DockLabels; density: Density; fontSize: FontSize; effects: Effects }

/** The attributes set on <html>. `data-scheme` is always resolved; `data-theme` is the v1 attribute, kept until P7. */
export interface AppearanceAttributes {
  'data-family': Family; 'data-scheme': 'light' | 'dark'; 'data-dock': DockPosition; 'data-dock-labels': DockLabels
  'data-density': Density; 'data-font-size': FontSize; 'data-effects': Effects; 'data-theme': 'console' | 'daylight'
}

/** The family a user lands on when they never chose one. The P6 flip to 'neutral' is this one line (and theme-init.js). */
export const DEFAULT_FAMILY: Family = 'phosphor'

export const APPEARANCE_KEYS = {
  family: 'fp-family', scheme: 'fp-scheme', dock: 'fp-dock', dockLabels: 'fp-dock-labels',
  density: 'fp-density', fontSize: 'fp-font-size', effects: 'fp-effects', legacyTheme: 'fp-theme'
} as const

export const FAMILIES: readonly Family[] = ['neutral', 'mono', 'phosphor']
const SCHEMES: readonly Scheme[] = ['system', 'light', 'dark']
const DOCKS: readonly DockPosition[] = ['bottom', 'left', 'right']
const DOCK_LABELS: readonly DockLabels[] = ['hover', 'always']
const DENSITIES: readonly Density[] = ['comfortable', 'compact']
const FONT_SIZES: readonly FontSize[] = ['default', 'large']

// v1 `fp-theme` -> scheme (`system` and anything else map to the default, `system`). Read only
// while `fp-family` is absent (ui-plan §7.3); the key is never deleted.
const legacyScheme = (theme: string | undefined): Scheme | undefined => theme === 'console' ? 'dark' : theme === 'daylight' ? 'light' : undefined

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

export function resolveAppearance(stored: Record<string, string | undefined>, prefersDark: boolean, reducedMotion: boolean): { appearance: Appearance; attributes: AppearanceAttributes } {
  const familyStored = FAMILIES.includes(stored[APPEARANCE_KEYS.family] as Family)
  const legacy = familyStored ? undefined : legacyScheme(stored[APPEARANCE_KEYS.legacyTheme])
  const appearance: Appearance = {
    family: pick(stored[APPEARANCE_KEYS.family], FAMILIES, DEFAULT_FAMILY),
    scheme: pick(stored[APPEARANCE_KEYS.scheme], SCHEMES, legacy ?? 'system'),
    dock: pick(stored[APPEARANCE_KEYS.dock], DOCKS, 'bottom'),
    dockLabels: pick(stored[APPEARANCE_KEYS.dockLabels], DOCK_LABELS, 'hover'),
    density: pick(stored[APPEARANCE_KEYS.density], DENSITIES, 'comfortable'),
    fontSize: pick(stored[APPEARANCE_KEYS.fontSize], FONT_SIZES, 'default'),
    effects: stored[APPEARANCE_KEYS.effects] === 'off' ? 'off' : 'on'
  }
  const scheme = appearance.scheme === 'system' ? (prefersDark ? 'dark' : 'light') : appearance.scheme
  return {
    appearance,
    attributes: {
      'data-family': appearance.family, 'data-scheme': scheme, 'data-dock': appearance.dock, 'data-dock-labels': appearance.dockLabels,
      'data-density': appearance.density, 'data-font-size': appearance.fontSize,
      'data-effects': appearance.effects === 'off' || reducedMotion ? 'off' : 'on',
      'data-theme': scheme === 'dark' ? 'console' : 'daylight'
    }
  }
}
