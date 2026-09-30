# Frontier Calm: UI plan

Draft for owner approval. Companion to `SPEC.md` (the decided direction) and `tokens.css` (the token layer). Written against the repo at v0.9.3 (`main`, 87f4673). Nothing in the repo has been modified.

## 1. Summary

Frontier's renderer gets a new layout and a flatter design system: a floating dock replaces the sidebar, nine sections become five, a 44px header row replaces the 104px topbar, and three theme families (Neutral, Mono, Phosphor), each in light and dark, replace the single Phosphor Console. The current UI reads as complex because it says the same thing several ways at once: up to five accent hues on one screen, corner ticks, glow, scanlines, uppercase eyebrows, coloured pills that carry more than ten different meanings, and 12 sidebar controls before any content. The work runs in seven phases; P1 and P2 change nothing users can see, and P3 onward land on an integration branch that ships when P6 is done. Not changing: the main process, the preload/IPC bridge, the domain model and `AppSettings`, routing and failover behaviour, the ADR 0002 disclosure duty, and the Phosphor palette, which stays selectable and remains the default until one constant is flipped in P6. Decided by the owner on 2026-09-30: Neutral is the default family for every user, including those who had chosen Console or Daylight (section 7.3); Home is removed and Tasks in compose state is the start screen (section 10.2); the participant roster stays a dialog (section 10.1, row 2).

## 2. Audit of the current UI

Evidence comes from the console and daylight screenshots in `site/src/assets/screens/` and from the renderer source. Phosphor Console was a deliberate identity (`docs/design-phosphor-console.md`) and it suits a console that sits over several agents. It is kept as a family. This audit explains why the screens read as busy; it is not a verdict on the design.

### 2a. Colour and effects

Distinct accent hues visible on one screen, counted from the screenshots:

| Screen | Screenshot | Hues | Which |
|---|---|---|---|
| Home | `home-console.png` | 3 | amber, green, cyan |
| Agents | `agents-console.png` | 3 | amber, green, cyan |
| Tasks | `tasks-console.png` | 4 | amber, green, cyan, orange |
| Review | `review-console.png` | 4 | amber, green, cyan, red |
| Routing | `routing-console.png` | 5 | amber, green, cyan, orange, plus the browser-default blue on the checkboxes |

- **Colour marks category as well as state.** On Agents, green means "signed in" in the Login column and "standard tier" in the Models column. Amber means "frontier tier", the plan-usage bar, the enabled toggle, and the version and token numbers (`agents-console.png`). The reader cannot infer the meaning from the colour.
- **Glow.** `text-shadow` on `strong.readout`, and `box-shadow` on lamps, gauge segments, the slider thumb and the switch knob. Eighteen stylesheet lines outside `tokens.css` mention glow.
- **Corner ticks.** Eight gradient layers on `.panel::before` and `dialog::before` (`components.css`, lines 1-30). They show on every panel corner in all five console screenshots.
- **Scanlines.** `.screen::after` draws a repeating gradient over the advisor well in the Tasks inspector (`tasks-console.png`), the route cards, the "what is sent" request preview and the usage history chart.
- **Radar sweep and lamp blink.** A conic-gradient radar marks a queued task and a blinking amber lamp marks a running one (`home-console.png`, "Running now").
- **Uppercase eyebrows.** 27 `class="eyebrow"` elements in `index.html`, 24 lines in TS that build or name one, and 24 `text-transform: uppercase` rules across nine stylesheets. `home-console.png` alone shows nine uppercase labels: MISSION CONTROL, START WORK, IN FLIGHT, WAITING FOR YOU, CAPACITY (column), WORK, SETUP, CAPACITY (rail) and ADVANCED, plus the FRONTIER / LOCAL AGENT ROUTER wordmark.
- **Three typefaces and small type.** Chakra Petch, IBM Plex Sans and JetBrains Mono. Of the 183 font declarations at 8-13px in the stylesheets, 101 are 10px or smaller (16 at 8px, 49 at 9px, 36 at 10px) and 7 are 13px. Pills are 8-9px mono uppercase (`.chip`, `.check-chip`).

### 2b. Chrome

- **Sidebar: 12 interactive targets.** Project switcher, collapse toggle, nine nav destinations (Home, Tasks, Workspaces, Review, Agents, Routing, Context & Tools, Skills, Settings) and the advisor chip. It also holds the wordmark and tagline, three group labels (WORK, SETUP, CAPACITY) and five capacity rows that read "available" on every screen. Below 820px window height (`base.css`, `@media (max-height: 820px)`) the rows become five more lamp buttons. The sidebar is 244px wide, 17% of the default 1440px window.
- **Topbar.** 104px tall (`.topbar` in `base.css`), 11% of the default 920px window height. It carries a 10px eyebrow and a 28px title that restate the sidebar item just clicked ("Home" under MISSION CONTROL in `home-console.png`).
- **Header actions are duplicated.** "New task" is a topbar button on Tasks, Agents and Settings (`tasks-console.png`, `agents-console.png`), "Start task" is Home's composer button, the ⌘N dialog is a third copy of the same form, and the palette has a fourth entry. On Agents the amber "New task" sits beside Check agents and Add CLI, which are that screen's real actions.
- **Project scope is stated up to three times.** The sidebar switcher, a "Project: todo-api" chip at the top of the queue and of the review list (`tasks-console.png`, `review-console.png`), and the chip inside Home's composer.

### 2c. Per-screen issues

- **Home and Tasks duplicate each other.** The composer exists as Home's panel, as the ⌘N dialog (`#task-dialog`, same fields under different ids) and as the reply box in the conversation. Home's "Running now" and "Needs your review" columns repeat the Tasks queue groups of the same names, and its "Agents" column repeats the sidebar capacity rail and the Agents table. Agent capacity is drawn in three places (`home-console.png`, `tasks-console.png`, `agents-console.png`).
- **Run-mode cards.** Three cards about 355px wide, each with a title and a 9px sentence, for a choice where "One agent" is the default (`home-console.png`). Between the textarea and the primary button sit five bands: the label "How should this run?", the cards, a collapsed ADVANCED disclosure, the route preview line and the button. The same cards repeat in the ⌘N dialog.
- **Getting-started cards on Agents.** Three numbered cards (01, 02, 03), about 100px tall, above the table (`agents-console.png`). The content is instruction that is needed once. They can be dismissed with a small icon at the card edge.
- **One pill shape, more than ten meanings.** SIGNED IN / UNKNOWN (login) and FRONTIER / STANDARD / FAST / LOCAL (tier, three colours) in `agents-console.png`. CHECKS PASSED: TYPECHECK, TEST / CHECKS FAILED: TEST (check result) and NEW / EDIT (file action) in `review-console.png`. COMPLETED (task status) and JEV · JEV-1.13.0 (advisor source) in `tasks-console.png`. STANDARD TIER (route preview) in `home-console.png`. The queue adds `split` and `31% ctx` tags (`tasks-console.png`), Review adds `merged`, Skills adds native and prompt-injected badges, and the project scope is a pill too. That is eleven meanings. The rounded-pill shape is shared by eleven components (`.status-pill`, `.chip`, `.project-chip`, `.project-field-chip`, `.check-chip`, `.skill-badge`, `.review-merged-chip`, `.task-group-count`, `.stage-step`, `.receipt-chip`, `.lane-measure`).
- **Routing is a top-level section.** It sits in the Setup group with Agents, Context & Tools and Skills, and Settings is a fifth place at the bottom, so configuration lives in five destinations. The Routing screen is five cards (advisor, policies, what is sent, catalog, insights) that are settings, not a place people work in. On the advisor card two save models coexist: a "Save advisor settings" button and a checkbox whose help text says "Saved immediately when changed" (`routing-console.png`).
- **The inspector is dense.** In `tasks-console.png` the 320px inspector shows about 25 data points before the Files and Activity sections: source chip and latency, six task-type bars, a complexity bar, three signals, three best-fit bars and a sentence, under seven uppercase micro-headings (INSPECTOR, ROUTE, ADVISOR, TASK TYPE, COMPLEXITY, SIGNALS, BEST FIT), mostly at 9-11px.
- **The queue and conversation header stack chrome.** Queue rows carry up to three bordered chips (agent, "N files", "31% ctx") and a coloured "split" tag, and the queue header wraps "WORK QUEUE", "Tasks", the search box and "Clear finished" into 280px (`tasks-console.png`). The conversation has four bands of chrome before the first message: title with status pill and three icon buttons, subtitle, a five-cell meta strip (AGENT, MODEL, TOKENS, ELAPSED, CONTEXT), and an action row.
- **Daylight changes colour, not complexity.** `home-daylight.png` keeps every device above (ticks, eyebrows, pills, run-mode cards) on a beige palette.

