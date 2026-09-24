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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function fakeJevResponse(answers: Record<string, unknown>): Response {
  return {
    ok: true, status: 200, headers: new Headers(),
    text: async () => '',
    json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 0 }, answers })
  } as unknown as Response
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

  it('bounds pending time by its own overall deadline, and ignores a Jev answer that arrives after it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-engine-advisor-deadline-'))
    const store = new JsonStore(join(directory, 'state.json'))
    const settings = freshDefaults()
    settings.providers = [
      ...freshDefaults().providers.map((item) => ({ ...item, enabled: false })),
      provider('first', 1, ['-e', 'process.stdout.write("ok")'])
    ]
    settings.advisor = { mode: 'active', model: 'jev-latest', minConfidence: 0.5, shareRepoFacts: false, previewWhileTyping: false }
    await store.save({ settings, tasks: [] })

    const advisorKeys = new AdvisorKeyManager(join(directory, 'advisor.json'), trivialCipher())
    await advisorKeys.initialize()
    await advisorKeys.setKey('sk-test-token')

    // The fetch itself never settles until the test resolves it — a generous
    // per-attempt client timeout proves it is the engine's own overall
    // deadline (well below it), not JevClient's, that ends the wait.
    const gate = deferred<Response>()
    const fetchMock = (async () => gate.promise) as unknown as typeof fetch
    const jevClient = new JevClient({ fetch: fetchMock, timeoutMs: 60_000 })
    const engine = new OrchestrationEngine(store, undefined, advisorKeys, jevClient, 40)
    await engine.initialize()

    const created = await engine.createTask({ prompt: 'Implement a feature', cwd: directory, mode: 'balanced' })
    expect(created.type).toBe('coding')

    const finished = await waitForTask(engine, created.id, 3_000)
    expect(finished.status).toBe('completed')
    expect(finished.advice?.source).toBe('heuristic')
    expect(finished.advice?.error).toBe('Jev did not answer in time')
    expect(finished.type).toBe('coding')

    // The real answer finally lands, long after the deadline already applied
    // the heuristic and let the task run to completion. It must be ignored —
    // never overwriting the advice or the type of a task that already moved on.
    gate.resolve(fakeJevResponse({
      task_type: { type: 'choice', choice: 'review', probabilities: { review: 0.95 }, confidence: 0.95 },
      complexity: { type: 'score', score: 1, probabilities: {}, confidence: 0.9 },
      edits_files: { type: 'noul', noul: 0.5 },
      long_context: { type: 'noul', noul: 0.5 },
      split_worthy: { type: 'noul', noul: 0.1 }
    }))
    await new Promise((resolve) => setTimeout(resolve, 150))
    const after = engine.snapshot().tasks.find((item) => item.id === created.id)
    expect(after?.advice?.source).toBe('heuristic')
    expect(after?.type).toBe('coding')
  })

  it('does not push orchestration subtasks or synthesis onto a frontier model just because the parent task rated architectural', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-engine-advisor-orchestrate-'))
    const store = new JsonStore(join(directory, 'state.json'))
    // Echoes the resolved {model} argument back as its entire output, so a
    // wrongly-applied advisor pick would visibly diverge from the configured
    // default rather than being invisible in a passthrough "ok".
    const echoModelScript = 'process.stdout.write(process.argv[1] || "")'
    const settings = freshDefaults()
    settings.providers = [
      ...freshDefaults().providers.map((item) => ({ ...item, enabled: false })),
      {
        id: 'first', name: 'First Provider', kind: 'custom' as const, enabled: true, executable: process.execPath,
        args: ['-e', echoModelScript, '{model}'], model: 'claude-haiku-4-5', priority: 1, maxConcurrent: 1,
        capabilities: ['coding', 'debugging', 'review', 'planning', 'documentation', 'general'] as ProxyTask['type'][]
      }
    ]
    settings.advisor = { mode: 'active', model: 'jev-latest', minConfidence: 0.5, shareRepoFacts: false, previewWhileTyping: false }
    await store.save({ settings, tasks: [] })

    const advisorKeys = new AdvisorKeyManager(join(directory, 'advisor.json'), trivialCipher())
    await advisorKeys.initialize()
    await advisorKeys.setKey('sk-test-token')

    // A confident, architectural-complexity answer — exactly the case that
    // would push every subtask onto a frontier model if advice leaked into
    // subtask/synthesis routing.
    const fetchMock = (async () => fakeJevResponse({
      task_type: { type: 'choice', choice: 'coding', probabilities: { coding: 0.95 }, confidence: 0.95 },
      complexity: { type: 'score', score: 2.9, probabilities: {}, confidence: 0.95 },
      edits_files: { type: 'noul', noul: 0.9 },
      long_context: { type: 'noul', noul: 0.8 },
      split_worthy: { type: 'noul', noul: 0.1 }
    })) as unknown as typeof fetch
    const engine = new OrchestrationEngine(store, undefined, advisorKeys, new JevClient({ fetch: fetchMock }))
    await engine.initialize()
    // Give the fake provider a second, larger model via the live runtime
    // reference (real discovery for a 'custom' kind only ever finds its own
    // configured default), so pickModel has an actual choice to get wrong.
    const runtime = engine.providerRuntime('first')
    if (runtime) runtime.models = ['claude-haiku-4-5', 'claude-opus-5']

    const created = await engine.createTask({ prompt: 'Build a small feature', cwd: directory, mode: 'balanced', orchestrate: true })
    const finished = await waitForTask(engine, created.id)

    expect(finished.status).toBe('completed')
    expect(finished.advice?.source).toBe('jev')
    expect(finished.advice?.complexity).toBe(2.9)
    // The planner stage (the parent route) DID use the advice and picked the
    // frontier-tier model for its own run.
    expect(finished.routedModel).toEqual({ providerId: 'first', model: 'claude-opus-5', reason: expect.any(String) })
    // Every subtask, and the synthesis step, ran on the provider's own
    // default model — not the advice-suggested frontier one.
    expect(finished.subtasks?.every((subtask) => subtask.output.trim() === 'claude-haiku-4-5')).toBe(true)
    expect(finished.output.trim()).toBe('claude-haiku-4-5')
  })
})

