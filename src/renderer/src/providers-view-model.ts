// Provider quota/capacity/session helpers shared across views.
import type { AppSnapshot, ProxyTask, SessionInfo } from '../../shared/types'
import { activeSessions, sessionBlocked, sessionResetAt, sessionStatusNote, sessionWindowElapsedPercent, sessionWindowLabel, sessionWindowPercent } from '../../shared/sessions'
import { snapshot } from './state'
import { countdown } from './ui/format'

export type SnapshotProvider = AppSnapshot['providers'][number]

export function providerName(id?: string): string {
  return snapshot.providers.find((provider) => provider.id === id)?.name ?? 'Routing…'
}

export function activeCooldown(provider: SnapshotProvider): boolean {
  return Boolean(provider.runtime.cooldownUntil && Date.parse(provider.runtime.cooldownUntil) > Date.now())
}

export function trackedTokens(provider: SnapshotProvider): number {
  const usage = provider.runtime.usage
  const actual = usage.inputTokens + usage.outputTokens
  return actual || usage.estimatedInputTokens + usage.estimatedOutputTokens
}

export function providerSessions(provider: SnapshotProvider): SessionInfo[] {
  return activeSessions(provider.runtime)
}

export function trackedBudgetPercent(provider: SnapshotProvider): number | undefined {
  return provider.dailyTokenBudget ? Math.min(100, (trackedTokens(provider) / provider.dailyTokenBudget) * 100) : undefined
}

export function providerLimitReached(provider: SnapshotProvider): boolean {
  if (activeCooldown(provider) || (trackedBudgetPercent(provider) ?? 0) >= 100) return true
  return providerSessions(provider).some((session) => sessionBlocked(session))
}

// What the app actually knows about a provider's plan window, in the order the
// CLIs report it: a real percentage if given, otherwise the named window and how
// long it has left, otherwise nothing — never a percentage we made up.
export function providerQuota(provider: SnapshotProvider): { text: string; reset?: string; percent?: number; timePercent?: number } {
  const sessions = providerSessions(provider)
  // The headline number and the window it names have to be the same window.
  const worst = sessions.filter((session) => sessionWindowPercent(session) !== undefined)
    .sort((left, right) => sessionWindowPercent(right)! - sessionWindowPercent(left)!)[0]
  const worstPercent = worst ? sessionWindowPercent(worst)! : undefined
  const tracked = trackedBudgetPercent(provider)
  if (worstPercent !== undefined && (tracked === undefined || worstPercent >= tracked)) {
    return { text: `${Math.round(worstPercent)}% of ${sessionWindowLabel(worst)} window used`, reset: sessionResetAt(worst), percent: worstPercent }
  }
  if (tracked !== undefined) return { text: `${Math.round(tracked)}% of tracked daily budget used`, percent: tracked }
  const window = sessions.find((session) => sessionResetAt(session)) ?? sessions[0]
  if (!window) return { text: 'No plan limit reported' }
  const note = sessionStatusNote(window)
  return { text: `${sessionWindowLabel(window)} window${note ? ` · ${note}` : ''}`, reset: sessionResetAt(window), timePercent: sessionWindowElapsedPercent(window) }
}

export function providerCapacity(provider: SnapshotProvider): { label: string; tone: string } {
  if (!provider.enabled) return { label: 'Disabled', tone: 'muted' }
  if (activeCooldown(provider)) return { label: `Limit reached · ${countdown(provider.runtime.cooldownUntil)}`, tone: 'limited' }
  if (providerLimitReached(provider)) return { label: 'Usage limit reached', tone: 'limited' }
  if (!provider.runtime.available) return { label: 'Not installed', tone: 'offline' }
  if (provider.runtime.running) return { label: 'Working', tone: 'busy' }
  return { label: 'Available', tone: 'ready' }
}

export function providerSelectableForTask(provider: SnapshotProvider, task: ProxyTask): boolean {
  return provider.enabled && provider.runtime.available && !providerLimitReached(provider) && provider.capabilities.includes(task.type)
}
