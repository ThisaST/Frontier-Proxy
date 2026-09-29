import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

const kit = strip(read('src/renderer/src/styles/kit.css'))
// P1 lands the real tokens.css in parallel; either the design doc's or the app's may define a name.
const defined = new Set([...strip(read('docs/ui-calm/tokens.css')).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
for (const m of strip(read('src/renderer/src/styles/tokens.css')).matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1])
// Custom properties the kit defines itself (a component-local channel), so they need no token.
// `--value` is written by the meter() factory through style.setProperty, and always read with a fallback.
const local = new Set([...kit.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]).concat('--value'))

// SPEC section 4 class names. `.tabs` (horizontal) and `.dock` are not part of P2 (ui-plan 10.1 row 14, P3).
const SPEC_CLASSES = [
  'btn', 'btn-primary', 'btn-secondary', 'btn-ghost', 'btn-danger', 'btn-sm', 'btn-icon',
  'input', 'select', 'textarea', 'switch', 'slider', 'segmented',
  'status', 'ok', 'warn', 'danger', 'info', 'neutral', 'running',
  'tag', 'badge', 'meter', 'accent', 'card', 'row', 'is-selected', 'section-title', 'field-label',
  'table', 'vtabs', 'sheet', 'dialog', 'toast', 'tooltip', 'kbd', 'empty', 'avatar', 'code', 'diff', 'add', 'del', 'readout'
]

describe('kit.css', () => {
  it('has no hex or rgb() colour literals', () => {
    expect(kit.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
    expect(kit.match(/\brgba?\(/g) ?? []).toEqual([])
    expect(kit.match(/\bhsla?\(/g) ?? []).toEqual([])
  })

  it('only uses var(--x) that tokens define', () => {
    const used = [...kit.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(50)
    const missing = [...new Set(used)].filter((name) => !defined.has(name) && !local.has(name))
    expect(missing).toEqual([])
  })

  it('defines every SPEC section 4 class as a selector', () => {
    const selectors = kit.replace(/\{[^{}]*\}/g, '{}')
    const missing = SPEC_CLASSES.filter((name) => !new RegExp(`\\.${name}(?![\\w-])`).test(selectors))
    expect(missing).toEqual([])
  })

  it('draws a focus ring with the focus token and never removes outlines without a replacement', () => {
    expect(kit).toMatch(/:focus-visible[^{]*\{\s*outline:\s*2px solid var\(--focus\);\s*outline-offset:\s*2px/)
    // text fields swap the outline for the border + ring; nothing else may say `outline: none`
    const removed = [...kit.matchAll(/([^{}]*)\{[^{}]*outline:\s*none[^{}]*\}/g)].map((m) => m[1].trim())
    expect(removed.every((selector) => /:focus/.test(selector) && /input|select|textarea/.test(selector))).toBe(true)
  })

  it('turns the running pulse off for reduced motion and data-effects="off"', () => {
    expect(kit).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.status\.running::before\s*\{\s*animation:\s*none/)
    expect(kit).toMatch(/:root\[data-effects="off"\]\s+\.status\.running::before\s*\{\s*animation:\s*none/)
  })

  it('never uppercases a tag, and lets Phosphor label identity flow through tokens', () => {
    expect(/\.tag\s*\{[^}]*text-transform/.test(kit)).toBe(false)
    for (const name of ['section-title', 'field-label']) {
      const block = kit.match(new RegExp(`\\.${name}\\s*\\{[^}]*\\}`))?.[0] ?? ''
      expect(block).toContain('var(--font-display)')
      expect(block).toContain('text-transform: var(--label-transform)')
      expect(block).toContain('letter-spacing: var(--tracking-label)')
    }
  })

  it('segments the meter track for Phosphor from the same markup', () => {
    expect(kit).toMatch(/:root\[data-family="phosphor"\] \.meter-track\s*\{[^}]*repeating-linear-gradient/)
  })

  it('is imported after tokens.css and before the legacy component sheets', () => {
    const imports = [...read('src/renderer/src/styles/index.css').matchAll(/@import '\.\/([\w./-]+)'/g)].map((m) => m[1])
    expect(imports.indexOf('kit.css')).toBeGreaterThan(imports.indexOf('tokens.css'))
    expect(imports.indexOf('kit.css')).toBeLessThan(imports.indexOf('base.css'))
    expect(imports.indexOf('kit.css')).toBeLessThan(imports.indexOf('components.css'))
  })

  it('gates every rule that collides with a legacy class used by shipped markup', () => {
    const rules = [...kit.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => m[1].trim())
    const colliding = rules.filter((selector) => /\.(segmented|switch|slider|readout|field-label)(?![\w-])/.test(selector))
    expect(colliding.length).toBeGreaterThan(10)
    expect(colliding.filter((selector) => !selector.startsWith(':root[data-kit="v2"]'))).toEqual([])
  })
})
