import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OrchestrationEngine } from '../src/main/engine'
import { JsonStore } from '../src/main/store'
import { freshDefaults } from '../src/shared/defaults'
import type { AppSnapshot, ProviderConfig } from '../src/shared/types'

// End-to-end lifecycle tests: drive the real OrchestrationEngine through
// createTask -> pump -> execute -> completion using fake CLIs (node scripts run
// via process.execPath), so routing, spawning, stdin prompting, stdout
// streaming, failover, and usage accounting are all exercised together without
// needing a real Codex/Claude/Copilot install.

// A custom provider whose "CLI" is a node one-liner. Custom-kind providers get
// raw stdout passthrough and no control-plane injection, so the script's stdout
// is the task output verbatim.
function fakeProvider(id: string, priority: number, script: string): ProviderConfig {
  return {
    id, name: `Provider ${id}`, kind: 'custom', enabled: true,
    executable: process.execPath, args: ['-e', script], priority, maxConcurrent: 1,
    capabilities: ['coding', 'debugging', 'review', 'planning', 'documentation', 'general']
  }
}

// A script that echoes a fixed answer and exits 0 (a successful agent run).
const succeedWith = (answer: string): string => `process.stdout.write(${JSON.stringify(answer)})`
// A script that fails with a message on stderr and a non-zero exit code.
const failWith = (message: string): string => `process.stderr.write(${JSON.stringify(message)});process.exit(1)`

async function makeEngine(providers: ProviderConfig[]): Promise<{ engine: OrchestrationEngine; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'frontier-e2e-'))
  const store = new JsonStore(join(cwd, 'state.json'))
  const settings = freshDefaults()
  // JsonStore.load() always re-merges the built-in default providers by id, so
  // the set can never be fully replaced — only overridden. Disable every default
  // (via an id-matched override) so only the fake providers under test are
  // eligible for routing.
  settings.providers = [
    ...freshDefaults().providers.map((provider) => ({ ...provider, enabled: false })),
    ...providers
  ]
  await store.save({ settings, tasks: [] })
  const engine = new OrchestrationEngine(store)
  await engine.initialize()
  return { engine, cwd }
}

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

