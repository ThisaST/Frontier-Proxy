import { randomUUID } from 'node:crypto'
import type {
  ActivityEvent, ParticipantRunInput, ParticipantRunResult, ParticipantRunner, ParticipantView, ProviderConfig, ProviderRuntime,
  Workspace, WorkspaceMessage, WorkspaceParticipant, WorkspaceStreamEvent, WorkspaceTurn, WorkspaceTurnStatus, WorkspaceView
} from '../shared/types'
import { isValidHandle, normalizeHandle, parseMentions } from '../shared/mentions'
import { activeSessions, sessionBlocked } from '../shared/sessions'
import { branchSlug, commitWorktree, createWorktree, isGitRepo, removeWorktree } from './worktree'

// Duplicated from engine.ts's FILE_TOOL_ACTIONS/recordFileChange: workspace.ts must not
// import engine.ts (the dependency arrow points inward, ADR D10), and the helper isn't
// exported. Keep the two maps in sync by hand if a new mutating tool is added.
const FILE_TOOL_ACTIONS: Record<string, 'create' | 'edit' | 'delete'> = {
  Write: 'create', Edit: 'edit', Delete: 'delete', MultiEdit: 'edit', NotebookEdit: 'edit', str_replace_editor: 'edit'
}

function recordTurnFileChange(turn: WorkspaceTurn, event: ActivityEvent): void {
  if (event.kind !== 'tool' || !event.detail) return
  const action = FILE_TOOL_ACTIONS[event.label]
  if (!action) return
  const existing = (turn.filesChanged ?? []).filter((change) => change.path !== event.detail)
  turn.filesChanged = [...existing, { path: event.detail, action, at: event.at }].slice(-50)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Why @handle can't be reached right now, in the user's words — mirrors router.ts's
// skipReason, but for one named participant rather than a ranked field of providers:
// a workspace mention has no capability/mode scoring, only "can this identity run at all".
function participantUnavailableReason(participant: WorkspaceParticipant, provider: ProviderConfig | undefined, runtime: ProviderRuntime | undefined, now = Date.now()): string | undefined {
  if (!participant.enabled) return 'disabled in this workspace'
  if (!provider) return 'its provider is no longer configured'
  if (!provider.enabled) return `${provider.name} is turned off in Providers`
  if (!runtime?.available) return `${provider.name} CLI is not detected on this machine`
  if (runtime.cooldownUntil && Date.parse(runtime.cooldownUntil) > now) return `${provider.name} is cooling down after a usage limit`
  if (activeSessions(runtime, now).some((session) => sessionBlocked(session, now))) return `${provider.name} has reached its reported plan usage limit`
  return undefined
}

export interface WorkspaceRuntimeDeps {
  runner: ParticipantRunner
  listProviders(): ProviderConfig[]
  providerRuntime(providerId: string): ProviderRuntime | undefined
  claimProviderSlot(providerId: string): boolean // false when the provider is at maxConcurrent
  releaseProviderSlot(providerId: string): void
  persist(): void // ask the host to save + emit a snapshot
  emitStream(event: WorkspaceStreamEvent): void
}

// A pluggable fan-out shape so a future `sequential` strategy (each participant sees
// prior replies) drops in without touching postMessage/dispatch (ADR D5). Parallel is
// the only implementation shipped: every addressed participant starts at once.
export type DispatchStrategy = (starters: Array<() => Promise<void>>) => Promise<void>
export const parallelDispatch: DispatchStrategy = (starters) => Promise.all(starters.map((start) => start())).then(() => undefined)

export class WorkspaceRuntime {
  private readonly workspaces: Workspace[]
  private readonly controllers = new Map<string, AbortController>()

  constructor(private readonly deps: WorkspaceRuntimeDeps, initial: Workspace[] = []) {
    this.workspaces = [...initial]
  }

  list(): Workspace[] { return this.workspaces }
  find(workspaceId: string): Workspace | undefined { return this.workspaces.find((workspace) => workspace.id === workspaceId) }

  // Renderer-facing view: availability is computed here from ProviderRuntime, never in
  // the renderer, so it never has to reason about ProviderConfig.kind (ADR D2).
  snapshot(): WorkspaceView[] { return this.workspaces.map((workspace) => this.toView(workspace)) }

  private toView(workspace: Workspace): WorkspaceView {
    const participants: ParticipantView[] = workspace.participants.map((participant) => {
      if (participant.kind === 'human') return { ...participant, available: true }
      const provider = this.deps.listProviders().find((item) => item.id === participant.providerId)
      const runtime = provider ? this.deps.providerRuntime(provider.id) : undefined
      const reason = participantUnavailableReason(participant, provider, runtime)
      return { ...participant, available: !reason, unavailableReason: reason }
    })
    return { ...workspace, participants }
  }

  private require(workspaceId: string): Workspace {
    const workspace = this.find(workspaceId)
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found.`)
    return workspace
  }

  createWorkspace(name: string, cwd: string): Workspace {
    const human: WorkspaceParticipant = { id: randomUUID(), handle: 'you', name: 'You', kind: 'human', role: 'Local user', capabilities: [], enabled: true }
    const workspace: Workspace = { id: randomUUID(), name, cwd, participants: [human], messages: [], turns: [], createdAt: new Date().toISOString(), nextSeq: 1 }
    this.workspaces.push(workspace)
    this.deps.persist()
    return workspace
  }

  renameWorkspace(workspaceId: string, name: string): Workspace {
    const workspace = this.require(workspaceId)
    workspace.name = name
    this.deps.persist()
    return workspace
  }

  deleteWorkspace(workspaceId: string): void {
    const workspace = this.find(workspaceId)
    for (const turn of workspace?.turns ?? []) this.controllers.get(turn.id)?.abort()
    const index = this.workspaces.findIndex((item) => item.id === workspaceId)
    if (index >= 0) this.workspaces.splice(index, 1)
    this.deps.persist()
  }

  // Accepts a participant with or without an id: omitting one creates a new entry,
  // supplying an existing one updates it in place.
  upsertParticipant(workspaceId: string, participant: Omit<WorkspaceParticipant, 'id'> & { id?: string }): WorkspaceParticipant {
    const workspace = this.require(workspaceId)
    if (!isValidHandle(participant.handle)) throw new Error(`"${participant.handle}" is not a valid handle.`)
    const handle = normalizeHandle(participant.handle)
    const clash = workspace.participants.find((item) => item.id !== participant.id && normalizeHandle(item.handle) === handle)
    if (clash) throw new Error(`@${handle} is already used by ${clash.name} in this workspace.`)
    const next: WorkspaceParticipant = { ...participant, id: participant.id ?? randomUUID(), handle }
    const index = workspace.participants.findIndex((item) => item.id === next.id)
    if (index >= 0) workspace.participants[index] = next
    else workspace.participants.push(next)
    this.deps.persist()
    return next
  }

  removeParticipant(workspaceId: string, participantId: string): void {
    const workspace = this.require(workspaceId)
    workspace.participants = workspace.participants.filter((participant) => participant.id !== participantId)
    this.deps.persist()
  }

  // Only human-authored messages ever reach dispatch (ADR D4) — this is the sole
  // entry point that logs a message AND may spawn turns for it.
  async postMessage(workspaceId: string, text: string, strategy: DispatchStrategy = parallelDispatch): Promise<WorkspaceMessage> {
    const workspace = this.require(workspaceId)
    const human = workspace.participants.find((participant) => participant.kind === 'human')
    const { addressed, unknown } = parseMentions(text, workspace.participants)
    const message: WorkspaceMessage = {
      id: randomUUID(), seq: workspace.nextSeq++, author: 'human', participantId: human?.id, text, createdAt: new Date().toISOString(), addressed
    }
    workspace.messages.push(message)
    this.deps.persist()
    await this.dispatch(workspace, message, unknown, strategy)
    return message
  }

  private systemMessage(workspace: Workspace, reason: string): void {
    workspace.messages.push({ id: randomUUID(), seq: workspace.nextSeq++, author: 'system', text: reason, createdAt: new Date().toISOString(), addressed: [], systemReason: reason })
  }

  private async dispatch(workspace: Workspace, trigger: WorkspaceMessage, unknownHandles: string[], strategy: DispatchStrategy): Promise<void> {
    // Defensive: postMessage is the only caller and always builds a human-authored
    // trigger, but this guards the invariant explicitly (ADR D4) against future misuse.
    if (trigger.author !== 'human') return
    for (const handle of unknownHandles) this.systemMessage(workspace, `No participant named @${handle} in this workspace.`)

    const starters: Array<() => Promise<void>> = []
    for (const participantId of trigger.addressed) {
      const participant = workspace.participants.find((item) => item.id === participantId)
      if (!participant || participant.kind === 'human') continue // humans are never dispatched to
      const provider = this.deps.listProviders().find((item) => item.id === participant.providerId)
      const runtime = provider ? this.deps.providerRuntime(provider.id) : undefined
      const reason = participantUnavailableReason(participant, provider, runtime)
      if (reason) { this.systemMessage(workspace, `Can't reach @${participant.handle}: ${reason}.`); continue }
      starters.push(() => this.runTurn(workspace, trigger, participant, trigger.seq))
    }
    if (starters.length) await strategy(starters)
    this.deps.persist()
  }

  private async runTurn(workspace: Workspace, trigger: WorkspaceMessage, participant: WorkspaceParticipant, historySeq: number): Promise<void> {
    const turn: WorkspaceTurn = {
      id: randomUUID(), workspaceId: workspace.id, messageId: trigger.id, participantId: participant.id,
      providerId: participant.providerId!, status: 'queued', output: ''
    }
    workspace.turns.push(turn)
    this.deps.persist()
    await this.executeTurn(workspace, trigger, participant, turn, historySeq)
  }

  // A turn whose provider is at maxConcurrent waits for a slot rather than failing —
  // the awaitSubtaskProvider lesson (engine.ts): with the shipped maxConcurrent: 1
  // default, a naive implementation fails the second lane the instant the first starts.
  private async awaitSlot(participant: WorkspaceParticipant, turn: WorkspaceTurn, controller: AbortController): Promise<boolean> {
    const providerId = participant.providerId!
    for (;;) {
      if (controller.signal.aborted) { turn.status = 'cancelled'; turn.error = 'Cancelled before it could start.'; turn.failureKind = 'cancelled'; return false }
      const provider = this.deps.listProviders().find((item) => item.id === providerId)
      const runtime = this.deps.providerRuntime(providerId)
      const reason = participantUnavailableReason(participant, provider, runtime)
      if (reason) { turn.status = 'failed'; turn.error = `Can't reach @${participant.handle}: ${reason}.`; turn.failureKind = 'unavailable'; return false }
      if (this.deps.claimProviderSlot(providerId)) return true
      await sleep(50)
    }
  }

  private async executeTurn(workspace: Workspace, trigger: WorkspaceMessage, participant: WorkspaceParticipant, turn: WorkspaceTurn, historySeq: number): Promise<void> {
    const controller = new AbortController()
    this.controllers.set(turn.id, controller)
    const providerId = participant.providerId!
    try {
      const claimed = await this.awaitSlot(participant, turn, controller)
      if (!claimed) { this.deps.persist(); return }
      try {
        if (controller.signal.aborted) { turn.status = 'cancelled'; turn.error = 'Task cancelled.'; turn.failureKind = 'cancelled'; return }
        turn.status = 'running'
        turn.startedAt = new Date().toISOString()
        this.deps.persist()

        let workdir = workspace.cwd
        const isolate = participant.capabilities.includes('edit-files') && await isGitRepo(workspace.cwd)
        if (isolate) {
          // Attempt number = this turn's position among turns already run for the same
          // trigger+participant (persisted turn order, so it's stable across restarts).
          // retryTurn re-runs the same trigger/participant and would otherwise derive the
          // exact same branch name as the original, so createWorktree collides every time.
          const siblings = workspace.turns.filter((item) => item.messageId === trigger.id && item.participantId === participant.id)
          const attempt = siblings.indexOf(turn) + 1
          const base = `frontier/ws-${branchSlug(workspace.name)}/${trigger.seq}-${normalizeHandle(participant.handle)}`
          const branch = attempt <= 1 ? base : `${base}-${attempt}` // Branch prefix stays `frontier/` so assertTaskBranch (branches.ts) keeps guarding it (ADR D6).
          try {
            workdir = await createWorktree(workspace.cwd, branch)
            turn.branch = branch
          } catch (err) {
            // Deliberately diverges from orchestrate/bench's silent worktree-fallback: their
            // fallback runs in the task's own cwd, which is still where the user expects
            // writes. Here the participant is explicitly labelled branch-isolated in the UI,
            // so silently writing to the real working tree would break that promise — fail
            // the turn instead. Don't "fix" this back to a fallback.
            turn.status = 'failed'
            turn.error = `Couldn't create an isolated branch for @${participant.handle}: ${err instanceof Error ? err.message : String(err)}`
            turn.failureKind = 'failed'
            return
          }
        }
        try {
          const history = workspace.messages.filter((message) => message.seq <= historySeq)
          const input: ParticipantRunInput = {
            workspace, participant, trigger, history, cwd: workdir, signal: controller.signal,
            onOutput: (chunk) => {
              turn.output += chunk
              this.deps.emitStream({ workspaceId: workspace.id, turnId: turn.id, kind: 'output', data: chunk })
              this.deps.persist()
            },
            onActivity: (event) => { turn.activity = [...(turn.activity ?? []), event].slice(-100); recordTurnFileChange(turn, event); this.deps.persist() },
            onModel: (model) => { turn.model = model; this.deps.persist() }
          }
          const result = await this.deps.runner.run(input)
          const status = this.applyResult(turn, result, controller)
          if (turn.branch && status === 'completed') turn.committed = await commitWorktree(workdir, `Frontier workspace: ${participant.name} replying to ${trigger.text.slice(0, 60)}`)
          if (status === 'completed' && turn.output.trim()) this.appendAgentMessage(workspace, participant, turn.output)
        } finally {
          if (workdir !== workspace.cwd) await removeWorktree(workspace.cwd, workdir)
        }
      } finally {
        this.deps.releaseProviderSlot(providerId)
      }
    } finally {
      this.controllers.delete(turn.id)
      this.deps.persist()
    }
  }

  // Returns the resolved status as a local value rather than relying on callers to
  // re-read turn.status: TS narrows a just-assigned property to its literal type across
  // the awaits above, so comparing turn.status again after this call needs the value
  // handed back explicitly instead.
  private applyResult(turn: WorkspaceTurn, result: ParticipantRunResult, controller: AbortController): WorkspaceTurnStatus {
    turn.finishedAt = new Date().toISOString()
    if (!turn.output.trim() && result.output) turn.output = result.output
    if (!turn.model && result.model) turn.model = result.model
    // No failover, ever (ADR D5): a quota/unavailable/normal failure just stops this
    // turn with its reason — never reroutes to another provider.
    turn.status = controller.signal.aborted || result.failureKind === 'cancelled' ? 'cancelled' : result.ok ? 'completed' : 'failed'
    if (!result.ok) { turn.error = result.error; turn.failureKind = result.failureKind }
    return turn.status
  }

  // This is the only place an agent's reply is appended, and it never calls dispatch —
  // even when the reply text itself contains @mentions, it must not spawn more turns
  // (ADR D4). `addressed` is still resolved so the UI can render mention chips.
  private appendAgentMessage(workspace: Workspace, participant: WorkspaceParticipant, text: string): void {
    const addressed = parseMentions(text, workspace.participants).addressed
    workspace.messages.push({ id: randomUUID(), seq: workspace.nextSeq++, author: 'agent', participantId: participant.id, text, createdAt: new Date().toISOString(), addressed })
  }

  // Re-runs one participant against the same trigger message as a NEW turn — history
  // is never mutated, so the failed/cancelled original stays visible for comparison.
  async retryTurn(workspaceId: string, turnId: string): Promise<WorkspaceTurn> {
    const workspace = this.require(workspaceId)
    const original = workspace.turns.find((item) => item.id === turnId)
    if (!original) throw new Error(`Turn ${turnId} not found.`)
    const trigger = workspace.messages.find((message) => message.id === original.messageId)
    const participant = workspace.participants.find((item) => item.id === original.participantId)
    if (!trigger || !participant) throw new Error('Cannot retry: the original message or participant no longer exists.')
    const turn: WorkspaceTurn = {
      id: randomUUID(), workspaceId: workspace.id, messageId: trigger.id, participantId: participant.id,
      providerId: participant.providerId ?? original.providerId, status: 'queued', output: ''
    }
    workspace.turns.push(turn)
    this.deps.persist()
    await this.executeTurn(workspace, trigger, participant, turn, trigger.seq)
    return turn
  }

  cancelTurn(workspaceId: string, turnId: string): void {
    const workspace = this.require(workspaceId)
    const turn = workspace.turns.find((item) => item.id === turnId)
    if (!turn || turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled') return
    this.controllers.get(turnId)?.abort()
  }
}
