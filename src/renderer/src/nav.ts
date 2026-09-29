// Navigation ids (ui-plan §5). The dock carries five sections; `home` survives until P4 folds
// it into Tasks. Routing, Context & Tools and Skills moved into Settings as tabs, but every old
// id still resolves, so `switchView('routing')` and friends keep working for every caller. Pure:
// no DOM, unit-tested in tests/nav.test.ts.
export const VIEWS = ['home', 'tasks', 'workspace', 'review', 'agents', 'settings'] as const
export type ViewId = typeof VIEWS[number]

export const SETTINGS_TABS = ['general', 'appearance', 'routing', 'control', 'skills', 'verification'] as const
export type SettingsTab = typeof SETTINGS_TABS[number]

export interface ResolvedView { view: ViewId; tab?: SettingsTab }

export const isSettingsTab = (id: string | undefined): id is SettingsTab => (SETTINGS_TABS as readonly string[]).includes(id ?? '')

// A view id resolves to itself; a Settings tab id (which covers the old `routing`, `control` and
// `skills` screens) resolves to Settings with that tab. Anything else is unknown.
export function resolveView(id: string): ResolvedView | undefined {
  if ((VIEWS as readonly string[]).includes(id)) return { view: id as ViewId }
  if (isSettingsTab(id)) return { view: 'settings', tab: id }
  return undefined
}
