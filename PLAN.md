# Frontier Proxy — Implementation Plan

Frontier is a **control plane above local, already-authenticated coding CLIs**
(Claude Code, Codex, GitHub Copilot, Ollama). Configure MCP / tools / context /
models once; Frontier routes and orchestrates work across providers and reports
real usage. No API keys — auth is each CLI's own login.

## Done

- **Control plane (Context & Tools)** — one profile → native flags per CLI
  (`--mcp-config`, `--allowedTools`, `--append-system-prompt`, …). Live per-provider preview.
- **Results rendering** — markdown + code blocks (copy), route timeline, token/elapsed meta.
- **Model detection + activity feed** — underlying model badge; live tool/thinking feed
  parsed from each CLI's stream (Claude verified against real events).

## In progress (this iteration)

### Phase 2 — MCP manager polish
- Per-server **environment variables** and **HTTP headers** editors.
- **Import** servers from an existing `.mcp.json` / `mcp-config.json`.
- **Per-provider control-plane opt-out** toggle on each provider card.
- GitHub Copilot MCP toolset awareness (see Copilot notes below).

### File-change identification
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
`total_cost_usd`, per-model breakdown, and `rate_limit_event` (`resetsAt`,
`overageStatus`, `isUsingOverage`).
- Per-provider: tokens used (actual, not estimated), cost, per-model split.
- **Session reset countdown** + overage status from `rate_limit_event`.
- **% used** against the app's configurable daily budget (honest proxy for "quota left",
  since subscription CLIs don't expose a hard remaining-quota number).
- History chart of usage over time.

### Phase 7 — Model switching from the UI ✅
- Per-task model override in the New Task dialog (and quick-switch on provider cards).
- Known-model pickers where possible (Claude: opus/sonnet/haiku; others: free-text +
  remembered recents). Injected via each CLI's `--model`.

### Phase 8 — UI/UX polish ✅ (first pass)
- Done: task search/filter, orchestrated task badge, keyboard shortcuts (⌘K search, ⌘N new task).
- Future: full command palette, provider cards showing real auth + MCP status, deeper theming.

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