## 3. Goals and non-goals

**Goals**

1. One accent per screen and colour only for state (SPEC principles 1 and 2).
2. Fewer places: five sections, one way to start work, one place to configure.
3. Less chrome: a 44px header row, no permanent sidebar, content gets the full window.
4. Readable type: nothing under 11px, 13px as the UI default.
5. Keep the Phosphor identity available and legible as a family.
6. Lose no capability and no disclosure. The ADR 0002 privacy chip is visible on every screen.
7. Migrate in steps that each typecheck, pass tests and can be reviewed alone.

**Non-goals**

- No change under `src/main`, `src/preload` or `src/shared/types.ts`; `AppSettings` gains no fields. Appearance stays renderer-only.
- No new product features. No dock auto-hide (SPEC 3.1), no per-participant themes, no framework migration. The renderer stays vanilla TS and CSS.
- No change to routing, failover, verification or workspace behaviour.
- No new icon set. Lucide stays.
- No rewrite of markdown or diff rendering. Only the colours those read change.

## 4. The decided direction

Taken from SPEC sections 1 and 2. This plan does not re-decide any of it.

- **Three families, two schemes.** Neutral (cool grays, one indigo accent), Mono (warm stone and ink, near-zero colour) and Phosphor (the current palette mapped onto the new token names). Each has light and dark: six variants.
- **New layout.** A floating dock at the bottom, left or right replaces the sidebar. A 44px per-screen header row replaces the topbar. Density is comfortable or compact.
- **Five sections.** Tasks (absorbs Home), Workspaces, Review, Agents, Settings (absorbs Routing, Context & Tools, Skills, Verification).
- **Principles that settle ambiguous cases.**
  1. Text carries hierarchy, colour carries state. Colour is only the accent, the three status tones, and diffs.
  2. One accent per screen, one primary button visible at a time.
  3. Surfaces are flat: no ticks, inset highlights, glow, scanlines or gradients. Phosphor keeps its glow token, on readouts only.
  4. Labels are sentence case. Phosphor may uppercase them through `--label-transform`.
  5. Status is a dot and a word, never a coloured uppercase pill.
  6. Numbers are mono and tabular.
  7. Meters are thin bars with a numeric readout.
  8. Nothing is a modal that can be a pane. Dialogs are for confirmations and short forms.
  9. Everything configurable about the chrome lives in Settings → Appearance and applies live.

## 5. Information architecture

Every current destination, dialog and overlay, and where it goes.

| Current | After | Notes |
|---|---|---|
| Home (`#home-view`): composer, Running now, Needs your review, Agents cards | Tasks, compose state | Composer moves to the centre pane. "Running now" and "Needs your review" become the queue groups. The Agents cards are dropped (the Agents table has the same data). A "Recent" list (last 5 tasks) sits under the composer. |
| Tasks | Tasks | Queue, conversation and inspector keep their roles and resize gutters. |
| Workspaces | Workspaces | Dock item. |
| Review with count badge | Review, badge on the dock item | The badge is written today as a side effect of `renderHome()`. It gets its own writer in P3. |
| Agents | Agents | Table stays. Getting-started cards become a one-line dismissible notice. |
| Routing | Settings → Routing | All five cards move, not only SPEC's list (section 10.1). |
| Context & Tools | Settings → Context & Tools | The control-plane draft must stay mounted (P5). |
| Skills | Settings → Skills | Keeps its own project-directory field, defaulting to the current project. |
| Settings (scheduler, verification, notifications, memory, appearance cards) | Settings → General, Verification, Appearance | General: scheduler and failover, notifications, memory. |
| Sidebar wordmark and tagline | Removed from the chrome | The name stays in the window title. SPEC is silent; see open question 10.2 (7). |
| Sidebar project switcher | Header row, left | Shown on Tasks, Workspaces, Review. Omitted on Agents and Settings. |
| Sidebar collapse toggle (`fp-sidebar-collapsed`) | Removed | The key is ignored, not migrated. |
| Sidebar capacity rail | Agents table (status and plan-window columns) | Not repeated on other screens. |
| Advisor status chip (sidebar) | Header chip, far right, every screen | Click opens Settings → Routing. Carries the full disclosure (section 6.2). |
| Topbar with eyebrow, title and "New task" | Header row, and the dock "New" action | |
| New task dialog (`#task-dialog`, ⌘N) | Dock "New" and ⌘N open Tasks in compose state | Dialog removed in P4. In P3 the dock button still opens it. |
| "Project: name ×" chips in queue, review and workspace lists | Removed | The header switcher replaces them. |
| Tasks "Clear finished" | Action on the Done group header, and the palette | |
| Review "Refresh"; Agents "Check agents" and "Add CLI" | Header row actions | |
| Command palette (`#command-palette`) | Stays a dialog. Dock "Search" and ⌘K open it | Entries change: "Go to Home", "Routing", "Context & Tools", "Skills" become Settings tab targets. |
| Agent drawer (`#agent-drawer`) | `.sheet` on the same `<dialog>` | Restyled, 460px to 420px, still modal for focus containment. |
| File overlay (`#task-file-overlay`) | Stays an overlay | Restyle only. |
| Participants dialog (`#participants-dialog`) | Stays a dialog, restyled with `.dialog` | Owner decision, 2026-09-30; keeps the choice made in `eddbef9`. |
| Participant editor, workspace form, confirm dialog | Stay dialogs | Short forms and confirmations. |
| Toast (bottom-right) | Top-right, dot and text | |
| Shared tooltip (`ui/tooltip.ts`) | Stays | Unchanged. Dock labels use the prototype's CSS `::after`, which is safe because the dock is `position: fixed` and sits in no scrolling ancestor. |

