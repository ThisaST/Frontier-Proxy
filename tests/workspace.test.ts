import { afterAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parallelDispatch, WorkspaceRuntime, type WorkspaceRuntimeDeps } from '../src/main/workspace'
import type {
  ParticipantRunInput, ParticipantRunResult, ParticipantRunner, ProviderConfig, ProviderRuntime, WorkspaceParticipant, WorkspaceStreamEvent
} from '../src/shared/types'

const run = promisify(execFile)
const cleanup: string[] = []
afterAll(async () => { for (const dir of cleanup) await rm(dir, { recursive: true, force: true }).catch(() => undefined) })

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'frontier-ws-repo-'))
  cleanup.push(dir)
  await run('git', ['init', '-b', 'main'], { cwd: dir })
  await run('git', ['config', 'user.email', 't@t'], { cwd: dir })
  await run('git', ['config', 'user.name', 'T'], { cwd: dir })
  await writeFile(join(dir, 'seed.txt'), 'seed')
  await run('git', ['add', '-A'], { cwd: dir })
  await run('git', ['commit', '-m', 'init'], { cwd: dir })
  return dir
}

async function makePlainDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'frontier-ws-plain-'))
  cleanup.push(dir)
  return dir
}

function provider(id: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id, name: id, kind: 'claude', enabled: true, executable: id, priority: 50, maxConcurrent: 1,
    capabilities: ['coding', 'debugging', 'review', 'planning', 'documentation', 'general'], ...overrides
  }
}

function runtime(overrides: Partial<ProviderRuntime> = {}): ProviderRuntime {
  return {
    available: true, running: 0,
    usage: { date: '2026-08-06', tasks: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, elapsedMs: 0 },
    ...overrides
  }
}

function participant(overrides: Partial<WorkspaceParticipant> & { handle: string }): WorkspaceParticipant {
  return { id: overrides.id ?? overrides.handle, name: overrides.name ?? overrides.handle, kind: 'agent', role: 'Agent', capabilities: [], enabled: true, ...overrides }
}

// A scripted ParticipantRunner: `when(handle, fn)` fixes the reply for a given
// participant; otherwise the default reply just echoes the handle.
class FakeRunner implements ParticipantRunner {
  calls: ParticipantRunInput[] = []
  private readonly byHandle = new Map<string, (input: ParticipantRunInput) => Promise<ParticipantRunResult>>()
  when(handle: string, fn: (input: ParticipantRunInput) => Promise<ParticipantRunResult>): void { this.byHandle.set(handle, fn) }
  async run(input: ParticipantRunInput): Promise<ParticipantRunResult> {
    this.calls.push(input)
    const handler = this.byHandle.get(input.participant.handle)
    if (handler) return handler(input)
    return { ok: true, output: `${input.participant.handle} says hi` }
  }
}

function harness(providerList: ProviderConfig[]) {
  const providers = new Map(providerList.map((item) => [item.id, item]))
  const runtimes = new Map(providerList.map((item) => [item.id, runtime()]))
  const streams: WorkspaceStreamEvent[] = []
  const counts = { persist: 0 }
  const runner = new FakeRunner()
  const deps: WorkspaceRuntimeDeps = {
    runner,
    listProviders: () => [...providers.values()],
    providerRuntime: (id) => runtimes.get(id),
    claimProviderSlot: (id) => {
      const config = providers.get(id); const state = runtimes.get(id)
      if (!config || !state || state.running >= config.maxConcurrent) return false
      state.running += 1
      return true
    },
    releaseProviderSlot: (id) => { const state = runtimes.get(id); if (state) state.running = Math.max(0, state.running - 1) },
    persist: () => { counts.persist += 1 },
    emitStream: (event) => { streams.push(event) }
  }
  return { runtime: new WorkspaceRuntime(deps), runner, providers, runtimes, streams, counts, deps }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out')
    await sleep(10)
  }
}

describe('WorkspaceRuntime — CRUD', () => {
  it('seeds a new workspace with a human participant', () => {
    const h = harness([])
    const workspace = h.runtime.createWorkspace('Team', '/tmp/somewhere')
    expect(workspace.participants).toHaveLength(1)
    expect(workspace.participants[0].kind).toBe('human')
  })

  it('rejects a duplicate handle within the same workspace', () => {
    const h = harness([provider('solo')])
    const workspace = h.runtime.createWorkspace('Team', '/tmp/somewhere')
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'nova', providerId: 'solo' }))
    expect(() => h.runtime.upsertParticipant(workspace.id, participant({ id: 'other-id', handle: 'nova', providerId: 'solo', name: 'Nova 2' }))).toThrow(/already used/)
  })

  it('rejects an invalid handle', () => {
    const h = harness([provider('solo')])
    const workspace = h.runtime.createWorkspace('Team', '/tmp/somewhere')
    expect(() => h.runtime.upsertParticipant(workspace.id, participant({ handle: '2bad', providerId: 'solo' }))).toThrow()
  })
})

