import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { OrchestrationEngine } from '../src/main/engine'
import { JsonStore } from '../src/main/store'
import { freshDefaults } from '../src/shared/defaults'
import type { AppSnapshot, ProviderConfig, VerificationSettings } from '../src/shared/types'

// The verification lane end to end: a real git repo, real worktrees, real child
// processes for both the "agent" and the checks. What is faked is only the CLI
// itself — a node one-liner that edits a file, exactly as an agent would.

const run = promisify(execFile)
const AUTHOR = ['-c', 'user.name=Frontier Tests', '-c', 'user.email=tests@frontier.local']

const writesAFile = (name: string, answer: string): string =>
  `require('fs').writeFileSync(${JSON.stringify(name)}, 'change\\n');process.stdout.write(${JSON.stringify(answer)})`

function fakeProvider(id: string, priority: number, script: string): ProviderConfig {
  return {
    id, name: `Provider ${id}`, kind: 'custom', enabled: true,
    executable: process.execPath, args: ['-e', script], priority, maxConcurrent: 1,
    capabilities: ['coding', 'debugging', 'review', 'planning', 'documentation', 'general']
  }
}

async function makeEngine(providers: ProviderConfig[], verification: VerificationSettings): Promise<{ engine: OrchestrationEngine; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'frontier-verify-e2e-'))
  await run('git', ['init', '-b', 'main'], { cwd })
  await writeFile(join(cwd, 'README.md'), '# repo\n')
  await run('git', ['add', '-A'], { cwd })
  await run('git', [...AUTHOR, 'commit', '-m', 'init'], { cwd })

  const store = new JsonStore(join(await mkdtemp(join(tmpdir(), 'frontier-verify-state-')), 'state.json'))
  const settings = freshDefaults()
  settings.verification = verification
  settings.providers = [...freshDefaults().providers.map((provider) => ({ ...provider, enabled: false })), ...providers]
  await store.save({ settings, tasks: [] })
  const engine = new OrchestrationEngine(store)
  await engine.initialize()
  return { engine, cwd }
}

