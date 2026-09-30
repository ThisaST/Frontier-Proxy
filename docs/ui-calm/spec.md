# Frontier UI v2 — "Calm" layout and design system. Working spec.

Frontier Proxy is a local-first Electron desktop app that routes coding tasks to CLI agents
(Claude Code, Codex, Copilot, OpenCode, Ollama) already installed on the machine. Read
/Users/thisanet/Development/Personal/proxy-app/CLAUDE.md for the product. The current UI is
"Phosphor Console" (docs/design-phosphor-console.md): amber/cyan/green neon, glow, corner
ticks, three typefaces, uppercase eyebrows, a 9-item sidebar with a capacity rail. The
current screenshots are in site/src/assets/screens/*.png — use them for CONTENT (what each
screen actually shows, real labels, real data shapes), not for style.

## 1. What changes, in one paragraph

Phosphor stays as one selectable theme family. Two new families join it: **Neutral** (cool
grays, one calm indigo accent) and **Mono** (warm stone and ink, near-zero colour). Every
family has light and dark. Independently of theme, the app gets a **new layout**: the
sidebar becomes a floating **dock** the user can place at the bottom, left or right; the
nine sections consolidate to five (Tasks, Workspaces, Review, Agents, Settings); the topbar
with eyebrow + 28px title is gone, replaced by a slim per-screen header row. Density
(comfortable / compact), dock position, dock labels, theme family and scheme are all user
settings under Settings → Appearance.

## 2. Principles (these decide every ambiguous case)

1. **Text carries hierarchy, colour carries state.** Weight, size and spacing do the
   structure. Colour appears only on: the accent (selection, primary action, links), the
   three status tones (ok / warn / danger), and diffs. Nothing else is coloured.
2. **One accent per screen.** One primary button visible at a time. Everything else is
   secondary (bordered) or ghost (text).
3. **Surfaces are flat.** Panels are `--surface` on `--bg` with a 1px `--border`. No corner
   ticks, no inset highlights, no glow, no scanlines, no gradients (Phosphor family only
   keeps its glow token, and only on readouts).
4. **Labels are sentence case.** No uppercase eyebrows. A section heading is 13px/600
   `--fg`; a field label is 12px/500 `--fg-muted`. (Phosphor family may uppercase labels
   via `--label-transform`; the markup stays the same.)
5. **Status is a dot + a word.** Never a coloured pill with uppercase text. A `.status`
   is an 8px dot in the tone colour followed by plain text in `--fg-muted`.
6. **Numbers are mono and tabular.** Token counts, percentages, timings, model ids, branch
   names, paths → `--font-mono`, `font-variant-numeric: tabular-nums`, 12px.
7. **Meters are thin bars.** A 4px track in `--surface-3` with a fill in the tone colour,
   plus the numeric readout beside it. Segmented gauges are gone (Phosphor family may
   render the same `.meter` with segments; the component API is identical).
8. **Nothing is a modal that can be a pane.** Task detail, branch detail and agent detail are
   panes or a right-side sheet, never a centred dialog. Dialogs are for confirmations and
   short forms only (New workspace, Add participant, Add CLI).
9. **Everything the user can configure about the chrome is in one place** (Settings →
   Appearance) and takes effect live.

## 3. Layout model

### 3.1 The dock (replaces the sidebar)
A floating bar with 5 nav items + 2 actions:
- Nav: **Tasks**, **Workspaces**, **Review** (with a count badge when branches are waiting),
  **Agents**, **Settings**. Icons are Lucide-style 18px strokes (`currentColor`, 1.5 stroke).
- Actions, separated from the nav by a 1px divider inside the dock: **New** (a filled
  accent circle with a plus; opens the composer/new-task), **Search** (⌘K command palette).
- Positions: `bottom` (horizontal pill, centred, `--dock-inset` from the bottom edge),
  `left` and `right` (vertical pill, vertically centred, `--dock-inset` from that edge).
- Labels: `hover` (default; tooltip on hover) or `always` (label under the icon at bottom,
  beside it at left/right; the dock grows accordingly).
- Style: `--surface` background, `--shadow-dock`, `--r-4` radius, 6px inner padding, 40px
  items with `--r-2` radius. Active item: `--accent-soft` background + `--accent` icon.
  Hover: `--hover`. Badge: 16px pill, `--accent` bg, `--accent-fg` text, 10px/600.
- The content area pads itself by `--dock-size + 2 * --dock-inset` on the dock's side so
  nothing hides under it.
- Auto-hide is NOT a setting (a dock the user can lose is worse than one that takes 52px).

### 3.2 The header row (replaces the topbar)
One 44px row at the top of every screen: **project switcher** (a bordered button showing a
folder icon + project name + chevron; "All projects" when unscoped) on the left, the screen
**title** (15px/600) next to it, and the screen's own actions on the right (e.g. Review:
"Refresh"; Agents: "Check agents", "Add CLI"). No eyebrow, no 28px display title.
Screens that are not project-scoped (Agents, Settings) omit the switcher.

### 3.3 Screens

**Tasks** (absorbs Home). Three panes, all scroll independently, full height.
- Left, `--queue-w`: the **queue**. A search field at top, then groups "Running", "Needs
  review", "Done", "Failed" as collapsible headers (13px/600 + a count in `--fg-faint`).
  Rows: title (13px, 2-line clamp), meta line (12px `--fg-muted`: agent · time), a status
  dot on the left. Selected row: `--accent-soft` bg. No chips on rows except one small
  "N files" text when >0.
- Centre: the **conversation**. With no task selected it shows the **composer** large
  (this is the old Home): textarea, a segmented "One agent / Split & delegate / Compare"
  control (plain segmented, no card-per-option), a single collapsible "Options" row
  (routing policy, agent, model, skills as compact selects), a one-line route preview
  ("Will run on Claude Code · claude-sonnet-5 · standard tier — Jev decides at start")
  and the one primary button "Start task". Below it, "Recent" (last 5 tasks as rows).
  With a task selected: a compact header (title 15px/600, status, agent·model·tokens·
  elapsed in mono 12px on one line, actions: Run again, Change agent, expand), then the
  thread (user turns right-aligned bubble in `--surface-2`; assistant turns full-width
  with the agent name as a 12px label; markdown, code blocks in `--code-bg`), then the
  reply composer pinned at the bottom (textarea + Send).
- Right, `--inspector-w`, collapsible: the **inspector**. Sections "Route", "Files changed",
  "Activity", each a 13px/600 header with a chevron. Route shows: chosen agent+model, one
  sentence reason, then "Factors" as label/value rows with a thin meter, then the advisor
  block (task type with confidence, complexity as a meter, signals as dot+word, best fit
  as three label/meter rows). Files changed: rows with a tiny "new/edit" text tag, path in
  mono, +/- counts. Activity: a timeline of tool calls (icon, tool name, detail in mono,
  time).

**Workspaces.** Left list of workspaces (name, repo path mono, participant avatars as
2-letter initials in `--surface-3` circles), centre thread (messages with `@handle` chips
rendered as `--accent-soft` inline pills; system messages as centred 12px `--fg-muted`
lines), a composer with @-mention autocomplete, and a "Participants" dialog opened from the header row (decided 2026-09-30: it stays a dialog, not a pane; rows: initials,
@handle, role, availability dot+word, "works on an isolated branch" as a 12px note).

**Review.** Left list grouped by repo (repo name 13px/600, "on main" mono), rows: branch
title, meta (N files · +a −b · time), and a check line as dot+word ("Checks passed:
typecheck, test" / "Checks failed: test" / "No checks detected"). Right: header (title,
branch name mono, actions "Merge into main" primary + "Delete branch" ghost-danger), a
"Checks" list (dot, name, command mono, duration mono right-aligned), then a two-column
file list + diff view (unified diff, add/del rows using `--diff-*`, line numbers mono
`--fg-faint`).

**Agents.** A short intro sentence. A table: Agent (dot + name), Kind (mono), Login
(dot + "Signed in" / "Unknown" / "Logged out"), Version (mono), Models (count + up to 3
small neutral text tags: frontier / standard / fast / local), Today's tokens (mono), Plan
window (thin meter + "resets in 1h 57m" mono), Enabled (switch). Clicking a row opens a
right-side **sheet** (not a drawer over the whole screen) with the agent's config.
Getting-started guidance becomes a dismissible single-line notice, not three cards.

**Settings.** Left tab list (vertical, 13px): **General** (scheduler concurrency,
failover, notifications, Frontier memory), **Appearance**, **Routing** (advisor mode
segmented Off/Shadow/Active, key, model, confidence slider, share-repo-facts switch,
policies table, calibration table), **Context & Tools** (system prompt, extra dirs, tool
allow/deny lists, MCP servers table with an "Import .mcp.json" action, per-agent preview),
**Skills** (catalog table with enable switches, scope, native-for tags), **Verification**
(detected checks, custom commands). Right: the tab's content, max 760px wide, sections
separated by 32px with 13px/600 headings.
**Appearance** tab contains exactly: Theme family (three preview tiles: Neutral, Mono,
Phosphor, each showing a mini mock of the shell in that family), Scheme (System / Light /
Dark segmented), Dock position (Bottom / Left / Right segmented), Dock labels (On hover /
Always), Density (Comfortable / Compact), Reduce effects (switch, shown enabled only for
Phosphor), Font size (Default / Large). Every change applies live.

### 3.4 Privacy line
The old sidebar privacy line ("Local process mode · prompts stay on this machine" vs the
Jev disclosure) moves to a small **status chip at the far right of the header row**:
dot + "Local" (ok tone) or dot + "Jev · Active" (info tone) with a tooltip carrying the
full disclosure. It must exist on every screen (ADR 0002 requires the disclosure).

## 4. Component inventory (v2)

Every component uses only tokens from tokens.css. Names below are the CSS classes the
prototype and the design-system page must share.

- `.btn` `.btn-primary` `.btn-secondary` `.btn-ghost` `.btn-danger` `.btn-sm` `.btn-icon`
  — 32px (26px sm), `--r-2`, 13px/500. Primary: `--accent-fill` bg (equal to `--accent` in every family except Phosphor light, where the text accent is too dark to be a button fill), `--accent-fg` text, hover `--accent-hover`.
  Secondary: `--surface` bg + `--border`. Ghost: transparent, `--fg-muted` → `--fg` on
  hover. Danger: ghost with `--danger` text; hover `--danger-soft` bg.
- `.input` `.select` `.textarea` — `--surface` bg, `--border`, `--r-1`, 13px, 32px tall;
  focus: `--focus` 1px border + 3px `--selection` ring.
- `.switch` — 32×18 track, `--surface-3` off / `--accent` on, 14px knob.
- `.segmented` — a `--surface-2` track with `--r-2`; the active option is `--surface` with
  `--shadow-1`; 13px/500.
- `.status` — dot (8px, tone) + text. Tones: `.ok` `.warn` `.danger` `.info` `.neutral`
  `.running` (running = accent dot with a soft 1.2s pulse, disabled with reduced motion).
- `.tag` — small text tag, 11px/500, `--surface-2` bg, `--fg-muted`, `--r-1`, 2px 6px
  padding. Never coloured, never uppercase. Used for kinds, tiers, file actions.
- `.badge` — count, 16px pill, `--accent` bg.
- `.meter` — 4px track + fill; `.meter.ok/.warn/.danger/.accent`; readout beside it in mono.
- `.card` — `--surface`, `--border`, `--r-3`, 16px padding. Rarely used: only the theme
  preview tiles, agent sheet sections, and the composer.
- `.row` — list row: 10px 12px padding, `--r-2`, hover `--hover`, selected `--accent-soft`.
- `.section-title` — 13px/600 `--fg`; `.field-label` — 12px/500 `--fg-muted`.
- `.table` — 13px, header 12px/500 `--fg-muted`, rows separated by `--border`, hover `--hover`,
  numeric cells mono right-aligned.
- `.tabs` (horizontal, underline style: 2px `--accent` under the active tab) and
  `.vtabs` (vertical, Settings).
- `.sheet` — right side panel, 420px, `--surface`, `--shadow-2`, slides in over content.
- `.dialog` — centred, 480px, `--r-4`, `--shadow-2`, header 18px/600, footer actions right.
- `.toast` — bottom-right (bottom-left if dock is right? no: always top-right, 12px from
  edge), `--surface`, `--shadow-2`, dot+text.
- `.tooltip` — `--fg` bg, `--bg` text, 12px, `--r-1`.
- `.kbd` — 11px mono, `--surface-2`, `--border`, `--r-1`.
- `.empty` — centred 13px `--fg-muted` text + one secondary action, no illustration.
- `.dock` — see 3.1.
- `.avatar` — 24px circle, `--surface-3`, 11px/600 initials.
- `.code` / `.diff` — `--code-bg`, mono 12px, 1.5 line-height; diff rows use `--diff-*`.

Focus: every interactive element gets `outline: 2px solid var(--focus); outline-offset: 2px`
on `:focus-visible`. Never removed.

## 5. Type scale
Inter for everything except numbers/code (JetBrains Mono). 28 is gone. Scale: 11 (tags,
kbd), 12 (meta, labels, mono data), 13 (default UI, table cells, buttons), 14 (conversation
body), 15 (screen title, task title), 18 (dialog title, big empty-state), 22 (only the
composer heading "What should an agent do?"). Weights 400/500/600 only.
Google Fonts link for mockups: Inter 400/500/600, JetBrains Mono 400/600, plus Chakra Petch
500/600 and IBM Plex Sans 400/500/600 (Phosphor family only).

## 6. Themes in the prototype
The shell is `<div class="app" data-family="neutral|mono|phosphor" data-scheme="light|dark"
data-dock="bottom|left|right" data-dock-labels="hover|always" data-density="comfortable|
compact">`. Tokens are scoped to that element (see tokens.css). The initial scheme follows
`prefers-color-scheme`. The prototype's own Settings → Appearance controls change these
attributes live; a small floating "Preview controls" strip (top-right, outside the app
frame, clearly marked as prototype-only) offers the same switches so a reviewer can flip
theme/dock from any screen. Persist choices in localStorage inside try/catch.

Phosphor in the new layout must still look like Phosphor: amber accent, glow on readouts
(`text-shadow: var(--glow)` on `.readout`), Chakra Petch for `.section-title` and the
screen title via `--font-display`, uppercase tracked labels via `--label-transform` /
`--tracking-label`. No corner ticks and no scanlines in the new layout — those were the
complexity; the palette and type are the identity.
