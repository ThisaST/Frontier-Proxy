# Frontier Proxy — Implementation Plan

Frontier is a **control plane above local, already-authenticated coding CLIs**
(Claude Code, Codex, GitHub Copilot, Ollama). Configure MCP / tools / context /
models once; Frontier routes and orchestrates work across providers and reports
real usage. No API keys for coding agents — auth is each CLI's own login. The one
narrow, opt-in exception is the Jev routing advisor (see the 2026-09-25 entry
below and [ADR 0002](docs/adr/0002-auxiliary-service-credentials.md)).

## 2026-09-25 — Renderer split, Phosphor Console, Jev advisor, new IA (branch: jev-routing-ui-improvements)

A full pass on the desktop UI and the routing stack, landed as five phases on one branch:

- **P1a — Renderer split.** The old monolithic renderer became `main.ts` (bootstrap),
  `state.ts`, `ui/` (`dom`, `format`, `feedback`, `icons`, `components`), `views/*` (one
  file per screen), `task-form.ts` (shared by Home and the ⌘N dialog), `project.ts`, and
  `theme.ts`. No behavior change; see CLAUDE.md's new "Renderer architecture & design
  system" section for the module map.
- **P1b — Phosphor Console.** A new visual identity: a retro-future instrument panel
  (`docs/design-phosphor-console.md`) — semantic design tokens (`styles/tokens.css`),
  Console (dark) / Daylight (light) themes following `prefers-color-scheme`, Chakra
  Petch / IBM Plex Sans / JetBrains Mono bundled with `@fontsource` (no CDN), Lucide
  icons (`ui/icons.ts`), and a component kit (`ui/components.ts`) — bezel panels with
  corner ticks, readouts, segmented gauges, status lamps, and a radar-sweep motif for
  "advising" states. Reskins the existing layout; IA changes were deliberately deferred
  to P3/P4 so the look could be judged on its own.
- **P2 — Jev backend.** The routing advisor: `src/main/advisor.ts` builds bounded,
  privacy-conscious requests (prompt + attachment names + optional lightweight repo
  facts, never file contents), `AdvisorKeyManager` encrypts the key with `safeStorage`,
  and `src/main/router.ts` folds Jev's typed answers into bounded, labelled
  `RoutingFactor`s gated on Off/Shadow/Active mode and a confidence threshold. Landed
  under [ADR 0002](docs/adr/0002-auxiliary-service-credentials.md), which narrows
  (rather than drops) the "no API keys" rule for auxiliary, non-agent services.
- **P3 — Information architecture, Home, Routing screen.** A composer-first Home with a
  live route preview (agent, model, radar sweep while scoring), a project switcher
  scoping the whole app to one repo, and a dedicated Routing screen — the Jev console:
  mode, credentials, the exact request payload preview, the model catalog, and the
  agreement summary.
- **P4 — Tasks and Agents.** Tasks became a three-pane screen (work queue, conversation,
  collapsible route/files/activity inspector) replacing the old detail-view/tab layout;
  the file viewer moved into an overlay. Providers became a dense Agents table with a
  per-row detail drawer instead of one card per provider.
- **P5 — Per-model learning, calibration, per-subtask advice.** `modelOutcomes` extends
  outcome-aware routing one level deeper (provider → model), Jev advice can now route
  individual orchestration subtasks by their own complexity instead of inheriting one
  provider default, and the Routing screen gained a calibration view bucketing
  Jev-advised tasks by answer confidence against what actually happened.

**P7a — site re-theme** (this change) brings `site/` to the same Phosphor Console tokens
and adds routing-advisor documentation and the narrowed API-key copy; see `site/` and the
docs pages under `site/src/pages/docs/`. Still deferred (unchanged in Remaining work
below): **forges** (opening pull requests through GitHub/GitLab/Bitbucket — credentials
for these already fall under ADR 0002, implementation not started).

**P7b — responsive & accessibility** is done as well. The layout works from 1440 px down
to 720 px wide (Electron `minWidth: 720`), with no horizontal page scroll in any view at
720/900/1024/1280/1440. The sidebar falls back to an icon rail below 1024 px, and the task
list and inspector both collapse to overlays. The axe-core audit that drove it now reports
zero violations in both themes. The work covers:
- meter roles and labelled switches;
- task-list semantics and heading order;
- `--fg-faint` raised to 4.5:1;
- focus-visible tooltips, a skip link, and live regions;
- one radio-group pattern for all segmented controls;
- focus returned from every dialog.

