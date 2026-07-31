import { describe, expect, it } from 'vitest'
import { rankProviders, routeTask, type RoutableProvider } from '../src/main/router'
import type { ProviderKind, ProxyTask, TaskType } from '../src/shared/types'

function provider(id: string, kind: ProviderKind, tasks = 0, available = true): RoutableProvider {
  return {
    id, name: id, kind, enabled: true, executable: id, priority: 80, maxConcurrent: 1,
    capabilities: ['coding', 'debugging', 'review', 'planning', 'documentation', 'general'],
    runtime: {
      available, running: 0,
      usage: { date: '2026-07-20', tasks, estimatedInputTokens: 0, estimatedOutputTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, elapsedMs: 0 }
    }
  }
}

function task(mode: ProxyTask['mode'], type: TaskType = 'coding'): ProxyTask {
  return {
    id: 'task', prompt: 'Implement a feature', cwd: '/tmp', mode, type, status: 'queued',
    createdAt: new Date().toISOString(), output: '', attempts: [], estimatedInputTokens: 10, estimatedOutputTokens: 0
  }
}

describe('provider routing', () => {
  it('prefers an agentic local provider in saver mode', () => {
    const ranked = rankProviders(task('saver'), [provider('codex', 'codex'), provider('local', 'codex-oss')])
    expect(ranked[0].id).toBe('local')
  })

  it('prefers frontier providers in quality mode', () => {
    const ranked = rankProviders(task('quality'), [provider('local', 'codex-oss'), provider('codex', 'codex')])
    expect(ranked[0].id).toBe('codex')
  })

  it('honors an available provider override', () => {
    const value = task('quality')
    value.preferredProviderId = 'claude'
    const ranked = rankProviders(value, [provider('codex', 'codex'), provider('claude', 'claude')])
    expect(ranked[0].id).toBe('claude')
  })

  it('excludes offline, cooling, busy, and over-budget providers', () => {
    const offline = provider('offline', 'codex', 0, false)
    const cooling = provider('cooling', 'claude'); cooling.runtime.cooldownUntil = new Date(Date.now() + 60_000).toISOString()
    const busy = provider('busy', 'codex'); busy.runtime.running = 1
    const budget = provider('budget', 'codex'); budget.dailyTokenBudget = 5
    expect(rankProviders(task('balanced'), [offline, cooling, busy, budget])).toEqual([])
  })

  it('uses reported tokens when enforcing a tracked usage limit', () => {
    const limited = provider('limited', 'claude')
    limited.dailyTokenBudget = 1_000
    limited.runtime.usage.inputTokens = 995
    expect(rankProviders(task('balanced'), [limited])).toEqual([])
  })

  it('skips a provider when any active CLI plan window is fully used', () => {
    const limited = provider('limited', 'claude')
    limited.runtime.sessions = [
      { limitType: 'five hour', utilizationPercent: 45, updatedAt: new Date().toISOString() },
      { limitType: 'seven day', utilizationPercent: 100, resetsAt: new Date(Date.now() + 60_000).toISOString(), updatedAt: new Date().toISOString() }
    ]
    expect(rankProviders(task('balanced'), [limited])).toEqual([])
  })

  it('allows a provider again after its fully used window has reset', () => {
    const providerAfterReset = provider('available', 'claude')
    providerAfterReset.runtime.sessions = [{ utilizationPercent: 100, resetsAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date().toISOString() }]
    expect(rankProviders(task('balanced'), [providerAfterReset])).toHaveLength(1)
  })

  it('spreads otherwise similar subscription usage', () => {
    const ranked = rankProviders(task('balanced', 'general'), [provider('used', 'codex', 20), provider('fresh', 'codex', 0)])
    expect(ranked[0].id).toBe('fresh')
  })
})

describe('routing explanation', () => {
  it('breaks the winning score into factors that sum to it', () => {
    const chosen = task('quality', 'review')
    const { ranked, decision } = routeTask(chosen, [provider('claude', 'claude'), provider('codex', 'codex')])
    const winner = decision.candidates.find((candidate) => candidate.providerId === ranked[0].id)!
    expect(decision.chosenProviderId).toBe('claude')
    expect(winner.eligible).toBe(true)
    expect(winner.factors?.reduce((sum, factor) => sum + factor.points, 0)).toBeCloseTo(winner.score!)
    expect(winner.factors).toEqual(expect.arrayContaining([
      { label: 'Configured priority', points: 80 },
      { label: 'review affinity', points: 18 },
      { label: 'Quality first policy', points: 18 }
    ]))
  })

  it('credits an explicit override to the user', () => {
    const chosen = task('balanced')
    chosen.preferredProviderId = 'claude'
    const { decision } = routeTask(chosen, [provider('claude', 'claude'), provider('codex', 'codex')])
    const winner = decision.candidates.find((candidate) => candidate.providerId === 'claude')!
    expect(winner.factors).toContainEqual({ label: 'Chosen by you', points: 1_000 })
  })

  it('records a plain-language reason for every skipped provider', () => {
    const offline = provider('offline', 'codex', 0, false)
    const cooling = provider('cooling', 'claude'); cooling.runtime.cooldownUntil = new Date(Date.now() + 60_000).toISOString()
    const busy = provider('busy', 'copilot'); busy.runtime.running = 1
    const narrow = provider('narrow', 'ollama'); narrow.capabilities = ['documentation']
    const off = provider('off', 'codex'); off.enabled = false

    const { ranked, decision } = routeTask(task('balanced', 'coding'), [offline, cooling, busy, narrow, off])
    expect(ranked).toEqual([])
    const reasons = Object.fromEntries(decision.candidates.map((candidate) => [candidate.providerId, candidate.skippedReason]))
    expect(reasons.offline).toBe('CLI not detected on this machine')
    expect(reasons.cooling).toBe('Cooling down after a usage limit')
    expect(reasons.busy).toBe('Already running 1 of 1 allowed tasks')
    expect(reasons.narrow).toBe('Not enabled for coding work')
    expect(reasons.off).toBe('Turned off in Providers')
    expect(decision.candidates.every((candidate) => candidate.eligible === false)).toBe(true)
  })

  it('lists eligible providers ahead of skipped ones, best first', () => {
    const offline = provider('offline', 'codex', 0, false)
    const { decision } = routeTask(task('saver'), [offline, provider('cloud', 'claude'), provider('local', 'codex-oss')])
    expect(decision.candidates.map((candidate) => candidate.providerId)).toEqual(['local', 'cloud', 'offline'])
  })
})