// The prompt sent over stdin distinguishes the planner call (buildPlannerPrompt's
// fixed wording) from every other stage on the same fake CLI, so one script can
// stand in for the planner, every subtask, and the synthesizer.
const PLANNER_MARKER = 'independent subtasks'
function planningOrEchoScript(plan: Array<{ title: string; prompt: string; type: string }>): string {
  return [
    'const chunks = []',
    'process.stdin.on("data", (d) => chunks.push(d))',
    'process.stdin.on("end", () => {',
    '  const input = Buffer.concat(chunks).toString("utf8")',
    `  if (input.includes(${JSON.stringify(PLANNER_MARKER)})) process.stdout.write(${JSON.stringify(JSON.stringify(plan))})`,
    '  else process.stdout.write(process.argv[1] || "")',
    '})'
  ].join('\n')
}

describe('per-subtask Jev advice', () => {
  const plan = [
    { title: 'Small tweak', prompt: 'Fix the typo', type: 'coding' },
    { title: 'Big rewrite', prompt: 'Rearchitect the module', type: 'coding' }
  ]

  async function subtaskEngine(advisorMode: 'active' | 'shadow' | 'off', fetchMock: typeof fetch, advisorDeadlineMs = 3_000): Promise<{ engine: OrchestrationEngine; directory: string }> {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-engine-subtask-advice-'))
    const store = new JsonStore(join(directory, 'state.json'))
    const settings = freshDefaults()
    settings.providers = [
      ...freshDefaults().providers.map((item) => ({ ...item, enabled: false })),
      {
        id: 'first', name: 'First Provider', kind: 'custom' as const, enabled: true, executable: process.execPath,
        args: ['-e', planningOrEchoScript(plan), '{model}'], model: 'claude-sonnet-5', priority: 1, maxConcurrent: 1,
        capabilities: ['coding', 'debugging', 'review', 'planning', 'documentation', 'general'] as ProxyTask['type'][]
      }
    ]
    settings.advisor = { mode: advisorMode, model: 'jev-latest', minConfidence: 0.5, shareRepoFacts: false, previewWhileTyping: false }
    await store.save({ settings, tasks: [] })

    const advisorKeys = new AdvisorKeyManager(join(directory, 'advisor.json'), trivialCipher())
    await advisorKeys.initialize()
    await advisorKeys.setKey('sk-test-token')

    const engine = new OrchestrationEngine(store, undefined, advisorKeys, new JevClient({ fetch: fetchMock }), advisorDeadlineMs)
    await engine.initialize()
    const runtime = engine.providerRuntime('first')
    if (runtime) runtime.models = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5']
    return { engine, directory }
  }

  // First call answers the parent's own 5-question advice; every call after
  // that answers the per-subtask questions.
  function twoStageFetch(): typeof fetch {
    let calls = 0
    return (async () => {
      calls += 1
      if (calls === 1) {
        return fakeJevResponse({
          task_type: { type: 'choice', choice: 'coding', probabilities: { coding: 0.95 }, confidence: 0.95 },
          complexity: { type: 'score', score: 1.5, probabilities: {}, confidence: 0.9 },
          edits_files: { type: 'noul', noul: 0.9 },
          long_context: { type: 'noul', noul: 0.5 },
          split_worthy: { type: 'noul', noul: 0.9 }
        })
      }
      return fakeJevResponse({
        complexity_1: { type: 'score', score: 0.2, probabilities: {}, confidence: 0.9 },
        target_1: { type: 'choice', choice: 'first::claude-haiku-4-5', probabilities: { 'first::claude-haiku-4-5': 0.9 }, confidence: 0.9 },
        complexity_2: { type: 'score', score: 2.9, probabilities: {}, confidence: 0.9 },
        target_2: { type: 'choice', choice: 'first::claude-opus-5', probabilities: { 'first::claude-opus-5': 0.9 }, confidence: 0.9 }
      })
    }) as unknown as typeof fetch
  }

  it('runs subtasks of different complexity on different-tier models of the same provider', async () => {
    const { engine, directory } = await subtaskEngine('active', twoStageFetch())
    const created = await engine.createTask({ prompt: 'Build a small feature', cwd: directory, mode: 'balanced', orchestrate: true })
    const finished = await waitForTask(engine, created.id)

    expect(finished.status).toBe('completed')
    const small = finished.subtasks?.find((subtask) => subtask.title === 'Small tweak')
    const big = finished.subtasks?.find((subtask) => subtask.title === 'Big rewrite')
    expect(small?.advice).toMatchObject({ source: 'jev', complexity: 0.2 })
    expect(big?.advice).toMatchObject({ source: 'jev', complexity: 2.9 })
    // Neither pick matches the provider's own configured default
    // ('claude-sonnet-5'), so this can only be the per-subtask advice at work.
    expect(small?.output.trim()).toBe('claude-haiku-4-5')
    expect(big?.output.trim()).toBe('claude-opus-5')
    // Synthesis stays advice-free — it ran on the provider's own default.
    expect(finished.output.trim()).toBe('claude-sonnet-5')
  })

  it('leaves subtasks on provider defaults when the subtask-advice call does not answer within the deadline', async () => {
    const gate = new Promise<Response>(() => { /* never settles */ })
    const hangingFetch = (async () => gate) as unknown as typeof fetch
    const { engine, directory } = await subtaskEngine('active', hangingFetch, 40)
    const created = await engine.createTask({ prompt: 'Build a small feature', cwd: directory, mode: 'balanced', orchestrate: true })
    const started = Date.now()
    const finished = await waitForTask(engine, created.id, 5_000)
    // The planner's own advisor call already used a real (settled) fetch by
    // the time this task is queued in these tests; only requestSubtaskAdvice
    // is left hanging, and it must still resolve within its own deadline.
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(finished.status).toBe('completed')
    expect(finished.subtasks?.every((subtask) => !subtask.advice)).toBe(true)
    expect(finished.subtasks?.every((subtask) => subtask.output.trim() === 'claude-sonnet-5')).toBe(true)
  })

  it('shadow mode leaves every subtask on provider defaults, recording only what it would have picked', async () => {
    const { engine, directory } = await subtaskEngine('shadow', twoStageFetch())
    const created = await engine.createTask({ prompt: 'Build a small feature', cwd: directory, mode: 'balanced', orchestrate: true })
    const finished = await waitForTask(engine, created.id)

    expect(finished.status).toBe('completed')
    expect(finished.subtasks?.every((subtask) => !subtask.advice)).toBe(true)
    expect(finished.subtasks?.every((subtask) => subtask.output.trim() === 'claude-sonnet-5')).toBe(true)
    // Still recorded what it WOULD have picked, without changing anything.
    const small = finished.subtasks?.find((subtask) => subtask.title === 'Small tweak')
    expect(small?.routing?.advisor?.mode).toBe('shadow')
  })

  it('off mode never makes the extra per-subtask call and changes nothing', async () => {
    let called = false
    const fetchSpy = (async () => { called = true; throw new Error('should never be called') }) as unknown as typeof fetch
    const { engine, directory } = await subtaskEngine('off', fetchSpy)
    const created = await engine.createTask({ prompt: 'Build a small feature', cwd: directory, mode: 'balanced', orchestrate: true })
    const finished = await waitForTask(engine, created.id)

    expect(finished.status).toBe('completed')
    expect(finished.subtasks?.every((subtask) => !subtask.advice && !subtask.routing)).toBe(true)
    expect(finished.subtasks?.every((subtask) => subtask.output.trim() === 'claude-sonnet-5')).toBe(true)
    expect(called).toBe(false)
  })
})

