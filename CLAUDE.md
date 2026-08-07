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

That is the **task** shape. There is a second one — a **workspace**, where you `@mention`
named participants in a long-lived per-repo thread and nothing is routed or failed over.
It is a separate domain model on purpose; see *Collaborative workspaces* below.

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

## Skills manager (Skills screen)

Agent skills are `SKILL.md` folders the installed CLIs already discover on their own.
Frontier surfaces them in one catalog, lets you enable/disable them globally and
per conversation, and translates that choice into each CLI's own mechanism at spawn
time — the same role the control plane plays for MCP servers.

**Discovery is strictly read-only** (`src/main/skills.ts`, unit-tested). Frontier never
writes to a skill folder and never runs `copilot skill add|remove` or `claude plugin`;
those mutate persistent CLI state. The module imports only `readdir`/`stat`/`readFile` —
keep it that way. It only *chooses which* of the user's existing skills to activate.

Roots scanned, and which CLIs find each one unaided (`nativeFor`):

| root | scope | nativeFor |
|---|---|---|
| `~/.claude/skills` | personal | claude |
| `~/.copilot/skills` | personal | copilot |
| `~/.agents/skills` | personal | copilot, codex, codex-oss |
| `~/.codex/skills` | personal | codex, codex-oss |
| `<cwd>/.claude/skills` | project | claude, copilot |
| `<cwd>/.github/skills` | project | copilot |
| `<dir>/.agents/skills`, cwd → repo root | project | copilot, codex, codex-oss |

`.agents/skills` walks upward from cwd, stopping at the first `.git`. Roots are de-duped
by path (a non-git cwd under `$HOME` otherwise re-adds `~/.agents/skills` as project scope).
Frontmatter is read by a hand-rolled parser — only unindented top-level keys count, so a
nested `metadata:` map is skipped rather than misparsed. **Identity is the normalized skill
name**, not the path: every CLI addresses a skill by name, so copies in several roots collapse
into one entry carrying every `source`, and its `nativeFor` is the union.

**Translation is tiered** (`controlPlaneInjection(provider, profile, skills)`), because only
Claude has a verified per-run lever:

- **Claude** — native, and the only CLI where disabling is actually enforced. Both directions
  are emitted, and each does a different job (verified against the real CLI):
  - `--allowedTools Skill(<name>)` **pre-approves** invocation headlessly — exactly like
    `mcp__<name>__*`. It does **not** scope the skill list: `claude -p` with
    `--allowedTools "Skill(docker-deployment)"` still reports every installed skill.
  - `--disallowedTools Skill(<name>)` **blocks invocation**. Forcing the call under this flag
    fails with a permission error; the identical prompt without it succeeds. This is what
    makes a disabled skill actually disabled, so never drop the deny side as redundant.
- **Copilot / Codex** — no per-run skill flag exists, so `Skill(...)` is **never** emitted into
  their args. They get the enabled skills' name, description, and absolute `SKILL.md` path
  through the existing prompt seams (`promptPrefix` / `developer_instructions`), plus a
  "do not use" clause for disabled ones. **That exclusion is advisory and unenforceable** —
  the UI must label it best-effort, never imply a guarantee.
- A skill is *ambient* for a CLI when none of its sources is native to it; those get the root
  `--add-dir`'d (Copilot and Claude; Codex has no such flag) so the agent can read the file.
  The cited path always prefers a source that CLI can actually reach.

`AppSettings.skills` persists a **disabled**-set, not an enabled-set: a new skill is on by
default, and an empty `disabledIds` reproduces the CLIs' own behaviour exactly. Per-task,
`ProxyTask.skillIds` stores the absolute resolved set (`undefined` = inherit the global
default), so a retry or continuation keeps what it originally ran with. `activeRunProfile(task)`
resolves the catalog from **`task.cwd`**, never a worktree path, and returns `{ controlPlane,
skills }` for every run path. Stale ids are never pruned — the catalog is cwd-scoped, so an
absent skill is not a deleted one.

## Orchestration (planner delegates subtasks)

When a task is created with `orchestrate: true`, the engine runs `orchestrate(task)`
instead of `execute(task)`:
1. **Plan** — the top-ranked provider is asked (via `buildPlannerPrompt`) to emit a JSON
   subtask array; `parsePlan` (in `orchestrate.ts`, unit-tested) extracts it even from
   fenced/prose-wrapped output. Empty plan → falls back to running the whole task as one subtask.
2. **Delegate** — `runSubtasks` ranks providers per subtask type and runs them with bounded
   concurrency (`maxParallelTasks` lanes), streaming each subtask's output live. A lane whose
   providers are all *busy* waits for a slot (`awaitSubtaskProvider`) instead of failing —
   with one installed CLI at `maxConcurrent: 1` (the shipped default) the second lane would
   otherwise find everything busy the instant the first started and abandon its subtask.
   Only a subtask no idle provider could take is a real failure.
