import { describe, expect, it } from 'vitest'
import { rankProviders, type RoutableProvider } from '../src/main/router'
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

  it('skips a provider whose CLI reports a fully used plan window', () => {
    const limited = provider('limited', 'claude')
    limited.runtime.session = { utilizationPercent: 100, updatedAt: new Date().toISOString() }
    expect(rankProviders(task('balanced'), [limited])).toEqual([])
  })

  it('spreads otherwise similar subscription usage', () => {
    const ranked = rankProviders(task('balanced', 'general'), [provider('used', 'codex', 20), provider('fresh', 'codex', 0)])
    expect(ranked[0].id).toBe('fresh')
  })
})