describe('end-to-end task lifecycle', () => {
  it('routes a task to the top provider, streams its output, and completes', async () => {
    const { engine, cwd } = await makeEngine([
      fakeProvider('primary', 100, succeedWith('pong')),
      fakeProvider('backup', 10, succeedWith('should-not-run'))
    ])
    const created = await engine.createTask({ prompt: 'Reply with pong', cwd, mode: 'balanced' })
    const task = await waitForTask(engine, created.id)

    expect(task.status).toBe('completed')
    expect(task.selectedProviderId).toBe('primary')
    expect(task.output).toBe('pong')
    // The completed run is recorded as an assistant turn on the conversation.
    expect(task.turns?.at(-1)).toMatchObject({ role: 'assistant', content: 'pong', status: 'completed' })

    const primary = engine.snapshot().providers.find((item) => item.id === 'primary')
    expect(primary?.runtime.usage.tasks).toBe(1)
  })

  it('honors an explicit provider override even when it is lower priority', async () => {
    const { engine, cwd } = await makeEngine([
      fakeProvider('fast', 100, succeedWith('from-fast')),
      fakeProvider('chosen', 1, succeedWith('from-chosen'))
    ])
    const created = await engine.createTask({ prompt: 'do the thing', cwd, mode: 'balanced', preferredProviderId: 'chosen' })
    const task = await waitForTask(engine, created.id)

    expect(task.status).toBe('completed')
    expect(task.selectedProviderId).toBe('chosen')
    expect(task.output).toBe('from-chosen')
  })

  it('fails over to the next provider on a quota error and cools the first down', async () => {
    const { engine, cwd } = await makeEngine([
      fakeProvider('exhausted', 100, failWith('Error: usage limit reached for this account')),
      fakeProvider('healthy', 10, succeedWith('recovered'))
    ])
    const created = await engine.createTask({ prompt: 'anything', cwd, mode: 'balanced' })
    const task = await waitForTask(engine, created.id)

    expect(task.status).toBe('completed')
    expect(task.selectedProviderId).toBe('healthy')
    expect(task.output).toContain('recovered')

    const exhausted = engine.snapshot().providers.find((item) => item.id === 'exhausted')
    expect(exhausted?.runtime.cooldownUntil).toBeTruthy()
  })

  it('leaves a per-task model behind when failover moves to an agent that cannot run it', async () => {
    // The failover target echoes whatever model it was actually launched with.
    const echoModel = fakeProvider('healthy', 10, succeedWith('ran'))
    echoModel.args = ['-e', 'process.stdout.write("model=[" + process.argv[1] + "]")', '{model}']
    echoModel.model = 'its-own-model'
    const { engine, cwd } = await makeEngine([
      fakeProvider('exhausted', 100, failWith('Error: usage limit reached for this account')),
      echoModel
    ])
    const created = await engine.createTask({ prompt: 'anything', cwd, mode: 'balanced', model: 'claude-opus-5', modelProviderId: 'exhausted' })
    const task = await waitForTask(engine, created.id)

    expect(task.status).toBe('completed')
    expect(task.selectedProviderId).toBe('healthy')
    expect(task.output).toContain('model=[its-own-model]')
    expect(task.output).not.toContain('model=[claude-opus-5]')
    expect(task.output).toContain('cannot run claude-opus-5')
  })

  it('fails over when a CLI is logged out, and cools the logged-out provider down', async () => {
    // Observed live: a logged-out Claude CLI exits 1 with "Not logged in · Please
    // run /login". That is a fixable auth problem, not a broken task, so Frontier
    // now treats it as unavailable — cools the provider down and fails over.
    const { engine, cwd } = await makeEngine([
      fakeProvider('loggedout', 100, failWith('Not logged in · Please run /login')),
      fakeProvider('healthy', 10, succeedWith('recovered'))
    ])
    const created = await engine.createTask({ prompt: 'anything', cwd, mode: 'balanced' })
    const task = await waitForTask(engine, created.id)

    expect(task.status).toBe('completed')
    expect(task.selectedProviderId).toBe('healthy')
    expect(task.output).toContain('recovered')
    const loggedOut = engine.snapshot().providers.find((item) => item.id === 'loggedout')
    expect(loggedOut?.runtime.available).toBe(false)
  })

  it('does NOT fail over on a genuine agent failure (rerunning partial edits is unsafe)', async () => {
    // A normal non-zero exit that is neither a quota, auth, nor spawn problem is
    // a real agent failure; the task stops rather than re-running elsewhere.
    const { engine, cwd } = await makeEngine([
      fakeProvider('broken', 100, failWith('TypeError: cannot read properties of undefined')),
      fakeProvider('healthy', 10, succeedWith('would-have-worked'))
    ])
    const created = await engine.createTask({ prompt: 'anything', cwd, mode: 'balanced' })
    const task = await waitForTask(engine, created.id)

    expect(task.status).toBe('failed')
    expect(task.selectedProviderId).toBe('broken')
    const healthy = engine.snapshot().providers.find((item) => item.id === 'healthy')
    expect(healthy?.runtime.usage.tasks).toBe(0)
  })

  // Observed live with only one CLI installed (the shipped default: every
  // provider maxConcurrent 1, maxParallelTasks 2). The first lane marked the
  // provider busy before the second lane ranked, so the second subtask found no
  // free provider and was abandoned — failing the whole orchestrated task.
  it('waits for a provider slot instead of abandoning a subtask when the only CLI is busy', async () => {
    const script = [
      "let input='';process.stdin.on('data',(c)=>input+=c);process.stdin.on('end',()=>{",
      "if(input.includes('planning coordinator'))process.stdout.write('[{\"title\":\"A\",\"prompt\":\"do a\",\"type\":\"coding\"},{\"title\":\"B\",\"prompt\":\"do b\",\"type\":\"coding\"}]');",
      "else process.stdout.write('ok');})"
    ].join('')
    const { engine, cwd } = await makeEngine([{ ...fakeProvider('solo', 100, script), maxConcurrent: 1 }])

    const created = await engine.createTask({ prompt: 'split this work', cwd, mode: 'balanced', orchestrate: true })
    const task = await waitForTask(engine, created.id, 20_000)

    expect(task.subtasks?.map((subtask) => subtask.status)).toEqual(['completed', 'completed'])
    expect(task.subtasks?.some((subtask) => subtask.error)).toBe(false)
    expect(task.status).toBe('completed')
  })

  // Head-to-head runs the same prompt on every chosen agent instead of routing
  // it, so a lane that fails is a result about that agent — never a reroute.
  it('runs a bench on the chosen agents in parallel and keeps each result separate', async () => {
    const { engine, cwd } = await makeEngine([
      fakeProvider('alpha', 100, succeedWith('alpha answer')),
      fakeProvider('beta', 90, succeedWith('beta answer')),
      fakeProvider('gamma', 80, failWith('gamma exploded')),
      fakeProvider('unused', 70, succeedWith('never runs'))
    ])
    const created = await engine.createTask({
      prompt: 'compare these agents', cwd, mode: 'balanced', benchProviderIds: ['alpha', 'beta', 'gamma']
    })
    const task = await waitForTask(engine, created.id, 20_000)

    expect(task.bench).toBe(true)
    expect(task.orchestrated).toBeUndefined()
    const lanes = Object.fromEntries((task.subtasks ?? []).map((lane) => [lane.providerId, lane]))
    expect(Object.keys(lanes).sort()).toEqual(['alpha', 'beta', 'gamma'])
    expect(lanes.alpha.output).toBe('alpha answer')
    expect(lanes.beta.output).toBe('beta answer')
    // The failing agent stays failed rather than being replaced by a healthy one.
    expect(lanes.gamma.status).toBe('failed')
    expect(lanes.gamma.error).toContain('gamma exploded')
    expect(task.status).toBe('completed')
    expect(task.output).toContain('Head-to-head results')

    const unused = engine.snapshot().providers.find((provider) => provider.id === 'unused')
    expect(unused?.runtime.usage.tasks).toBe(0)
  })

  it('requires at least two agents for a comparison', async () => {
    const { engine, cwd } = await makeEngine([fakeProvider('solo', 100, succeedWith('x'))])
    await expect(engine.createTask({ prompt: 'compare', cwd, mode: 'balanced', benchProviderIds: ['solo'] }))
      .rejects.toThrow('at least two')
  })

  it('continues a completed task in-context by replaying the transcript', async () => {
    const { engine, cwd } = await makeEngine([
      // Echo whatever arrives on stdin so we can assert the transcript replay.
      fakeProvider('agent', 100, 'process.stdin.pipe(process.stdout)')
    ])
    const created = await engine.createTask({ prompt: 'first question', cwd, mode: 'balanced' })
    await waitForTask(engine, created.id)

    const continued = await engine.continueTask(created.id, 'second question')
    expect(continued.status).toBe('completed')
    expect(continued.output).toContain('Full conversation history transferred by Frontier')
    expect(continued.output).toContain('first question')
    expect(continued.output).toContain('second question')
    // Two user turns + two assistant turns.
    expect(continued.turns?.filter((turn) => turn.role === 'user')).toHaveLength(2)
    expect(continued.turns?.filter((turn) => turn.role === 'assistant')).toHaveLength(2)
  })
})
