# Design spec — Calm

Frontier's visual system. The rule that settles most questions: **text carries hierarchy,
colour carries state.** Weight, size and spacing make the structure; colour appears only on the
accent (selection, the primary action, links), the three status tones (ok / warn / danger) and
diffs. Surfaces are flat: a 1px border on a plain fill, no ticks, no highlights, no gradients.

The design history — the audit of the previous UI, the decisions and the phases — is in
[`docs/ui-calm/`](ui-calm/) (`ui-plan.md`, `spec.md`, the prototype tokens). This file is the
spec of record for what ships; where they differ, this file and the code win.

## 1. Themes

Three **families** — Neutral (cool grays, one indigo accent), Mono (warm stone and ink, near-zero
colour) and Phosphor (amber, glow on readouts, Chakra Petch) — each in **light** and **dark**:
six variants. The attributes live on `<html>`, set before first paint by `public/theme-init.js`
and afterwards by `theme.ts` (the pure resolution is `theme-model.ts`'s `resolveAppearance`; the
two are tested against the same inputs in `tests/appearance.test.ts`).

| attribute | values | localStorage key | default |
|---|---|---|---|
| `data-family` | `neutral`, `mono`, `phosphor` | `fp-family` | `neutral` |
| `data-scheme` | `light`, `dark` (always resolved) | `fp-scheme`: `system`, `light`, `dark` | `system` |
| `data-dock` | `bottom`, `left`, `right` | `fp-dock` | `bottom` |
| `data-dock-labels` | `hover`, `always` | `fp-dock-labels` | `hover` |
| `data-density` | `comfortable`, `compact` | `fp-density` | `comfortable` |
| `data-font-size` | `default`, `large` | `fp-font-size` | `default` |
| `data-effects` | `on`, `off` | `fp-effects` | `on` (`off` under `prefers-reduced-motion`) |
| `data-platform` | `mac`, `other` | none: derived from `navigator` | — |

All of it is renderer-only and never sent to the main process. Storage access is wrapped in
try/catch, so blocked `localStorage` falls back to the defaults.

**Migration from `fp-theme`.** The previous UI stored `fp-theme` (`console`, `daylight`,
`system`). While `fp-family` is absent, `console` reads as scheme `dark` and `daylight` as `light`,
and `initTheme()` writes `fp-scheme` once from it. The family is not migrated: everyone who never
chose one lands on the default family, Neutral, whatever they had. `fp-theme` is never deleted and
is never read again once `fp-family` exists. `fp-sidebar-collapsed` is ignored.

## 2. Tokens (`styles/tokens.css`)

Components use only semantic tokens, never a raw hex or `rgb()` (`tests/tokens.test.ts` scans for
it, and for any `var(--x)` with no definition). Each variant is written as
`:is(:root, .app)[data-family=…][data-scheme=…]`, so a nested `.app` can carry its own pair; the
Appearance preview tiles use that.

| token | Neutral light | Neutral dark | use |
|---|---|---|---|
| `--bg` | `#f5f5f7` | `#131316` | app background |
| `--surface` / `-2` / `-3` | `#ffffff` / `#f1f1f4` / `#e8e8ec` | `#1a1a1e` / `#212126` / `#2a2a30` | panels; inputs and wells; hover fills and meter tracks |
| `--border` / `--border-strong` | `#e4e4e9` / `#cdcdd5` | `#2b2b32` / `#3c3c45` | 1px rules; hovered controls |
| `--fg` / `--fg-muted` / `--fg-faint` | `#18181b` / `#5c5d66` / `#6d6e75` | `#ececf0` / `#a3a4ae` / `#888891` | text; secondary text; placeholders and quiet metadata |
| `--accent` | `#4b5fcf` | `#8d9cee` | text, icons, links, the active dock item |
| `--accent-fill` | `#4b5fcf` | `#8d9cee` | anything behind `--accent-fg` text: primary button, badge, switch on |
| `--ok` `--warn` `--danger` `--info` | `#2c7a4b` `#875a0e` `#bf3a2f` `#4b5fcf` | `#7cc79b` `#d9a64a` `#ec7a72` `#8d9cee` | status dots and words, meter fills |
| `*-soft` | tinted fills | tinted fills | selected rows (`--accent-soft`), danger hover |
| `--focus`, `--selection` | accent; accent at .18 | accent; accent at .25 | focus outline; text-field ring |
| `--code-bg`, `--diff-*` | | | code blocks; diff add/del rows |
| `--shadow-1` `-2` `-dock` | | | segmented active option; sheet, dialog, toast; the dock |

