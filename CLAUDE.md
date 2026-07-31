# CLAUDE.md — Frontier Proxy

Guidance for working in this repository.

## What this app is (read this first)

Frontier Proxy is a **local-first desktop orchestrator** (Electron) that routes coding
tasks to **CLI agents already installed and authenticated on the user's machine** —
Codex CLI, Claude Code, GitHub Copilot CLI, and Ollama-backed models.

**Core principle — no API keys, ever.** The app does **not** call model APIs and does
**not** hold API keys of its own. Authentication is entirely delegated to each CLI's own
login/subscription session (`codex` login, `claude` login, `copilot login`, local
`ollama`). When Frontier runs a provider it spawns that CLI in non-interactive mode and
the CLI reuses its existing on-disk session.

Do **not** add `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / token entry fields to providers.
That contradicts the whole design. If a provider can't authenticate, the fix is to log in
with that provider's own CLI (e.g. `copilot login`), not to inject a key from the app.

## How a task flows

1. Renderer (`src/renderer`) collects prompt + working dir + routing mode → IPC.
2. `OrchestrationEngine` (`src/main/engine.ts`) queues it, classifies the task type
   (`src/shared/classify.ts`), and pumps the queue respecting global/per-provider
   concurrency.
3. `rankProviders` (`src/main/router.ts`) scores eligible providers (override → policy →
   task affinity → user priority → estimated usage/load).
4. `runProvider` (`src/main/providers.ts`) spawns the CLI with `cross-spawn`,
   `shell: false`, prompt over **stdin**, and streams stdout back. It never interpolates
   the prompt into a shell command.
5. On quota/rate-limit/unavailable failures it cools that provider down and fails over to
   the next. A normal agent failure stops the task (rerunning partial edits is unsafe).

## Control plane — Context & Tools (central config)

Frontier owns one CLI-agnostic profile (`AppSettings.controlPlane`, type
`ControlPlaneProfile`) covering MCP servers, tool allow/deny lists, a shared
system prompt, extra context dirs, and a strict-MCP flag. You configure it once
in the **Context & Tools** screen; Frontier translates it into each CLI's native
flags at spawn time — so you never edit `claude`/`copilot`/`codex` configs by hand.

Translation lives in `src/main/controlplane.ts` (`controlPlaneInjection`) — a pure,
unit-tested function (`tests/controlplane.test.ts`). Per CLI:

- **Claude Code**: `--mcp-config <inline-json>` (+ `--strict-mcp-config`),
  `--allowedTools` / `--disallowedTools`, `--add-dir`, `--append-system-prompt`. Each
  enabled MCP server also adds `mcp__<server>__*` to `--allowedTools`, because
  `acceptEdits` does not approve MCP calls in non-interactive mode.
- **Copilot**: `--additional-mcp-config <json>`, `--allow-tool=` / `--deny-tool=`,
  `--add-dir`; it has no system-prompt flag, so the shared prompt is folded into the
  stdin prompt via `promptPrefix`. Copilot receives its required `tools: ["*"]` field
  and each enabled server name is added to `--allow-tool` for headless execution.
- **Codex / Codex + Ollama**: stdio and Streamable HTTP MCP servers are supplied as
  per-invocation `-c 'mcp_servers.<name>={...}'` overrides; the shared system prompt
  and MCP session notice are supplied through Codex's native per-invocation
  `developer_instructions` config, preserving their developer role instead of folding
  them into the user prompt. Legacy SSE servers are not injected because Codex does not
  support that transport. Names containing characters outside letters,
  digits, `_`, and `-` receive a stable Codex-only alias because the CLI's dotted
  override parser cannot address quoted TOML key segments. Enabled servers use Codex's
  per-server `default_tools_approval_mode = "approve"` so MCP calls work headlessly.

`buildProviderCommand(provider, cwd, prompt, profile?)` splices the injected args in
before the provider's own `extra` args. A provider can opt out with
`useControlPlane: false`. The UI previews the exact flags live (unsaved draft included)
via `engine.previewControlPlane(providerId, profile?)`. Before creating, retrying, or
continuing a task, the renderer persists its current control-plane draft so the main
process always launches the provider with the configuration visible in the UI.

Claude and Copilot receive MCP JSON shaped as `{ "mcpServers": { "<name>": { command,
args, env } | { type, url, headers } } }`. Codex receives equivalent TOML tables through
CLI config overrides (`headers` maps to Codex's `http_headers`).

## Streaming, model detection & activity feed

`consumeJsonLines` (in `src/main/providers.ts`) parses each CLI's stream and drives
three handlers: `onText` (assistant text), `onModel` (the underlying model id), and
`onActivity` (tool calls / thinking). The engine writes these onto the task
(`task.model`, `task.activity`) and re-emits the snapshot, so the UI shows the model
badge and a live "how it's working" feed like Claude Code.

- **Claude** (`parseClaudeLine`, exported + unit-tested in `tests/stream.test.ts`):
  model from the `system/init` event (`claude-opus-4-8[1m]` → canonicalized to
  `claude-opus-4-8`); text streamed from `stream_event → content_block_delta →
  text_delta`; tool calls from `assistant` events (`content[].tool_use`); thinking from
  `thinking_delta`, flushed on `content_block_stop`. The final `result` text is used
  only as a fallback when nothing streamed (avoids duplication).
- **Codex** (`parseCodexLine`): best-effort — `command_execution` / `file_change` /
  `mcp_tool_call` / `reasoning` become activity; `agent_message` is text. Untested
  live (Codex not installed here).
- **Copilot / Ollama / custom**: raw text passthrough; `task.model` falls back to the
  provider's configured model.

`summarizeToolInput` picks the most meaningful field (file_path, command, pattern, …)
for a one-line activity detail. Activity is capped at the last 100 events per task.

**File changes**: `recordFileChange` (engine) derives `task.filesChanged` from activity
events whose tool label is in `FILE_TOOL_ACTIONS` (Write→create, Edit/MultiEdit/
NotebookEdit→edit), de-duplicated by path. The UI shows a distinct "Files changed" panel.

## MCP manager (Context & Tools screen)

Each MCP server row edits `McpServerConfig` in the draft: name, transport (stdio/http/sse),
command+args+**env** (stdio) or url+**headers** (http/sse). "Import .mcp.json" merges a
standard `{ "mcpServers": {…} }` document via a file input. Each provider card has an
**Apply shared Context & Tools profile** toggle bound to `useControlPlane` (shown only for
claude/copilot/codex kinds). Remote servers can authenticate through browser OAuth; tokens
are encrypted with Electron `safeStorage`, remain in the main process, refresh automatically,
and reach provider processes through environment-backed header placeholders. Copilot's
provider card also maps GitHub MCP tool/toolset selections to the CLI's per-session flags.
See `PLAN.md` for the full roadmap.

## Orchestration (planner delegates subtasks)

When a task is created with `orchestrate: true`, the engine runs `orchestrate(task)`
instead of `execute(task)`:
1. **Plan** — the top-ranked provider is asked (via `buildPlannerPrompt`) to emit a JSON
   subtask array; `parsePlan` (in `orchestrate.ts`, unit-tested) extracts it even from
   fenced/prose-wrapped output. Empty plan → falls back to running the whole task as one subtask.
2. **Delegate** — `runSubtasks` ranks providers per subtask type and runs them with bounded
   concurrency (`maxParallelTasks` lanes), streaming each subtask's output live.
3. **Synthesize** — `buildSynthesisPrompt` feeds all subtask outputs to a provider; its
   streamed result becomes `task.output`.
`task.orchestrationStage` (planning→delegating→synthesizing→done) and `task.subtasks[]`
drive the UI stage bar + subtask cards. `task.modelOverride` (from the New Task dialog)
is applied to every run via `withModel`.

**Worktree isolation** (`src/main/worktree.ts`, integration-tested against real git): when
the task cwd is a git repo, `runSubtasks` gives each subtask its own `git worktree` off HEAD
on a `frontier/<taskId>/<n>-<slug>` branch, runs it there (isolated file edits), commits its
changes to that branch (`subtask.committed`), then tears the worktree down — leaving the
branch for the user to review/merge. Non-git cwd falls back to the shared directory.

## Conversations (multi-turn continuation)

Every task is a conversation (`task.turns: ConversationTurn[]`), not a one-shot. The
initial prompt seeds a `user` turn; each run appends an `assistant` turn
(`startAssistantTurn`/`finalizeAssistantTurn`). `engine.continueTask(taskId, message)`
appends a follow-up `user` turn and runs again **in-context**:
- **Claude** — resumes the CLI session via `--resume <sessionId>` (session id captured
  from the `system/init` event's `session_id` → `task.sessionId`/`sessionProviderId`,
  verified working). Only the new message is sent; the CLI keeps the history.
- **Other CLIs / no session** — falls back to replaying the transcript (`transcript()`)
  as context before the new message.
The UI renders the thread as user/assistant turns with a composer at the bottom of the
output panel (Enter to send). When stopped, it also shows a **Next provider** selector backed
by `engine.changeTaskProvider`; switching clears any provider-private resume session and the
next turn receives the full attributed transcript, including cancelled/partial turns.
Intentional cancellation is terminal for the current run and never enters automatic failover.
Without an explicit change, subsequent turns stay pinned to the most recently selected provider
even when that CLI has no resumable session id.

## Layout, context window & memory

- **Fixed app shell** — `body`/`.shell`/`main` are `height:100vh; overflow:hidden`; the
  Tasks view fills remaining height and its panels scroll independently (no full-page
  scroll). Other views scroll internally. A draggable `.grid-gutter` between the work
  queue and live output resizes the columns (persisted to `localStorage` `fp-wq-width`).
- **Context window** — usage and context are separate streams. `parseClaudeLine` reads the
  latest `message_start` input/cache usage plus `message_delta` output usage for current
  conversation occupancy, then pairs it with the active model's `modelUsage[*].contextWindow`.
  Cumulative `result.usage` is never used as context. Codex exposes no dedicated context field,
  so its per-turn `turn.completed.usage` input+output tokens are used as the current context
  occupancy (cumulative usage is accumulated separately via `onUsage`). Because Codex does not
  report its window, the engine pairs the occupancy with the provider's configured/known
  `contextWindow` (default 400k for the GPT-5 family) and stores `task.contextSource = "estimated"`.
  The UI labels estimates accordingly.
- **Task workspace** — **Open details** (or double-clicking a task) opens the `task-detail`
  view with a large conversation pane, provider route/work log, task context meter, and a
  **Files & changes** tab. `engine.readTaskFile` only reads paths present in that task's
  `filesChanged`; it enforces workspace containment, caps text at 1 MB, identifies binary
  files, and returns a Git working-tree diff. The renderer uses `highlight.js` for language-
  aware source/diff highlighting.
- **Frontier memory** — `AppSettings.memory` (edited in Settings) is prepended by
  `promptWithMemory` as shared context to every new task's first turn and the planner
  prompt, so knowledge carries across tasks. Continuations inherit it via the resumed session.

## Usage & sessions

`parseClaudeLine` also emits `onUsage` (from the `result` event: real input/output tokens +
`total_cost_usd`) and `onSession` (from `rate_limit_event`: reset, status, and any reported
utilization). Codex `turn.completed` events contribute real token counts as well. The engine
accumulates these into `runtime.usage` and stores every distinct plan window in
`runtime.sessions` instead of overwriting one window with another. `JsonStore` persists
the current day's usage and reported windows in `providerRuntime`; stale daily totals are
discarded at the next local-date rollover.
Context occupancy is deliberately task-scoped (`task.contextTokens/contextWindow`), shown on
the task row and dedicated task workspace—not on provider Usage cards. A provider-level
context-window value can still be configured as a fallback when its CLI does not report one.
The Usage view shows session/plan usage, reset countdown, tracked tokens, and automatic-
fallback state for every provider.

Quota/unavailable failures fail over during first turns, follow-up conversations, and every
orchestration stage. A logged-out/unauthenticated CLI (matched by `AUTH_PATTERN` in
`providers.ts` on a non-zero exit) is classified as `unavailable`, so it cools down and fails
over rather than failing the whole task — the fix is still to log that CLI in. A follow-up that leaves its owning CLI replays the conversation transcript
to the replacement provider. Reported 100% plan utilization and configured tracked-usage
limits also remove a provider from routing before launch.

## Model discovery & per-task model picker

`discoverModels(provider)` (in `src/main/providers.ts`) enumerates the models a
provider can run and `checkProviders` stores the result on `runtime.models`:

- **Ollama / Codex-OSS**: real discovery — parses `ollama list` (first column of the
  table, header dropped) for locally-pulled models.
- **Claude / Codex / Copilot**: a **curated** `KNOWN_MODELS` set — these CLIs have no
  headless "list models" command, so we ship sensible defaults.
- The provider's own configured `model` is always folded in and the set de-duplicated.

The **New Task** dialog's model field is a dropdown (`#task-model-select`) populated by
`renderTaskModelOptions` from `runtime.models`, scoped to the chosen provider override
(or grouped by provider under Automatic via `<optgroup>`). "Provider default" (blank) and
"Custom model…" (reveals the `#task-model` free-text input for any id) bracket the list.
The selection flows through `CreateTaskInput.model` → `task.modelOverride` → `withModel`.

