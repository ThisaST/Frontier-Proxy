import { describe, expect, it } from 'vitest'
import type { AppSnapshot, ProviderConfig, ProviderRuntime, ProxyTask, SubTask, WorkspaceParticipant, WorkspaceTurn, WorkspaceView } from '../src/shared/types'
import { activityLabel, agentAppearance, buildOfficeScene, officeSummary, type OfficeAgent, type OfficeInput } from '../src/shared/office-model'

const NOW = Date.parse('2026-10-01T12:00:00Z')
const T = (minute: number): string => `2026-10-01T11:${String(minute).padStart(2, '0')}:00Z`

function provider(id: string, overrides: Partial<ProviderConfig> = {}, state: Partial<ProviderRuntime> = {}): AppSnapshot['providers'][number] {
  return {
    id, name: id, kind: 'claude', enabled: true, executable: id, priority: 50, maxConcurrent: 1,
    capabilities: ['coding', 'debugging', 'review', 'planning', 'documentation', 'general'], ...overrides,
    runtime: {
      available: true, running: 0,
      usage: { date: '2026-10-01', tasks: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, elapsedMs: 0 },
      ...state
    }
  }
}

function participant(overrides: Partial<WorkspaceParticipant> & { handle: string }): WorkspaceParticipant {
  return { id: overrides.id ?? overrides.handle, name: overrides.name ?? overrides.handle, kind: 'agent', role: 'Agent', capabilities: [], enabled: true, ...overrides }
}

function task(id: string, overrides: Partial<ProxyTask> = {}): ProxyTask {
  return {
    id, prompt: `Task ${id}`, cwd: '/repo', mode: 'balanced', type: 'coding', status: 'completed', createdAt: T(0),
    output: '', attempts: [], estimatedInputTokens: 0, estimatedOutputTokens: 0, ...overrides
  }
}

function running(id: string, providerId: string, overrides: Partial<ProxyTask> = {}): ProxyTask {
  return task(id, { status: 'running', selectedProviderId: providerId, attempts: [{ providerId, startedAt: T(1), status: 'running' }], ...overrides })
}

function subtask(id: string, providerId: string | undefined, status: SubTask['status'], overrides: Partial<SubTask> = {}): SubTask {
  return { id, title: `Sub ${id}`, prompt: id, type: 'coding', status, providerId, output: '', ...overrides }
}

function turn(id: string, providerId: string, participantId: string, status: WorkspaceTurn['status'], overrides: Partial<WorkspaceTurn> = {}): WorkspaceTurn {
  return { id, workspaceId: 'ws1', messageId: 'm1', participantId, providerId, status, output: '', ...overrides }
}

function workspaceView(id: string, turns: WorkspaceTurn[], overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    id, name: `Workspace ${id}`, cwd: '/repo', messages: [], turns, createdAt: T(0), nextSeq: 1,
    participants: [
      { ...participant({ handle: '@rev', role: 'Reviewer', providerId: 'claude', accent: 'teal' }), available: true },
      { ...participant({ handle: '@doc', role: 'Docs', providerId: 'codex' }), available: true }
    ],
    ...overrides
  }
}

const scene = (
  providers: AppSnapshot['providers'], tasks: ProxyTask[] = [], workspaces: WorkspaceView[] = [], input: Partial<OfficeInput> = {}
) => buildOfficeScene({ providers, tasks, workspaces }, { now: NOW, reviewCount: 0, ...input })
const agent = (built: ReturnType<typeof scene>, id: string): OfficeAgent => built.agents.find((item) => item.providerId === id)!

