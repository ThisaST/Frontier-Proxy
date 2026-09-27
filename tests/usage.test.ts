import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OrchestrationEngine } from '../src/main/engine'
import { JsonStore } from '../src/main/store'
import { freshDefaults } from '../src/shared/defaults'
import type { ProviderConfig, UsageDay } from '../src/shared/types'
import { noopHydrate } from './test-helpers'

function provider(id: string): ProviderConfig {
  return {
    id, name: id, kind: 'custom', enabled: false, executable: process.execPath, priority: 80, maxConcurrent: 1,
    capabilities: ['coding', 'debugging', 'review', 'planning', 'documentation', 'general']
  }
}

function day(date: string, tokens: number): UsageDay {
  return {
    date, tasks: 2, estimatedInputTokens: 0, estimatedOutputTokens: 0,
    inputTokens: tokens, outputTokens: tokens, costUsd: 0, elapsedMs: 1_000
  }
}

async function engineWith(runtime: Record<string, unknown>): Promise<OrchestrationEngine> {
  const directory = await mkdtemp(join(tmpdir(), 'frontier-usage-'))
  const store = new JsonStore(join(directory, 'state.json'))
  const settings = freshDefaults()
  settings.providers = [provider('agent')]
  await store.save({ settings, tasks: [], providerRuntime: { agent: runtime as never } })
  const engine = new OrchestrationEngine(store, undefined, undefined, undefined, undefined, noopHydrate)
  await engine.initialize()
  return engine
}

function runtimeOf(engine: OrchestrationEngine): NonNullable<ReturnType<OrchestrationEngine['providerRuntime']>> {
  return engine.snapshot().providers.find((item) => item.id === 'agent')!.runtime
}

describe('usage history', () => {
  // Before this, the previous day's totals were simply blanked at the local-date
  // rollover, so the Usage view could only ever show today.
  it('moves a finished day into history instead of discarding it', async () => {
    const engine = await engineWith({ usage: day('2020-01-01', 500) })
    const runtime = runtimeOf(engine)
    expect(runtime.usage.date).not.toBe('2020-01-01')
    expect(runtime.usage.inputTokens).toBe(0)
    expect(runtime.history?.map((entry) => entry.date)).toEqual(['2020-01-01'])
    expect(runtime.history?.[0].inputTokens).toBe(500)
  })

  it("keeps today's totals as today's, not as history", async () => {
    const today = new Date().toLocaleDateString('en-CA')
    const runtime = runtimeOf(await engineWith({ usage: day(today, 700) }))
    expect(runtime.usage.inputTokens).toBe(700)
    expect(runtime.history ?? []).toEqual([])
  })

  it('carries an existing history forward and keeps it bounded', async () => {
    const history = Array.from({ length: 40 }, (_, index) => day(`2020-02-${String(index + 1).padStart(2, '0')}`, index))
    const runtime = runtimeOf(await engineWith({ usage: day('2020-03-15', 10), history }))
    expect(runtime.history).toHaveLength(30)
    // The oldest entries are the ones dropped, and the rolled-over day is last.
    expect(runtime.history?.at(-1)?.date).toBe('2020-03-15')
  })

  it('never records an empty day', async () => {
    const runtime = runtimeOf(await engineWith({ usage: { ...day('2020-01-01', 0), tasks: 0 } }))
    expect(runtime.history ?? []).toEqual([])
  })

  it('restores outcome statistics across a restart', async () => {
    const outcomes = { coding: { runs: 4, completed: 4, merged: 3, discarded: 1, verified: 4, verifyFailed: 0 } }
    expect(runtimeOf(await engineWith({ usage: day(new Date().toLocaleDateString('en-CA'), 1), outcomes })).outcomes).toEqual(outcomes)
  })
})