## Provider invocation (in `buildProviderCommand`)

- **codex**: `codex exec --json --sandbox workspace-write --skip-git-repo-check -C <cwd> -`
- **codex-oss**: adds `--oss --local-provider ollama`
- **claude**: `claude -p --output-format stream-json --permission-mode acceptEdits …`
- **copilot**: `copilot -s --no-ask-user --allow-tool=<safe set> …` (non-interactive silent mode)
- **ollama**: `ollama run <model>` (no agent tools; review/planning/docs/general only)
- **custom**: user-defined argv; supports `{prompt}` `{cwd}` `{model}` placeholders

## Known gotcha: GitHub Copilot headless auth

Copilot's non-interactive mode (`copilot -s`) only works if the Copilot CLI is currently
logged in. Login state lives in `~/.copilot/config.json` → `loggedInUsers`. If that array
is **empty** (only `lastLoggedInUser` present), the CLI is logged out and headless runs
fail with *"No authentication information found."* Fix: run `copilot login`. This is a
Copilot session-expiry issue, **not** something to solve with an API key field.

The green **"Ready"** badge only runs `<exe> --version` — it confirms the binary is found,
**not** that the CLI is authenticated. A provider can show "Ready" and still fail a task
because its CLI is logged out.

## Project layout

```
src/main/       queue/engine, router, process adapters (providers), persistence, Electron main
src/preload/    narrow typed IPC bridge (contextIsolation, no Node in renderer)
src/renderer/   desktop UI (vanilla TS + CSS)
src/shared/     shared types, defaults, task classification
tests/          routing, classification, persistence, process-safety
```

State persists to `frontier-state.json` in Electron's per-user `userData` dir.

## Commands

```bash
pnpm install
pnpm dev                       # run in dev
pnpm typecheck                 # tsc for node + web projects
pnpm test                      # vitest
pnpm package                   # electron-builder --dir (unpacked)
pnpm dist                      # full installers for the current OS
```

On Windows, `pnpm dist` can fail via the `pnpm build && …` prefix when pnpm re-runs
`install`; building directly works:

```bash
npm run build
./node_modules/.bin/electron-builder     # NSIS installer + portable exe → release/
```

If packaging hits `EPERM: … rename 'release\win-unpacked'`, close any running Frontier
Proxy instance and delete `release/win-unpacked*`, then re-run.

## Conventions

- Keep the renderer free of Node APIs; go through the preload bridge.
- Never launch a provider through a shell; keep `shell: false` and pass the prompt on stdin.
- Match the existing terse, single-line-where-practical TS style in this repo.