3. **Synthesize** — `buildSynthesisPrompt` feeds all subtask outputs to a provider; its
   streamed result becomes `task.output`. The synthesis prompt states explicitly that this
   is a **read-only reporting step**: the synthesizer is a full agent with file tools running
   in the task cwd, and without that instruction it sees the subtasks' files "missing" (they
   are committed on their worktree branches) and redoes all the work in the main tree.
`task.orchestrationStage` (planning→delegating→synthesizing→done) and `task.subtasks[]`
drive the UI stage bar + subtask cards. `task.modelOverride` (from the New Task dialog)
is applied to every run via `withModel`, but only on the agent that owns it.

**Worktree isolation** (`src/main/worktree.ts`, integration-tested against real git): when
the task cwd is a git repo, `runSubtasks` gives each subtask its own `git worktree` off HEAD
on a `frontier/<taskId>/<n>-<slug>` branch, runs it there (isolated file edits), commits its
changes to that branch (`subtask.committed`), then tears the worktree down — leaving the
branch for the user to review/merge. Non-git cwd falls back to the shared directory.

## Head-to-head comparison (bench)

`createTask({ benchProviderIds: [...] })` (≥2 agents) sets `task.bench` and seeds one
`subtasks[]` lane per chosen agent. `runBench` sends the **identical** prompt to every lane
at once, each in its own worktree branch (`frontier/<taskId>/bench-<agent-slug>`), and
deliberately performs **no failover** — a lane that fails is a result about that agent, not
something to reroute. Activity events are prefixed with the agent name because lanes stream
concurrently. `task.output` is a factual scoreboard built from what happened (`benchSummary`),
not another model call. The UI renders lanes as side-by-side columns instead of a transcript,
and hides the follow-up composer (a comparison has no single conversation to continue).

## Collaborative workspaces (`src/main/workspace.ts`, ADR 0001)

A **workspace** is the second conversation shape alongside `ProxyTask`: one repo, one
long-lived thread, and several named agent participants sitting in it next to you —
Slack for engineering. You address a participant by `@handle`; **only addressed
participants run**. There is no routing and no failover here, because a message is
addressed to a *named identity*, not to "whichever agent is free".

Design and rationale live in [`docs/adr/0001-collaborative-workspaces.md`](docs/adr/0001-collaborative-workspaces.md);
the decision ids (D1–D10) referenced in the source comments are that document's.

- **Domain model** (`src/shared/types.ts`, additive) — `Workspace { participants, messages,
  turns, cwd, nextSeq }`. Messages are one flat log with a monotonic `seq`; a
  `WorkspaceTurn` (one participant's run for one trigger message) is stored **beside** the
  log, not inside a message, so a retry appends a turn without mutating history.
  `PersistedState.workspaces` defaults to `[]`, so pre-workspace `frontier-state.json`
  files load unchanged; `running` turns are reconciled on load like tasks.
- **Participants, not provider kinds** (D2) — the snapshot exposes `ParticipantView =
  WorkspaceParticipant & { available, unavailableReason }`, computed in the main process
  from `ProviderRuntime` (disabled / not configured / CLI not detected / cooling down /
  plan limit reached). **No `provider.kind` branching may appear under
  `src/renderer/`** — adding a sixth provider kind must not touch the workspace UI. A
  participant's `model` is only ever handed to its own `providerId`, enforced by
  `resolveParticipantModel` (pure, unit-tested) reusing `resolveTaskModel`.
- **Mentions are the only dispatch mechanism** (D3) — `parseMentions` in
  `src/shared/mentions.ts` is pure and shared by the renderer's autocomplete and the
  main-process dispatcher so the two cannot drift. Mentions inside fenced/inline code are
  examples, not addresses. No mention → the message is logged and nobody runs. An
  unknown or unreachable handle produces a **system message in the thread naming the
  reason**, never a silent drop. `@here`/`@all` are deliberately not implemented — fan-out
  to every agent is a quota event.
- **Agent replies never re-dispatch** (D4) — `postMessage` is the only entry point that can
  spawn turns, and `appendAgentMessage` never calls `dispatch`. An `@mention` inside an
  agent's reply renders as a chip and starts nothing; without this, two participants that
  mention each other burn the subscription.
- **Parallel, independent fan-out** (D5) — every addressed participant starts at once and
  sees the identical thread prefix (`seq <= trigger.seq`); none see each other's replies.
  `dispatch` takes a `DispatchStrategy` so a future `sequential` mode drops in without
  touching the message model. Turns claim slots from the **same** per-provider
  `running`/`maxConcurrent` pool tasks use, and a busy provider makes the turn *wait*
  (`awaitSlot`) rather than fail — the `awaitSubtaskProvider` lesson again.
- **Per-turn worktree isolation** (D6) — a participant with the `edit-files` capability
  runs in its own worktree off HEAD on `frontier/ws-<workspaceSlug>/<seq>-<handle>`
  (retries get `-<attempt>` appended, or they would collide with the original), commits to
  that branch (`turn.branch`/`turn.committed`), and the worktree is torn down. Unlike
  orchestrate/bench, a worktree that cannot be created **fails the turn** instead of
  silently falling back to the working tree — the UI promises branch isolation, so a
  silent fallback is a broken promise. Don't "fix" this back to a fallback.
  **Accepted risk, state it plainly in UI copy**: `capabilities` governs *isolation*, not
  *enforcement* — `acceptEdits`/`workspace-write` still let a non-`edit-files` participant
  write, it just writes in the shared cwd. Label `edit-files` as "works on an isolated
  branch", never as a permission. (`run-commands` is modelled and editable but no code path
  differentiates it from `read-repo` yet.)
