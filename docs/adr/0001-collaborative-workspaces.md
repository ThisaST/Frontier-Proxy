# ADR 0001 — Collaborative workspaces with AI participants

- **Status**: Proposed
- **Date**: 2026-08-06
- **Supersedes**: none
- **Related**: `CLAUDE.md` (control plane, skills, worktree isolation, bench)

## Context

Frontier today is task-shaped. A `ProxyTask` is one prompt, routed to one provider,
with failover, optional orchestration stages, and an optional bench comparison. The UI
mirrors that: a work queue on the left, a transcript on the right.

We want a second shape alongside it: a **workspace** — Slack/Teams for engineering,
where a repo has one long-lived conversation and several named AI participants sit in it
next to the human. You address a participant by `@handle`; only addressed participants
respond. There is no automatic routing.

The constraint that shapes everything below is **minimal breakage**. The existing task
chat, engine, router, and persisted state must keep working untouched, and today's
`frontier-state.json` must load unchanged.

## Decision

### D1 — A new domain model, not a reshaped `ProxyTask`

`Workspace`, `WorkspaceParticipant`, `WorkspaceMessage`, and `WorkspaceTurn` are new
types added to `src/shared/types.ts`. `PersistedState` gains `workspaces: Workspace[]`,
defaulted to `[]` on load, so an existing state file deserializes with no migration.

**Rejected**: reusing `ProxyTask.turns`. A `ProxyTask` carries provider failover,
`orchestrationStage`, `subtasks[]`, `bench`, `modelOverrideProviderId`, and a single
owning provider. A workspace conversation has none of those and contradicts several —
notably failover, which is incoherent when a message is addressed to a *named identity*.
Overloading the type would force every existing task code path to grow a "is this
actually a workspace?" branch, which is exactly the breakage we are avoiding.

### D2 — The renderer sees participants, never provider kinds

```ts
export type ParticipantKind = 'human' | 'agent'
export type ParticipantCapability = 'read-repo' | 'edit-files' | 'run-commands'

export interface WorkspaceParticipant {
  id: string
  handle: string          // '@handle', unique per workspace, lowercased on write
  name: string            // display name
  kind: ParticipantKind
  role: string            // free text — 'Backend reviewer', 'Docs'
  providerId?: string     // agent only; references ProviderConfig.id
  model?: string          // agent only; CLI-specific id, valid only for providerId
  capabilities: ParticipantCapability[]
  accent?: string         // avatar colour token
  enabled: boolean
}
```

The snapshot exposes `ParticipantView = WorkspaceParticipant & { available: boolean;
unavailableReason?: string }`, computed in the main process from `ProviderRuntime`. The
renderer renders roster rows, mention chips, and message avatars from that alone. It
must never read `ProviderConfig.kind`, and no `switch (kind)` may appear under
`src/renderer/`. Adding a sixth provider kind must not touch the workspace UI.

`model` stays paired with `providerId`, matching the existing rule that model ids are
CLI-specific and never travel between agents (`resolveTaskModel`). A participant's model
is only ever handed to that participant's own provider.

### D3 — Mentions are the only dispatch mechanism

`src/shared/mentions.ts` exports a pure `parseMentions(text, participants)` returning
`{ addressed: string[]; unknown: string[] }` — participant ids in first-occurrence order,
plus handles that matched nothing. It is unit-tested and shared by the renderer's
autocomplete and the main-process dispatcher, so the two cannot drift.

- No mention → the message is logged and nobody runs. This is the "no auto routing yet"
  requirement, and it is enforced in one place.
- Human participants are never dispatched to.
- A mention of a disabled or unavailable participant produces a **system message** in the
  thread naming the reason. It is never silently dropped.
- `@here` / `@all` are **not** implemented in v1. Fan-out to every agent in a repo is a
  quota event, and it should be a deliberate later decision.

### D4 — Agent replies never re-dispatch

Only human-authored messages trigger dispatch. If an agent's reply text contains
`@someone`, it is rendered as a chip but starts nothing.

Without this rule, two participants that mention each other spawn CLI processes until the
subscription quota is gone. Agent-to-agent conversation is a real future feature, but it
needs an explicit turn budget and a stop condition, which is a separate ADR.

### D5 — Parallel, independent fan-out

Every addressed participant starts at once and sees the identical thread prefix — every
message with `seq <= trigger.seq`. None of them see each other's replies.

Concurrency is bounded by the existing per-provider `maxConcurrent` and
`ProviderRuntime.running`. A turn whose provider is busy **waits for a slot** rather than
failing, reusing the lesson from `awaitSubtaskProvider`: with the shipped default of
`maxConcurrent: 1`, a naive implementation would fail the second lane the instant the
first started.

