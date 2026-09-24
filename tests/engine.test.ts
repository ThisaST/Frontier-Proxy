import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeSessionWindows, OrchestrationEngine } from '../src/main/engine'
import { JsonStore } from '../src/main/store'
import { AdvisorKeyManager, JevClient } from '../src/main/advisor'
import { freshDefaults } from '../src/shared/defaults'
import type { AppSnapshot, ProviderConfig, ProxyTask } from '../src/shared/types'

// Poll the engine snapshot until the task reaches a terminal state.
async function waitForTask(engine: OrchestrationEngine, taskId: string, timeoutMs = 8_000): Promise<AppSnapshot['tasks'][number]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const task = engine.snapshot().tasks.find((item) => item.id === taskId)
    if (task && (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')) return task
    if (Date.now() > deadline) throw new Error(`Task ${taskId} did not settle; last status: ${task?.status}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('provider session windows', () => {
  it('retains different limits and updates only the matching window', () => {
    const initial = [
      { limitType: 'five hour', utilizationPercent: 20, updatedAt: '2026-07-27T00:00:00.000Z' },
      { limitType: 'seven day', utilizationPercent: 60, updatedAt: '2026-07-27T00:00:00.000Z' }
    ]
    const merged = mergeSessionWindows(initial, { limitType: 'five hour', utilizationPercent: 25, updatedAt: '2026-07-27T01:00:00.000Z' })
    expect(merged).toHaveLength(2)
    expect(merged.find((window) => window.limitType === 'five hour')?.utilizationPercent).toBe(25)
    expect(merged.find((window) => window.limitType === 'seven day')?.utilizationPercent).toBe(60)
  })

  it('forgets a window that has already reset instead of keeping it stale', () => {
    const now = Date.parse('2026-08-02T12:00:00.000Z')
    const initial = [{ limitType: '7-day', utilizationPercent: 60, resetsAt: '2026-08-01T09:10:00.000Z', updatedAt: '2026-08-01T07:31:00.000Z' }]
    const merged = mergeSessionWindows(initial, { limitType: '5-hour', resetsAt: '2026-08-02T14:00:00.000Z', updatedAt: '2026-08-02T11:59:00.000Z' }, now)
    expect(merged.map((window) => window.limitType)).toEqual(['5-hour'])
  })
})

function provider(id: string, priority: number, args: string[] = []): ProviderConfig {
  return {
    id, name: id === 'first' ? 'First Provider' : 'Second Provider', kind: 'custom', enabled: true,
    executable: process.execPath, args, priority, maxConcurrent: 1,
    capabilities: ['coding', 'debugging', 'review', 'planning', 'documentation', 'general']
  }
}

describe('conversation provider selection', () => {
  it('keeps an intentionally cancelled conversation on its current provider', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-engine-cancel-'))
    const store = new JsonStore(join(directory, 'state.json'))
    const settings = freshDefaults()
    settings.providers = [
      provider('first', 1, ['-e', 'process.stdin.pipe(process.stdout)']),
      provider('second', 100, ['-e', 'process.stdin.pipe(process.stdout)'])
    ]
    const task: ProxyTask = {
      id: 'cancelled-conversation', prompt: 'Initial question', cwd: directory, mode: 'balanced', type: 'general',
      status: 'cancelled', selectedProviderId: 'first', createdAt: new Date().toISOString(),
      output: 'Partial answer', attempts: [], estimatedInputTokens: 4, estimatedOutputTokens: 2,
      turns: [
        { id: 'user-1', role: 'user', content: 'Initial question', at: new Date().toISOString() },
        { id: 'assistant-1', role: 'assistant', content: 'Partial answer', providerId: 'first', status: 'cancelled', at: new Date().toISOString() }
      ]
    }
    await store.save({ settings, tasks: [task] })
    const engine = new OrchestrationEngine(store)
    await engine.initialize()

    const continued = await engine.continueTask(task.id, 'Continue here')
    expect(continued.status).toBe('completed')
    expect(continued.selectedProviderId).toBe('first')
    expect(continued.output).toContain('First Provider (cancelled): Partial answer')
  })

  it('switches only when requested and transfers the complete transcript', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-engine-'))
    const store = new JsonStore(join(directory, 'state.json'))
    const settings = freshDefaults()
    settings.providers = [
      provider('first', 100),
      provider('second', 10, ['-e', 'process.stdin.pipe(process.stdout)'])
    ]
    const task: ProxyTask = {
      id: 'conversation', prompt: 'Initial question', cwd: directory, mode: 'balanced', type: 'general',
      status: 'cancelled', selectedProviderId: 'first', createdAt: new Date().toISOString(),
      output: 'Earlier answer', attempts: [], estimatedInputTokens: 4, estimatedOutputTokens: 3,
      sessionId: 'first-session', sessionProviderId: 'first',
      turns: [
        { id: 'user-1', role: 'user', content: 'Initial question', at: new Date().toISOString() },
        { id: 'assistant-1', role: 'assistant', content: 'Earlier answer', providerId: 'first', model: 'model-one', status: 'cancelled', at: new Date().toISOString() }
      ]
    }
    await store.save({ settings, tasks: [task] })
    const engine = new OrchestrationEngine(store)
    await engine.initialize()

    const changed = await engine.changeTaskProvider(task.id, 'second')
    expect(changed.continuationProviderId).toBe('second')
    expect(changed.sessionId).toBeUndefined()
    expect(changed.selectedProviderId).toBe('first')

    const continued = await engine.continueTask(task.id, 'New question')
    expect(continued.status).toBe('completed')
    expect(continued.selectedProviderId).toBe('second')
    expect(continued.output).toContain('User: Initial question')
    expect(continued.output).toContain('First Provider (model-one, cancelled): Earlier answer')
    expect(continued.output).toContain('User: New question')
    expect(continued.output).toContain('Full conversation history transferred by Frontier')
  })

  it('persists @ references and includes their resolved workspace context', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-engine-context-'))
    await writeFile(join(directory, 'notes.md'), '# Notes', 'utf8')
    const store = new JsonStore(join(directory, 'state.json'))
    const settings = freshDefaults()
    settings.providers = [provider('first', 1, ['-e', 'process.stdin.pipe(process.stdout)'])]
    const task: ProxyTask = {
      id: 'referenced-conversation', prompt: 'Initial question', cwd: directory, mode: 'balanced', type: 'general',
      status: 'completed', selectedProviderId: 'first', createdAt: new Date().toISOString(), output: 'Done', attempts: [],
      estimatedInputTokens: 4, estimatedOutputTokens: 1,
      turns: [
        { id: 'user-1', role: 'user', content: 'Initial question', at: new Date().toISOString() },
        { id: 'assistant-1', role: 'assistant', content: 'Done', providerId: 'first', status: 'completed', at: new Date().toISOString() }
      ]
    }
    await store.save({ settings, tasks: [task] })
    const engine = new OrchestrationEngine(store)
    await engine.initialize()

    const continued = await engine.continueTask(task.id, 'Review @notes.md', [{ id: 'ref-1', kind: 'file', name: 'notes.md', path: 'notes.md' }])
    expect(continued.turns?.at(-2)?.attachments).toEqual([{ id: 'ref-1', kind: 'file', name: 'notes.md', path: 'notes.md' }])
    expect(continued.output).toContain('[Referenced workspace items]')
    expect(continued.output).toContain('file: @notes.md')
    expect(continued.output).toContain(join(directory, 'notes.md'))
  })
})

describe('skill selection', () => {
  it('carries the per-task skill selection through a retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-engine-retry-'))
    const store = new JsonStore(join(directory, 'state.json'))
    const settings = freshDefaults()
    settings.providers = [provider('first', 1, ['-e', 'process.stdout.write("ok")'])]
    await store.save({ settings, tasks: [] })
    const engine = new OrchestrationEngine(store)
    await engine.initialize()

    const created = await engine.createTask({ prompt: 'Do work', cwd: directory, mode: 'balanced', skillIds: ['skill-a', 'skill-b'] })
    expect(created.skillIds).toEqual(['skill-a', 'skill-b'])

    const retried = await engine.retryTask(created.id)
    expect(retried.skillIds).toEqual(['skill-a', 'skill-b'])
  })

  it('round-trips the global disabled-skill set through updateSettings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-engine-settings-'))
    const store = new JsonStore(join(directory, 'state.json'))
    await store.save({ settings: freshDefaults(), tasks: [] })
    const engine = new OrchestrationEngine(store)
    await engine.initialize()

    const snapshot = await engine.updateSettings({ skills: { disabledIds: ['skill-a', 'skill-a', 'skill-b'] } })
    expect(snapshot.settings.skills.disabledIds).toEqual(['skill-a', 'skill-b'])
  })
})

function trivialCipher() {
  return { encrypt: (value: string) => Buffer.from(value).toString('base64'), decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8') }
}

describe('Jev routing advisor', () => {
  it('never blocks the queue: a task still completes on the heuristic fallback when the advisor call hangs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-engine-advisor-'))
    const store = new JsonStore(join(directory, 'state.json'))
    const settings = freshDefaults()
    // JsonStore.load() always re-merges the built-in default providers by id
    // (see tests/e2e.test.ts's makeEngine), so any actually-installed CLI on
    // this machine (codex, claude, …) would otherwise outrank the fake one below.
    settings.providers = [
      ...freshDefaults().providers.map((item) => ({ ...item, enabled: false })),
      provider('first', 1, ['-e', 'process.stdout.write("ok")'])
    ]
    settings.advisor = { mode: 'active', model: 'jev-latest', minConfidence: 0.5, shareRepoFacts: false, previewWhileTyping: false }
    await store.save({ settings, tasks: [] })

    const advisorKeys = new AdvisorKeyManager(join(directory, 'advisor.json'), trivialCipher())
    await advisorKeys.initialize()
    await advisorKeys.setKey('sk-test-token')

    // A fetch that only ever settles when its AbortSignal fires — like a real
    // network call that hangs until something else cancels it. Only
    // JevClient's own per-attempt timeout can end this.
    const hangingFetch = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })) as unknown as typeof fetch
    const jevClient = new JevClient({ fetch: hangingFetch, timeoutMs: 30, retryDelayCapMs: 5 })

    const engine = new OrchestrationEngine(store, undefined, advisorKeys, jevClient)
    await engine.initialize()

    const created = await engine.createTask({ prompt: 'Implement a feature', cwd: directory, mode: 'balanced' })
    // Heuristic advice is set synchronously at creation, before Jev is ever asked.
    expect(created.advice?.source).toBe('heuristic')

    const finished = await waitForTask(engine, created.id)
    expect(finished.status).toBe('completed')
    // The advisor call timed out (bounded, never indefinite) and the task
    // routed and ran on the heuristic fallback regardless.
    expect(finished.advice?.source).toBe('heuristic')
    expect(finished.advice?.error).toContain('Jev did not respond in time.')
  })

  it('never asks Jev, and never blocks, when the advisor is off', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-engine-advisor-off-'))
    const store = new JsonStore(join(directory, 'state.json'))
    const settings = freshDefaults()
    settings.providers = [
      ...freshDefaults().providers.map((item) => ({ ...item, enabled: false })),
      provider('first', 1, ['-e', 'process.stdout.write("ok")'])
    ]
    await store.save({ settings, tasks: [] })

    const advisorKeys = new AdvisorKeyManager(join(directory, 'advisor.json'), trivialCipher())
    await advisorKeys.initialize()
    await advisorKeys.setKey('sk-test-token')

    let called = false
    const fetchSpy = (async () => { called = true; throw new Error('should never be called') }) as unknown as typeof fetch
    const engine = new OrchestrationEngine(store, undefined, advisorKeys, new JevClient({ fetch: fetchSpy }))
    await engine.initialize()

    const created = await engine.createTask({ prompt: 'Implement a feature', cwd: directory, mode: 'balanced' })
    const finished = await waitForTask(engine, created.id)
    expect(finished.status).toBe('completed')
    expect(finished.advice?.source).toBe('heuristic')
    expect(finished.advice?.error).toBeUndefined()
    expect(called).toBe(false)
  })
})