Mono and Phosphor define the same names; read the file for their values. Rules in every family:

- **`--accent` vs `--accent-fill`.** Text, icons, links and borders use `--accent`; a fill under
  `--accent-fg` text uses `--accent-fill`. They are equal in five variants. In Phosphor light the
  text accent is `#8f5a00` (dark enough to read) and the fill `#c98a00` (light enough to carry
  dark text).
- **`--fg-faint` is held to 4.5:1** on `--surface` in every variant. It is for placeholders, line
  numbers and quiet metadata, not decoration, and it is still text.
- **Scales.** Spacing `--s-1`…`--s-9` (4, 8, 12, 16, 20, 24, 32, 40, 56 px). Radii `--r-1` 4
  (inputs, tags), `--r-2` 6 (buttons, rows), `--r-3` 10 (cards, panels), `--r-4` 14 (dock,
  dialogs), `--r-pill`. Motion `--t-fast` 120ms, `--t-med` 220ms, one `--ease`.
- **Density** `compact` sets `--density: .85`, control heights 28/24 px (from 32/26) and narrower
  Tasks side panes. **Font size** `large` raises every `--fs-*` step by 1px.

## 3. Type

Fonts are bundled with `@fontsource/*` and imported from `styles/fonts.css`; the CSP is
`default-src 'self'`, so there is no CDN. Neutral and Mono use **Inter** for the UI and
**JetBrains Mono** for numbers and code. Weights are 400, 500, 600 only.

Scale: 11 (tags, kbd), 12 (meta, labels, mono data), 13 (default UI, table cells, buttons), 14
(conversation body), 15 (screen and task titles), 18 (dialog titles), 22 (the composer heading);
`--fs-16` and `--fs-28` exist in the token layer. A number, id, path, branch or model name is
`--font-mono` with `font-variant-numeric: tabular-nums` (`.readout`). Labels are sentence case;
there are no uppercase eyebrows outside Phosphor (§7).

## 4. Kit

`styles/kit.css` (classes) and `ui/components.ts` (factories). A family or scheme changes tokens,
never markup.

- **Buttons** `.btn` + `-primary` `-secondary` `-ghost` `-danger`, `-sm`, `-icon`; one primary per
  screen. Fields `.input` `.select` `.textarea`: focus is the `--focus` border plus a 3px
  `--selection` ring.
- **`status(tone, text)`**: an 8px dot and a word in `--fg-muted`; tones `ok warn danger info
  neutral running` (running pulses, and stops with reduced motion). With no text it is a dot-only
  status that carries an `aria-label`.
- **`tag(text)`**: small neutral text for kinds, tiers and file actions. Never coloured.
- **`meter(percent, tone, label)`** and **`meterRow(label, percent, readout, tone)`**: a 4px track
  with a mono readout. `role="meter"` with `aria-valuenow`, or a labelled image when the value is
  not reported. The fill width is `--value`, set through the CSSOM because the CSP blocks inline
  `style` attributes.
- **`avatar(initials)`**, **`sectionTitle`** (13/600), **`fieldLabel`** (12/500, muted).
- **`inspectorSection`**, **`dialogHandle`** and **`restoreFocusOnClose`**. Tables are plain `.table` markup built by their views.
- **Classes only:** `.card` (theme tiles, agent sheet sections, the composer), `.row` (list rows;
  selected is `--accent-soft`), `.vtabs` (Settings), `.segmented` (a `radiogroup`, arrow keys via
  `ui/segmented.ts`), `.switch` (checkbox + `.slider`), `.badge`, `.kbd`, `.code` and `.diff`,
  `.empty` (text and one action, no illustration).