async function waitForTask(engine: OrchestrationEngine, taskId: string, timeoutMs = 25_000): Promise<AppSnapshot['tasks'][number]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const task = engine.snapshot().tasks.find((item) => item.id === taskId)
    if (task && (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')) return task
    if (Date.now() > deadline) throw new Error(`Task ${taskId} did not settle; last status: ${task?.status}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const passing: VerificationSettings = { enabled: true, commands: ['node --eval process.exit(0)'], timeoutSeconds: 60 }

describe('verifying isolated branches', () => {
  it('runs the checks against each bench lane and measures what it produced', async () => {
    const { engine, cwd } = await makeEngine([
      fakeProvider('alpha', 100, writesAFile('alpha.txt', 'alpha answer')),
      fakeProvider('beta', 90, writesAFile('beta.txt', 'beta answer'))
    ], passing)
    const created = await engine.createTask({ prompt: 'compare these agents', cwd, mode: 'balanced', benchProviderIds: ['alpha', 'beta'] })
    const task = await waitForTask(engine, created.id)

    const lanes = task.subtasks ?? []
    expect(lanes.map((lane) => lane.providerId).sort()).toEqual(['alpha', 'beta'])
    for (const lane of lanes) {
      expect(lane.committed).toBe(true)
      expect(lane.verification?.ran).toBe(true)
      expect(lane.verification?.ok).toBe(true)
      expect(lane.filesTouched).toBe(1)
      expect(lane.additions).toBe(1)
      expect(lane.startedAt && lane.finishedAt).toBeTruthy()
    }
    // The scoreboard reports the measurements rather than only who finished.
    expect(task.output).toContain('| Agent | Result | Checks |')
    expect(task.output).toContain('1 file +1')
  })

  it('records a failing check without failing the agent that produced it', async () => {
    const { engine, cwd } = await makeEngine([
      fakeProvider('alpha', 100, writesAFile('alpha.txt', 'alpha answer')),
      fakeProvider('beta', 90, writesAFile('beta.txt', 'beta answer'))
    ], { enabled: true, commands: ['node --eval console.error("suite failed");process.exit(1)'], timeoutSeconds: 60 })
    const task = await waitForTask(engine, (await engine.createTask({ prompt: 'compare', cwd, mode: 'balanced', benchProviderIds: ['alpha', 'beta'] })).id)

    const lane = (task.subtasks ?? [])[0]
    // The run succeeded; the repo's checks did not. Those are separate verdicts.
    expect(lane.status).toBe('completed')
    expect(lane.verification?.ok).toBe(false)
    expect(lane.verification?.checks[0].output).toContain('suite failed')
    expect(task.output).toContain('✗')
  })

  it("surfaces each branch's checks in the review inbox", async () => {
    const { engine, cwd } = await makeEngine([
      fakeProvider('alpha', 100, writesAFile('alpha.txt', 'alpha answer')),
      fakeProvider('beta', 90, writesAFile('beta.txt', 'beta answer'))
    ], passing)
    await waitForTask(engine, (await engine.createTask({ prompt: 'compare', cwd, mode: 'balanced', benchProviderIds: ['alpha', 'beta'] })).id)

    const [repo] = await engine.listBranchInbox()
    expect(repo.branches).toHaveLength(2)
    for (const branch of repo.branches) expect(branch.verification?.ok).toBe(true)
  })

  it('skips the checks entirely when they are turned off', async () => {
    const { engine, cwd } = await makeEngine([
      fakeProvider('alpha', 100, writesAFile('alpha.txt', 'a')),
      fakeProvider('beta', 90, writesAFile('beta.txt', 'b'))
    ], { enabled: false, commands: ['node --eval process.exit(1)'], timeoutSeconds: 60 })
    const task = await waitForTask(engine, (await engine.createTask({ prompt: 'compare', cwd, mode: 'balanced', benchProviderIds: ['alpha', 'beta'] })).id)
    expect((task.subtasks ?? []).every((lane) => lane.verification === undefined)).toBe(true)
  })
})

describe('learning from the review verdict', () => {
  it("counts a completed, verified run and then the user's merge decision", async () => {
    const { engine, cwd } = await makeEngine([
      fakeProvider('alpha', 100, writesAFile('alpha.txt', 'alpha answer')),
      fakeProvider('beta', 90, writesAFile('beta.txt', 'beta answer'))
    ], passing)
    const task = await waitForTask(engine, (await engine.createTask({ prompt: 'compare', cwd, mode: 'balanced', benchProviderIds: ['alpha', 'beta'] })).id)
    const lanes = task.subtasks ?? []

    const outcomesFor = (id: string) => engine.snapshot().providers.find((provider) => provider.id === id)?.runtime.outcomes?.[lanes[0].type]
    expect(outcomesFor('alpha')).toMatchObject({ runs: 1, completed: 1, verified: 1, verifyFailed: 0, merged: 0, discarded: 0 })

    const alpha = lanes.find((lane) => lane.providerId === 'alpha')!
    const beta = lanes.find((lane) => lane.providerId === 'beta')!
    await engine.mergeBranch(cwd, alpha.branch!)
    await engine.deleteBranch(cwd, beta.branch!)

    expect(outcomesFor('alpha')).toMatchObject({ merged: 1, discarded: 0 })
    expect(outcomesFor('beta')).toMatchObject({ merged: 0, discarded: 1 })
  })

  // Tidying up a branch that is already in the history is housekeeping, not a
  // rejection of the agent that wrote it.
  it('does not count deleting an already-merged branch as a rejection', async () => {
    const { engine, cwd } = await makeEngine([
      fakeProvider('alpha', 100, writesAFile('alpha.txt', 'alpha answer')),
      fakeProvider('beta', 90, writesAFile('beta.txt', 'beta answer'))
    ], passing)
    const task = await waitForTask(engine, (await engine.createTask({ prompt: 'compare', cwd, mode: 'balanced', benchProviderIds: ['alpha', 'beta'] })).id)
    const alpha = (task.subtasks ?? []).find((lane) => lane.providerId === 'alpha')!

    await engine.mergeBranch(cwd, alpha.branch!)
    await engine.deleteBranch(cwd, alpha.branch!)

    const outcomes = engine.snapshot().providers.find((provider) => provider.id === 'alpha')?.runtime.outcomes?.[alpha.type]
    expect(outcomes).toMatchObject({ merged: 1, discarded: 0 })
  })

  // Same signals as above, but keyed by the model that actually ran alongside
  // the provider-level figure — so a merged/discarded branch teaches the
  // router about that specific model, not only about the CLI as a whole.
  it('records the run and merge verdict against the model that ran, alongside the provider-level figure', async () => {
    const { engine, cwd } = await makeEngine([
      { ...fakeProvider('alpha', 100, writesAFile('alpha.txt', 'alpha answer')), model: 'alpha-model' },
      fakeProvider('beta', 90, writesAFile('beta.txt', 'beta answer'))
    ], passing)
    const task = await waitForTask(engine, (await engine.createTask({ prompt: 'compare', cwd, mode: 'balanced', benchProviderIds: ['alpha', 'beta'] })).id)
    const lanes = task.subtasks ?? []
    const alpha = lanes.find((lane) => lane.providerId === 'alpha')!
    const modelOutcomesFor = (id: string) => engine.snapshot().providers.find((provider) => provider.id === id)?.runtime.modelOutcomes

    expect(alpha.model).toBe('alpha-model')
    expect(modelOutcomesFor('alpha')?.['alpha-model']?.[alpha.type]).toMatchObject({ runs: 1, completed: 1, verified: 1 })
    // Beta's fake CLI never reports a model, so no per-model figure exists —
    // only the provider level does, which the test above already covers.
    expect(modelOutcomesFor('beta')).toBeUndefined()

    await engine.mergeBranch(cwd, alpha.branch!)
    expect(modelOutcomesFor('alpha')?.['alpha-model']?.[alpha.type]).toMatchObject({ merged: 1 })
  })
})
