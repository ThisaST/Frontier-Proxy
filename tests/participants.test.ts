import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { buildParticipantPrompt, CliParticipantRunner, resolveParticipantModel, type ParticipantRunnerDeps } from '../src/main/participants'
import type { ModelOwner } from '../src/main/providers'
import type {
  ControlPlaneProfile, ParticipantRunInput, ProviderConfig, ResolvedSkill, Workspace, WorkspaceMessage, WorkspaceParticipant
} from '../src/shared/types'

function participant(overrides: Partial<WorkspaceParticipant> = {}): WorkspaceParticipant {
  return {
    id: 'p-claude', handle: 'claude', name: 'Claude', kind: 'agent', role: 'Backend reviewer',
    providerId: 'claude', capabilities: ['read-repo', 'edit-files'], enabled: true, ...overrides
  }
}

function humanParticipant(overrides: Partial<WorkspaceParticipant> = {}): WorkspaceParticipant {
  return { id: 'p-human', handle: 'thisara', name: 'Thisara', kind: 'human', role: 'Owner', capabilities: [], enabled: true, ...overrides }
}

function message(overrides: Partial<WorkspaceMessage> = {}): WorkspaceMessage {
  return { id: 'm1', seq: 1, author: 'human', participantId: 'p-human', text: 'hello', createdAt: new Date().toISOString(), addressed: [], ...overrides }
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws1', name: 'Payments', cwd: '/repo/payments', participants: [humanParticipant(), participant()],
    messages: [], turns: [], createdAt: new Date().toISOString(), nextSeq: 1, ...overrides
  }
}

function runInput(overrides: Partial<ParticipantRunInput> = {}): Omit<ParticipantRunInput, 'signal' | 'onOutput' | 'onActivity' | 'onModel'> {
  const ws = overrides.workspace ?? workspace()
  const trigger = overrides.trigger ?? message({ id: 'trigger', seq: 5, text: '@claude can you review this?', addressed: ['p-claude'] })
  const history = overrides.history ?? [message({ id: 'm0', seq: 1, text: 'earlier context' }), trigger]
  return { workspace: ws, participant: overrides.participant ?? participant(), trigger, history, cwd: overrides.cwd ?? ws.cwd }
}

