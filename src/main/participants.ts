// Adapts the existing single-provider `runProvider` pipeline to the workspace
// participant contract (ADR 0001, P3). Reads providers.ts; never modifies it.
import { estimateTokens } from '../shared/classify'
import type {
  ControlPlaneProfile, ParticipantRunInput, ParticipantRunResult, ParticipantRunner,
  ProviderConfig, ResolvedSkill, RunFailureKind, Workspace, WorkspaceMessage, WorkspaceParticipant
} from '../shared/types'
import { resolveTaskModel, runProvider, type ModelOwner, type RunFailureKind as ProviderRunFailureKind } from './providers'

// providers.ts and shared/types.ts each define an identical `RunFailureKind`
// union, duplicated on purpose (src/shared cannot import src/main — see
// CLAUDE.md). Map explicitly so a future divergence between the two unions
// fails to compile here instead of silently mismatching.
function toRunFailureKind(kind: ProviderRunFailureKind | undefined): RunFailureKind | undefined {
  return kind
}

// Injected accessors, not an `engine.ts` import, so this stays unit-testable
// with a fake runner and the dependency arrow never points back into the
// engine (ADR D10). `controlPlane`/`resolveSkills`/`memory` are functions
// rather than snapshotted values because settings can change between turns.
export interface ParticipantRunnerDeps {
  findProvider(providerId: string): ProviderConfig | undefined
  // Every configured provider's model identity, for the same cross-CLI
  // containment `engine.ts`'s `withModel` applies to tasks.
  modelOwners(): ModelOwner[]
  // The shared control-plane profile, MCP-auth resolved exactly as
  // `activeRunProfile` resolves it for a task (ADR D8).
  controlPlane(): Promise<ControlPlaneProfile>
  // The cwd-scoped skill catalog, resolved with the global disabled-set —
  // keyed on the *workspace* cwd, never a per-turn worktree path (ADR D8).
  resolveSkills(cwd: string): Promise<ResolvedSkill[]>
  memory(): string
}

// A participant's `model` is valid only for its own `providerId` (ADR D2) —
// the same rule `resolveTaskModel`/`withModel` enforce for tasks. Exported and
// pure so the containment can be tested without spawning a CLI.
export function resolveParticipantModel(provider: ProviderConfig, participant: WorkspaceParticipant, owners: ModelOwner[]): ProviderConfig {
  const owner = owners.find((item) => item.id === provider.id) ?? { id: provider.id, kind: provider.kind, model: provider.model }
  const model = resolveTaskModel(owner, participant.model, participant.providerId, owners)
  return model === provider.model ? provider : { ...provider, model }
}

const DEFAULT_PROMPT_TOKEN_BUDGET = 6_000
const OMISSION_MARKER = '[Earlier messages in this workspace were omitted to fit the context budget.]'

function rosterById(workspace: Workspace): Map<string, WorkspaceParticipant> {
  return new Map(workspace.participants.map((participant) => [participant.id, participant]))
}

function rosterLines(workspace: Workspace): string[] {
  return workspace.participants.filter((participant) => participant.enabled)
    .map((participant) => `@${participant.handle} — ${participant.name}, ${participant.role}`)
}

function workspacePreamble(workspace: Workspace): string {
  return [`Workspace: ${workspace.name}`, `Repo: ${workspace.cwd}`, 'Participants in this workspace:', ...rosterLines(workspace)].join('\n')
}

function messageLabel(message: WorkspaceMessage, roster: Map<string, WorkspaceParticipant>): string {
  if (message.author === 'system') return '[system]'
  const participant = message.participantId ? roster.get(message.participantId) : undefined
  return participant ? `[@${participant.handle} · ${participant.role}]` : '[system]'
}

function formatMessage(message: WorkspaceMessage, roster: Map<string, WorkspaceParticipant>): string {
  return `${messageLabel(message, roster)}\n${message.text}`
}

// `history` is documented as "messages with seq <= trigger.seq", which already
// includes the trigger — but guard the pure function against callers (tests,
// or a future strategy) that pass a history without it, since keeping the
// trigger is the one truncation rule that is never negotiable.
function transcriptMessages(history: WorkspaceMessage[], trigger: WorkspaceMessage): WorkspaceMessage[] {
  return history.some((message) => message.id === trigger.id) ? history : [...history, trigger]
}