`switchView(view: string)` has 21 call sites in 8 files. It keeps accepting the old ids through a pure `resolveView()` in a new `src/renderer/src/nav.ts`: `home` resolves to Tasks in compose state, and `routing`, `control`, `skills` resolve to Settings plus a tab. No caller changes.

## 6. Layout model

### 6.1 The dock

- **Items.** Tasks, Workspaces, Review, Agents, Settings. A 1px divider, then New (filled accent circle) and Search. The dock keeps `class="nav-item"` and `data-view` on its five nav buttons, because `workspace.ts` (`goToNav`) and `site/scripts/screenshots/capture.js` query `.nav-item[data-view]`. The New button reuses the id `new-task-button`.
- **Position.** `bottom` (horizontal, centred), `left` or `right` (vertical, centred), each `--dock-inset` (12px) from the edge.
- **Labels.** `hover` shows a tooltip on hover and on keyboard focus. `always` puts the label under the icon at the bottom and beside it at left and right. `--dock-size` grows with it: 52px to about 64px at the bottom, 52px to about 148px at the sides. These are starting values to tune in P3.
- **Badge.** Review only. 16px pill, `--accent-fill` background, `--accent-fg` text, hidden at zero.
- **Content padding.** `main` pads `--dock-size + 2 * --dock-inset` (76px by default) on the dock's side, so nothing sits under it. Overlay panels that today use `top: 104px` (`views/tasks.css`, two rules) switch to a `--header-h` token.
- **Short windows.** The window minimum is 720 x 560 (`src/main/index.ts`). A vertical dock is about 320px tall. It gets `max-height: calc(100vh - 2 * var(--dock-inset))` and scrolls if it has to.
- **macOS.** The window uses `titleBarStyle: 'hiddenInset'`, and no `-webkit-app-region` exists in the repo. The header row is the drag region (buttons opt out) and, when the dock is not at the left, its left padding clears the traffic lights. A renderer-derived `data-platform` attribute drives that.

### 6.2 The header row and the privacy chip

One persistent `<header class="app-header">` element, 44px, above the screens: project switcher (Tasks, Workspaces, Review only), screen title (15px/600), a flexible gap, the screen's action slot, and the privacy chip. Screens fill the title and action slot. Because the row is one element, not a per-screen copy, the chip cannot be missing from a screen.

The chip is a ghost `button` holding a status dot and a word: "Local" (ok tone) or "Jev · Shadow" / "Jev · Active" (info tone). Its text and tooltip come from a pure `advisorDisclosure(settings, hasKey)` in `src/renderer/src/advisor-disclosure.ts`, extracted from `renderAdvisorStatus()` in `main.ts`. The wording is preserved: with the advisor on and a key stored, the sentence names Jev and the mode and lists what leaves the machine, including split-run subtask prompts. It never says "local" in that state (CLAUDE.md, "The sidebar privacy line must stay truthful"). The chip is focusable and uses the shared tooltip, so the disclosure shows on focus as well as hover, and `aria-label` carries the full sentence. The "What is sent" card in Settings → Routing remains the long-form disclosure.

### 6.3 Pane model per screen

| Screen | Panes | Notes |
|---|---|---|
| Tasks | Queue (`--queue-w`, 300px) · conversation or composer (flexible, 420px floor) · inspector (`--inspector-w`, 320px, collapsible) | Resize gutters and `fp-wq-width` / `fp-inspector-width` stay. The auto-collapse thresholds measure the container, so the dock padding is absorbed. `[` and `]` keep toggling the panes. |
| Workspaces | List · thread; participants in a dialog opened from the header row | Composer with @-mention autocomplete stays under the thread. |
| Review | List grouped by repo · detail (checks, then file list and diff) | |
| Agents | One table · sheet on row click | |
| Settings | Vertical tabs (about 200px) · content, 760px maximum | Default tab: General. |

### 6.4 What is configurable, and the defaults

All in Settings → Appearance, all applied live, all stored in the renderer.

| Setting | Control | Attribute on `<html>` | localStorage key | Values | Default |
|---|---|---|---|---|---|
| Theme family | Three preview tiles | `data-family` | `fp-family` | `neutral`, `mono`, `phosphor` | `neutral` (Phosphor until the flip in P6) |
| Scheme | Segmented | `data-scheme` (resolved) | `fp-scheme` | `system`, `light`, `dark` | `system` |
| Dock position | Segmented | `data-dock` | `fp-dock` | `bottom`, `left`, `right` | `bottom` |
| Dock labels | Segmented | `data-dock-labels` | `fp-dock-labels` | `hover`, `always` | `hover` |
| Density | Segmented | `data-density` | `fp-density` | `comfortable`, `compact` | `comfortable` |
| Reduce effects | Switch, enabled for Phosphor only | `data-effects` | `fp-effects` (kept) | `on`, `off` | `on` (forced `off` under `prefers-reduced-motion`) |
| Font size | Segmented | `data-font-size` | `fp-font-size` | `default`, `large` | `default` |

Font size is in SPEC 3.3 but not in SPEC section 6 or the attribute list, so this plan adds it as the seventh setting (open question 10.2 (10)).

**Why these defaults**

- **Dock at the bottom.** Tasks is width-constrained: the conversation keeps a 420px floor next to a 300px queue and a 320px inspector in a window whose minimum is 720px wide. A side dock spends 76px of that width. The bottom dock spends 76px of height, and every pane already scrolls inside a fixed shell, so height is the cheaper axis.
- **Labels on hover.** Five destinations with familiar icons do not need permanent labels, and `always` grows the dock. Tooltips show on keyboard focus as well as hover, so this costs no keyboard access.
- **Comfortable density.** The current UI is dense already, so the default should not add to it. Compact is opt-in.
- **Neutral.** One calm accent is the point of the redesign. Phosphor stays one click away.
- **System scheme.** It matches the old "System" default, so the OS setting keeps deciding.

## 7. Theme model and persistence

### 7.1 Attributes

In the app, all attributes go on `<html>`, not on a `.app` wrapper. The prototype and the design-system page scope tokens to `.app[...]` only so that several themed shells can sit on one page.

| Attribute | Values | Notes |
|---|---|---|
| `data-family` | `neutral`, `mono`, `phosphor` | |
| `data-scheme` | `light`, `dark` | Always resolved. `system` is a stored preference, never an attribute value. |
| `data-dock` | `bottom`, `left`, `right` | |
| `data-dock-labels` | `hover`, `always` | |
| `data-density` | `comfortable`, `compact` | |
| `data-effects` | `on`, `off` | Kept as is. `[data-effects='off']` already stops all motion (`base.css`). |
| `data-font-size` | `default`, `large` | Large raises the `--fs-*` scale by 1px. Fully effective only after the views stop using raw px (P6). |
| `data-platform` | `mac`, `other` | Derived from `navigator`, not a setting. Drives the traffic-light inset. |

The old `data-theme` (`console`, `daylight`) is retired. Only `theme.ts`, `public/theme-init.js` and `tokens.css` read it today.