describe('buildParticipantPrompt', () => {
  it('renders every enabled participant in the roster and omits disabled ones', () => {
    const ws = workspace({
      participants: [
        humanParticipant(),
        participant(),
        participant({ id: 'p-codex', handle: 'codex', name: 'Codex', role: 'Docs', providerId: 'codex', enabled: false })
      ]
    })
    const prompt = buildParticipantPrompt(runInput({ workspace: ws }), '')
    expect(prompt).toContain('@thisara — Thisara, Owner')
    expect(prompt).toContain('@claude — Claude, Backend reviewer')
    expect(prompt).not.toContain('@codex')
  })

  it('attributes human, agent, and system messages, oldest first', () => {
    const ws = workspace()
    const history: WorkspaceMessage[] = [
      message({ id: 'm1', seq: 1, author: 'human', participantId: 'p-human', text: 'first message' }),
      message({ id: 'm2', seq: 2, author: 'system', participantId: undefined, text: '@codex is not available', systemReason: 'disabled' }),
      message({ id: 'm3', seq: 3, author: 'agent', participantId: 'p-claude', text: 'on it' })
    ]
    const trigger = history[2]
    const prompt = buildParticipantPrompt(runInput({ workspace: ws, history, trigger }), '')
    expect(prompt.indexOf('[@thisara · Owner]')).toBeGreaterThanOrEqual(0)
    expect(prompt.indexOf('[system]')).toBeGreaterThan(prompt.indexOf('[@thisara · Owner]'))
    expect(prompt.indexOf('[@claude · Backend reviewer]')).toBeGreaterThan(prompt.indexOf('[system]'))
    expect(prompt).toContain('first message')
    expect(prompt).toContain('@codex is not available')
    expect(prompt).toContain('on it')
  })

  it('names the addressed participant and role in the "you are" block', () => {
    const prompt = buildParticipantPrompt(runInput({ participant: participant({ handle: 'claude', role: 'Backend reviewer' }) }), '')
    expect(prompt).toContain('You are @claude, the Backend reviewer in this workspace.')
    expect(prompt).toContain('Reply as yourself, in your own voice.')
    expect(prompt).toContain('Do not roleplay as anyone else.')
  })

  it('tells an edit-files participant its changes land on an isolated branch', () => {
    const prompt = buildParticipantPrompt(runInput({ participant: participant({ capabilities: ['read-repo', 'edit-files'] }) }), '')
    expect(prompt).toContain('Any file changes you make in this turn land on an isolated branch for review.')
  })

  it('asks a non-edit-files participant not to modify files, worded as a request not a guarantee', () => {
    const prompt = buildParticipantPrompt(runInput({ participant: participant({ capabilities: ['read-repo'] }) }), '')
    expect(prompt).toContain('Please answer without modifying any files in this turn — this is a request, not an enforced restriction.')
    expect(prompt).not.toContain('isolated branch')
  })

  it('drops the oldest messages under a tight token budget while always keeping the trigger', () => {
    const trigger = message({ id: 'trigger', seq: 3, text: 'the actual question', participantId: 'p-human' })
    const history = [
      message({ id: 'm1', seq: 1, text: 'a'.repeat(400), participantId: 'p-human' }),
      message({ id: 'm2', seq: 2, text: 'b'.repeat(400), participantId: 'p-human' }),
      trigger
    ]
    const prompt = buildParticipantPrompt(runInput({ history, trigger }), '', 40)
    expect(prompt).toContain('the actual question')
    expect(prompt).not.toContain('a'.repeat(400))
    expect(prompt).toContain('[Earlier messages in this workspace were omitted to fit the context budget.]')
  })

  it('never drops the trigger message even under an impossibly tight budget', () => {
    const trigger = message({ id: 'trigger', seq: 1, text: 'only message', participantId: 'p-human' })
    const prompt = buildParticipantPrompt(runInput({ history: [trigger], trigger }), '', 1)
    expect(prompt).toContain('only message')
  })

  it('prepends Frontier memory when non-empty and omits it when empty', () => {
    const withMemory = buildParticipantPrompt(runInput(), 'remember the deploy checklist')
    expect(withMemory).toContain('[Frontier memory — persistent context you should use]')
    expect(withMemory).toContain('remember the deploy checklist')

    const withoutMemory = buildParticipantPrompt(runInput(), '')
    expect(withoutMemory).not.toContain('[Frontier memory')
  })
})

describe('resolveParticipantModel', () => {
  const owners: ModelOwner[] = [
    { id: 'claude', kind: 'claude', models: ['claude-opus-5', 'claude-sonnet-5'] },
    { id: 'codex', kind: 'codex', model: 'gpt-5-codex' }
  ]

  it('hands a participant\'s model to its own provider', () => {
    const claudeProvider: ProviderConfig = { id: 'claude', name: 'Claude Code', kind: 'claude', enabled: true, executable: 'claude', priority: 1, maxConcurrent: 1, capabilities: ['coding'] }
    const p = participant({ providerId: 'claude', model: 'claude-opus-5' })
    const resolved = resolveParticipantModel(claudeProvider, p, owners)
    expect(resolved.model).toBe('claude-opus-5')
  })

  it('does not apply the model when the resolved provider differs from the one it was picked for', () => {
    const codexProvider: ProviderConfig = { id: 'codex', name: 'Codex', kind: 'codex', enabled: true, executable: 'codex', priority: 1, maxConcurrent: 1, capabilities: ['coding'] }
    // A participant whose model was picked for `claude`, mistakenly evaluated against `codex`.
    const p = participant({ providerId: 'claude', model: 'claude-opus-5' })
    const resolved = resolveParticipantModel(codexProvider, p, owners)
    expect(resolved.model).toBe('gpt-5-codex')
  })
})

