// Navigation ids (ui-plan §5). The dock carries six sections. Home was folded into Tasks in P4:
// its old id resolves to Tasks in compose state. Routing, Context & Tools and Skills moved into
// Settings as tabs, but every old id still resolves, so `switchView('routing')` and friends keep
// working for every caller. Pure: no DOM, unit-tested in tests/nav.test.ts.
export const VIEWS = ['tasks', 'workspace', 'review', 'agents', 'office', 'settings'] as const
export type ViewId = typeof VIEWS[number]

export const SETTINGS_TABS = ['general', 'appearance', 'routing', 'control', 'skills', 'verification'] as const
export type SettingsTab = typeof SETTINGS_TABS[number]

export interface ResolvedView { view: ViewId; tab?: SettingsTab; compose?: true }

export const isSettingsTab = (id: string | undefined): id is SettingsTab => (SETTINGS_TABS as readonly string[]).includes(id ?? '')

// A view id resolves to itself; `home` resolves to Tasks in compose state; a Settings tab id
// (which covers the old `routing`, `control` and `skills` screens) resolves to Settings with that
// tab. Anything else is unknown.
export function resolveView(id: string): ResolvedView | undefined {
  if (id === 'home') return { view: 'tasks', compose: true }
  if ((VIEWS as readonly string[]).includes(id)) return { view: id as ViewId }
  if (isSettingsTab(id)) return { view: 'settings', tab: id }
  return undefined
}

// --- The Tasks centre pane (ui-plan §10.1 row 1) ---
// It shows either the composer or one selected task, never neither: selecting a task leaves
// compose, entering compose clears the selection, and a selection that disappears (cleared,
// deleted, or scoped out by the project switcher) falls back to compose. Nothing ever picks a task
// on the user's behalf, which is what the old "auto-select the first task" rule did.
export interface TaskSurface { composing: boolean; selectedTaskId?: string }
export type TaskSurfaceEvent =
  | { kind: 'compose' }
  | { kind: 'select'; taskId: string }
  | { kind: 'reconcile'; taskIds: readonly string[] } // the tasks in scope right now

export function nextTaskSurface(current: TaskSurface, event: TaskSurfaceEvent): TaskSurface {
  if (event.kind === 'compose') return { composing: true }
  if (event.kind === 'select') return { composing: false, selectedTaskId: event.taskId }
  if (current.composing) return { composing: true }
  return current.selectedTaskId && event.taskIds.includes(current.selectedTaskId) ? current : { composing: true }
}
