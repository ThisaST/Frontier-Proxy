# Design spec — Phosphor Console

Frontier's visual identity from P1b onward. It is a retro-future **instrument panel**: smoked
glass, amber phosphor readouts, cyan data, segmented gauges, and a radar sweep while routing.
The metaphor matches what the app does. Frontier is a control console over several agents,
and routing is the instrument it is proudest of.

Legibility comes first. The effects (glow, scanlines, sweep) belong on **readouts and
status**, never on body text, and the whole set can be switched off.

## 1. Themes

`<html data-theme="console|daylight">` plus `data-effects="on|off"`. The setting in
Settings → Appearance offers **System** (the default, follows `prefers-color-scheme`),
**Console** (dark), and **Daylight** (light), plus a **Reduce effects** switch. Effects are
also off under `prefers-reduced-motion`. The theme is set before first paint from
`localStorage` (wrapped in try/catch), so the screen never flashes.

## 2. Tokens (`styles/tokens.css`)

Components use only semantic tokens. They never use raw hex values.

| token | Console (dark) | Daylight (light) | use |
|---|---|---|---|
| `--bg` | `#0B0D0C` | `#E9E4D8` | app background (glass / instrument beige) |
| `--surface-1` | `#101312` | `#F3EFE5` | panels |
| `--surface-2` | `#161B19` | `#FBF8F1` | raised: cards, inputs, dialogs |
| `--surface-3` | `#1D2421` | `#E1DBCC` | hover, selected rows, wells |
| `--bezel` | `#262E2A` | `#C9C1AE` | panel borders |
| `--bezel-strong` | `#37423C` | `#A89F89` | focus-adjacent, dividers under headers |
| `--fg` | `#E6E3D8` | `#1C1F1D` | primary text |
| `--fg-muted` | `#8E978F` | `#5E625B` | secondary text (must pass 4.5:1 on surface-1) |
| `--fg-faint` | `#5C655F` | `#8C8F86` | labels/placeholders only (≥3:1) |
| `--amber` | `#FFB000` | `#9A6200` | primary accent: selection, primary actions, active route |
| `--amber-fill` | `#FFB000` | `#C98A00` | primary button fill |
| `--on-amber` | `#1A1300` | `#1A1300` | text on amber fill |
| `--cyan` | `#37E2D5` | `#0B7C74` | data, links, info, focus ring |
| `--phosphor` | `#7CFF6B` | `#2F7D1F` | ready / success / passed |
| `--alarm` | `#FF4D4D` | `#B3261E` | failed / blocked / danger |
| `--caution` | `#FF8A3D` | `#A5470A` | cooling down / estimates / warnings |
| `--glow-amber` | `0 0 8px rgb(255 176 0 / .35)` | `none` | readout glow |
| `--glow-cyan` | `0 0 8px rgb(55 226 213 / .30)` | `none` | |

Other scales:
- **Spacing:** a 4 px scale, `--s-1`…`--s-8` = 4, 8, 12, 16, 20, 24, 32, 48.
- **Radii:** `--r-sm 3px`, `--r-md 6px`, `--r-lg 10px`. Instruments are squarer than the
  current UI; nothing is pill-shaped except status lamps.
- **Elevation:**
  - `--e-1`: panel, an inset top highlight plus a 1px bezel.
  - `--e-2`: dialog/drawer, adding a drop shadow `0 18px 48px rgb(0 0 0 / .45)` (Console) or
    `0 12px 32px rgb(40 30 10 / .18)` (Daylight).
- **Motion:** `--t-fast 120ms`, `--t-med 220ms`, easing `cubic-bezier(.2,.7,.2,1)`.

## 3. Type

Fonts are bundled with `@fontsource/*` npm packages and imported from CSS. The CSP is
`default-src 'self'`, so there is no CDN.

| role | family | notes |
|---|---|---|
| Display / labels / nav | **Chakra Petch** 500/600 | instrument lettering. Labels are UPPERCASE, `letter-spacing: .12em`, 11px |
| Body / conversation / forms | **IBM Plex Sans** 400/500/600 | long-form legibility |
| Readouts, numbers, code, ids | **JetBrains Mono** 400/600 | `font-variant-numeric: tabular-nums` everywhere numbers change |

Scale: 11 (label), 12, 13 (default UI), 14 (body/conversation), 16, 20 (panel title), 28
(view title, Chakra Petch 600).

## 4. Signature motifs