describe('CliParticipantRunner', () => {
  const controlPlane: ControlPlaneProfile = { systemPrompt: '', addDirs: [], allowedTools: [], disallowedTools: [], mcpServers: [], strictMcp: false }
  const skills: ResolvedSkill[] = []

  function deps(overrides: Partial<ParticipantRunnerDeps> = {}): ParticipantRunnerDeps {
    return {
      findProvider: () => undefined,
      modelOwners: () => [],
      controlPlane: async () => controlPlane,
      resolveSkills: async () => skills,
      memory: () => '',
      ...overrides
    }
  }

  it('reports an unavailable failure when the participant\'s provider is missing', async () => {
    const runner = new CliParticipantRunner(deps())
    const result = await runner.run({ ...runInput(), signal: new AbortController().signal, onOutput: () => undefined, onActivity: () => undefined, onModel: () => undefined })
    expect(result.ok).toBe(false)
    expect(result.failureKind).toBe('unavailable')
    expect(result.error).toContain('claude')
  })

  it('reports an unavailable failure when the participant\'s provider is disabled', async () => {
    const disabled: ProviderConfig = { id: 'claude', name: 'Claude Code', kind: 'claude', enabled: false, executable: 'claude', priority: 1, maxConcurrent: 1, capabilities: ['coding'] }
    const runner = new CliParticipantRunner(deps({ findProvider: () => disabled }))
    const result = await runner.run({ ...runInput(), signal: new AbortController().signal, onOutput: () => undefined, onActivity: () => undefined, onModel: () => undefined })
    expect(result.ok).toBe(false)
    expect(result.failureKind).toBe('unavailable')
  })

  it('runs a real process over stdin, with no shell, and never sets a resume session', async () => {
    const custom: ProviderConfig = {
      id: 'claude', name: 'Test agent', kind: 'custom', enabled: true, executable: process.execPath,
      args: ['-e', "process.stdin.on('data',d=>process.stdout.write(d.toString().toUpperCase()))"],
      priority: 1, maxConcurrent: 1, capabilities: ['coding']
    }
    const runner = new CliParticipantRunner(deps({ findProvider: () => custom }))
    let streamed = ''
    const input = { ...runInput(), cwd: process.cwd(), signal: new AbortController().signal, onOutput: (chunk: string) => { streamed += chunk }, onActivity: () => undefined, onModel: () => undefined }
    const result = await runner.run(input)
    expect(result.ok).toBe(true)
    // The built prompt (containing the trigger text) was delivered on stdin, not argv.
    const builtPrompt = buildParticipantPrompt(input, '')
    expect(result.output).toBe(builtPrompt.toUpperCase())
    expect(streamed).toBe(result.output)
  })

  it('forwards control plane, skills, and callbacks, and never passes a resumeSessionId', async () => {
    const providers = await import('../src/main/providers')
    const spy = vi.spyOn(providers, 'runProvider').mockResolvedValue({ ok: true, output: 'done', model: 'claude-opus-5' })
    const claudeProvider: ProviderConfig = { id: 'claude', name: 'Claude Code', kind: 'claude', enabled: true, executable: 'claude', priority: 1, maxConcurrent: 1, capabilities: ['coding'] }
    const owners: ModelOwner[] = [{ id: 'claude', kind: 'claude', model: 'claude-sonnet-5' }]
    const runner = new CliParticipantRunner(deps({ findProvider: () => claudeProvider, modelOwners: () => owners, controlPlane: async () => controlPlane, resolveSkills: async () => skills }))
    const onModel = vi.fn()
    const input = { ...runInput({ participant: participant({ providerId: 'claude', model: 'claude-opus-5' }) }), signal: new AbortController().signal, onOutput: () => undefined, onActivity: () => undefined, onModel }
    const result = await runner.run(input)

    expect(spy).toHaveBeenCalledTimes(1)
    const [providerArg, options] = spy.mock.calls[0]
    expect(providerArg.model).toBe('claude-opus-5')
    expect(options.controlPlane).toBe(controlPlane)
    expect(options.skills).toBe(skills)
    expect(options.onModel).toBe(onModel)
    expect('resumeSessionId' in options ? options.resumeSessionId : undefined).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(result.model).toBe('claude-opus-5')
    spy.mockRestore()
  })

  it('never spawns a process itself — only providers.ts is allowed to', () => {
    const source = readFileSync(new URL('../src/main/participants.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/\bspawn\(|\bexec\(|shell:\s*true/)
  })
})