describe('agent state', () => {
  it('each away state carries its reason and no primary', () => {
    const built = scene([
      provider('a', { enabled: false }),
      provider('b', {}, { available: false }),
      provider('c', {}, { auth: { state: 'logged-out', checkedAt: T(0) } }),
      provider('d', {}, { cooldownUntil: '2026-10-01T12:30:00Z' }),
      provider('e', {}, { sessions: [{ status: 'rejected', resetsAt: '2026-10-01T14:00:00Z', updatedAt: T(0) }] })
    ], [running('t', 'a')])
    expect(built.agents.map((item) => [item.state, item.reason])).toEqual([
      ['disabled', 'Disabled'], ['offline', 'CLI not detected'], ['logged-out', 'Logged out'],
      ['cooldown', 'Cooling down'], ['limited', 'Usage limit reached']
    ])
    expect(agent(built, 'd').until).toBe('2026-10-01T12:30:00Z')
    expect(agent(built, 'a').work).toHaveLength(1)
    expect(built.agents.every((item) => item.primary === undefined && item.badge === undefined)).toBe(true)
    expect(built.summary).toBe('5 agents: 5 away')
  })

  it('applies precedence: disabled > offline > logged-out > cooldown > limited', () => {
    const everything = { available: false, auth: { state: 'logged-out' as const, checkedAt: T(0) }, cooldownUntil: '2026-10-01T12:30:00Z' }
    expect(scene([provider('x', { enabled: false }, everything)]).agents[0].state).toBe('disabled')
    expect(scene([provider('x', {}, everything)]).agents[0].state).toBe('offline')
    expect(scene([provider('x', {}, { ...everything, available: true })]).agents[0].state).toBe('logged-out')
    expect(scene([provider('x', {}, { cooldownUntil: '2026-10-01T12:30:00Z', sessions: [{ status: 'rejected', updatedAt: T(0) }] })]).agents[0].state).toBe('cooldown')
    expect(scene([provider('x', {}, { cooldownUntil: '2026-10-01T11:30:00Z', sessions: [{ status: 'rejected', updatedAt: T(0) }] })]).agents[0].state).toBe('limited')
  })

  it('an unknown or logged-in login state is not away', () => {
    const built = scene([provider('a', {}, { auth: { state: 'unknown', checkedAt: T(0) } }), provider('b', {}, { auth: { state: 'logged-in', checkedAt: T(0) } }), provider('c')])
    expect(built.agents.map((item) => item.state)).toEqual(['idle', 'idle', 'idle'])
  })

  it('running > 0 without any known work is working, without a primary', () => {
    const built = scene([provider('a', {}, { running: 1 })])
    expect(built.agents[0]).toMatchObject({ state: 'working', running: 1, maxConcurrent: 1 })
    expect(built.agents[0].work).toEqual([])
    expect(built.agents[0].primary).toBeUndefined()
  })
})