**Selector strategy.** `tokens.css` writes each variant as `:is(:root, .app)[data-family="neutral"][data-scheme="light"]`. One file serves the app (attributes on `<html>`), the design-system page and the Appearance preview tiles (a nested `.app` carrying its own `data-family` and `data-scheme`). A bare `:root` block carries the default variant, so a page whose init script failed still renders. Under the current default it is Phosphor dark.

### 7.2 `theme.ts` and `public/theme-init.js`

`theme-init.js` stays a plain, non-module script loaded before the stylesheet (the CSP has no `'unsafe-inline'`, and it cannot import). It reads the keys above and sets every attribute before first paint, without writing storage. On any error it falls back to the default family, dark scheme, effects off, as it does now.

`theme.ts` becomes the appearance module. It exports a pure `resolveAppearance(stored, prefersDark, reducedMotion)` that both files implement identically (a test runs `theme-init.js` in `node:vm` against the same matrix). It also exports one setter per setting, `initTheme()` (applies attributes, writes the migrated keys once, listens to `prefers-color-scheme` when the scheme is `system`, and to `prefers-reduced-motion`), and, until P3, a compatibility adapter for `themePreference` / `setThemePreference` so the existing Appearance card keeps working.

All of it is a renderer-only preference and is never sent to the main process (CLAUDE.md).

### 7.3 Migration from `fp-theme`

| Stored `fp-theme` | Family | Scheme |
|---|---|---|
| `console` | `neutral` | `dark` |
| `daylight` | `neutral` | `light` |
| `system` | `neutral` | `system` |
| absent | `neutral` | `system` |

- `fp-theme` is left in place, never deleted, so a downgrade still finds its key. Once `fp-family` exists, `fp-theme` is never read again.
- `fp-effects` is unchanged.
- The Family column is one constant, `DEFAULT_FAMILY`. The old value still decides the scheme, so a Console user lands on Neutral dark and a Daylight user on Neutral light.

> **Decided (owner, 2026-09-30): Neutral for everyone.** Every user lands on Neutral after the P6 flip, including those who explicitly chose Console or Daylight; their light/dark choice is carried over as the scheme. Phosphor stays one click away in Settings → Appearance. The earlier idea of keeping explicit Console/Daylight users on Phosphor was dropped because a redesign that only reaches new installs does not fix the problem it exists to fix.

Until the flip in P6, `DEFAULT_FAMILY` is `'phosphor'`. Merged early phases therefore change nothing for anyone.

### 7.4 Old token names, kept as aliases through P6

P1 adds a legacy alias block so the untouched views render in every family. It is deleted in P7. Persisted workspace participants store `accent` as strings such as `var(--amber)` (`ACCENT_SWATCHES` in `workspace.ts`), so those aliases must survive until P6 stops rendering accents.

| Old | New | Old | New |
|---|---|---|---|
| `--amber` | `--accent` | `--surface-1` | `--surface` |
| `--amber-fill` | `--accent-fill` | `--bezel` | `--border` |
| `--on-amber` | `--accent-fg` | `--bezel-strong` | `--border-strong` |
| `--cyan` | `--info` | `--hover-wash` | `--hover` |
| `--phosphor` | `--ok` | `--glow-amber` and the other four | `--glow` |
| `--caution` | `--warn` | `--font-body` | `--font-sans` |
| `--alarm` | `--danger` | `--r-sm`, `--r-md`, `--r-lg` | `--r-1`, `--r-2`, `--r-3` |

Rule for new code: text, icons, links and borders use `--accent`; anything that sits behind `--accent-fg` text (primary button, dock badge, switch track when on) uses `--accent-fill`. The two are equal in five variants. In Phosphor light `--accent` is `#8f5a00` and `--accent-fill` is `#c98a00`, because the text accent fails contrast as a fill under dark text. `--accent-fill` replaces `--amber-fill` one for one.

## 8. Component map

SPEC section 4's components, mapped to what they replace. "Markup" says whether HTML or TS output changes.

| v2 | Replaces | Markup |
|---|---|---|
| `.btn` `-primary` `-secondary` `-ghost` `-danger` `-sm` `-icon` | `.primary-button` (14 in `index.html`, 3 in TS), `.secondary-button` (13, 8), `.text-button` (6, 9), `.icon-button` (12), `.primary-button.cancel-button` | Yes. Class rename in static markup and in `element('button', …)` calls. `cancel-button` becomes `-danger`. |
| `.input` `.select` `.textarea` | Bare `input, textarea, select` rules in `base.css`; `label` micro-type (10px) | Small. Classes added; bare-element rules deleted in P7. |
| `.switch` | `.switch` and `.slider` (`label > input[type=checkbox] + span`, in `agents.ts`, `skills.ts` and the effects switch in `index.html`) | Yes. The prototype's switch is `<button role="switch" aria-checked>`, so consumers listen for `click` instead of `change`. Same class name, so it swaps with its consumers in one change. |
| `.segmented` | `.segmented`, plus `ui/segmented.ts` keyboard behaviour | CSS only. The prototype uses `role="group"` with `aria-pressed` buttons; the app keeps its `radiogroup` / `radio` pattern with `aria-checked` and roving tabindex (the accessibility pass), so the kit CSS selects on `[aria-checked="true"]` too. Same class name; swap atomically. |
| `.status` (dot and word) | `lamp()` (20 calls), `.lamp-*`, `.status-pill` (3), `radar()` (2), `taskStatusIndicator`, `.check-chip`, the capacity badge | Yes. New `status(tone, text?, label?)` factory. Text omitted gives a dot-only status with `aria-label` (queue rows). `.status.running` replaces radar and blink. |
| `.tag` | `chip()` for tiers and kinds (`agents.ts:283`, `routing.ts:441`), JEV and LOCAL RULES (`tasks.ts:456`, `493`, `500`, `578`), `.tag-orchestrated`, `.tag-context`, `.skill-badge`, `.review-merged-chip`, file-action NEW / EDIT | Yes. New `tag(label)`. Never coloured. Login chip (`agents.ts:270-271`) becomes a `status`. |
| `.badge` | `.nav-badge` | Dock Review item only. `.task-group-count` becomes plain text in a faint tone, not a badge. |
| `.meter` | `gaugeSeg()` (7 calls), `probabilityBar()` and `probabilityBars()` (4), `.usage-gauge` | Yes. New `meter(percent, tone, label)` keeps the ARIA logic (`role="meter"` with `aria-valuenow`, plain `img` when the value is unknown) and a `meterRow(label, value)` for factor rows. The prototype sets `--value` in an inline `style` attribute; the app's CSP is `style-src 'self'`, which blocks that in markup, so the factory sets it with `style.setProperty`, as `gaugeSeg` and `probabilityBar` do today. |
| `.card` | Four uses only: theme preview tiles, agent sheet sections, the composer, lane cards | New. `.panel` stays as the name for panes and loses ticks and the inset highlight. |
| `.row` | `.task-row`, `.workspace-item`, `.project-switcher-item`, `.composer-mention`, `.command-palette-item`, `.workspace-roster-row`, `.skill-card` | Add `.row`; keep the hook classes JS uses. |
| `.section-title`, `.field-label` | `.eyebrow` (27 static, 24 TS lines), card `h2`, `.nav-group-label`, `.inspector-section-title`, `.task-group-head`, the 10px `label` style | Yes. Each eyebrow is deleted. The heading under it becomes a `.section-title`, or goes if the screen title already says it. |
| `.table` | `.data-table`, `.table-wrap`, `dataTable()` | Class rename. Column `render` functions stay. |
| `.vtabs` | New, for Settings | New. `.tabs` (horizontal) has no consumer in this plan and is not built until one exists. |
| `.sheet` | `.drawer` on `#agent-drawer` | Class change on the existing `<dialog>`. Also used for the participants sheet. |
| `.dialog` | Global `dialog` rule (660px, corner ticks) | CSS. 480px for short forms. The file overlay and the palette keep their own widths. |
| `.toast` | `#toast` | CSS. Moves top-right. |
| `.tooltip` | `.ui-tooltip` and `ui/tooltip.ts` | CSS only. The dock's own labels are CSS. |
| `.kbd` | `.command-palette-item-key`, `.command-palette-hint` (8px uppercase) | Small. |
| `.empty` | `.empty-state`, `emptyState()`, `.detail-empty` (20 TS uses) | Class rename in `ui/dom.ts`. |
| `.dock` | `.sidebar`, `.nav-item`, `.nav-badge`, `.sidebar-toggle`, `.provider-rail`, `.mini-provider*`, `.advisor-status` (becomes the header chip) | Yes. New markup in `index.html`. |
| `.avatar` | `.ws-avatar-dot` (coloured by `participant.accent`) | Yes. Two-letter initials on `--surface-3`. |
| `.code` `.diff` | `.task-code-line` family, `.md-code`, `.md-pre`, the `.hljs-*` colours | CSS only. `renderDiffInto` and `codeLine` are unchanged. `--code-bg` and `--diff-*` replace the `color-mix()` calls on the old tones. |

