// Shared mutable renderer state: the latest snapshot from the main process,
// current navigation, and the task-surface selection. Everything here is read
// across several view modules; state that only one view touches stays local
// to that view's own module instead of living here.
import type { AppSnapshot } from '../../shared/types'

export let snapshot: AppSnapshot
export function setSnapshot(next: AppSnapshot): void { snapshot = next }

export let currentView = 'home'
export function setCurrentView(view: string): void { currentView = view }

export let selectedTaskId: string | undefined
export function setSelectedTaskId(id: string | undefined): void { selectedTaskId = id }

// One task surface, three tabs — the task list and the workspace are the same
// screen, so there is no second place a task can be inspected.
export let surfaceTab: 'conversation' | 'files' | 'route' = 'conversation'
export function setSurfaceTab(tab: 'conversation' | 'files' | 'route'): void { surfaceTab = tab }