describe('work discovery', () => {
  it('a plain task is the last running attempt; an earlier finished attempt by another provider is ignored', () => {
    const failed = running('t', 'codex', { attempts: [
      { providerId: 'claude', startedAt: T(1), finishedAt: T(2), status: 'failed' },
      { providerId: 'codex', startedAt: T(3), status: 'running' }
    ], prompt: '  \nFix the login bug\nwith details', activity: [{ kind: 'tool', label: 'Edit', detail: 'src/a.ts', at: T(4) }] })
    const built = scene([provider('claude'), provider('codex')], [failed])
    expect(agent(built, 'claude').state).toBe('idle')
    expect(agent(built, 'codex')).toMatchObject({ state: 'working', primary: { kind: 'task', status: 'running', taskId: 't', title: 'Fix the login bug', activity: 'Edit src/a.ts', startedAt: T(3), inScope: true, cwd: '/repo' } })
  })

  it('a continued task runs on its second provider', () => {
    const continued = running('t', 'codex', { attempts: [
      { providerId: 'claude', startedAt: T(1), finishedAt: T(2), status: 'completed' },
      { providerId: 'codex', startedAt: T(5), status: 'running' }
    ] })
    const built = scene([provider('claude'), provider('codex')], [continued])
    expect([agent(built, 'claude').state, agent(built, 'codex').state]).toEqual(['idle', 'working'])
  })

  it('truncates a long first line of the prompt to 80 characters', () => {
    const built = scene([provider('a')], [running('t', 'a', { prompt: 'x'.repeat(200) })])
    expect(built.agents[0].primary!.title).toHaveLength(80)
    expect(built.agents[0].primary!.title.endsWith('…')).toBe(true)
  })

  it('orchestrated planning and synthesizing are stage work on the selected provider', () => {
    const planning = running('t', 'a', { orchestrated: true, orchestrationStage: 'planning', attempts: [], prompt: 'Build it' })
    expect(agent(scene([provider('a'), provider('b')], [planning]), 'a')).toMatchObject({ state: 'working', primary: { kind: 'stage', status: 'running', title: 'Planning: Build it' } })
    const synth = { ...planning, orchestrationStage: 'synthesizing' as const }
    expect(agent(scene([provider('a')], [synth]), 'a').primary!.title).toBe('Synthesizing: Build it')
  })

  it('orchestrated delegating shows running and queued subtasks and no stage', () => {
    const delegating = running('t', 'a', { orchestrated: true, orchestrationStage: 'delegating', attempts: [], activity: [{ kind: 'thinking', label: 'x', at: T(1) }], subtasks: [
      subtask('s1', 'a', 'running', { startedAt: T(2) }), subtask('s2', 'b', 'queued'), subtask('s3', 'b', 'completed'), subtask('s4', undefined, 'queued')
    ] })
    const built = scene([provider('a'), provider('b')], [delegating])
    expect(agent(built, 'a')).toMatchObject({ state: 'working', primary: { kind: 'subtask', subtaskId: 's1', title: 'Sub s1', activity: 'Thinking…' } })
    expect(agent(built, 'b')).toMatchObject({ state: 'waiting', primary: { kind: 'subtask', status: 'queued', subtaskId: 's2' } })
    expect(agent(built, 'b').work).toHaveLength(1)
  })

  it('bench lanes are kind bench with no activity', () => {
    const bench = running('t', 'a', { bench: true, orchestrated: false, subtasks: [subtask('l1', 'a', 'running', { startedAt: T(2) })], activity: [{ kind: 'notice', label: 'hi', at: T(1) }] })
    const built = scene([provider('a')], [bench])
    expect(built.agents[0].primary).toMatchObject({ kind: 'bench', subtaskId: 'l1', activity: undefined })
    expect(built.agents[0].work).toHaveLength(1)
  })

  it('a running turn is a meeting wearing the participant badge', () => {
    const built = scene([provider('claude'), provider('codex')], [], [workspaceView('ws1', [turn('t1', 'claude', '@rev', 'running', { startedAt: T(2), activity: [{ kind: 'tool', label: 'Read', at: T(3) }] })])])
    expect(agent(built, 'claude')).toMatchObject({
      state: 'meeting', badge: { handle: '@rev', role: 'Reviewer', accent: 'teal' },
      primary: { kind: 'turn', workspaceId: 'ws1', turnId: 't1', title: 'Workspace ws1', activity: 'Read', startedAt: T(2) }
    })
    expect(agent(built, 'codex').state).toBe('idle')
  })

  it('omits the badge when the participant is gone, and omits accent when unset', () => {
    const built = scene([provider('claude'), provider('codex')], [], [workspaceView('ws1', [turn('t1', 'claude', '@gone', 'running'), turn('t2', 'codex', '@doc', 'running')])])
    expect(agent(built, 'claude').primary!.badge).toBeUndefined()
    expect(agent(built, 'codex').badge).toEqual({ handle: '@doc', role: 'Docs' })
  })

  it('a queued turn is waiting', () => {
    const built = scene([provider('claude')], [], [workspaceView('ws1', [turn('t1', 'claude', '@rev', 'queued')])])
    expect(agent(built, 'claude')).toMatchObject({ state: 'waiting', primary: { kind: 'turn', status: 'queued' } })
  })

  it('maxConcurrent 2 with a task and a turn: meeting, two work items, the turn first', () => {
    const both = scene([provider('claude', { maxConcurrent: 2 }, { running: 2 })], [running('t', 'claude')], [workspaceView('ws1', [turn('t1', 'claude', '@rev', 'running', { startedAt: T(9) })])])
    expect(agent(both, 'claude').state).toBe('meeting')
    expect(agent(both, 'claude').work).toHaveLength(2)
    expect(agent(both, 'claude').work.map((item) => item.kind)).toEqual(['task', 'turn'])
  })
})