**Vanish:** `gaugeSeg` (to `meter`), `lamp` (to `status`), `radar` (to `status.running`), corner ticks (`.panel::before`, `dialog::before`), scanlines (`.screen`, four uses), `probabilityBars` (to meter rows), `.eyebrow`, the `--glow-*` tokens. **Stays:** `.readout` (mono tabular numbers; Phosphor adds its glow), `inspectorSection()` (restyled), `dialogHandle()` and `restoreFocusOnClose()`.

**Exists in the code, absent from SPEC section 4.** These need a call in P4-P6. Proposed: the orchestration stage bar (`.stage-step` pills) becomes one line of plain text with the current stage in `--fg`; the meta strip (`.meta-chip`) becomes one mono line; the run-mode cards (`.run-mode`, in `index.html` and `task-form.ts`) become a `.segmented` control, with the sentence shown for the selected option only; the compare-agents checklist (`.bench-provider`) becomes checkbox rows; lane cards (`laneCard` in `tasks.ts`) become `.card` with a `status` and a `meter`; `.project-chip` and `.project-field-chip` go, since the header switcher replaces them (the composer keeps a plain project field).

## 9. Migration phases

**Release rule.** P1 and P2 are safe to release alone: they change nothing visible. P3 through P6 land on a long-lived integration branch (`calm`) and ship together when P6 is done, because P3 removes the sidebar and P4 removes Home. A user should never see the new dock over old screens. The default-family flip (`DEFAULT_FAMILY` to `'neutral'`) is the last commit of P6.

**Verification method for every phase.** `pnpm typecheck` and `pnpm test`. For anything visual, run the real built renderer bundle against a stubbed `window.frontier` in the Browser pane, in all six variants and at 720 x 560 and 1440 x 920. No renderer test exists today and there is no DOM test environment (`vitest.config.ts` has none). Logic that must be tested is extracted into pure modules. Where a test needs DOM nodes, add `happy-dom` as a devDependency and mark those files `// @vitest-environment happy-dom`. That is a new dependency the owner should approve.

| Phase | Goal | Size | Parallel |
|---|---|---|---|
| P0 | Spec, tokens, mockups, this plan | done | none |
| P1 | Tokens, fonts, theme model, contrast checks | M | P1b with P2 |
| P2 | Component layer, additive | L | with P1b |
| P3 | Shell: dock, header row, Appearance, Settings tabs mounted | L | none; gates P4-P6 |
| P4 | Tasks absorbs Home | L | with P5, P6a, P6b |
| P5 | Settings absorbs Routing, Context & Tools, Skills, Verification | L | with P4, P6a, P6b |
| P6a | Agents table and sheet; Review restyle | M | with P4, P5, P6b |
| P6b | Workspaces restyle | M | with P4, P5, P6a |
| P7 | Delete dead code; docs; site; screenshots | M | P7a (site tokens) from P1 on |

### P0. Spec and mockups

**Size:** done. Delivered in this session: `SPEC.md`, `tokens.css`, the prototype and design-system page, and this plan.

### P1. Token layer, fonts, theme model

**Size:** M. **Parallel with:** P1a (tokens, fonts) first, then P1b (theme model, contrast) runs alongside P2.

