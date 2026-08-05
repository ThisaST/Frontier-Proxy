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
| P2 workspace runtime | engine-orchestration | ⏳ running | — |
| P3 participant adapter | provider-integration | ⏳ running | — |
| P4 IPC bridge | renderer-ui | ⬜ pending | — |
| P5 renderer view | renderer-ui | ⬜ pending | — |
| P6 Review inbox integration | engine-orchestration | ⬜ pending | — |
| P7 test hardening + invariant review | test-author → invariant-reviewer | ⬜ pending | — |

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

## Known follow-ups (not in scope for P1–P7)

- `capabilities` governs isolation, not enforcement — a participant without `edit-files`
  can still write, it just writes in the shared cwd (ADR D6). Real read-only needs
  per-run permission flags in the provider layer.
- Agent-to-agent conversation, `@here`, auto-routing, multi-human, and in-workspace
  threads are all deferred by the ADR.
