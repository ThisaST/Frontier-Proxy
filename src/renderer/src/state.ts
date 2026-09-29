// Shared mutable renderer state: the latest snapshot from the main process,
// current navigation, and the task-surface selection. Everything here is read
// across several view modules; state that only one view touches stays local
// to that view's own module instead of living here.
import type { AppSnapshot } from '../../shared/types'
import { nextTaskSurface, type TaskSurfaceEvent } from './nav'

export let snapshot: AppSnapshot
export function setSnapshot(next: AppSnapshot): void { snapshot = next }

export let currentView = 'tasks'
export function setCurrentView(view: string): void { currentView = view }

// The Tasks centre pane: the composer (`composing`) or one selected task, never both and never
// neither. Only `applyTaskSurface` changes them, through the pure rule in nav.ts.
export let composing = true
export let selectedTaskId: string | undefined
export function applyTaskSurface(event: TaskSurfaceEvent): void {
  const next = nextTaskSurface({ composing, selectedTaskId }, event)
  composing = next.composing
  selectedTaskId = next.selectedTaskId
}