## Done

- **Control plane (Context & Tools)** — one profile → native flags per CLI
  (`--mcp-config`, `--allowedTools`, `--append-system-prompt`, …). Live per-provider preview.
- **Results rendering** — markdown + code blocks (copy), route timeline, token/elapsed meta.
- **Model detection + activity feed** — underlying model badge; live tool/thinking feed
  parsed from each CLI's stream (Claude verified against real events).

## Completed in this iteration

### Phase 2 — MCP manager polish ✅
- Per-server **environment variables** and **HTTP headers** editors.
- **Import** servers from an existing `.mcp.json` / `mcp-config.json`.
- **Per-provider control-plane opt-out** toggle on each provider card.
- GitHub Copilot MCP tool and toolset controls, including an explicit all-tools mode.
- Browser-based OAuth for protected remote MCP servers, encrypted with the operating
  system credential store and injected only into each provider process.

### File-change identification ✅
- Track file-mutating tool calls (Claude `Edit`/`Write`/`MultiEdit`/`NotebookEdit`,
  Codex `file_change`) into `task.filesChanged` and show a **Files changed** panel
  (path + add/edit/delete + count) distinct from the general activity feed.

## Roadmap

> Phases 5–8 are **implemented** (2026-07-23). Notes retained below for reference.

### Phase 5 — Multi-provider orchestration: **planner delegates subtasks** (chosen) ✅
- A **lead/planner provider** decomposes a task into subtasks (structured plan).
- Frontier dispatches each subtask to the **best-fit provider/LLM** (capability +
  availability + budget + cooldown), running independent subtasks in parallel.
- Subtask outputs are collected and passed back for a **merge/synthesis** step.
- Inter-stage context is threaded explicitly (each subtask sees relevant prior output).
- New task "mode": `orchestrated`. Surface the plan → subtasks → merge as a visual
  DAG/timeline in the task view, each node showing its provider, model, status, tokens.
- Requires: a planner prompt/protocol (ask the planner CLI to emit a JSON subtask list),
  a subtask scheduler in the engine, and a synthesis pass.

### Phase 6 — Usage & sessions tab ✅
Data source: each CLI's stream. Claude emits real `usage` (input/output/cache tokens),
`total_cost_usd`, model metadata, and `rate_limit_event` (`resetsAt`,
`overageStatus`, `isUsingOverage`).
- Per-provider: tokens used (actual when reported, otherwise labeled estimates) and cost.
- **Session reset countdown** + overage status from `rate_limit_event`, retaining
  simultaneous plan windows (for example five-hour and seven-day limits) separately.
- **% used** against the app's configurable daily budget (honest proxy for "quota left",
  since subscription CLIs don't expose a hard remaining-quota number).

### Usage/context accuracy follow-up ✅
- Daily token totals, plan-window utilization, and conversation context are distinct metrics.
- Claude context uses the latest model request rather than cumulative task usage.
- Codex context is shown only when explicitly reported; configured fallbacks are labeled estimates.

### Phase 7 — Model switching from the UI ✅
- Per-task model override in the New Task dialog (and quick-switch on provider cards).
- Known-model pickers where possible (Claude: opus/sonnet/haiku; others: free-text +
  remembered recents). Injected via each CLI's `--model`.

### Phase 8 — UI/UX polish ✅ (first pass)
- Done: task search/filter, orchestrated task badge, keyboard shortcuts (⌘K command palette,
  ⌘N new task), and a full command palette for navigation, common actions, and task lookup.
- Future: provider cards showing real CLI auth + MCP status, deeper theming.

### Verification lane ✅
Every isolated run already left behind a branch nobody had read. The repo's **own** checks
(detected from `package.json` scripts / `Makefile` / `Cargo.toml` / `go.mod`, or configured
explicitly) now run against each worktree before teardown, and the result rides along to:
- **Review** — a pass/fail chip per branch plus a per-check panel with the captured output,
  so the inbox is "merge what passed" rather than "read a diff and hope".
