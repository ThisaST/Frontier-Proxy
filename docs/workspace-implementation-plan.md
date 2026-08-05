# Workspace feature — incremental implementation plan

Executes [ADR 0001](adr/0001-collaborative-workspaces.md) against
[the wireframe](workspace-wireframe.md). Every phase is independently shippable, leaves
`pnpm typecheck && pnpm test` green, and leaves the existing task view working.

All implementation agents run on **sonnet**. Every phase ends with `invariant-reviewer`
before the next one starts.

## Sequencing

```
P1 types + mentions + persistence          engine-orchestration
        │
        ├──────────────┬───────────────┐   ← P2 and P3 are parallel; P1 fixes the interface
        ▼              ▼               │
P2 workspace runtime  P3 participant adapter
   engine-orchestration  provider-integration
        └──────────────┴───────────────┘
                       ▼
P4 IPC bridge                              renderer-ui
                       ▼
P5 renderer view                           renderer-ui
                       ▼
P6 Review integration                      engine-orchestration
                       ▼
P7 test hardening + final review           test-author → invariant-reviewer
```

---

## P1 — Types, mention parser, persistence
**Agent**: `engine-orchestration` · **Files**: `src/shared/types.ts` (additive only),
`src/shared/mentions.ts` (new), `src/main/store.ts`, `src/shared/defaults.ts`

Add `Workspace`, `WorkspaceParticipant`, `WorkspaceMessage`, `WorkspaceTurn`,
`ParticipantView`, `WorkspaceStreamEvent` per ADR D2/D9. Add `workspaces: Workspace[]` to
`PersistedState` and `AppSnapshot`, defaulting to `[]` in `JsonStore.load` so an existing
`frontier-state.json` loads with no migration. A workspace whose turn was `running` at
shutdown is marked failed on load, mirroring the existing task rule.

Also define the runtime interface P2 and P3 both implement against, so they can run in
parallel:

```ts
export interface ParticipantRunner {
  run(input: ParticipantRunInput): Promise<ParticipantRunResult>
}
```

`src/shared/mentions.ts` exports pure `parseMentions(text, participants)` →
`{ addressed: string[]; unknown: string[] }`, first-occurrence order, handles lowercased,
`@handle` bounded so `email@nova.com` does not match.

**Gate**: `tests/mentions.test.ts` covers duplicate mentions, unknown handles,
punctuation-adjacent handles, code-fence exclusion, and the no-mention case. Loading a
pre-workspace state file yields `workspaces: []`.

---

## P2 — Workspace runtime
**Agent**: `engine-orchestration` · **Files**: `src/main/workspace.ts` (new),
`tests/workspace.test.ts` (new). `engine.ts` gets construction only.

`WorkspaceRuntime` owns CRUD (create/rename/delete workspace, add/edit/remove
participant), `postMessage`, and `dispatch`. It receives provider config, provider
runtime, and a `ParticipantRunner` through injected accessors — it must not import
`engine.ts` (ADR D10).

Dispatch, per ADR D3–D6:
- Only human-authored messages dispatch. Agent replies never re-dispatch.
- No mention → log only. Unknown or unavailable handle → system message with the reason.
- One turn per addressed agent, started in parallel, each seeing messages `seq <= trigger.seq`.
- A turn whose provider is at `maxConcurrent` waits for a slot rather than failing.
- No failover. A quota failure is a failed turn carrying its reason.
- `edit-files` participants get `createWorktree(cwd, 'frontier/ws-<slug>/<seq>-<handle>')`,
  then `commitWorktree`, then `removeWorktree`; record `turn.branch` / `turn.committed`.
  Non-git cwd falls back to the shared directory.
- Control plane and skills resolve from the **workspace cwd**, never the worktree path.

**Gate**: unit tests with a fake `ParticipantRunner` — parallel fan-out ordering, the
busy-provider wait, no-failover on quota, branch naming and slug safety, agent replies not
re-dispatching, worktree torn down on both success and failure.

---

## P3 — Participant → provider adapter
**Agent**: `provider-integration` · **Files**: `src/main/participants.ts` (new),
`tests/participants.test.ts` (new). `providers.ts` is read-only for this phase.

Implement `ParticipantRunner` over the existing `runProvider`. Build the turn prompt per
ADR D7: workspace preamble, roster with roles, attributed transcript, "you are @handle"
instruction, Frontier memory via `promptWithMemory`, tail-first truncation that always
keeps the trigger message. Export `buildParticipantPrompt` as a pure function.

Resolve the model with the existing rule — a participant's `model` is only ever passed to
its own `providerId`, reusing `resolveTaskModel` semantics. Do not set `resumeSessionId`
(ADR D7). Stream `onText`/`onActivity` back through the runner's callbacks so the bubble
can render live.

**Gate**: prompt-builder snapshot tests (roster rendering, attribution, truncation keeps
the trigger), model resolution for own-provider and foreign-provider cases, and a check
that no shell interpolation or API-key path was introduced.

---

## P4 — IPC bridge
**Agent**: `renderer-ui` · **Files**: `src/preload/index.ts`, `src/main/index.ts`,
`FrontierApi` in `src/shared/types.ts`

Add typed methods: `createWorkspace`, `updateWorkspace`, `deleteWorkspace`,
`upsertParticipant`, `removeParticipant`, `postWorkspaceMessage`, `retryWorkspaceTurn`,
`cancelWorkspaceTurn`, plus `onWorkspaceStream`. New channel
`frontier:workspace-stream`; `frontier:stream` and `StreamEvent` are not touched.

**Gate**: `pnpm typecheck` green; no new Node import reaches the renderer.

---

## P5 — Renderer view
**Agent**: `renderer-ui` · **Files**: `src/renderer/src/workspace.ts` (new),
`src/renderer/index.html`, `src/renderer/src/styles.css`,
`src/renderer/src/main.ts` (wiring only)

Build the wireframe. `main.ts` changes are limited to: importing the module, one nav
item, one `switchView` case, and one line in the snapshot re-render path. Everything else
lives in the new module.

Hard rule: no `ProviderKind` and no provider-name branching under `src/renderer/`. The
view renders `ParticipantView` only. The composer's mention autocomplete calls the shared
`parseMentions` — it does not re-implement matching. Capability copy is taken verbatim
from the wireframe, including the "not a permission boundary" line.

**Gate**: renderer builds; the view renders against a stubbed `window.frontier` in the
Browser pane (see the renderer-harness note in memory); the task view is visually and
behaviourally unchanged.

---

## P6 — Review inbox integration
**Agent**: `engine-orchestration` · **Files**: `src/main/index.ts` or wherever
`listBranchInbox` is called, `src/main/branches.ts` (only if grouping needs it)

Pass the union of distinct task cwds and workspace cwds. `assertTaskBranch` needs no
change — the prefix is still `frontier/`. Confirm a workspace branch can be diffed,
merged, and deleted through the existing screen.

**Gate**: existing `tests/branches.test.ts` still green, plus a case asserting a
`frontier/ws-…` branch passes the guard and a non-`frontier/` name still throws.

---

## P7 — Test hardening and final review
**Agents**: `test-author`, then `invariant-reviewer`

Fill coverage gaps across P1–P6 and run a full-feature invariant pass: no API keys in the
participant model, `shell: false` and prompt-over-stdin preserved, no Node in the
renderer, failover semantics unchanged for tasks and absent for workspaces, terse
single-line style matched.

---

## Rollback

Each phase is a separate commit on `feat/collaborative-workspaces`. P1–P4 are inert
without P5 — nothing in the shipped UI reaches them — so the feature can be abandoned at
any point before P5 by reverting the branch, with no state-file consequences.