// Trims from the head against a token budget, always keeping the trigger
// message (the last one), and marks when something was dropped.
function buildTranscript(history: WorkspaceMessage[], trigger: WorkspaceMessage, roster: Map<string, WorkspaceParticipant>, tokenBudget: number): string {
  let kept = transcriptMessages(history, trigger).map((message) => formatMessage(message, roster))
  let dropped = 0
  while (kept.length > 1 && estimateTokens(kept.join('\n\n')) > tokenBudget) { kept = kept.slice(1); dropped += 1 }
  return [...(dropped > 0 ? [OMISSION_MARKER] : []), ...kept].join('\n\n')
}

// Worded as an instruction, not a guarantee: `capabilities` governs worktree
// isolation, not enforcement — `acceptEdits`/`workspace-write` still let a
// non-`edit-files` participant write in the shared cwd (ADR D6 accepted risk).
function closingInstruction(participant: WorkspaceParticipant): string {
  const fileNote = participant.capabilities.includes('edit-files')
    ? 'Any file changes you make in this turn land on an isolated branch for review.'
    : 'Please answer without modifying any files in this turn — this is a request, not an enforced restriction.'
  return [
    `You are @${participant.handle}, the ${participant.role} in this workspace.`,
    'Reply as yourself, in your own voice.',
    'Answer only what you were asked in the last message — other participants were addressed separately and are answering in parallel.',
    'Do not roleplay as anyone else.',
    fileNote
  ].join(' ')
}

// Pure per ADR D7: workspace preamble, attributed transcript, "you are
// @handle" instruction, Frontier memory prepended (replicating
// `engine.ts`'s private `promptWithMemory` — see the P3 report for why it is
// replicated rather than imported). `tokenBudget` defaults but stays a
// parameter so tests can exercise truncation without a 6,000-token fixture.
export function buildParticipantPrompt(
  input: Omit<ParticipantRunInput, 'signal' | 'onOutput' | 'onActivity' | 'onModel'>,
  memory: string,
  tokenBudget = DEFAULT_PROMPT_TOKEN_BUDGET
): string {
  const roster = rosterById(input.workspace)
  const body = [
    workspacePreamble(input.workspace),
    buildTranscript(input.history, input.trigger, roster, tokenBudget),
    closingInstruction(input.participant)
  ].join('\n\n')
  const trimmedMemory = memory.trim()
  return trimmedMemory ? `[Frontier memory — persistent context you should use]\n${trimmedMemory}\n\n[Workspace conversation]\n${body}` : body
}

// Wraps `runProvider` for one participant's turn. Never sets `resumeSessionId`
// (ADR D7): the shared thread is the single source of truth, and a resumed
// private session would diverge the moment another participant speaks.
export class CliParticipantRunner implements ParticipantRunner {
  constructor(private readonly deps: ParticipantRunnerDeps) {}

  async run(input: ParticipantRunInput): Promise<ParticipantRunResult> {
    const providerId = input.participant.providerId
    const provider = providerId ? this.deps.findProvider(providerId) : undefined
    if (!provider || !provider.enabled) {
      return {
        ok: false, output: '',
        error: `@${input.participant.handle}'s provider (${providerId ?? 'none configured'}) is not configured or is disabled. Fix its setup or log that CLI in, then retry.`,
        failureKind: 'unavailable'
      }
    }

    const effectiveProvider = resolveParticipantModel(provider, input.participant, this.deps.modelOwners())
    const [controlPlane, skills] = await Promise.all([this.deps.controlPlane(), this.deps.resolveSkills(input.workspace.cwd)])
    const prompt = buildParticipantPrompt(input, this.deps.memory())

    const result = await runProvider(effectiveProvider, {
      prompt,
      cwd: input.cwd,
      signal: input.signal,
      onOutput: input.onOutput,
      onModel: input.onModel,
      onActivity: input.onActivity,
      controlPlane,
      skills
    })

    return { ok: result.ok, output: result.output, error: result.error, failureKind: toRunFailureKind(result.failureKind), model: result.model }
  }
}