- **Compare** — the scoreboard is now measured: checks, files touched, ±lines, wall time,
  tokens per lane. Still no judge model; every column is something Frontier observed.
- **Workspaces** — `edit-files` turns are checked the same way.
A branch with no detected checks reports "none detected", never a pass. A failing check
never fails the agent's run, and never blocks the merge button.

### Outcome-aware routing ✅
The Review inbox is the only place a human grades an agent, and that verdict was being
thrown away. Providers now accumulate per-task-type outcomes (completed, checks passed,
branch merged vs discarded) and the router folds them into one labelled, bounded (±14)
factor that appears on the Route tab like every other. Off by a single setting; silent
below three runs; cancellations are never counted.

### Usage history, per-model attribution, honest cost ✅
Daily totals move into a 30-day `history` at the rollover instead of being discarded, and
the Usage card charts them. Reported tokens are attributed per model. Cost now reads "not
reported" for the CLIs that report none, instead of showing a misleading `$0.00`.

### Provider login state ✅
"Ready" only ever meant the binary existed. Each provider card now also shows a signed-in /
signed-out chip, read read-only from that CLI's own on-disk session, reporting signed-out
only on positive evidence (Copilot's empty `loggedInUsers` being the documented case).

### Completion notifications ✅
Runs take minutes. A finished or failed task raises an OS notification, by default only
when Frontier is not focused.

### Snapshot coalescing ✅
Streaming cloned every task and workspace per token. Snapshots are now coalesced on a
~60 ms trailing timer, with state changes flushing immediately; live text is untouched
because it travels on its own channel.

## Remaining work

1. **Task templates & recipes** — save prompt + mode + agent + model + skills + cwd, run it
   from the ⌘K palette. Nothing in the app currently remembers a run's shape.
2. **Scheduled and git-triggered runs** — templates on a schedule, or when a branch moves.
   Honest scope: only while the app is open, no daemon.
3. **Forges — push / open PR through the user's own `gh`/`glab`** — the Review inbox
   dead-ends at a local merge. Delegating the handoff to an already-authenticated CLI is
   the same principle as delegating the models; a forge API credential (to open the PR
   itself) already falls under [ADR 0002](docs/adr/0002-auxiliary-service-credentials.md)
   as an auxiliary, non-agent service. Not started.
4. **Quota forecasting** — project the burn rate against the reported window and offer to
   shift the queue to a local model before the cap lands, instead of only reporting it.
5. **Context compaction before a continuation overflows** — `contextTokens/contextWindow`
   are tracked but purely informational today.
6. **MCP "test connection"** — servers are configured and translated but never verified, so
   a typo surfaces as a mysterious task failure much later.
7. **Run isolated for ordinary tasks** — worktree isolation is currently a privilege of
   orchestrate/bench/workspace turns; a plain task writes straight into the cwd.
8. **Run report export** — markdown/HTML of a task (prompt, route receipt, activity, diff,
   cost); doubles as a PR description.
9. **Provider stream compatibility fixtures** — validate Codex and Copilot parsing against
   captured events from current CLI releases; consume exact Codex context occupancy if its
   JSON stream adds it.
10. **Wire the UI checks into CI.** `scripts/check-contrast.mjs` exists but isn't a `pnpm`
    script or a CI step, and the axe audit was run by hand against the built renderer with a
    stubbed bridge. Both should run on every pull request. A real screen-reader session
    (VoiceOver/NVDA) has also not been done yet.

## GitHub Copilot CLI — extensible surfaces worth mirroring
From `copilot --help` (v1.0.73):
- `--additional-mcp-config <json>` and `~/.copilot/mcp-config.json` — MCP servers.
- `--add-github-mcp-tool` / `--add-github-mcp-toolset` / `--enable-all-github-mcp-tools`
  — granular GitHub MCP toolset selection (a good model for our MCP manager's toolset UI).
- `--available-tools` / `--excluded-tools` / `--allow-tool` / `--deny-tool` — fine tool scoping.
- `--allow-url` / `--deny-url` — network scoping.
- `--add-dir` — extra context roots. `--enable-memory` — persistent memory in prompt mode.
These map directly onto control-plane concepts; the toolset selector is the main net-new
UI idea to adopt.