1. **Bezel panels.** A 1px `--bezel` border, an inset 1px top highlight
   (`rgb(255 255 255 / .04)` in Console), and **corner ticks**: small L-brackets at the four
   corners drawn with `::before`/`::after` background gradients, in `--bezel-strong`. This is
   the most recognisable motif, so use it on panels and dialogs, not on every card.
2. **Readout text.** `.readout` is mono, amber or cyan, with `text-shadow: var(--glow-*)`.
   Use it for scores, confidences, token counts, countdowns, the chosen model id, and
   nowhere else.
3. **Segmented gauge.** `.gauge-seg` shows N discrete segments (default 10). Lit segments
   take the tone colour with glow; unlit ones take `--surface-3`. It replaces every
   continuous meter: plan windows, context occupancy, Jev confidence, and tracked budget. An
   `aria-valuenow` meter role is required.
4. **Status lamps.** Round LEDs, 8px, in phosphor, amber, caution, alarm, or off, with glow
   in Console. A lamp can blink **only** for "needs you" (1.2s ease, disabled when effects
   are off). The lamps replace the current `provider-dot` / `pulse-dot`.
5. **Radar sweep.** A 28–40px circular scope with a `conic-gradient` sweep rotating at 2.4s.
   It is shown while a task is *advising / queued for routing*, and on the Home composer's
   route preview while it computes. When effects are off it becomes a static scope with a
   pulsing centre dot.
6. **Scanlines.** A `repeating-linear-gradient` of 1px lines every 3px at 3% opacity, only
   inside `.screen` wells (route inspector, readouts, the Usage chart). It is never on text
   blocks or the conversation, and it is off with effects.
7. **Hardware keys.**
   - Primary buttons use `--amber-fill` / `--on-amber` with a 2px darker bottom edge; pressed
     shifts them down 1px.
   - Secondary buttons are `--surface-2` with a bezel.
   - Ghost buttons are text-only in `--fg-muted`, turning `--fg` on hover.
   - Danger buttons use an `--alarm` outline and fill on hover.
8. **Focus.** A 2px `--cyan` outline with 2px offset, on every interactive element. It is
   never removed.

## 5. Icons

Use **Lucide** (`lucide` npm package, tree-shaken ESM, SVG strings) through a tiny
`ui/icons.ts` returning `SVGElement`, with stroke 1.5, `currentColor`, and sizes 14/16/20.
It replaces every Unicode glyph icon (◇ ⌁ ▣ ⑃ ◫ ⊹ ❖ ⌘ ⤢ ＋ ↻ ×).

## 6. Component inventory (P1b)

Each component is a small TS factory in `ui/` plus a CSS rule in `components.css`, restyling
existing class names where it can (no markup churn beyond icons and gauges):
- `button` (primary / secondary / ghost / danger × sm/md) and `iconButton`
- `lamp`, `chip` (neutral / amber / cyan / phosphor / caution / alarm), `statusPill`
- `panel` (bezel + corner ticks + header slot) and `card`
- `tabs`, `segmented`, `field`/`select`/`switch`, `dialog`, `drawer`, `toast`, `menu`
- `emptyState` (with a dim scope illustration), `skeleton` (a scanline shimmer when effects
  are on)
- `gaugeSeg`, `probabilityBars` (horizontal segmented bars with a readout value, used for Jev
  probabilities and routing scores), and `radar`
- `dataTable` and `inspectorSection`

## 7. Layout frame (P3/P4 build on this)

The sidebar becomes a **left instrument rail**:
- the brand at the top ("FRONTIER" in Chakra Petch with an amber scope mark);
- a **project switcher**;
- WORK / SETUP groups (see plan §2.2);
- at the bottom, one lamp per agent (capacity), the advisor status line, and Settings.

The topbar holds the view title in Chakra Petch 28 and the view's own actions. Global
"Check agents" moves to the Agents view and ⌘K.

## 8. Accessibility

- Contrast ≥ 4.5:1 for all text in both themes. Check with a script in the P1b PR.
- Colour is never the only signal: lamps carry a text label or `aria-label`, and gauges carry
  a numeric readout.
- All effects are off under `prefers-reduced-motion` and with the "Reduce effects" switch.
- A keyboard path exists for everything, with visible focus.

## 9. Out of scope for P1b

Layout changes (composer-first Home, three-pane Tasks, the Routing screen) are P3/P4. P1b
re-skins the current layout with the new system, so the new look can be judged on its own
before the structure changes. `site/` is re-themed in P7.
