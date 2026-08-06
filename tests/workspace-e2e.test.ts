import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OrchestrationEngine } from '../src/main/engine'
import { JsonStore } from '../src/main/store'
import { WorkspaceRuntime } from '../src/main/workspace'
import { CliParticipantRunner } from '../src/main/participants'
import { freshDefaults } from '../src/shared/defaults'
import type { AppSnapshot, ProviderConfig, Workspace } from '../src/shared/types'

// Mirrors tests/e2e.test.ts's approach (a real engine, fake node-script CLIs
// spawned via cross-spawn) but drives the workspace side of the app: a real
// WorkspaceRuntime wired to a real CliParticipantRunner exactly as
// src/main/index.ts wires them — no Electron/BrowserWindow involved.

function fakeProvider(id: string, script: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id, name: `Provider ${id}`, kind: 'custom', enabled: true,
    executable: process.execPath, args: ['-e', script], priority: 50, maxConcurrent: 1,
    capabilities: ['coding', 'debugging', 'review', 'planning', 'documentation', 'general'], ...overrides
  }
}

// Reads the full prompt sent over stdin and echoes it back prefixed with a
// distinct marker, so a turn's own output doubles as proof of exactly what
// prompt it received.
const echoPromptAs = (marker: string): string =>
  `let input='';process.stdin.on('data',(c)=>input+=c);process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(marker)}+'::'+input))`

async function makeWorkspaceHarness(providers: ProviderConfig[]): Promise<{ engine: OrchestrationEngine; workspaceRuntime: WorkspaceRuntime; cwd: string; statePath: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'frontier-ws-e2e-'))
  const statePath = join(cwd, 'state.json')
  const store = new JsonStore(statePath)
  const settings = freshDefaults()
  // Same trick as e2e.test.ts's makeEngine: JsonStore.load() re-merges the
  // built-in default providers by id, so disable every default and only offer
  // the fakes under test for routing/dispatch.
  settings.providers = [
    ...freshDefaults().providers.map((provider) => ({ ...provider, enabled: false })),
    ...providers
  ]
  await store.save({ settings, tasks: [] })
  const engine = new OrchestrationEngine(store)
  await engine.initialize()

  // Same construction order as src/main/index.ts: `workspaceRuntime` is
  // declared before the runner/deps object so `persist` can close over it,
  // then assigned once WorkspaceRuntime itself exists.
  let workspaceRuntime!: WorkspaceRuntime
  const runner = new CliParticipantRunner({
    findProvider: (providerId) => engine.listProviders().find((item) => item.id === providerId),
    modelOwners: () => engine.modelOwners(),
    controlPlane: () => engine.controlPlaneProfile(),
    resolveSkills: (workspaceCwd) => engine.resolveSkillsForCwd(workspaceCwd),
    memory: () => engine.frontierMemory()
  })
  workspaceRuntime = new WorkspaceRuntime({
    runner,
    listProviders: () => engine.listProviders(),
    providerRuntime: (providerId) => engine.providerRuntime(providerId),
    claimProviderSlot: (providerId) => engine.claimProviderSlot(providerId),
    releaseProviderSlot: (providerId) => engine.releaseProviderSlot(providerId),
    persist: () => engine.persistWorkspaces(workspaceRuntime.list(), workspaceRuntime.snapshot()),
    emitStream: (event) => engine.emitWorkspaceStream(event)
  }, engine.loadedWorkspaces())

  return { engine, workspaceRuntime, cwd, statePath }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not met in time')
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