- **Transcript context, no session resume** (D7) — `buildParticipantPrompt`
  (`src/main/participants.ts`, pure and unit-tested) builds a fresh prompt per turn:
  workspace preamble (name, repo, roster with roles), the attributed thread
  (`[@handle · role]`) trimmed from the head against a token budget but **always** keeping
  the trigger, then "you are @handle, reply as yourself, answer only what you were asked".
  Frontier memory is prepended. `--resume` is deliberately unused: a private CLI session
  diverges from the shared log the moment another participant speaks.
- **Control plane and skills are inherited** (D8) — resolved exactly as `activeRunProfile`
  resolves them for a task, through `McpAuthManager.profileWithAuth` (a raw
  `settings.controlPlane` read would skip OAuth header injection), and keyed on the
  **workspace cwd, never the per-turn worktree path**. Per-participant MCP/skill sets are
  out of scope.
- **Separate stream channel** (D9) — `WorkspaceStreamEvent` on `frontier:workspace-stream`;
  `StreamEvent`/`frontier:stream` are untouched so nothing in the task view can regress.
- **Wiring, not edits to hot files** (D10) — `WorkspaceRuntime` gets provider access
  through injected accessors (`WorkspaceRuntimeDeps`) instead of importing `engine.ts`, so
  the dependency arrow never points inward and it is unit-testable with a fake runner.
  `engine.ts` only holds the state (`persistWorkspaces`, `loadedWorkspaces`, slot
  claim/release) and `src/main/index.ts` constructs the runtime and registers IPC. The
  renderer view is its own file, `src/renderer/src/workspace.ts`.

Tests: `tests/mentions.test.ts`, `tests/workspace.test.ts`, `tests/participants.test.ts`,
`tests/workspace-e2e.test.ts` (lifecycle, persistence, concurrency).

## Branch review inbox (`src/main/branches.ts`)

Split & delegate, bench runs, and workspace writing-turns leave `frontier/*` branches
behind. The **Review** screen lists them per repo (`listBranchInbox` over the distinct
task **and workspace** cwds, de-duplicated) with each branch's
commit subject, distance from HEAD, and per-file `+/-` counts measured from the merge base
(`HEAD...branch`), then offers a diff view, **Merge**, and **Delete**.

Safety rules, all unit-tested: only branch names starting with `frontier/` can ever be
diffed, merged, or deleted (`assertTaskBranch`); merging is refused while the checkout is
dirty; a conflicting merge is aborted and reported rather than left half-applied. Merge and
delete are both behind an explicit confirmation dialog in the UI.

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
  aware source/diff highlighting. The file tree comes from `git ls-files --cached --others
  --exclude-standard` when the cwd is a repo, so it respects the project's own `.gitignore`
  (non-Git folders fall back to a directory walk filtered by `IGNORED_TASK_TREE_NAMES`);
  `entriesFromPaths` rebuilds the folder hierarchy from those paths. Folders in the tree are
  collapsible and start collapsed except the branches holding this task's changed files.
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

**What each CLI actually reports** (`src/shared/sessions.ts`, pure and unit-tested, shared by
the engine, the router and the renderer so the three cannot drift apart):

- **Claude** names the window (`five_hour` → `5-hour`, with `windowMinutes` derived from that
  name), gives its `status` and reset time — and **no utilization percentage at all**. The UI
  therefore shows the window and its countdown, with a muted bar tracking *elapsed time* in the
  window, explicitly labelled as such. It never invents a usage percentage. `status` (the plan's
  verdict) and `overageStatus` are kept apart: an overage of `rejected` alongside `allowed` is
  not the plan saying no, and must not remove the provider from routing.