describe('WorkspaceRuntime — dispatch', () => {
  it('starts every addressed participant in parallel; neither sees the other reply', async () => {
    const h = harness([provider('prov-a'), provider('prov-b')])
    const workspace = h.runtime.createWorkspace('Team', await makePlainDir())
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'nova', providerId: 'prov-a' }))
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'doc', providerId: 'prov-b' }))

    await h.runtime.postMessage(workspace.id, 'hey @nova and @doc, please look at this')

    expect(workspace.turns).toHaveLength(2)
    expect(workspace.turns.every((turn) => turn.status === 'completed')).toBe(true)
    const novaCall = h.runner.calls.find((call) => call.participant.handle === 'nova')!
    const docCall = h.runner.calls.find((call) => call.participant.handle === 'doc')!
    // Both only ever saw the triggering human message — neither's history could
    // contain the other's reply, because a reply always gets a seq AFTER the trigger.
    expect(novaCall.history.map((message) => message.author)).toEqual(['human'])
    expect(docCall.history.map((message) => message.author)).toEqual(['human'])
    expect(workspace.messages.filter((message) => message.author === 'agent')).toHaveLength(2)
  })

  it('a turn whose provider is at maxConcurrent waits for a slot instead of failing', async () => {
    const h = harness([provider('solo', { maxConcurrent: 1 })])
    const workspace = h.runtime.createWorkspace('Team', await makePlainDir())
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'nova', providerId: 'solo' }))

    expect(h.deps.claimProviderSlot('solo')).toBe(true) // simulate another turn already occupying the only slot

    const pending = h.runtime.postMessage(workspace.id, 'go take a look @nova')
    await sleep(15)
    expect(workspace.turns).toHaveLength(1)
    expect(workspace.turns[0].status).toBe('queued')
    expect(h.runner.calls).toHaveLength(0)

    h.deps.releaseProviderSlot('solo')
    await pending

    expect(workspace.turns[0].status).toBe('completed')
    expect(h.runner.calls).toHaveLength(1)
  })

  it('a quota failure fails only that turn, with no reroute to another provider', async () => {
    const h = harness([provider('solo'), provider('other')])
    const workspace = h.runtime.createWorkspace('Team', await makePlainDir())
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'nova', providerId: 'solo' }))
    h.runner.when('nova', async () => ({ ok: false, output: '', error: 'quota exceeded', failureKind: 'quota' }))

    await h.runtime.postMessage(workspace.id, 'go @nova')

    expect(workspace.turns).toHaveLength(1)
    expect(workspace.turns[0].status).toBe('failed')
    expect(workspace.turns[0].failureKind).toBe('quota')
    expect(workspace.turns[0].providerId).toBe('solo')
    expect(h.runner.calls).toHaveLength(1) // 'other' was never tried
  })

  it('an agent reply containing @handle never re-dispatches', async () => {
    const h = harness([provider('solo'), provider('other')])
    const workspace = h.runtime.createWorkspace('Team', await makePlainDir())
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'nova', providerId: 'solo' }))
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'doc', providerId: 'other' }))
    h.runner.when('nova', async () => ({ ok: true, output: 'thanks, cc @doc for a second look' }))

    await h.runtime.postMessage(workspace.id, 'go @nova')

    expect(workspace.turns).toHaveLength(1) // doc was never dispatched even though nova's reply mentions it
    expect(h.runner.calls).toHaveLength(1)
    const reply = workspace.messages.find((message) => message.author === 'agent')!
    expect(reply.text).toContain('@doc')
    expect(reply.addressed.length).toBeGreaterThan(0) // resolved so the UI can still render a mention chip
  })

  it('a message with no mentions is logged but dispatches nothing', async () => {
    const h = harness([provider('solo')])
    const workspace = h.runtime.createWorkspace('Team', await makePlainDir())
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'nova', providerId: 'solo' }))

    await h.runtime.postMessage(workspace.id, 'just a note, no addressing here')

    expect(workspace.messages).toHaveLength(1)
    expect(workspace.turns).toHaveLength(0)
    expect(h.runner.calls).toHaveLength(0)
  })

  it('a mention of a disabled participant produces a system message naming the reason', async () => {
    const h = harness([provider('solo')])
    const workspace = h.runtime.createWorkspace('Team', await makePlainDir())
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'nova', providerId: 'solo', enabled: false }))

    await h.runtime.postMessage(workspace.id, 'go @nova')

    expect(workspace.turns).toHaveLength(0)
    const system = workspace.messages.find((message) => message.author === 'system')!
    expect(system.systemReason).toMatch(/disabled/i)
  })

  it('a mention of a participant whose provider is cooling down produces a system message', async () => {
    const h = harness([provider('solo')])
    h.runtimes.get('solo')!.cooldownUntil = new Date(Date.now() + 60_000).toISOString()
    const workspace = h.runtime.createWorkspace('Team', await makePlainDir())
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'nova', providerId: 'solo' }))

    await h.runtime.postMessage(workspace.id, 'go @nova')

    expect(workspace.turns).toHaveLength(0)
    const system = workspace.messages.find((message) => message.author === 'system')!
    expect(system.systemReason).toMatch(/cooling down/i)
  })

  it('an unknown handle also produces a system message rather than being silently dropped', async () => {
    const h = harness([provider('solo')])
    const workspace = h.runtime.createWorkspace('Team', await makePlainDir())
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'nova', providerId: 'solo' }))

    await h.runtime.postMessage(workspace.id, 'go @ghost')

    expect(workspace.turns).toHaveLength(0)
    const system = workspace.messages.find((message) => message.author === 'system')!
    expect(system.systemReason).toMatch(/ghost/)
  })
})