describe('ordering and scope', () => {
  it('sorts running before queued, in-scope before out, then by startedAt with undefined last', () => {
    const tasks = [
      running('late', 'a', { attempts: [{ providerId: 'a', startedAt: T(9), status: 'running' }] }),
      running('early', 'a', { attempts: [{ providerId: 'a', startedAt: T(2), status: 'running' }] }),
      running('away', 'a', { cwd: '/other', attempts: [{ providerId: 'a', startedAt: T(1), status: 'running' }] }),
      running('plan', 'a', { orchestrated: true, orchestrationStage: 'delegating', attempts: [], subtasks: [subtask('q1', 'a', 'queued', { startedAt: T(1) }), subtask('r0', 'a', 'running')] })
    ]
    const work = scene([provider('a', { maxConcurrent: 9 })], tasks, [], { projectCwd: '/repo' }).agents[0].work
    expect(work.map((item) => item.taskId === 'plan' ? item.subtaskId : item.taskId)).toEqual(['early', 'late', 'r0', 'away', 'q1'])
  })

  it('an out-of-scope task still makes the agent work, with an out-of-scope primary', () => {
    const built = scene([provider('a')], [running('t', 'a', { cwd: '/other' })], [], { projectCwd: '/repo' })
    expect(built.agents[0].state).toBe('working')
    expect(built.agents[0].primary!.inScope).toBe(false)
  })

  it('matches a project by exact cwd: a nested folder and a shared-prefix sibling are both out', () => {
    const built = scene([provider('a', { maxConcurrent: 4 })], [running('same', 'a', { cwd: '/repo' }), running('nested', 'a', { cwd: '/repo/pkg' }), running('out', 'a', { cwd: '/repo-two' })], [], { projectCwd: '/repo' })
    expect(Object.fromEntries(built.agents[0].work.map((item) => [item.taskId, item.inScope]))).toEqual({ same: true, nested: false, out: false })
  })

  it('an out-of-scope running turn counts as working, not waiting, even beside an in-scope queued subtask', () => {
    const plan = running('plan', 'a', { cwd: '/repo', orchestrated: true, orchestrationStage: 'delegating', attempts: [], subtasks: [subtask('s1', 'a', 'queued')] })
    const built = scene([provider('a', { maxConcurrent: 2 })], [plan], [workspaceView('ws1', [turn('t1', 'a', '@rev', 'running')], { cwd: '/other' })], { projectCwd: '/repo' })
    expect(built.agents[0].state).toBe('working')
    expect(built.agents[0].primary).toMatchObject({ kind: 'turn', status: 'running', inScope: false })
  })

  it('an out-of-scope running turn is not a meeting', () => {
    const built = scene([provider('claude')], [], [workspaceView('ws1', [turn('t1', 'claude', '@rev', 'running')], { cwd: '/other' })], { projectCwd: '/repo' })
    expect(built.agents[0].state).not.toBe('meeting')
    expect(built.rooms).toEqual([])
  })
})

