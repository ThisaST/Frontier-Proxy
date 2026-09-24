# Plan — Jev-advised routing, UI overhaul, multi-vendor PRs

Status: **accepted** (2026-09-24). Priority order: **UI** and **Jev routing** first, PR vendors after.

**Decisions (2026-09-24)**
- Jev: the user has a key. They enter it in the app's Routing screen, never in code or chat.
- What reaches Jev: we send the fields that help it decide: the prompt, attachment
  *names*, and lightweight **repo facts** (language mix, file count, manifests, top-level
  folders). File contents are never sent. Repo facts are on by default and can be turned off.
  The Routing screen shows the exact payload.
- Forges (§3) are **deferred**. The first cut is routing + UI only.
- Theme: a **visual rebrand** with an uncommon identity is in scope. The direction is chosen
  before P3 (the P1 renderer split is theme-neutral).
- Implementation: Sonnet 5 subagents implement each phase in isolated worktrees; the lead
  session reviews and merges.

---

## 0. Two decisions to settle before any code

### 0.1 This plan changes the "no API keys, ever" principle

`CLAUDE.md` and the sidebar ("Prompts stay between this app and your installed CLIs") both
promise that Frontier holds no keys and sends nothing outside the machine. Both requested
features break that promise:

- **Jev** is a hosted API (`POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`).
  To route a task, Frontier has to send the **prompt text to TypeSafe**.
- **Forge tokens** (you picked in-app tokens over `gh`/`glab`) are stored credentials.

Proposal: record this in **ADR 0002 — Auxiliary service credentials**, and narrow the rule
instead of dropping it:

| Still forbidden | Now allowed (opt-in) |
|---|---|
| Model-execution keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …). Agents keep using their own CLI login. | Keys for **auxiliary services** that never run a coding agent: the Jev router and forge (GitHub/GitLab/Bitbucket) APIs. |

Rules that come with the change:
- Every credential is encrypted with Electron `safeStorage`, like the MCP OAuth tokens
  (`src/main/index.ts:198`). It stays in the main process: it is never sent to the renderer
  or written to logs, and it is redacted from error text.
- Jev is **off by default**. The Routing screen says exactly what gets sent. The sidebar
  privacy note is computed from settings: "Local process mode" when Jev is off,
  "Routing advisor: Jev — prompt text is sent to TypeSafe" when it is on.
- Update `CLAUDE.md`, `README.md`, the Agents screen intro ("It never stores API keys"), and
  the site copy at the same time.

### 0.2 What Jev can and cannot do