describe('WorkspaceRuntime — worktree isolation', () => {
  it('names the branch frontier/ws-<slug>/<seq>-<handle>', async () => {
    const repo = await makeRepo()
    const h = harness([provider('solo')])
    const workspace = h.runtime.createWorkspace('Payments Team', repo)
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'nova', providerId: 'solo', capabilities: ['edit-files'] }))

    await h.runtime.postMessage(workspace.id, 'go @nova')

    const turn = workspace.turns[0]
    const trigger = workspace.messages[0]
    expect(turn.branch).toBe(`frontier/ws-payments-team/${trigger.seq}-nova`)
  })

  it('produces a git-safe branch even from a hostile workspace name', async () => {
    const repo = await makeRepo()
    const h = harness([provider('solo')])
    const workspace = h.runtime.createWorkspace('../../etc/Payments!! Team??', repo)
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'nova', providerId: 'solo', capabilities: ['edit-files'] }))

    await h.runtime.postMessage(workspace.id, 'go @nova')

    const turn = workspace.turns[0]
    expect(turn.branch).toMatch(/^frontier\/ws-[a-z0-9-]+\/\d+-nova$/)
    // and it must actually exist as a real branch — proves the slug survived git's own naming rules
    const { stdout } = await run('git', ['branch', '--list', turn.branch!], { cwd: repo })
    expect(stdout).toContain(turn.branch!.split('/').pop())
  })

  it('tears down the worktree when the turn fails, but leaves the branch for review', async () => {
    const repo = await makeRepo()
    const h = harness([provider('solo')])
    const workspace = h.runtime.createWorkspace('Team', repo)
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'nova', providerId: 'solo', capabilities: ['edit-files'] }))
    h.runner.when('nova', async () => ({ ok: false, output: '', error: 'boom', failureKind: 'failed' }))

    await h.runtime.postMessage(workspace.id, 'go @nova')

    const turn = workspace.turns[0]
    expect(turn.status).toBe('failed')
    expect(turn.branch).toBeDefined()
    const workdir = h.runner.calls[0].cwd
    await expect(stat(workdir)).rejects.toThrow() // worktree directory gone
    const { stdout } = await run('git', ['branch', '--list', turn.branch!], { cwd: repo })
    expect(stdout).toContain(turn.branch!.split('/').pop()) // branch survives
  })

  it('tears down the worktree when the turn is cancelled', async () => {
    const repo = await makeRepo()
    const h = harness([provider('solo')])
    const workspace = h.runtime.createWorkspace('Team', repo)
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'nova', providerId: 'solo', capabilities: ['edit-files'] }))
    h.runner.when('nova', (input) => new Promise((resolve) => {
      input.signal.addEventListener('abort', () => resolve({ ok: false, output: '', error: 'Cancelled.', failureKind: 'cancelled' }))
    }))

    const pending = h.runtime.postMessage(workspace.id, 'go @nova')
    await waitUntil(() => h.runner.calls.length > 0) // let it claim the slot, create the worktree, and reach the runner call
    expect(workspace.turns[0].status).toBe('running')
    const workdir = h.runner.calls[0].cwd

    h.runtime.cancelTurn(workspace.id, workspace.turns[0].id)
    await pending

    expect(workspace.turns[0].status).toBe('cancelled')
    expect(workspace.turns[0].branch).toBeDefined()
    await expect(stat(workdir)).rejects.toThrow()
  })

  it('runs a participant without edit-files directly in the workspace cwd', async () => {
    const repo = await makeRepo()
    const h = harness([provider('solo')])
    const workspace = h.runtime.createWorkspace('Team', repo)
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'nova', providerId: 'solo', capabilities: [] }))

    await h.runtime.postMessage(workspace.id, 'go @nova')

    expect(workspace.turns[0].branch).toBeUndefined()
    expect(h.runner.calls[0].cwd).toBe(repo)
  })

  it('falls back to the shared cwd for a non-git workspace', async () => {
    const plain = await makePlainDir()
    const h = harness([provider('solo')])
    const workspace = h.runtime.createWorkspace('Team', plain)
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'nova', providerId: 'solo', capabilities: ['edit-files'] }))

    await h.runtime.postMessage(workspace.id, 'go @nova')

    expect(workspace.turns[0].branch).toBeUndefined()
    expect(h.runner.calls[0].cwd).toBe(plain)
  })

  it('fails the turn with a clear reason (never the shared cwd) when worktree creation fails for any other reason', async () => {
    const repo = await makeRepo()
    const h = harness([provider('solo')])
    const workspace = h.runtime.createWorkspace('Team', repo)
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'nova', providerId: 'solo', capabilities: ['edit-files'] }))
    // Pre-create the exact branch this first attempt will derive, so `git worktree add -b`
    // collides for a reason other than the retry-naming bug this fix addresses.
    await run('git', ['branch', 'frontier/ws-team/1-nova'], { cwd: repo })

    await h.runtime.postMessage(workspace.id, 'go @nova')

    const turn = workspace.turns[0]
    expect(turn.status).toBe('failed')
    expect(turn.error).toMatch(/isolated branch/i)
    expect(turn.branch).toBeUndefined()
    expect(h.runner.calls).toHaveLength(0) // never ran in the workspace cwd
  })
})