describe('rooms', () => {
  it('seats a provider once even with a running and a queued turn, and lists the rest as waiting', () => {
    const view = workspaceView('ws1', [turn('t1', 'claude', '@rev', 'running'), turn('t2', 'claude', '@rev', 'queued'), turn('t3', 'codex', '@doc', 'queued'), turn('t4', 'codex', '@doc', 'queued'), turn('t5', 'codex', '@doc', 'completed')])
    const built = scene([provider('claude'), provider('codex')], [], [view])
    expect(built.rooms).toEqual([{ workspaceId: 'ws1', name: 'Workspace ws1', cwd: '/repo', seated: ['claude'], waiting: ['codex'] }])
  })

  it('orders rooms by workspace id and skips workspaces with nothing active or out of scope', () => {
    const built = scene([provider('claude', { maxConcurrent: 3 })], [], [
      workspaceView('wsB', [turn('b', 'claude', '@rev', 'running')]),
      workspaceView('wsA', [turn('a', 'claude', '@rev', 'queued')]),
      workspaceView('wsC', [turn('c', 'claude', '@rev', 'completed')]),
      workspaceView('wsD', [turn('d', 'claude', '@rev', 'running')], { cwd: '/other' })
    ], { projectCwd: '/repo' })
    expect(built.rooms.map((room) => room.workspaceId)).toEqual(['wsA', 'wsB'])
  })

  it('an away provider with a running turn is not seated', () => {
    const view = workspaceView('ws1', [turn('t1', 'claude', '@rev', 'running'), turn('t2', 'codex', '@doc', 'queued')])
    const built = scene([provider('claude', { enabled: false }), provider('codex', {}, { auth: { state: 'logged-out', checkedAt: T(0) } })], [], [view])
    expect(built.rooms).toEqual([{ workspaceId: 'ws1', name: 'Workspace ws1', cwd: '/repo', seated: [], waiting: [] }])
    expect(agent(built, 'claude').work).toHaveLength(1)
  })
})

describe('labels, summary and appearance', () => {
  it('activityLabel formats, collapses whitespace and truncates', () => {
    expect(activityLabel(undefined)).toBeUndefined()
    expect(activityLabel({ kind: 'tool', label: 'Edit', detail: 'src/a.ts', at: T(0) })).toBe('Edit src/a.ts')
    expect(activityLabel({ kind: 'tool', label: 'Bash', at: T(0) })).toBe('Bash')
    expect(activityLabel({ kind: 'thinking', label: 'whatever', at: T(0) })).toBe('Thinking…')
    expect(activityLabel({ kind: 'notice', label: 'Switched  to\n codex', at: T(0) })).toBe('Switched to codex')
    const long = activityLabel({ kind: 'tool', label: 'Bash', detail: 'a'.repeat(100), at: T(0) })!
    expect(long).toHaveLength(60)
    expect(long.endsWith('…')).toBe(true)
  })

  it('officeSummary words each count, skips zeros and pluralizes', () => {
    const states = (...list: OfficeAgent['state'][]): OfficeAgent[] => list.map((state, index) => ({ providerId: String(index), name: '', state, work: [], running: 0, maxConcurrent: 1 }))
    expect(officeSummary([])).toBe('No agents')
    expect(officeSummary(states('idle'))).toBe('1 agent: 1 idle')
    expect(officeSummary(states('working', 'working', 'meeting', 'idle'))).toBe('4 agents: 2 working, 1 in a meeting, 1 idle')
    expect(officeSummary(states('waiting', 'cooldown', 'limited', 'logged-out', 'offline', 'disabled', 'idle'))).toBe('7 agents: 1 waiting, 1 idle, 5 away')
  })

  it('agentAppearance is deterministic, in range, and varies across the shipped ids', () => {
    expect(agentAppearance('claude', 'Claude Code')).toEqual(agentAppearance('claude', 'Claude Code'))
    const looks = ['claude', 'codex', 'copilot', 'opencode', 'ollama'].map((id) => agentAppearance(id, id))
    for (const look of looks) {
      expect(look.skin).toBeLessThan(3); expect(look.hair).toBeLessThan(4); expect(look.shirt).toBeLessThan(6)
    }
    expect(new Set(looks.map((look) => JSON.stringify(look))).size).toBe(5)
  })

  it('building the same snapshot twice gives a deep-equal scene and passes reviewCount through', () => {
    const providers = [provider('claude', { maxConcurrent: 2 }, { running: 2 }), provider('codex', { enabled: false })]
    const tasks = [running('t', 'claude')]
    const workspaces = [workspaceView('ws1', [turn('t1', 'claude', '@rev', 'running')])]
    const first = scene(providers, tasks, workspaces, { reviewCount: 3 })
    expect(scene(providers, tasks, workspaces, { reviewCount: 3 })).toEqual(first)
    expect(first.reviewCount).toBe(3)
    expect(first.summary).toBe('2 agents: 1 in a meeting, 1 away')
  })
})