- **Overlays.** `.sheet` (right, 420px; the Agents detail), `.dialog` (480px; confirmations and
  short forms), `.toast` (top-right), the shared tooltip (`ui/tooltip.ts`, on hover and keyboard
  focus). Nothing is a dialog that can be a pane.

## 5. Layout

- **Dock.** A floating bar (`nav.dock`): Tasks, Workspaces, Review (count badge while branches
  wait), Agents, Settings, a divider, then New task and Search (⌘K). Bottom, left or right, 12px
  from the edge; labels on hover and keyboard focus, or always. `main` pads by `--dock-pad` on the
  dock's side so nothing sits under it. The active item is `--accent-soft` with an `--accent`
  icon. There is no auto-hide.
- **Header row.** One 44px row above every screen: the project switcher (Tasks, Workspaces and
  Review only), the screen title, the screen's actions, and the **privacy chip** at the far right.
  On macOS it is the window's drag region and clears the traffic lights.
- **Panes.** The shell is a fixed viewport and each pane scrolls itself. Tasks: queue ·
  conversation, or the composer in compose state · inspector (Route, Files changed, Activity,
  Context, Attempts; not shown while composing), side panes resizable and collapsible, the centre
  never under 420px. Workspaces: list · thread, participants in a dialog. Review: branches by
  repo · checks, files and diff. Agents: one table, a sheet on row click. Settings: vertical tabs ·
  content up to 760px.

## 6. Appearance settings

Settings → Appearance, all applied live: **Theme family** (three preview tiles), **Scheme** (System
/ Light / Dark), **Dock position**, **Dock labels**, **Density**, **Font size**, and **Reduce
effects** (a switch, enabled for Phosphor only, since only it has effects). Defaults: Neutral,
System, bottom dock, labels on hover, comfortable, default size, effects on.

## 7. Phosphor

The previous identity, kept as one family. It overrides tokens and nothing else:

| token | Neutral / Mono | Phosphor |
|---|---|---|
| `--font-sans` | Inter | IBM Plex Sans |
| `--font-display` (screen title, `.section-title`, `.field-label`) | Inter | Chakra Petch |
| `--label-transform`, `--tracking-label` | `none`, `0` | `uppercase`, `.08em` |
| `--glow` | `none` | amber, `0 0 8px`, on dark only |
| accent | indigo / ink | amber (`#ffb000` dark; `#8f5a00` light, fill `#c98a00`) |

Plus segmented meters (the same `.meter`, ten segments) and glow on `.readout`. There are no corner
ticks or scanlines. `data-effects="off"` (the Reduce effects switch, or `prefers-reduced-motion`)
sets `--glow` to `none` and stops the animations.

## 8. Accessibility

- Text contrast is at least 4.5:1 for every text token on every surface it is used on, in all six
  variants. `pnpm check:contrast` computes it from `tokens.css` (no duplicated table) and
  `tests/contrast.test.ts` runs the same pairs. Non-text signals (status dots, meter fills, the
  focus ring) aim for 3:1; the script covers text only.
- **Status is a dot and a word.** Colour is never the only signal, and a dot-only status has an
  accessible name. Meters carry `role="meter"` and a numeric readout.
- **Focus is never removed.** Interactive elements get a 2px `--focus` outline with a 2px offset on
  `:focus-visible`; text fields swap it for the border and ring.
- Motion (the running pulse, the sheet slide, the toast fade, Phosphor's glow) stops under
  `prefers-reduced-motion` and with Reduce effects.
- Everything is reachable by keyboard: dock items, header controls, Settings tabs (arrows), table
  rows (Enter), the sheet (focus contained, then restored). The skip link is the first tab stop.
- The privacy chip is on every screen and reads "Local" only when no advisor is active (ADR 0002).