Jev is a *System One* model. It does **not** generate text or code, and it can't replace a
coding agent (TypeSafe's docs say this directly). It takes a `state` and some typed
questions, then returns structured answers with **calibrated probabilities and confidence**:
- `choice`: picks one of up to 255 options and returns a probability for each.
- `score`: a level on a rubric you define.
- `noul`: the probability that a statement is true.

That fits Frontier's weakest routing step well. Today the step is a regex classifier
(`src/shared/classify.ts`) plus a hard-coded provider affinity table (`router.ts:9`), and
model choice happens only when the user picks one by hand. Cost is negligible:
$0.042 per million input tokens, output is free, and a call takes about 70–500 ms.

---

## 1. Jev-advised routing (priority)

### 1.1 Principles

1. **Jev advises, the router decides.** Jev's answers become **labelled, bounded
   `RoutingFactor`s**, like outcome and efficiency factors. They never override eligibility
   (disabled, not installed, cooling down, plan limit), an explicit agent pick
   (+1000), or the model the user chose.
2. **Code stays in control.** TypeSafe's own guidance: ask Jev narrow questions *about
   the task* (type, complexity, whether it edits files, context size), then map the answers
   to providers and models in deterministic, unit-tested code. A direct "which agent" pick is
   only one factor among several.
3. **Confidence gates influence.** Below a threshold, the heuristic classifier wins and the
   Route tab says so. Jev saying "I don't know" is a valid, visible result.
4. **Never block the queue.** The call has a 2 s timeout, one retry on 429/529, then the
   heuristic takes over. Offline, a 401, or Jev being disabled all behave exactly like today.
5. **Route to a model, not only a provider.** This is the new capability. The router picks
   `(provider, model)`, and the model always goes only to the agent that owns it
   (`resolveTaskModel` stays the enforcement point).

### 1.2 One Jev call per task ("speculative fan-out")

`state` = the prompt (trimmed to fit Jev's 32k budget), attachment *names*, and optionally
repo facts (languages, file count; controlled by a setting and off by default). One request
asks every question at once:

| id | type | question | used for |
|---|---|---|---|
| `task_type` | choice | coding / debugging / review / planning / documentation / general | replaces the regex when confident |
| `complexity` | score 0–3 | trivial edit → single-file change → multi-file feature → architectural/cross-cutting | desired **model tier** |
| `edits_files` | noul | will this change files? | lets read-only work go to local/Ollama |
| `long_context` | noul | does this need a lot of repo context? | favour large-window models |
| `split_worthy` | noul | are there independent parts? | *suggests* Split & delegate in the UI; never switches the mode on its own |
| `target` | choice | one option per eligible `(provider, model)` pair, with a description | one bounded "Jev best fit" factor |

The `target` options come from a new **model profile catalog**
(`src/shared/model-profiles.ts`). It holds a tier (`local | fast | standard | frontier`),
strengths, and a one-line description for each known model id. Discovered models that
aren't in the catalog get a generic description, and users can add a note per model in the
Agents screen. The catalog is the one place that says what Opus, GPT-5, and qwen are
good at.

### 1.3 How the answers become a route

```
task created ──► advise(task) ──► task.advice = { source: 'jev' | 'heuristic', model: 'jev-1.13.0',
   (async, ≤2s)                                   taskType+probs, complexity, nouls, targetProbs,
                                                  confidence, latencyMs, error? }
                        │
queue pump ────────────► routeTask(task)  ← still pure and synchronous; reads task.advice
                        │   factors: priority · type affinity · mode policy · outcomes · efficiency
                        │          + "Tier fit (complexity 2 → standard)"      ±20
                        │          + "Jev best fit 0.62"                       0…+15 × confidence
                        │          + "Read-only task → local OK"               only when edits_files < 0.2
                        ▼
                  pickModel(provider, advice, mode, override) → the model id handed to withModel
```

- `routeTask` / `rankProviders` stay pure. Failover, subtask lanes, and `awaitSubtaskProvider`
  keep working unchanged because they only read `task.advice`.
- Model precedence per provider: **user override (owner only) → routed model → provider
  default**. Saver/Quality mode moves the desired tier down or up by one.
- **Orchestration:** one extra Jev call advises every planned subtask (one question per
  subtask against the shared plan state). **Bench** and **workspaces** are not routed
  (workspace D3: an @mention names who runs), so Jev is not used there.
- **Continuations** keep today's pinning. Jev is not asked again.

### 1.4 Modes and learning

- `Off | Shadow | Active`. **Shadow** records what Jev *would* have chosen next to the real
  route, so you can check it before trusting it.
- Outcomes (`runtime.outcomes[taskType]`) gain a **per-model** breakdown, so a merged or
  discarded branch teaches the router about `opus` vs `sonnet`, not only about "Claude".
- Each advice is stored with its task's outcome. The Routing screen shows **calibration**:
  "when Jev was ≥0.8 confident, 91% of runs completed and 74% merged".

### 1.5 Files and tests

| New / changed | What |
|---|---|
| `src/main/advisor.ts` | `buildJevRequest(task, candidates, profiles)` (pure) · `adviceFromResponse(json)` (pure) · `JevClient` over an injected `fetch` (timeout, retry, redaction) |
| `src/shared/model-profiles.ts` | tier/strength catalog, `tierFor(modelId)` |
| `src/main/router.ts` | `adviceFactors(advice, provider)`, `pickModel(...)`, both bounded and pure |
| `src/main/engine.ts` | an `advising` step before a task becomes routable; stores `task.advice`, `task.routedModel` |
| `src/shared/types.ts` | `RoutingAdvice`, `RoutingAdvisorSettings`, per-model `OutcomeStats` |
| `tests/advisor.test.ts`, `tests/router.test.ts` | request shape, 32k trimming, response parsing, low-confidence fallback, 401/429/timeout → heuristic, factor bounds, the model-ownership invariant, and the check that shadow mode leaves ranking unchanged |

Use plain `fetch` rather than `@typesafe-ai/sdk`. The request is one POST, the repo keeps
dependencies minimal, and an injected fetch keeps the client unit-testable.

---

## 2. UI overhaul (priority)

### 2.1 What makes the current layout hard to use

1. **Starting work is buried.** The main action sits behind a topbar button in a modal. The
   Home screen opens on *capacity*, not on work.
2. **The New Task dialog asks for about 8 decisions up front** (folder, run mode, policy,
   agent, model, skills, …). The router exists so people don't have to decide these.
3. **The Route rationale is hidden in a tab** that competes with Conversation and Files, so
   "why this agent / model" is rarely seen.
4. **Navigation is 8 flat items** that mix daily work (Tasks, Review) with one-time setup
   (Context & Tools, Skills).
5. **Repos are a free-text field per task**, although the app is organised by repo
   underneath: Review groups by repo, workspaces are per repo, and skills resolve from the
   cwd.
6. **Visual system:** Unicode glyph icons (◇ ⌁ ▣ ⑃) render inconsistently; every panel
   repeats an EYEBROW + H2 header; tokens cover colour only (no spacing or type scale); there
   is only a dark theme; and `min-width: 980px`.

### 2.2 New information architecture

```
┌ Sidebar ─────────────────┐
│ [▾ proxy-app]  ← project switcher (repo); "All projects" option
│ WORK
│   Home          composer + inbox
│   Tasks
│   Workspaces
│   Review & PRs  (badge)
│ SETUP
│   Agents & models   registry, usage, model catalog
│   Routing           NEW: advisor (Jev), policies, insights
│   Context & tools
│   Skills
│ ─────────────
│ capacity dots · privacy/advisor status · Settings
└──────────────────────────┘
```

**The project switcher** scopes Tasks, Workspaces, and Review to one repo, and it becomes
the default working directory for new work. That removes the free-text folder field from
the common path.

### 2.3 Screens

- **Home, composer first.** A large prompt box with the project chip, run-mode chips
  (One agent · Split · Compare), and a **route preview** line: "Claude Code · sonnet-4-5 ·
  standard tier". While you type, the preview uses the local heuristic. Jev is called once,
  on submit, unless "Preview with Jev while typing" is on, since typing would otherwise send
  drafts to TypeSafe. Below the composer: *Running now*, *Needs your review*, *Recent*. An
  "Advanced" section holds policy, agent, model, and skills. The modal stays available from
  ⌘N.
- **Tasks, three panes.** On the left, a list grouped by status (Running · Needs review ·
  Done · Failed). The conversation sits in the centre. On the right, a collapsible
  **inspector** holds:
  - a Route summary that is always visible: chosen agent and model, a one-sentence reason,
    Jev probability bars, and the factor breakdown (with skipped agents collapsed);
  - files changed, activity, the context meter, and branch/PR state.

  The full file viewer opens as a focused overlay, reusing today's task-detail view.
- **Routing (new screen).**
  - An advisor card with Off/Shadow/Active, API key (write-only field plus Test connection),
    model (`jev-latest` or a pinned version), confidence threshold, and a "What is sent"
    disclosure.
  - Policy defaults.
  - The model catalog with tiers and notes.
  - **Insights**: advice vs outcome, calibration, and shadow-mode agreement.
- **Review & PRs.** Branches grouped by project, with states Unreviewed → Checks passed/failed
  → PR open → Merged/Closed. Actions: *Merge locally* · *Push & open PR*. See §3.
- **Agents & models.** The provider cards become a denser table with a detail drawer. Login
  state, CLI version, discovered models (with tier chips), and usage appear together.

### 2.4 Design system

- **Tokens:** colour (semantic: `--fg`, `--fg-muted`, `--accent`, `--danger`, `--surface-1..3`),
  a 4 px spacing scale, a type scale (12/13/14/16/20/28), radii, elevation, and motion (with
  `prefers-reduced-motion`). **Light and dark themes**, selectable or following the system.
- **Components**, written as small TS factory functions plus CSS, with no framework:
  - button (primary/secondary/ghost/danger × sm/md);
  - icon button, chip/badge, status pill, card, panel;
  - tabs, segmented control, field/select/switch, dialog, drawer, toast, menu;
  - empty state, skeleton, meter/probability bar, data table, and the inspector section.
- **Icons:** replace the glyphs with an inline SVG set (Lucide, bundled through the
  build, which works with the renderer CSP; no CDN).
- **Responsive:** drop the 980 px minimum and work down to about 720 px. The inspector
  collapses and the sidebar falls back to its existing icon-only mode.
- **Accessibility:** a full keyboard pass, visible focus rings, contrast checked in both
  themes, and ARIA on tabs, listboxes, and dialogs.

### 2.5 Structural prerequisite

`src/renderer/src/main.ts` is 2,628 lines. Split it before redesigning, **with no behaviour
change**:
- `ui/` (dom helpers, components, icons);
- `views/` (home, tasks, review, agents, routing, control, skills, settings);
- `state.ts` (snapshot store and subscriptions).

`styles.css` splits into `tokens.css`, `components.css`, and `views/*.css`. Stay on vanilla
TS, which matches the repo and the "no Node in renderer" boundary. A framework migration
would be its own decision and isn't needed for this overhaul.

Remember `site/src/styles/theme.css` duplicates the palette, so it must follow the new tokens.

### 2.6 How we make sure the layout is actually better

1. **Wireframes first** (`docs/ui-wireframes.md`, following the precedent of
   `docs/workspace-wireframe.md`). Get sign-off on the IA and the three key screens before
   writing CSS.
2. Build each screen against the stubbed-bridge harness in the Browser pane, taking
   screenshots in both themes at 1440 and 800 px.
3. Walk through the core jobs: *start a task in the current repo*, *see why it picked this
   model*, *review and ship a branch*. Count clicks before and after.

---

## 3. Multi-vendor pull requests

### 3.1 Shape

```
src/main/forges/
  remote.ts      parseRemote(url) → { host, owner/namespace, repo }   (ssh + https + self-hosted; pure)
  types.ts       ForgeAdapter { createPullRequest, getPullRequest, defaultBranch, testAuth }
  github.ts      REST v3 · api.github.com or https://<ghe>/api/v3
  gitlab.ts      REST v4 · merge requests · gitlab.com or self-hosted base URL
  bitbucket.ts   Cloud 2.0 · /repositories/{workspace}/{repo}/pullrequests
  index.ts       vendor detection from remote host + configured accounts
```

- **Accounts:** `AppSettings.forges: ForgeAccount[] { id, vendor, baseUrl, label, hosts[] }`.
  Each token is stored separately and encrypted. The renderer only sees `hasToken` and the
  login returned by *Test connection* (`GET /user` or the vendor's equivalent). Bitbucket
  Cloud should use an **Atlassian API token** (email + token) rather than an app password;
  Atlassian has deprecated app passwords.
- **Flow (Review → Push & open PR):**
  1. Detect the vendor from the repo's remote.
  2. A dialog shows the target branch (the remote's default), the title, and a body
     prefilled from the **run report**: prompt, route receipt (with Jev advice),
     verification results, and changed files. This also covers roadmap item 8.
  3. `git push -u <remote> <branch>` is spawned with `shell:false` and uses the user's
     existing git credentials. The token is used for the **API call only**, never embedded
     in a URL.
  4. The API creates the PR. The result is stored as a `PullRequestLink { vendor, url,
     number, state, checks }` on the branch record.
- **Status:** refreshed when Review is opened or focused (no background polling), and shown
  as a chip for open/merged/closed and checks.
- **Safety (unit-tested):**
  - only `frontier/*` branches can be pushed (`assertTaskBranch`);
  - never force-push;
  - explicit confirmation before push;
  - a clean error when the branch already has a PR (link to it instead of creating a
    duplicate);
  - tokens redacted from every error.
- **Order:** GitHub (including GHE) → GitLab (including self-hosted) → Bitbucket Cloud.
  Bitbucket Data Center, Azure DevOps, and Gitea come later behind the same adapter.
- **Tests:** `tests/forges.test.ts` covers remote parsing (every URL form), request
  building per vendor against fixtures, error mapping, and redaction. Push and PR creation
  are tested with an injected fetch and a local bare git remote, like `worktree.ts`'s tests.

---

## 4. Sequencing

| Phase | Scope | Depends on | Size |
|---|---|---|---|
| **P0** | ADR 0002 + CLAUDE.md/README/site wording · UI wireframes for sign-off | — | S |
| **P1** | Renderer split (no behaviour change) · tokens, components, icons, light theme | P0 wireframes | L |
| **P2** | Jev advisor backend: `advisor.ts`, model profiles, router factors, `pickModel`, engine advising step, Off/Shadow/Active, tests | P0 ADR (**can run in parallel with P1**) | M |
| **P3** | New IA: sidebar groups, project switcher, composer-first Home, **Routing** screen, Route inspector | P1, P2 | L |
| **P4** | Tasks three-pane + inspector · Agents & models table/drawer | P1 | M |
| **P5** | Per-model outcome learning · Jev calibration/insights · subtask advising | P2 + some shadow data | M |
| **P6** | Forges: GitHub → GitLab → Bitbucket, Review & PRs redesign, run-report PR body | P1 | L |
| **P7** | Responsive, accessibility pass, site theme sync, docs/changelog | all | S |

Each phase ships as its own PR with `pnpm typecheck && pnpm test` green and screenshots for
UI phases.

---

## 5. Open questions

All four were answered on 2026-09-24; see *Decisions* at the top. The one still open is
which rebrand direction to take.
