#!/usr/bin/env node
// Computes WCAG 2.1 contrast ratios for the Phosphor Console token pairs that
// are actually used for text, in both themes, and fails (non-zero exit) if
// any pair drops below its required ratio. Token values are duplicated here
// deliberately — this is a standalone check, not a runtime module, and it
// must keep working even if someone temporarily breaks the CSS import graph.
// Keep these hexes in sync with src/renderer/src/styles/tokens.css §2.

const THEMES = {
  console: {
    bg: '#0B0D0C',
    'surface-1': '#101312',
    // The sidebar/rail is `--surface-1` (see base.css `.sidebar`); listed again
    // here under its own label so it always shows up as an explicitly-checked
    // surface rather than relying on that being obvious.
    sidebar: '#101312',
    'surface-2': '#161B19',
    fg: '#E6E3D8',
    'fg-muted': '#8E978F',
    'fg-faint': '#7C857F',
    amber: '#FFB000',
    'amber-fill': '#FFB000',
    'on-amber': '#1A1300',
    cyan: '#37E2D5',
    phosphor: '#7CFF6B',
    alarm: '#FF4D4D',
    caution: '#FF8A3D'
  },
  daylight: {
    bg: '#E9E4D8',
    'surface-1': '#F3EFE5',
    sidebar: '#F3EFE5',
    'surface-2': '#FBF8F1',
    fg: '#1C1F1D',
    'fg-muted': '#4C5049',
    'fg-faint': '#62665F',
    amber: '#8F5A00',
    'amber-fill': '#C98A00',
    'on-amber': '#1A1300',
    cyan: '#00706C',
    phosphor: '#286D17',
    alarm: '#B3261E',
    caution: '#A5470A'
  }
}

// The pairs the spec calls out: fg, fg-muted, fg-faint, amber, cyan,
// phosphor, caution, alarm on surface-1/surface-2/bg/sidebar, plus on-amber
// on amber-fill. axe-core's real-world verdict is 4.5:1 for small text
// regardless of how "faint" the label reads visually, so every text token
// here — fg-faint included — is held to the same 4.5:1 floor.
const TEXT_TOKENS = ['fg', 'fg-muted', 'fg-faint', 'amber', 'cyan', 'phosphor', 'caution', 'alarm']
const BACKGROUNDS = ['bg', 'surface-1', 'sidebar', 'surface-2']

function srgbToLinear(channel) {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(hex) {
  const value = hex.replace('#', '')
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  const [lr, lg, lb] = [r, g, b].map(srgbToLinear)
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
}

function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexA)
  const lb = relativeLuminance(hexB)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

function requiredRatio() {
  return 4.5
}

let failed = false
const rows = []

for (const [themeName, tokens] of Object.entries(THEMES)) {
  for (const bgToken of BACKGROUNDS) {
    for (const textToken of TEXT_TOKENS) {
      const ratio = contrastRatio(tokens[textToken], tokens[bgToken])
      const required = requiredRatio(textToken)
      const ok = ratio >= required
      if (!ok) failed = true
      rows.push({ theme: themeName, pair: `${textToken} on ${bgToken}`, ratio: ratio.toFixed(2), required, ok })
    }
  }
  // on-amber on amber-fill (button text) — always needs 4.5:1.
  const ratio = contrastRatio(tokens['on-amber'], tokens['amber-fill'])
  const ok = ratio >= 4.5
  if (!ok) failed = true
  rows.push({ theme: themeName, pair: 'on-amber on amber-fill', ratio: ratio.toFixed(2), required: 4.5, ok })
}

const widest = Math.max(...rows.map((row) => row.pair.length))
console.log('theme     pair'.padEnd(10 + widest + 2) + 'ratio   required  result')
console.log('-'.repeat(10 + widest + 26))
for (const row of rows) {
  console.log(
    row.theme.padEnd(10) +
    row.pair.padEnd(widest + 2) +
    `${row.ratio}:1`.padEnd(8) +
    `${row.required}:1`.padEnd(10) +
    (row.ok ? 'PASS' : 'FAIL')
  )
}

if (failed) {
  console.error('\nOne or more token pairs fail their WCAG contrast requirement.')
  process.exit(1)
} else {
  console.log('\nAll token pairs meet their WCAG contrast requirement.')
}
