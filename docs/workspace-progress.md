# Workspace feature — build progress

Resume file. If a session is interrupted, read this plus `git log --oneline main..HEAD`
and continue at the first unchecked phase. Each phase is its own commit, so nothing needs
redoing.

- **Branch**: `feat/collaborative-workspaces`
- **Design**: [ADR 0001](adr/0001-collaborative-workspaces.md) ·
  [wireframe](workspace-wireframe.md) · [plan](workspace-implementation-plan.md)
- **Agents**: all implementation runs on sonnet, per the plan's phase assignments.

## Status

| Phase | Agent | State | Commit |
|---|---|---|---|
| P1 types + mentions + persistence | engine-orchestration | ✅ done | `5331afa` |
| P3 participant adapter | provider-integration | ✅ done | `5c7d316` |
| P2 workspace runtime | engine-orchestration | ✅ done | `e8b1366` |
| P4 IPC bridge + app wiring | engine-orchestration | ✅ done | `01c1dcb` |
| P5 renderer view | renderer-ui | ✅ done | `f1de5a6` |
| P6b Review deep link from branch chip | renderer-ui | ✅ done | `4ce028c` |
| P6 Review integration + branch safety | engine-orchestration | ✅ done | `b7c6243` |
| P7 test hardening | test-author | ✅ done | `2bbe275` |
| P7 invariant review | invariant-reviewer | ✅ passed | — |

**P1–P7 are complete and committed.** 229 tests across 21 files, `pnpm typecheck` clean,
`electron-vite build` succeeds. The invariant review found no hits on any hard invariant
or any of the feature's own stated invariants (ADR D2, D4–D8), each verified in code.

## Remaining: three low-severity review findings

Not blockers — the feature is functional and green without them. Both agents assigned to
these died on a session limit before writing anything, so the tree is clean and they can
simply be re-run.

1. **Break the renderer circular import** (`renderer-ui`). `src/renderer/src/main.ts`
   imports from `./workspace`, and `workspace.ts` imports `openBranchInReview` back from
   `./main`. It builds today only because every cross-reference sits inside an
   event-handler closure — evaluation-order luck. Extract `openBranchInReview` plus the
   `reviewSelection` / `reviewFilePath` state into a one-way `src/renderer/src/navigation.ts`
   both import. Behaviour-neutral; verify all three Review deep links still work (home row,
   bench-lane chip, workspace turn chip).
2. **Add a D8 regression test** (`test-author`). No test proves control plane and skills
   resolve from `workspace.cwd` rather than the per-turn worktree `input.cwd`. The code is
   correct; the test is missing. Construct an input where the two paths genuinely differ,
   capture the argument passed to `resolveSkills`, and assert it is the workspace cwd —
   this is what a "pass `input.cwd` everywhere for consistency" refactor would break.
3. **Add the promised `tests/branches.test.ts` case** (`test-author`). The P6 gate called
   for a case asserting a `frontier/ws-…` branch passes the guard and a non-`frontier/`
   name still throws. The guard is generically correct and covered, but the specific case
   was never added.

Informational, no action needed: the `run-commands` capability is modelled, editable, and
shown as a roster chip, but no code path differentiates it from `read-repo` yet. It is not
a shipped capability.

P4 was reassigned from renderer-ui to engine-orchestration: the hard part turned out to
be main-process construction, not the bridge.

## Standing constraints for every phase

- `src/main/providers.ts` has **unrelated uncommitted work** in the tree. Do not edit it
  and do not `git add` it. Import from it only.
- Commit with explicit paths, never `git add -A` — the tree also holds unrelated
  untracked files (`test.mcp.json`, `src/main/codex-rollout.ts`, `docs/publishing-article.md`).
- Every phase ends with `pnpm typecheck && pnpm test` green before its commit.

## Accepted deviations from the plan

- P1: `AppSnapshot.workspaces` is `WorkspaceView[]` (participants as `ParticipantView`),
  matching the existing `providers` pattern, and is optional so `engine.ts` and
  `store.save()` call sites stayed untouched. P4 may tighten it once those are wired.
- P1: `RunFailureKind` is duplicated between `src/shared/types.ts` and
  `src/main/providers.ts` rather than shared, because collapsing it means editing
  `providers.ts`. Revisit once that file's uncommitted work is resolved.

## Corrections made during the build

- **Retry branch collision (P6).** P2 derived a writing turn's branch from the trigger's
  `seq`, so a retry produced the same name and silently fell back to running in the user's
  working tree. The UI promises branch isolation, so a silent fallback is a broken promise —
  P6 gives retries a unique branch and fails the turn (with a stated reason) if a worktree
  genuinely cannot be created. This deliberately diverges from the fallback convention in
  `orchestrate`/`bench`, where the task cwd is already where the user expects writes.
- **MCP auth (P3).** The control plane is resolved through `McpAuthManager.profileWithAuth`,
  not a raw `settings.controlPlane` read, which would have silently skipped OAuth header
  injection for remote MCP servers.
- **Shared concurrency (P4).** Workspace turns claim slots from the same per-provider
  `runtimes` map tasks use, so a workspace turn and a task compete for one `maxConcurrent`
  slot rather than each getting a private pool.

## Deferred, with reasons

- The repo-context card omits the wireframe's "main · 2 uncommitted" line — no bridge method
  exposes a lightweight per-cwd git status, and adding one was outside P5's scope.

## Known follow-ups (not in scope for P1–P7)

- `capabilities` governs isolation, not enforcement — a participant without `edit-files`
  can still write, it just writes in the shared cwd (ADR D6). Real read-only needs
  per-run permission flags in the provider layer.
- Agent-to-agent conversation, `@here`, auto-routing, multi-human, and in-workspace
  threads are all deferred by the ADR.