describe('previewAdvisor policy', () => {
  it('threads the preview policy into the pseudo task, flipping local vs hosted ranking between saver and quality', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-engine-preview-policy-'))
    const store = new JsonStore(join(directory, 'state.json'))
    const settings = freshDefaults()
    const capabilities: ProxyTask['type'][] = ['coding', 'debugging', 'review', 'planning', 'documentation', 'general']
    settings.providers = [
      ...freshDefaults().providers.map((item) => ({ ...item, enabled: false })),
      { id: 'local', name: 'Local Model', kind: 'ollama' as const, enabled: true, executable: process.execPath, model: 'llama3', priority: 0, maxConcurrent: 1, capabilities },
      { id: 'hosted', name: 'Hosted Agent', kind: 'claude' as const, enabled: true, executable: process.execPath, model: 'claude-opus-5', priority: 0, maxConcurrent: 1, capabilities }
    ]
    await store.save({ settings, tasks: [] })
    const engine = new OrchestrationEngine(store)
    await engine.initialize()
    // The real `checkProvider` probe (`<exe> list`/`--version`) has nothing to
    // do with the policy this test is about; force both candidates available
    // through the live runtime reference `previewAdvisor` itself reads.
    for (const id of ['local', 'hosted']) {
      const runtime = engine.providerRuntime(id)
      if (runtime) runtime.available = true
    }

    const saver = await engine.previewAdvisor({ prompt: 'Fix a small typo in the README', cwd: directory, policy: 'saver' })
    expect(saver.decision.mode).toBe('saver')
    expect(saver.decision.chosenProviderId).toBe('local')

    const quality = await engine.previewAdvisor({ prompt: 'Fix a small typo in the README', cwd: directory, policy: 'quality' })
    expect(quality.decision.mode).toBe('quality')
    expect(quality.decision.chosenProviderId).toBe('hosted')

    // Omitting the policy still defaults to 'balanced', matching the New Task
    // dialog's own default, rather than inheriting whatever was last passed.
    const balanced = await engine.previewAdvisor({ prompt: 'Fix a small typo in the README', cwd: directory })
    expect(balanced.decision.mode).toBe('balanced')
  })
})
