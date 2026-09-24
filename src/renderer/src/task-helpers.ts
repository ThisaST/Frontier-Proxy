// Small task-domain helpers shared across the tasks, home, and command-palette
// views.
import type { ProxyTask, VerificationReport } from '../../shared/types'
import { element } from './ui/dom'
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

// A verification report in one chip. "not run" is deliberately distinct from
// "passed": a repo with no detected checks has proved nothing about the branch.
export function verificationChip(verification?: VerificationReport): HTMLElement | undefined {
  if (!verification) return undefined
  if (!verification.ran) return element('span', 'check-chip none', 'no checks detected')
  const failed = verification.checks.filter((check) => !check.ok)
  return element('span', `check-chip ${failed.length ? 'fail' : 'pass'}`,
    failed.length ? `checks failed: ${failed.map((check) => check.name).join(', ')}` : `checks passed: ${verification.checks.map((check) => check.name).join(', ')}`)
}
