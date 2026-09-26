// Small task-domain helpers shared across the tasks, home, and command-palette
// views.
import type { ProxyTask, VerificationReport } from '../../shared/types'
import { element } from './ui/dom'
import { lamp, radar } from './ui/components'
import { formatDuration } from './ui/format'

export function taskIsBusy(task: ProxyTask): boolean {
  return task.status === 'running' || task.status === 'queued'
}

export function taskElapsed(task: ProxyTask): string {
  if (!task.startedAt) return '—'
  const end = task.finishedAt ? Date.parse(task.finishedAt) : Date.now()
  return formatDuration(Math.max(0, end - Date.parse(task.startedAt)))
}

// Prefer the CLI's real reported tokens; fall back to character-count estimates
// (labelled as such) when the provider reports none.
export function taskTokens(task: ProxyTask): { input: number; output: number; estimated: boolean } {
  if (task.usageInputTokens !== undefined || task.usageOutputTokens !== undefined) {
    return { input: task.usageInputTokens ?? 0, output: task.usageOutputTokens ?? 0, estimated: false }
  }
  return { input: task.estimatedInputTokens, output: task.estimatedOutputTokens, estimated: true }
}

export function taskKindLabel(task: ProxyTask): string {
  return task.bench ? 'Comparison' : task.orchestrated ? 'Split & delegate' : 'Single agent'
}

// The status indicator shared by the work queue, Home's active list, and the
// command palette: a radar sweep while queued for routing (the moment the
// spec singles out for the radar motif), a blinking amber lamp while running,
// and a plain lamp once the task has a final state.
export function taskStatusIndicator(status: ProxyTask['status']): HTMLElement {
  if (status === 'queued') return radar(16, 'Queued for routing')
  if (status === 'running') return lamp('amber', 'Running')
  if (status === 'completed') return lamp('phosphor', 'Completed')
  if (status === 'failed') return lamp('alarm', 'Failed')
  return lamp('muted', 'Cancelled')
}

// A verification report in one chip. "not run" is deliberately distinct from
// "passed": a repo with no detected checks has proved nothing about the branch.
export function verificationChip(verification?: VerificationReport): HTMLElement | undefined {
  if (!verification) return undefined
  if (!verification.ran) return element('span', 'check-chip none', 'no checks detected')
  const failed = verification.checks.filter((check) => !check.ok)
  return element('span', `check-chip ${failed.length ? 'fail' : 'pass'}`,
    failed.length ? `checks failed: ${failed.map((check) => check.name).join(', ')}` : `checks passed: ${verification.checks.map((check) => check.name).join(', ')}`)
}