- **Codex** carries real percentages on its `token_count` events (`rate_limits.{primary,
  secondary}` → `used_percent`, `window_minutes`, `resets_in_seconds`); windows are named from
  their length. Best-effort, like the rest of the Codex parse.
- **Copilot / Ollama** stream no JSON, so they legitimately report nothing.

A window whose reset time has passed is **dropped**, not held at a stale percentage — on load,
on merge, and on read. Keeping it produced the old "No plan limit reported · resets in
resetting…" contradiction. A provider is removed from routing when a live window is ≥100% used
or its own status rejects (`sessionBlocked`), never on an expired window.

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
- **Codex**: real discovery — `codex debug models` renders the CLI's own model catalog as
  JSON; `parseCodexModels` (pure, unit-tested) keeps the `visibility: "list"` slugs, ordered
  by the catalog's `priority`. Hidden/internal entries are dropped. This must stay real: the
  curated ids drifted out from under the ChatGPT-account backend, so the picker offered
  `gpt-5-codex`/`o4-mini` and every task using them died on a 400 ("not supported when using
  Codex with a ChatGPT account"). `KNOWN_MODELS.codex` survives only as the last-resort set
  for a CLI too old to have `debug models`.
- **Claude / Copilot**: a **curated** `KNOWN_MODELS` set — these CLIs have no headless
  "list models" command, so we ship sensible defaults.
- The provider's own configured `model` is always folded in and the set de-duplicated.

A model the CLI or backend refuses is a *configuration* failure, not a capacity one:
`modelRejectionError` rewrites it into a sentence naming the model and the fix, and the run
stays a plain failure (failing over would silently run the task on an agent the user did not
pick). `codexErrorMessage` unwraps Codex's verbatim `{"type":"error",…}` envelopes so the
transcript shows the sentence instead of raw JSON.

The **New Task** dialog's model field is a dropdown (`#task-model-select`) populated by
`renderTaskModelOptions` from `runtime.models`, scoped to the chosen provider override
(or grouped by provider under Automatic via `<optgroup>`). "Provider default" (blank) and
"Custom model…" (reveals the `#task-model` free-text input for any id) bracket the list.
The selection flows through `CreateTaskInput.model` → `task.modelOverride` → `withModel`.

**Model ids are CLI-specific and never travel between agents.** Codex fails the whole
run on `claude-opus-5` ("not supported when using Codex with a ChatGPT account"), so the
picked model is tagged with the agent it came from (`CreateTaskInput.modelProviderId` →
`task.modelOverrideProviderId`) and `resolveTaskModel` (pure, unit-tested in
`tests/providers.test.ts`) hands it only to that agent — every other provider reached by
routing, failover, a bench lane, a subtask, or a provider switch runs its own model, with
a note in the transcript. An id no configured agent claims is treated as a custom id and
still passes through. The router also gives the owning agent +60 so Automatic tries it
first without making it the only option.

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
                workspace.ts + participants.ts hold the collaborative-workspace runtime
src/preload/    narrow typed IPC bridge (contextIsolation, no Node in renderer)
src/renderer/   desktop UI (vanilla TS + CSS); src/workspace.ts is the workspace view
src/shared/     shared types, defaults, task classification, mention parsing
tests/          routing, classification, persistence, process-safety, workspaces
docs/adr/       architecture decision records (0001 — collaborative workspaces)
site/           Astro marketing + docs site, deployed to GitHub Pages
```

State persists to `frontier-state.json` in Electron's per-user `userData` dir.

## The website (`site/`)

An Astro static site — landing page, docs, changelog — published to
`https://frontier.thisara.me` by `.github/workflows/site.yml`. The domain is a constant in
`site/astro.config.mjs`; it must match Settings → Pages → Custom domain, and it drives the
origin, the base path (`/`, not the project-site path), and the emitted `CNAME`.

`site/` is deliberately **outside** the pnpm workspace (`pnpm-workspace.yaml` lists only
`.`) and keeps its own lockfile, so the desktop app's `pnpm install --frozen-lockfile`
never sees Astro. Always install it with `pnpm --dir site install --ignore-workspace`.

It restates the product, so it must not drift. Anything derivable is read at build time,
not copied: the download table and version come from the GitHub releases API (falling
back to the root `package.json` version when offline), the changelog is generated from
those same releases, and `docs/architecture.svg` is inlined from the repo.
`src/lib/repo.ts` resolves repository files via `__REPO_ROOT__`, injected by
`astro.config.mjs` — inside the SSR bundle `import.meta.url` points at the bundle, not a
source file. `SITE_OFFLINE=1` exercises the fallback path.

`site/src/styles/theme.css` duplicates the design tokens from
`src/renderer/src/styles.css` (palette, Georgia headings, brand mark, pills and dots).
Changing the app's palette means changing both.

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