describe('WorkspaceRuntime — retry', () => {
  it('appends a new turn and leaves the original intact', async () => {
    const h = harness([provider('solo')])
    const workspace = h.runtime.createWorkspace('Team', await makePlainDir())
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'nova', providerId: 'solo' }))
    h.runner.when('nova', async () => ({ ok: false, output: '', error: 'boom', failureKind: 'failed' }))

    await h.runtime.postMessage(workspace.id, 'go @nova')
    expect(workspace.turns).toHaveLength(1)
    const original = workspace.turns[0]

    h.runner.when('nova', async () => ({ ok: true, output: 'fixed now' }))
    const retried = await h.runtime.retryTurn(workspace.id, original.id)

    expect(workspace.turns).toHaveLength(2)
    expect(original.status).toBe('failed')
    expect(retried.id).not.toBe(original.id)
    expect(retried.status).toBe('completed')
  })

  it('retrying an edit-files participant gets a distinct branch, and both branches survive', async () => {
    const repo = await makeRepo()
    const h = harness([provider('solo')])
    const workspace = h.runtime.createWorkspace('Team', repo)
    h.runtime.upsertParticipant(workspace.id, participant({ handle: 'nova', providerId: 'solo', capabilities: ['edit-files'] }))
    h.runner.when('nova', async () => ({ ok: false, output: '', error: 'boom', failureKind: 'failed' }))

    await h.runtime.postMessage(workspace.id, 'go @nova')
    const original = workspace.turns[0]
    expect(original.status).toBe('failed')
    expect(original.branch).toBeDefined()

    h.runner.when('nova', async () => ({ ok: true, output: 'fixed now' }))
    const retried = await h.runtime.retryTurn(workspace.id, original.id)

    expect(retried.status).toBe('completed')
    expect(retried.branch).toBeDefined()
    expect(retried.branch).not.toBe(original.branch)

    const { stdout } = await run('git', ['branch', '--list', 'frontier/ws-team/*'], { cwd: repo })
    expect(stdout).toContain(original.branch!.split('/').pop())
    expect(stdout).toContain(retried.branch!.split('/').pop())
  })
})

// Exercised directly for coverage of the strategy seam described in the module.
describe('parallelDispatch', () => {
  it('runs every starter and waits for all of them', async () => {
    const order: string[] = []
    await parallelDispatch([
      async () => { await sleep(5); order.push('a') },
      async () => { order.push('b') }
    ])
    expect(order).toEqual(['b', 'a'])
  })
})