// `persist()` saves through JsonStore fire-and-forget (`void this.persistAndEmit()`),
// so a caller that just awaited postMessage() has no guarantee the write already
// landed on disk. Poll the file itself, the same way waitForTask polls the
// in-memory snapshot in tests/e2e.test.ts.
async function waitForPersistedWorkspace(statePath: string, workspaceId: string, predicate: (workspace: Workspace) => boolean, timeoutMs = 5_000): Promise<Workspace> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const raw = JSON.parse(await readFile(statePath, 'utf8')) as { workspaces?: Workspace[] }
      const workspace = raw.workspaces?.find((item) => item.id === workspaceId)
      if (workspace && predicate(workspace)) return workspace
    } catch {
      // file may be mid-write (temp-rename in progress); retry.
    }
    if (Date.now() > deadline) throw new Error(`Workspace ${workspaceId} did not reach the expected persisted state in time`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function waitForTask(engine: OrchestrationEngine, taskId: string, timeoutMs = 8_000): Promise<AppSnapshot['tasks'][number]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const task = engine.snapshot().tasks.find((item) => item.id === taskId)
    if (task && (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')) return task
    if (Date.now() > deadline) throw new Error(`Task ${taskId} did not settle; last status: ${task?.status}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('end-to-end workspace lifecycle', () => {
  it('runs two mentioned participants in parallel and isolated, persists through JsonStore, and dispatches a targeted follow-up', async () => {
    const { workspaceRuntime, cwd, statePath } = await makeWorkspaceHarness([
      fakeProvider('agent-a', echoPromptAs('NOVA-REPLY')),
      fakeProvider('agent-b', echoPromptAs('DOC-REPLY'))
    ])

    const workspace = workspaceRuntime.createWorkspace('Payments', cwd)
    workspaceRuntime.upsertParticipant(workspace.id, {
      handle: 'nova', name: 'Nova', kind: 'agent', role: 'Backend', providerId: 'agent-a', capabilities: [], enabled: true
    })
    workspaceRuntime.upsertParticipant(workspace.id, {
      handle: 'doc', name: 'Doc', kind: 'agent', role: 'Docs', providerId: 'agent-b', capabilities: [], enabled: true
    })

    await workspaceRuntime.postMessage(workspace.id, 'hey @nova and @doc, please take a look')

    expect(workspace.turns).toHaveLength(2)
    expect(workspace.turns.every((turn) => turn.status === 'completed')).toBe(true)

    const novaParticipant = workspace.participants.find((item) => item.handle === 'nova')!
    const docParticipant = workspace.participants.find((item) => item.handle === 'doc')!
    const novaTurn = workspace.turns.find((turn) => turn.participantId === novaParticipant.id)!
    const docTurn = workspace.turns.find((turn) => turn.participantId === docParticipant.id)!

    // Output landed on the right turn.
    expect(novaTurn.output).toContain('NOVA-REPLY::')
    expect(docTurn.output).toContain('DOC-REPLY::')

    // Parallel isolation (ADR D5): both turns were built from the identical
    // trigger-time history, before either had replied, so neither's prompt
    // (echoed back verbatim as its own output) can contain the other's reply.
    expect(novaTurn.output).not.toContain('DOC-REPLY::')
    expect(docTurn.output).not.toContain('NOVA-REPLY::')

    // Both agent replies landed as messages on the shared thread.
    expect(workspace.messages.filter((message) => message.author === 'agent')).toHaveLength(2)

    // Persist + reload through JsonStore: a brand-new engine reading the same
    // state file sees the same turns and messages intact.
    const reloaded = await waitForPersistedWorkspace(statePath, workspace.id, (item) => item.turns.length === 2 && item.turns.every((turn) => turn.status === 'completed'))
    expect(reloaded.messages).toHaveLength(3) // trigger + two agent replies
    expect(reloaded.turns.map((turn) => turn.output).sort()).toEqual([docTurn.output, novaTurn.output].sort())

    const reloadedStore = new JsonStore(statePath)
    const reloadedEngine = new OrchestrationEngine(reloadedStore)
    await reloadedEngine.initialize()
    const reloadedWorkspace = reloadedEngine.loadedWorkspaces().find((item) => item.id === workspace.id)!
    expect(reloadedWorkspace.turns).toHaveLength(2)
    expect(reloadedWorkspace.turns.every((turn) => turn.status === 'completed')).toBe(true)
    expect(reloadedWorkspace.participants.map((item) => item.handle).sort()).toEqual(['doc', 'nova', 'you'])

    // A follow-up addressed to only one participant runs only that one.
    await workspaceRuntime.postMessage(workspace.id, 'thanks @nova, one more thing')
    expect(workspace.turns).toHaveLength(3)
    const followUpTurn = workspace.turns.at(-1)!
    expect(followUpTurn.participantId).toBe(novaParticipant.id)
    expect(followUpTurn.status).toBe('completed')
  })
})

describe('workspace and task concurrency', () => {
  it('a workspace turn and a task compete for the same per-provider slot', async () => {
    // Sleeps only when it recognizes the task's prompt, so we can prove the
    // provider's single slot is genuinely shared: the workspace turn dispatched
    // while the task holds it must stay queued rather than run alongside it.
    const script = [
      "let input='';process.stdin.on('data',(c)=>input+=c);process.stdin.on('end',()=>{",
      "if(input.includes('TASK-MARKER'))setTimeout(()=>process.stdout.write('task-done'),400);",
      "else process.stdout.write('agent-done');",
      '})'
    ].join('')
    const { engine, workspaceRuntime, cwd } = await makeWorkspaceHarness([
      fakeProvider('shared', script, { maxConcurrent: 1 })
    ])

    const workspace = workspaceRuntime.createWorkspace('Team', cwd)
    workspaceRuntime.upsertParticipant(workspace.id, {
      handle: 'nova', name: 'Nova', kind: 'agent', role: 'Backend', providerId: 'shared', capabilities: [], enabled: true
    })

    const createdTask = await engine.createTask({ prompt: 'TASK-MARKER: run the long thing', cwd, mode: 'balanced' })
    // Wait until the task has actually claimed the provider's only slot.
    await waitUntil(() => (engine.providerRuntime('shared')?.running ?? 0) === 1)

    const pendingMessage = workspaceRuntime.postMessage(workspace.id, 'go @nova')
    await new Promise((resolve) => setTimeout(resolve, 25))
    // If the workspace turn had its own private pool (the P4 regression this
    // guards against), it would already be running or done here even while the
    // task holds the single real slot.
    expect(workspace.turns).toHaveLength(1)
    expect(workspace.turns[0].status).toBe('queued')

    const task = await waitForTask(engine, createdTask.id)
    await pendingMessage

    expect(task.status).toBe('completed')
    expect(task.output).toBe('task-done')
    expect(workspace.turns[0].status).toBe('completed')
    expect(workspace.turns[0].output).toBe('agent-done')
  })
})
