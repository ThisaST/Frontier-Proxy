import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PAIRS, TOKENS_CSS, checkContrast, contrastRatio, parseColor } from '../scripts/check-contrast.mjs'

describe('token contrast (scripts/check-contrast.mjs)', () => {
  it('holds every text pair to 4.5:1 in all six family x scheme variants', () => {
    const { rows, failures } = checkContrast()
    expect(rows).toHaveLength(6 * PAIRS.length)
    expect(failures.map((row) => `${row.variant} ${row.pair} ${row.ratio.toFixed(2)}`)).toEqual([])
  })

  it('catches a failing pair', () => {
    const css = readFileSync(TOKENS_CSS, 'utf8').replace('--fg-faint: #7c857f', '--fg-faint: #3a4a41')
    expect(checkContrast(css).failures.map((row) => `${row.variant} ${row.pair}`)).toEqual(['phosphor/dark fg-faint on surface'])
  })

  it('composites translucent tokens over the surface before measuring', () => {
    expect(parseColor('rgb(255 176 0 / .12)')).toEqual([255, 176, 0, 0.12])
    expect(contrastRatio([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 5)
    // an almost-opaque red tint makes red text on it unreadable; at 12% it is fine
    const css = readFileSync(TOKENS_CSS, 'utf8').replace('--danger-soft: rgb(255 77 77 / .12)', '--danger-soft: rgb(255 77 77 / .9)')
    expect(checkContrast(css).failures.map((row) => `${row.variant} ${row.pair}`)).toEqual(['phosphor/dark danger on danger-soft'])
  })
})
