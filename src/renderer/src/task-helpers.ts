// Small task-domain helpers shared across the Tasks view, its composer, and the
// command palette. Everything above verificationChip is pure (no snapshot, no
// DOM beyond building a node) and unit-tested in tests/task-helpers.test.ts.
import type { AdvisorPreviewResult, ProviderConfig, ProxyTask, VerificationReport } from '../../shared/types'
import { tierFor } from '../../shared/model-profiles'
import { element } from './ui/dom'
import { status, type StatusTone } from './ui/components'
import { formatDuration } from './ui/format'
import { checkLine } from '../../shared/review-agents'
import { status } from './ui/components'

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

// --- The work queue's groups ---

export type TaskGroupId = 'running' | 'needs-review' | 'done' | 'failed'
export const TASK_GROUPS: ReadonlyArray<{ id: TaskGroupId; label: string }> = [
  { id: 'running', label: 'Running' },
  { id: 'needs-review', label: 'Needs review' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed' }
]

// "Needs review" is completed work that left something to look at: a
// committed isolated branch, or — when that is hard to tell for a plain
// single-agent run — any recorded file change.
export function taskNeedsReview(task: ProxyTask): boolean {
  if (task.status !== 'completed') return false
  if (task.subtasks?.some((lane) => lane.branch && lane.committed)) return true
  return Boolean(task.filesChanged?.length)
}

export function taskGroup(task: ProxyTask): TaskGroupId {
  if (task.status === 'running' || task.status === 'queued') return 'running'
  if (task.status === 'failed' || task.status === 'cancelled') return 'failed'
  return taskNeedsReview(task) ? 'needs-review' : 'done'
}

// `query` is matched case-insensitively against the prompt, type, policy, status and agent name;
// `agentName` resolves a provider id (the renderer passes providerName, tests a plain lookup).
export function taskMatchesQuery(task: ProxyTask, query: string, agentName: (id?: string) => string = (id) => id ?? ''): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return `${task.prompt} ${task.type} ${task.mode} ${task.status} ${agentName(task.selectedProviderId)}`.toLowerCase().includes(needle)
}

// Every group in display order, each holding the matching tasks in their original order. Empty
// groups are kept so callers can count; the queue skips them when rendering.
export function queueGroups(tasks: readonly ProxyTask[], query: string, agentName?: (id?: string) => string): Array<{ id: TaskGroupId; label: string; tasks: ProxyTask[] }> {
  const groups = TASK_GROUPS.map((group) => ({ ...group, tasks: [] as ProxyTask[] }))
  for (const task of tasks) if (taskMatchesQuery(task, query, agentName)) groups.find((group) => group.id === taskGroup(task))!.tasks.push(task)
  return groups
}

// --- Status: a dot and a word (spec §2.5) ---

export function taskStatusTone(taskStatus: ProxyTask['status'], needsReview = false): StatusTone {
  if (taskStatus === 'running') return 'running'
  if (taskStatus === 'completed') return needsReview ? 'warn' : 'ok'
  if (taskStatus === 'failed') return 'danger'
  return 'neutral' // queued, cancelled
}

export function taskStatusWord(taskStatus: ProxyTask['status'], needsReview = false): string {
  if (taskStatus === 'completed' && needsReview) return 'Needs review'
  return taskStatus.charAt(0).toUpperCase() + taskStatus.slice(1)
}

// The status shared by the work queue, lane cards, the conversation header and the command
// palette. `withText` false (the queue rows) draws the dot alone; its word is still the
// accessible name.
export function taskStatusIndicator(taskStatus: ProxyTask['status'], options: { needsReview?: boolean; withText?: boolean } = {}): HTMLElement {
  const word = taskStatusWord(taskStatus, options.needsReview)
  return status(taskStatusTone(taskStatus, options.needsReview), options.withText ? word : '', { ariaLabel: word, title: word })
}

// --- The composer's one-line route preview ---

export interface RoutePreviewOptions {
  runMode?: 'single' | 'orchestrate'
  // Jev is on but not asked while typing, so the real route is decided at start.
  advisorDecidesAtStart?: boolean
}

export interface RoutePreview { lead: string; agent: string; model: string; tier: string; notes: string[] }

// What the composer says about a route preview, as parts (the view bolds the agent) and as one
// sentence. `provider` is the chosen candidate's config, or undefined when nobody is eligible.
export function routePreview(result: AdvisorPreviewResult, provider: Pick<ProviderConfig, 'name' | 'kind' | 'model'> | undefined, options: RoutePreviewOptions = {}): RoutePreview | undefined {
  if (!provider) return undefined
  const model = result.model ?? provider.model ?? 'default model'
  const notes: string[] = []
  if (options.advisorDecidesAtStart) notes.push('Jev decides at start')
  if (result.heuristic.error) notes.push(result.heuristic.error)
  return { lead: options.runMode === 'orchestrate' ? 'Will plan on' : 'Will run on', agent: provider.name, model, tier: `${tierFor(result.model ?? provider.model, provider.kind)} tier`, notes }
}

export function routePreviewText(result: AdvisorPreviewResult, provider: Pick<ProviderConfig, 'name' | 'kind' | 'model'> | undefined, options: RoutePreviewOptions = {}): string {
  const preview = routePreview(result, provider, options)
  if (!preview) return 'No agent is currently eligible to run this.'
  const sentence = `${preview.lead} ${preview.agent} · ${preview.model} · ${preview.tier}`
  return preview.notes.length ? `${sentence} — ${preview.notes.join('. ')}` : sentence
}

// Compare mode is not routed: it runs exactly the agents that were ticked.
export function benchPreviewText(agentNames: readonly string[]): string {
  if (agentNames.length < 2) return 'Choose at least two agents to compare.'
  return `Will send the same prompt to ${agentNames.join(', ')}, each on its own branch, with no failover.`
}

// A verification report as a dot and a word (a branch row, a bench lane). The text comes from the
// pure `checkLine`; "no checks detected" is neutral, never a green tick.
export function verificationChip(verification?: VerificationReport): HTMLElement | undefined {
  if (!verification) return undefined
  const line = checkLine(verification)
  return status(line.tone, line.text)
}
