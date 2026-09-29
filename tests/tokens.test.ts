import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseRules, resolveTokens } from '../scripts/css-tokens.mjs'

const RENDERER = fileURLToPath(new URL('../src/renderer', import.meta.url))
const TOKENS = join(RENDERER, 'src/styles/tokens.css')
const files = (readdirSync(RENDERER, { recursive: true }) as string[])
  .filter((file) => /\.(css|ts|html)$/.test(file) && !file.includes('node_modules'))
  .map((file) => ({ file: file.replaceAll('\\', '/'), text: readFileSync(join(RENDERER, file), 'utf8') }))
const rules = parseRules(readFileSync(TOKENS, 'utf8'))
const legacy: Record<string, Record<string, string>> = JSON.parse(readFileSync(new URL('./fixtures/phosphor-v1-tokens.json', import.meta.url), 'utf8'))

// Custom properties that belong to one component and are set by its own CSS or, at runtime, by
// its own TS (`setProperty`), not design tokens. Each must still be used somewhere (checked below).
const COMPONENT_LOCAL = ['--tick', '--tick-w', '--wq-col', '--insp-col', '--ws-list-col', '--tree-depth', '--radar-size', '--swatch']

describe('renderer stylesheets and the token layer', () => {
  it('every var(--x) is defined in tokens.css, or is a known component-local property', () => {
    const defined = new Set(rules.flatMap((rule) => Object.keys(rule.decls)))
    const used = files.flatMap(({ file, text }) => [...text.matchAll(/var\((--[\w-]+)/g)].map((m) => [m[1], file] as const))
    expect(used.length).toBeGreaterThan(300) // the scan really found the stylesheets
    expect(used.filter(([name]) => !defined.has(name) && !COMPONENT_LOCAL.includes(name)).map(([name, file]) => `${name} in ${file}`)).toEqual([])
    for (const name of COMPONENT_LOCAL) expect(used.some(([used]) => used === name), `${name} is allowlisted but unused`).toBe(true)
  })

  it('no raw #hex, rgb() or hsl() colour appears outside tokens.css', () => {
    const literal = /(?<![&\w])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/gi // `&#039;` and `#some-id` are not colours
    expect(files.filter(({ file }) => file !== 'src/styles/tokens.css').flatMap(({ file, text }) => (text.match(literal) ?? []).map((hit) => `${hit} in ${file}`))).toEqual([])
  })
})

const VARIANTS = ['neutral', 'mono', 'phosphor'].flatMap((family) => ['light', 'dark'].map((scheme) => ({ 'data-family': family, 'data-scheme': scheme })))
const V2 = [
  '--bg', '--surface', '--surface-2', '--surface-3', '--border', '--border-strong', '--fg', '--fg-muted', '--fg-faint',
  '--accent', '--accent-fill', '--accent-hover', '--accent-fg', '--accent-soft', '--ok', '--ok-soft', '--warn', '--warn-soft',
  '--danger', '--danger-soft', '--info', '--info-soft', '--focus', '--selection', '--hover', '--pressed', '--scrim',
  '--shadow-1', '--shadow-2', '--shadow-dock', '--code-bg', '--diff-add', '--diff-add-fg', '--diff-del', '--diff-del-fg', '--glow',
  '--font-sans', '--font-mono', '--font-display', '--tracking-label', '--label-transform', '--density', '--control-h'
]

describe('token layer v2', () => {
  it('defines every v2 token, and resolves every v1 name, in all six variants', () => {
    for (const attrs of VARIANTS) {
      const tokens = resolveTokens(rules, attrs) // throws on a var() with no definition
      expect(V2.filter((name) => !tokens[name]), JSON.stringify(attrs)).toEqual([])
      expect(Object.keys(legacy['console']).filter((name) => !tokens[name]), JSON.stringify(attrs)).toEqual([])
    }
  })

  it('only Phosphor has glow, Chakra Petch display type and uppercase labels', () => {
    for (const attrs of VARIANTS) {
      const tokens = resolveTokens(rules, attrs)
      const phosphor = attrs['data-family'] === 'phosphor'
      expect(tokens['--label-transform'] === 'uppercase').toBe(phosphor)
      expect(tokens['--font-display'].includes('Chakra Petch')).toBe(phosphor)
      expect(tokens['--glow'] !== 'none').toBe(phosphor && attrs['data-scheme'] === 'dark')
    }
  })

  it('--accent-fill equals --accent everywhere except Phosphor light (ui-plan 7.4)', () => {
    for (const attrs of VARIANTS) {
      const tokens = resolveTokens(rules, attrs)
      expect(tokens['--accent-fill'] === tokens['--accent']).toBe(!(attrs['data-family'] === 'phosphor' && attrs['data-scheme'] === 'light'))
    }
  })

  it('effects off removes every glow in every variant', () => {
    for (const attrs of VARIANTS) {
      const tokens = resolveTokens(rules, { ...attrs, 'data-effects': 'off' })
      expect(Object.entries(tokens).filter(([name, value]) => name.startsWith('--glow') && value !== 'none')).toEqual([])
    }
  })
})

// Fixture: every v1 token as it resolved on main at 87f4673 (before the v2 layer), per state.
// P1 promises the app looks identical, so each must resolve to the same value under Phosphor,
// whether the page carries the v1 `data-theme`, the new family/scheme pair, or both (theme-init
// sets both during the transition), and with no attribute at all (first paint).
// One deliberate exception: --s-8 is 40px in the v2 scale (was 48px); nothing uses it.
describe('Phosphor v1 tokens are unchanged', () => {
  const dark = { 'data-family': 'phosphor', 'data-scheme': 'dark' }
  const light = { 'data-family': 'phosphor', 'data-scheme': 'light' }
  const cases: [string, Record<string, string>[]][] = [
    ['console', [{}, { 'data-theme': 'console' }, dark, { ...dark, 'data-theme': 'console' }, { ...dark, 'data-effects': 'on' }]],
    ['daylight', [{ 'data-theme': 'daylight' }, light, { ...light, 'data-theme': 'daylight' }, { ...light, 'data-effects': 'on' }]],
    ['console+effects-off', [{ 'data-effects': 'off' }, { 'data-theme': 'console', 'data-effects': 'off' }, { ...dark, 'data-effects': 'off' }, { ...dark, 'data-theme': 'console', 'data-effects': 'off' }]],
    ['daylight+effects-off', [{ 'data-theme': 'daylight', 'data-effects': 'off' }, { ...light, 'data-effects': 'off' }, { ...light, 'data-theme': 'daylight', 'data-effects': 'off' }]]
  ]

  it.each(cases)('%s', (state, attrSets) => {
    const { '--s-8': _skip, ...expected } = legacy[state]
    expect(Object.keys(expected).length).toBeGreaterThan(40)
    for (const attrs of attrSets) {
      const { '--s-8': s8, ...actual } = resolveTokens(rules, attrs)
      expect(s8).toBe('40px')
      expect(Object.fromEntries(Object.keys(expected).map((name) => [name, actual[name]])), JSON.stringify(attrs)).toEqual(expected)
    }
  })
})
