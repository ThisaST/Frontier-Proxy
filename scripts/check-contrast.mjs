#!/usr/bin/env node
// Computes WCAG 2.1 contrast ratios for the token pairs the UI uses as text, in all six
// family x scheme variants, straight from src/renderer/src/styles/tokens.css (no duplicated
// table), and exits non-zero if any pair drops below 4.5:1. Translucent tokens
// (`rgb(r g b / a)`, which Phosphor uses for its "soft" fills) are composited over the
// variant's --surface before measuring. tests/contrast.test.ts runs the same check.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseRules, resolveTokens } from './css-tokens.mjs'

export const TOKENS_CSS = fileURLToPath(new URL('../src/renderer/src/styles/tokens.css', import.meta.url))
export const FAMILIES = ['neutral', 'mono', 'phosphor']
export const SCHEMES = ['light', 'dark']
export const MIN_RATIO = 4.5

// [text token, background token]. axe-core holds small text to 4.5:1 however "faint" it reads, so fg-faint is included.
export const PAIRS = [
  ['fg', 'surface'], ['fg-muted', 'surface'], ['fg-faint', 'surface'], ['accent', 'surface'], ['accent-fg', 'accent-fill'], ['accent-fg', 'accent-hover'],
  ['ok', 'surface'], ['warn', 'surface'], ['danger', 'surface'], ['info', 'surface'],
  ['fg', 'bg'], ['fg-muted', 'bg'], ['fg-muted', 'surface-2'],
  ['ok', 'ok-soft'], ['warn', 'warn-soft'], ['danger', 'danger-soft'], ['accent', 'accent-soft'],
  ['diff-add-fg', 'diff-add'], ['diff-del-fg', 'diff-del']
]

/** '#rrggbb', '#rgb' or 'rgb(r g b [/ a])' -> [r, g, b, a] with channels 0-255. */
export function parseColor(value) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1]
    return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)).concat(1)
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+%?))?\s*\)$/i.exec(value)
  if (!rgb) throw new Error(`cannot parse colour: ${value}`)
  const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4])
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha]
}

const over = ([r, g, b, a], [br, bg, bb]) => [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1]

function luminance([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
}

export function contrastRatio(a, b) {
  const [la, lb] = [luminance(a), luminance(b)]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Returns { rows, failures } for every pair in every variant of `css`. */
export function checkContrast(css = readFileSync(TOKENS_CSS, 'utf8')) {
  const rules = parseRules(css)
  const rows = []
  for (const family of FAMILIES) {
    for (const scheme of SCHEMES) {
      const tokens = resolveTokens(rules, { 'data-family': family, 'data-scheme': scheme })
      const surface = parseColor(tokens['--surface'])
      const color = (name, base) => {
        if (!tokens[`--${name}`]) throw new Error(`${family}/${scheme}: token --${name} is not defined`)
        return over(parseColor(tokens[`--${name}`]), base)
      }
      for (const [text, background] of PAIRS) {
        const bg = color(background, surface)
        const ratio = contrastRatio(color(text, bg), bg)
        rows.push({ variant: `${family}/${scheme}`, pair: `${text} on ${background}`, ratio, ok: ratio >= MIN_RATIO })
      }
    }
  }
  return { rows, failures: rows.filter((row) => !row.ok) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { rows, failures } = checkContrast()
  const width = Math.max(...rows.map((row) => row.pair.length))
  console.log('variant           pair'.padEnd(18 + width + 2) + 'ratio    result')
  for (const row of rows) console.log(row.variant.padEnd(18) + row.pair.padEnd(width + 2) + `${row.ratio.toFixed(2)}:1`.padEnd(9) + (row.ok ? 'PASS' : 'FAIL'))
  if (failures.length) {
    console.error(`\n${failures.length} of ${rows.length} token pairs are below ${MIN_RATIO}:1.`)
    process.exit(1)
  }
  console.log(`\nAll ${rows.length} token pairs meet ${MIN_RATIO}:1.`)
}