**There is no failover.** A message addressed to `@claude` that hits a quota wall becomes
a failed turn with a stated reason, exactly like a bench lane. Rerouting it to Codex
would put words in a named participant's mouth.

`dispatch()` takes a strategy object so a future `sequential` mode (each participant sees
prior replies) drops in without touching the message model or the UI.

### D6 — Per-turn worktree isolation for writing participants

A participant with `edit-files` runs in its own git worktree off `HEAD`, on branch
`frontier/ws-<workspaceSlug>/<seq>-<handle>`, reusing `createWorktree` /
`commitWorktree` / `removeWorktree` unchanged. The commit stays on the branch; the
worktree is torn down. `turn.branch` and `turn.committed` are recorded and the message
bubble links to the Review screen.

Participants without `edit-files` run directly in the workspace cwd. A non-git cwd falls
back to the shared directory for everyone, as orchestration already does.

The branch prefix stays `frontier/`, so `assertTaskBranch` keeps guarding diff, merge,
and delete with no change. `listBranchInbox` is called with the union of distinct task
cwds **and** workspace cwds.

**Accepted risk, stated plainly**: `capabilities` governs *isolation*, not *enforcement*.
`buildProviderCommand` bakes in `--permission-mode acceptEdits` and
`--sandbox workspace-write`, so a participant without `edit-files` is still technically
able to write — it just writes in the shared cwd rather than a worktree. Real read-only
enforcement means per-run permission flags, which is a provider-layer change and a
separate ADR. **The UI must label `edit-files` as "works on an isolated branch", not as a
permission.**

### D7 — Transcript context, no session resume

Each turn is built a fresh prompt: a workspace preamble (name, repo path, the participant
roster with roles), the attributed thread (`[@handle · role]`), then "You are @handle …
reply as yourself; answer only what you were asked." Frontier memory is prepended via the
existing `promptWithMemory`. The transcript is trimmed from the head against a token
budget, always keeping the trigger message.

**`--resume` is deliberately unused.** A resumed CLI session holds a private history that
diverges from the shared log the moment another participant speaks; the shared thread is
the single source of truth. This costs input tokens and is the right trade for
correctness. A per-participant session cache is a later optimisation.

### D8 — Control plane and skills are inherited, not re-invented

A workspace resolves the global `ControlPlaneProfile` and the cwd-scoped skills catalog
exactly as `activeRunProfile(task)` does today, keyed on the **workspace cwd**, never a
worktree path. Per-participant MCP servers or skill sets are explicitly out of scope for
v1.

### D9 — A separate stream channel

`WorkspaceStreamEvent { workspaceId, turnId, kind, data }` on a new
`frontier:workspace-stream` IPC channel. `StreamEvent` and `frontier:stream` are not
touched, so nothing in the task view can regress. `AppSnapshot` gains `workspaces`.

### D10 — New files, not edits to hot ones

| Concern | Location |
|---|---|
| Types, mention parser | `src/shared/types.ts` (additive), `src/shared/mentions.ts` (new) |
| Workspace runtime | `src/main/workspace.ts` (new) |
| Participant → provider adapter | `src/main/participants.ts` (new) |
| Renderer view | `src/renderer/src/workspace.ts` (new) |

`engine.ts` (1045 lines) and `renderer/src/main.ts` (2456 lines) receive only wiring:
construction, IPC registration, a nav item, and a `switchView` case. `providers.ts` is
read, not modified. `WorkspaceRuntime` receives its provider access through injected
accessors rather than importing the engine, so it is unit-testable with a fake runner and
so the dependency arrow never points back into `engine.ts`.

## Consequences

**Good.** The task view is untouched and cannot regress. Old state files load. Every
provider-specific concern stays behind `runProvider` and `controlPlaneInjection`, which
already exist and are tested. Adding a provider kind, or a second human later, does not
reach the workspace UI. `dispatch()` has one entry point, so auto-routing later means
adding a strategy, not rewriting the view.

**Costs.** Transcript replay per turn is more expensive than session resume. Branch churn
grows: one branch per writing turn, and the Review screen will need filtering if
workspaces get chatty. Two conversation models now exist in the codebase, and the
temptation to merge them later is real — the boundary is that a *task* has a lifecycle and
a router, a *workspace* has identities and a log.

**Invariants preserved.** No API keys anywhere in the participant model — a participant
names a `providerId` and authentication stays the CLI's own session. Prompts go over
stdin, `shell: false`, no Node in the renderer, all IPC through the typed preload bridge.

## Open questions, deliberately deferred

1. Multiple humans. The model has `kind: 'human'`, but there is no network layer and one
   local user. Modelled, not wired.
2. Auto-routing an unaddressed message to a best-fit participant.
3. Agent-to-agent conversation with a turn budget (see D4).
4. Real read-only enforcement per participant (see D6).
5. Threads or channels inside a workspace; v1 is one flat conversation.
