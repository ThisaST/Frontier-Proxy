// Is a provider out of capacity right now? Pure and DOM-free so the renderer and the Office scene agree.
import type { ProviderConfig, ProviderRuntime } from './types'
import { activeSessions, sessionBlocked } from './sessions'

export type CapacityProvider = ProviderConfig & { runtime: ProviderRuntime }

export function activeCooldown(provider: CapacityProvider, now = Date.now()): boolean {
  return Boolean(provider.runtime.cooldownUntil && Date.parse(provider.runtime.cooldownUntil) > now)
}

export function trackedTokens(provider: CapacityProvider): number {
  const usage = provider.runtime.usage
  const actual = usage.inputTokens + usage.outputTokens
  return actual || usage.estimatedInputTokens + usage.estimatedOutputTokens
}

export function trackedBudgetPercent(provider: CapacityProvider): number | undefined {
  return provider.dailyTokenBudget ? Math.min(100, (trackedTokens(provider) / provider.dailyTokenBudget) * 100) : undefined
}

export function providerLimitReached(provider: CapacityProvider, now = Date.now()): boolean {
  if (activeCooldown(provider, now) || (trackedBudgetPercent(provider) ?? 0) >= 100) return true
  return activeSessions(provider.runtime, now).some((session) => sessionBlocked(session, now))
}