- **Goal.** New tokens exist for all six variants, old names still resolve, and the six attributes and their storage are in place, with no visible change.
- **Files.**
  - `src/renderer/src/styles/tokens.css`: v2 scales, six variant blocks (SPEC's `tokens.css`, with `:is(:root, .app)` selectors), density, the legacy alias block (section 7.4). Bare `:root` default is Phosphor dark.
  - `src/renderer/src/styles/fonts.css`, `package.json`, `pnpm-lock.yaml`: add `@fontsource/inter` 400, 500, 600. Keep Chakra Petch, IBM Plex Sans and JetBrains Mono: the Phosphor blocks in `tokens.css` set `--font-display` to Chakra Petch and `--font-sans` to IBM Plex Sans.
  - `src/renderer/src/theme.ts` and `src/renderer/public/theme-init.js`: section 7.2 and 7.3.
  - `src/renderer/src/views/settings.ts` is not touched in P1; the compatibility adapter keeps its imports working.
  - `scripts/check-contrast.mjs`: read `tokens.css` instead of a duplicated table; check all six variants; composite the alpha tokens Phosphor uses (`--accent-soft`, `--diff-*`) over their surface; check `--accent-fg` on `--accent-fill`. Add `"check:contrast"` to `package.json`.
- **Visible after.** Nothing. Phosphor stays the default and the legacy aliases reproduce today's look. Compare screenshots before and after to confirm.
- **Tests.** New `tests/appearance.test.ts` (the migration table, `resolveAppearance` across stored, dark and reduced-motion inputs, and `theme-init.js` run in `node:vm` against the same matrix). New `tests/contrast.test.ts`, so CI runs it through the existing `pnpm test`. New `tests/tokens.test.ts`: every `var(--x)` in the renderer stylesheets is defined in `tokens.css`, and no raw hex or `rgb()` appears outside it (true today, apart from an HTML entity in `syntax.ts`).
- **Risk.** An alias that resolves differently from the old token in one variant. Mitigate with the screenshot comparison in both Phosphor schemes. `--fg-faint` was raised to 4.5:1 in all four Neutral and Mono variants on 2026-09-30 (section 10.1), so the existing contrast rule holds without an exception.

### P2. Component layer, additive

**Size:** L. **Parallel with:** P1b.

- **Goal.** Every SPEC section 4 component exists in CSS and as a TS factory where one is needed, and renders in all six variants. Nothing consumes them yet.
- **Files.**
  - New `src/renderer/src/styles/kit.css`, imported from `styles/index.css` after `tokens.css` and before the legacy `components.css`. Contains `btn`, `input`, `select`, `textarea`, `switch`, `segmented`, `status`, `tag`, `badge`, `meter`, `card`, `row`, `section-title`, `field-label`, `table`, `vtabs`, `sheet`, `dialog`, `toast`, `tooltip`, `kbd`, `empty`, `avatar`, `code`, `diff`. The focus ring is `outline: 2px solid var(--focus)`. Row, table and control heights read `--density` and `--control-h`.
  - `src/renderer/src/ui/components.ts`: add `status()`, `tag()`, `meter()`, `meterRow()`, `avatar()`. Keep `chip`, `lamp`, `gaugeSeg`, `radar`, `probabilityBar(s)` as they are.
  - Name collisions: `.segmented` and `.switch` already exist with different CSS and are used by shipped views (20 TS references to `segmented`). Land each swap together with its consumers in this phase.
- **Visible after.** Nothing. The old components remain in place until P3-P6 migrate their call sites.
- **Tests.** DOM tests (with `happy-dom`) for the factories: `meter()` emits `role="meter"` with `aria-valuenow` for a known value and a labelled `img` for an unknown one; `status()` dot-only carries `aria-label`; `.status.running` has no animation under `data-effects="off"`. Render every component in all six variants and compare with the P0 design-system page.
- **Risk.** The largest CSS addition. The brief lists deleting gauge, lamp, radar and ticks in P2; that cannot happen here, because 20 lamp calls, 7 gauge calls and every `.panel` still use them until their views migrate. Deletion moves to P7 (ticks on `.panel` and `dialog` go in P3, when the old shell goes).

### P3. Shell: dock, header row, Appearance

**Size:** L. **Parallel with:** none. It gates P4-P6 because it owns the shared files.

- **Goal.** The dock and header row replace the sidebar and topbar, Appearance is live, the five sections are reachable, and the privacy chip is on every screen. Old screen contents stay.
- **Files.**
  - `src/renderer/index.html`: remove `<aside class="sidebar">` and `.topbar`; add `<nav class="dock">` and `<header class="app-header">`. Wrap `#routing-view`, `#control-view` and `#skills-view` as panels inside `#settings-view`, shown by tab.
  - `src/renderer/src/main.ts`: remove the sidebar collapse logic, `renderMiniProviders`, `VIEW_META` eyebrows and `applyResponsiveSidebarDefault`; `renderAdvisorStatus()` calls `advisorDisclosure()`; `switchView` delegates to `nav.ts`.
  - New `src/renderer/src/nav.ts` (`resolveView`, the view and tab ids), new `src/renderer/src/advisor-disclosure.ts`.
  - `src/renderer/src/styles/base.css`: delete sidebar, topbar, project-switcher-in-sidebar, provider-rail and advisor-status rules. New `src/renderer/src/styles/shell.css` for dock, header, content padding, per-dock-position and per-label tokens.
  - `src/renderer/src/styles/components.css`: remove the corner-tick rules. `src/renderer/src/styles/views/tasks.css`: replace the two `top: 104px` overlays with `--header-h`.
  - `src/renderer/src/project.ts`: anchor the menu to the header trigger; update the comments that say "sidebar".
  - `src/renderer/src/ui/tooltip.ts`: not needed for the dock. It stays for the header chip (below placement).
  - `src/renderer/src/views/settings.ts`: vertical tabs; the Appearance panel with the seven controls; the old theme card is removed.
  - `src/renderer/src/views/review.ts`: `renderReviewBadge()`, called from `loadReview()` and `render()`, so the badge no longer depends on `renderHome()`.
  - `src/renderer/src/command-palette.ts`: entries go through `resolveView`. Its `#health-check` and `#clear-finished` clicks depend on buttons that exist only on other screens; keep those ids or replace the clicks with exported functions.
- **Visible after.** The dock (all positions, both label modes), the 44px header with the project switcher and the privacy chip, working Appearance controls for family, scheme, dock, labels and density, and Settings holding the former Routing, Context & Tools and Skills screens unrestyled. Home is reachable only through the palette until P4, which is why nothing from P3 ships alone.
- **Tests.** New `tests/nav.test.ts` (`resolveView` for all 9 old ids and the 5 new ones, unknown ids). New `tests/disclosure.test.ts` (off, off with a key, shadow and active with no key, shadow, active with repo facts, active without; never the word "local" when the advisor is active and a key exists; the split-run subtask clause is present).
- **Risk.** Highest shared-file churn: `index.html`, `main.ts`, `base.css`. Do it in one PR so P4-P6 branch from a stable base. The macOS inset and the drag region need a check on a real Mac window, not only in the Browser pane.

### P4. Tasks absorbs Home

**Size:** L. **Parallel with:** P5, P6a, P6b (touches only Tasks, Home and the new-task files).

- **Goal.** Tasks opens to a large composer; there is one composer and one place to start work; the queue, conversation and inspector are restyled.
- **Files.**
  - `src/renderer/src/views/tasks.ts`: compose state; queue rows and group headers; conversation header; thread; inspector on `status`, `tag`, `meterRow`; stage bar and lane cards; `[` `]` toggles unchanged.
  - New `src/renderer/src/views/compose.ts`: the logic that lives in `views/home.ts` today (project field, debounced `previewAdvisor` route preview, `submitHomeTask`) plus the Recent list. Then delete `src/renderer/src/views/home.ts`, `src/renderer/src/styles/views/home.css` and the Home sections of `index.html`.
  - `src/renderer/src/task-form.ts`: one instance; the `home-*` ids go. `src/renderer/src/dialogs/new-task.ts` is deleted, with `#task-dialog`; ⌘N and the dock New action call compose.
  - `src/renderer/src/state.ts`: a `composing` flag. Today `renderTasks()` auto-selects the first task whenever none is selected, so a "nothing selected" state never occurs; compose has to be an explicit state.
  - `src/renderer/src/task-helpers.ts`: `taskStatusIndicator` returns `status()`.
  - `src/renderer/src/providers-view-model.ts`: receives `providerLampTone`, which `views/agents.ts` imports from `views/home.ts` today. `views/review.ts` drops its `renderHome()` call.
  - `src/renderer/src/main.ts`: drop the Home imports and the 30s Home refresh; the initial view is Tasks in compose state.
  - `src/renderer/src/styles/views/tasks.css`, `index.html` (Tasks section), `command-palette.ts` (New task, Compare agents).
- **Visible after.** No Home. Tasks lands on the composer with a segmented run mode, one Options row, a one-line route preview, one primary button and a Recent list. The queue has status dots and no chips except "N files". The conversation header is one line. The inspector is Route, Files changed, Activity, and the existing Context and Attempts sections.
- **Tests.** Extract `queueGroups(tasks, query)` (today `taskGroup`, `taskNeedsReview` and `taskMatchesQuery` inside `tasks.ts`) into `task-helpers.ts` and test it. Extract `routePreviewText(result, provider)` from `renderRouteResult` and test it. Test the compose and selection rule as a pure function in `nav.ts`.
- **Risk.** The composer requires a concrete project (`Start task` is disabled without `currentProject`), while the header switcher can say "All projects". Keep a plain project field in the composer. Live snapshots stream every ~60ms; the composer's selects already preserve their value across `renderProviderOptions()`, and that must survive the move. Empty-state copy that says "Start one from Home" needs rewriting.

### P5. Settings absorbs Routing, Context & Tools, Skills, Verification

**Size:** L. **Parallel with:** P4, P6a, P6b.

- **Goal.** Six restyled tabs with one save model and a dirty-state guard on every form.
- **Files.**
  - `src/renderer/src/views/settings.ts`: General (scheduler and failover, notifications, memory), Verification, Appearance panel wiring.
  - `src/renderer/src/views/routing.ts`: the five `build*Card` functions become sections of one tab; `renderRouting()` runs only while its tab is active; `advisorFormDirty`, `markAdvisorDirty`, `clearAdvisorDirty` move across intact.
  - `src/renderer/src/views/control.ts`: the draft renders on tab entry only, as today.
  - `src/renderer/src/views/skills.ts`, `styles/views/settings.css`, `routing.css`, `control.css`, `skills.css`, `index.html` (Settings section).
  - New `src/renderer/src/ui/dirty.ts`: a small dirty-guard helper, unit-tested.
- **Visible after.** One Settings screen with a tab list. Cards become sections under 13px/600 headings. Save is either an explicit per-tab bar with "Unsaved changes" and Discard, or immediate for switches, never both on one control.
- **Tests.** `tests/dirty.test.ts` for the helper: a snapshot render skips a dirty field, save and discard clear it.
- **Risk.**
  - **The dirty-flag rule.** CLAUDE.md requires every settings-editing view to track its own dirty flag so a streamed snapshot cannot overwrite an unsaved edit. Only the advisor form does today. `renderSettings()` rewrites `max-parallel`, `cooldown-minutes`, `verify-enabled`, `verify-timeout` and both notification checkboxes on every snapshot, and guards `memory-input` and `verify-commands` only by `document.activeElement`. The move to tabs must add the guard to General and Verification, not only preserve the advisor's.
  - **The control-plane draft.** `persistControlPlaneDraft()` (called by `tasks.ts` and `task-form.ts` before a run) reads `#cp-*` inputs from the DOM. Hidden tab panels must stay mounted, not be destroyed, or it throws.
  - **The "What is sent" card** is a disclosure surface; it moves with the tab and must stay.

### P6a. Agents and Review

**Size:** M. **Parallel with:** P4, P5, P6b.

- **Goal.** Agents and Review on the v2 components.
- **Files.** `src/renderer/src/views/agents.ts`, `src/renderer/src/views/review.ts`, `src/renderer/src/task-helpers.ts` (`verificationChip` returns `status()`), `src/renderer/src/styles/views/agents.css`, `review.css`, `index.html` (Agents and Review sections).
- **Visible after.** Agents: a short intro, a one-line dismissible notice, the table with `status` for login, plain `tag`s for tiers and a thin `meter` for the plan window, `switch` for enabled; the row opens a right-side sheet. Review: rows with a dot-and-word check line; a Checks list; the diff on `--diff-*`.
- **Tests.** Extract the login state and check-line text builders (`loginChip`, `verificationChip` text) into pure functions and test the three cases each: signed in, unknown, signed out; passed, failed, no checks detected. Keep the distinction that "no checks detected" is not a pass (CLAUDE.md, Verification lane).
- **Risk.** Low. The Agents table and the right-side drawer already exist (section 10.1). This phase and P4 both edit `task-helpers.ts`, in different functions. "Add CLI" today adds a blank custom provider immediately with no dialog; the plan keeps that and opens the new row's sheet.

### P6b. Workspaces

**Size:** M. **Parallel with:** P4, P5, P6a.

- **Goal.** Workspaces on the v2 components. The participant roster stays a dialog.
- **Files.** `src/renderer/src/workspace.ts` (854 lines, its own `element` and `emptyState` helpers; it does not import `ui/dom`), `src/renderer/src/styles/views/workspace.css`, `index.html` (Workspaces section and its three dialogs).
- **Visible after.** Initials avatars on `--surface-3`; `@handle` chips as `--accent-soft` inline pills; centred system messages; the participants dialog restyled with `.dialog`; availability as a dot and a word; "works on an isolated branch" as a plain note. The accent picker leaves the participant editor. The `accent` field stays in state and is no longer rendered.
- **Tests.** A source-scan test that no `provider.kind` appears under `src/renderer/` outside type imports. Existing `tests/workspace*.test.ts` and `tests/mentions.test.ts` cover the main-process side and must stay green untouched.
- **Risk.** Low. The roster keeps the dialog from commit `eddbef9` (`docs/workspace-progress.md`), so no layout choice is reversed.

### P7. Cleanup, docs, site

**Size:** M. **Parallel with:** P7a (site tokens) can start once P1a is stable; the rest is last.

- **Goal.** Nothing dead remains and the docs and site match the product.
- **Files.**
  - Delete the legacy alias block in `tokens.css`; delete `chip`, `lamp`, `gaugeSeg`, `radar`, `probabilityBar(s)` from `ui/components.ts`; delete the legacy rules in `styles/components.css` and `base.css`; drop any `@fontsource` weight nothing references.
  - `git mv docs/design-phosphor-console.md docs/design-calm.md` and rewrite it (Phosphor becomes one family section). Update `README.md` line 7 and the CLAUDE.md sections "Renderer architecture & design system", "Layout, context window & memory" (fixed shell, three panes), "The sidebar privacy line must stay truthful" (now the header chip), and the "MCP manager", "Skills manager" and "Routing advisor" mentions of screens.
  - Site: `site/src/styles/theme.css` (duplicates the app's tokens, per CLAUDE.md), `site/src/lib/screens.ts` (`ScreenName` includes `home` and `routing`, which no longer exist; `ScreenVariant` is `console` | `daylight`), `site/scripts/screenshots/capture.js` (uses `.nav-item[data-view]`, `#home-prompt`, `fp-theme`, `fp-sidebar-collapsed`), and the 12 PNGs in `site/src/assets/screens/`.
- **Visible after.** Docs and website describe and show the new UI.
- **Tests.** `pnpm --dir site build` with and without `SITE_OFFLINE=1`.
- **Risk.** `capture.js` sets `fp-agents-guide-dismissed`, but the app reads `fp-agents-setup-dismissed`, which is why the Getting-started cards appear in `agents-console.png`. Fix the key when rewriting it.

## 10. Risks and open questions

### 10.1 Where the codebase differs from what the spec assumes

| # | Spec assumption | What the code does | Consequence |
|---|---|---|---|
| 1 | "No task selected" shows the composer | `renderTasks()` selects the first task whenever none is selected | Compose is an explicit state (P4). |
| 2 | Participants are a right-hand pane | The roster is a modal dialog by an earlier choice (`eddbef9`, `workspace.css` comment) | Decided: the dialog stays. The prototype's right-hand roster is a mockup convenience, not the target. |
| 3 | Avatars are neutral initials | Participants store `accent` as `var(--amber)`-style strings, shown as coloured dots, with a picker | Aliases stay until P6b; the field stays in state, unrendered. |
| 4 | Routing tab lists advisor form, policies, calibration | Routing also has "What is sent" (a disclosure surface), the model catalog, the shadow-agreement list, "learn from outcomes" and "ask Jev while I type" | All five cards move. Dropping "What is sent" would break a CLAUDE.md disclosure rule. |
| 5 | Inspector is Route, Files, Activity | It also has Context and Attempts sections, an orchestration stage bar, lane cards and bench columns | Kept and restyled (section 8). |
| 6 | "Add CLI" is a short dialog | `addCustomProvider()` adds a blank provider immediately | Kept; the sheet opens on the new row. |
| 7 | Agents gets a table and a sheet | Both exist. The drawer is a right-pinned modal `<dialog>`, and the setup guide is already dismissible | P6a is a restyle. The sheet stays modal for focus containment. |
| 8 | Attributes are family, scheme, dock, labels, density | SPEC 3.3 also lists a Font size control | Added as `data-font-size` / `fp-font-size`. |
| 9 | Tokens are accessible | `--fg-faint` was 3.0-4.0:1 in the first draft of the Neutral and Mono variants; the repo's rule and script hold every text token to 4.5:1 | Resolved: `tokens.css` now uses Neutral light `#6d6e75`, Neutral dark `#888891`, Mono light `#6f6c65`, Mono dark `#8b8881`, all at or above 4.5:1 on `--surface-2`. |
| 10 | Chrome can change freely | The palette clicks `#health-check` and `#clear-finished`; `goToNav` and `capture.js` query `.nav-item[data-view]`; `tasks.css` hard-codes `top: 104px` | Ids and classes kept, or replaced with functions (P3). |
| 11 | The main process is untouched (decided: one `backgroundColor` literal may change) | `src/main/index.ts` sets `backgroundColor: '#0c0e0d'` and `titleBarStyle: 'hiddenInset'` | Optional one-line follow-up for the background (visible only while resizing). The inset is handled in CSS. |
| 12 | Header shows the project switcher | The composer needs a concrete project; `Start task` is disabled without one | A project field stays inside the composer. |
| 13 | Settings forms are safe under live snapshots | Only the advisor form has a dirty flag (section P5) | Guards added in P5. |
| 14 | `.tabs` is part of the kit | Nothing in the app uses horizontal tabs | Not built until a consumer exists. |
| 15 | Segmented controls are `aria-pressed` buttons (prototype) | The app uses `radiogroup` / `radio` with arrow-key navigation (`ui/segmented.ts`) | The app's pattern is kept. |
| 16 | Switches are `<button role="switch">` (prototype) | The app's switches are checkbox and `.slider` markup, wired to `change` | Markup and handler change with the swap (P2). |
| 17 | Meters set `--value` inline (prototype) | CSP is `style-src 'self'`; inline `style` attributes are blocked (`index.html` has none) | Set with `style.setProperty` in the factory. |

### 10.2 Questions for the owner

1. **Default family for existing users** (section 7.3). Decided: Neutral for everyone.
2. **Does Home survive as a start screen?** Decided: no. Tasks in compose state is the start screen and Recent is its list.
3. **Is compact density worth it at v1?** It doubles the visual QA matrix (six variants times two densities). Recommendation: keep it, limited to control height, row padding and pane widths, all already tokens, and cut it if P2 needs per-component overrides.
4. **A keyboard shortcut to cycle dock position?** Recommendation: no. Add three palette commands ("Dock: bottom", "Dock: left", "Dock: right") instead, which are discoverable and cannot be hit by accident.
5. **Should the site switch to Neutral?** The site's screenshots must match the product default. Recommendation: Neutral screenshots (light and dark), one Phosphor shot in the docs, and the site chrome on Neutral. The cost is some loss of the site's current instrument-panel character.
6. **Syntax highlighting.** SPEC colours only accent, status and diffs. Code highlighting today uses five hues (`.hljs-*` in `components.css`). Recommendation: keep highlighting, mapped to tokens (`--accent`, `--ok`, `--info`, `--warn`, comments in `--fg-muted`), because unhighlighted code is harder to read than a coloured diff.
7. **Where does the brand mark go?** SPEC drops the wordmark from the chrome. Options: nowhere (window title only), or a small mark at the left of the header row. Recommendation: nowhere.
8. **A capacity signal on the Agents dock item.** With the rail gone, a limit-reached agent is invisible on other screens. Recommendation: a warn dot on the Agents item when any enabled agent is blocked. It is small and outside SPEC, so it needs approval.
9. **Release gating.** Recommendation: the integration branch in section 9. The alternative is a `fp-layout` flag with two live shells, which doubles maintenance for weeks.
10. **Font size setting at v1.** It only fully works once views stop using raw px (P6). Recommendation: ship the control if the scale tokens land in P2, otherwise defer.
11. **DOM test dependency.** Approve `happy-dom` as a devDependency for factory and view tests (section 9).
12. **Right participants pane.** Decided: keep the dialog from `eddbef9` (section 10.1 row 2).

## 11. Acceptance checklist

The redesign is done when all of these hold.

- [ ] `pnpm typecheck` and `pnpm test` pass, including the new contrast, appearance, tokens, nav, disclosure and dirty tests.
- [ ] Text contrast is at least 4.5:1 for every text token on every surface it is used on, in all six variants, and non-text signals (status dots, meter fills, the focus ring) are at least 3:1. `--fg-faint` is at 4.5:1 in every family.
- [ ] The privacy chip is visible on every screen and every Settings tab. It reads "Local" only when the advisor is off or has no key, and it names Jev and the mode, with the full disclosure in the tooltip and `aria-label`, otherwise. It is reachable by keyboard.
- [ ] No `provider.kind` branching under `src/renderer/` (a scan test).
- [ ] No raw hex or `rgb()` outside `tokens.css`, and no `var(--x)` without a definition (a scan test).
- [ ] Reduced motion and "Reduce effects" stop the running-dot pulse, the sheet slide, the toast fade and Phosphor's glow.
- [ ] Every screen and every dialog is reachable and operable by keyboard: dock items, header controls, Settings tabs (arrow keys), table rows (Enter), the sheet (focus contained, focus returns), ⌘K and ⌘N. The skip link is still the first tab stop.
- [ ] A streamed snapshot never overwrites an unsaved edit in: the composer, General, Routing (advisor), Verification, the Context & Tools draft, the agent sheet and the participant editor.
- [ ] Every capability in the current UI has a home in section 5. The old `switchView` ids still resolve.
- [ ] The layout works at 720 x 560 in all three dock positions and both label modes, with no content under the dock, and at 1440 x 920.
- [ ] The dock, header and every screen have been reviewed in all six variants, comfortable and compact.
- [x] `git diff` shows no change under `src/preload` or `src/shared/types.ts`, and under `src/main` only the BrowserWindow `backgroundColor` literal (matches Neutral dark `--bg`).
- [ ] `docs/design-calm.md`, README, CLAUDE.md, the site tokens, `screens.ts`, `capture.js` and the site screenshots are updated, and `pnpm --dir site build` passes.
