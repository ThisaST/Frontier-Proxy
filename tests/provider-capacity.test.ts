import { describe, expect, it } from 'vitest'
import type { ProviderConfig, ProviderRuntime } from '../src/shared/types'
import { activeCooldown, providerLimitReached, trackedBudgetPercent, trackedTokens, type CapacityProvider } from '../src/shared/provider-capacity'

const NOW = Date.parse('2026-10-01T12:00:00Z')

function capacity(config: Partial<ProviderConfig> = {}, runtime: Partial<ProviderRuntime> = {}): CapacityProvider {
  return {
    id: 'claude', name: 'Claude', kind: 'claude', enabled: true, executable: 'claude', priority: 50, maxConcurrent: 1, capabilities: ['coding'], ...config,
    runtime: { available: true, running: 0, usage: { date: '2026-10-01', tasks: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, elapsedMs: 0 }, ...runtime }
  }
}

describe('provider capacity', () => {
  it('a cooldown in the future limits the provider; one in the past does not', () => {
    const future = capacity({}, { cooldownUntil: '2026-10-01T12:05:00Z' })
    const past = capacity({}, { cooldownUntil: '2026-10-01T11:55:00Z' })
    expect(activeCooldown(future, NOW)).toBe(true)
    expect(providerLimitReached(future, NOW)).toBe(true)
    expect(activeCooldown(past, NOW)).toBe(false)
    expect(providerLimitReached(past, NOW)).toBe(false)
  })

  it('a tracked daily budget at 100% limits the provider, below it does not', () => {
    const usage = { date: '2026-10-01', tasks: 1, estimatedInputTokens: 0, estimatedOutputTokens: 0, inputTokens: 600, outputTokens: 400, costUsd: 0, elapsedMs: 0 }
    const full = capacity({ dailyTokenBudget: 1000 }, { usage })
    expect(trackedTokens(full)).toBe(1000)
    expect(trackedBudgetPercent(full)).toBe(100)
    expect(providerLimitReached(full, NOW)).toBe(true)
    expect(providerLimitReached(capacity({ dailyTokenBudget: 2000 }, { usage }), NOW)).toBe(false)
  })

  it('a blocked plan window limits the provider, an expired one does not', () => {
    const blocked = capacity({}, { sessions: [{ limitType: '5-hour', status: 'rejected', resetsAt: '2026-10-01T14:00:00Z', updatedAt: '2026-10-01T11:00:00Z' }] })
    const expired = capacity({}, { sessions: [{ limitType: '5-hour', status: 'rejected', resetsAt: '2026-10-01T11:00:00Z', updatedAt: '2026-10-01T11:00:00Z' }] })
    expect(providerLimitReached(blocked, NOW)).toBe(true)
    expect(providerLimitReached(expired, NOW)).toBe(false)
  })

  it('has nothing to report for an untouched provider', () => {
    const idle = capacity()
    expect(trackedBudgetPercent(idle)).toBeUndefined()
    expect(providerLimitReached(idle, NOW)).toBe(false)
  })
})
