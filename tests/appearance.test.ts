import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { DEFAULT_FAMILY, platformAttribute, resolveAppearance } from '../src/renderer/src/theme-model'

const THEME_INIT = readFileSync(new URL('../src/renderer/public/theme-init.js', import.meta.url), 'utf8')
type Stored = Record<string, string | undefined>
const resolve = (stored: Stored, dark = false, reduced = false) => resolveAppearance(stored, dark, reduced)

describe('resolveAppearance: defaults', () => {
  it('lands on DEFAULT_FAMILY, the system scheme and calm chrome when nothing is stored', () => {
    expect(resolve({}, true).attributes).toEqual({
      'data-family': DEFAULT_FAMILY, 'data-scheme': 'dark', 'data-dock': 'bottom', 'data-dock-labels': 'hover',
      'data-density': 'comfortable', 'data-font-size': 'default', 'data-effects': 'on', 'data-theme': 'console', 'data-kit': 'v2'
    })
    expect(resolve({}, false).attributes['data-scheme']).toBe('light')
    expect(resolve({}).appearance.scheme).toBe('system')
  })

  it('stays Phosphor until the P6 flip', () => expect(DEFAULT_FAMILY).toBe('phosphor'))
})

describe('resolveAppearance: fp-theme migration (ui-plan 7.3)', () => {
  it.each([
    ['console', 'dark'], ['daylight', 'light'], ['system', 'system'], [undefined, 'system'], ['junk', 'system'], ['constructor', 'system']
  ])('fp-theme %s -> scheme %s', (theme, scheme) => {
    expect(resolve({ 'fp-theme': theme }).appearance).toMatchObject({ family: DEFAULT_FAMILY, scheme })
  })

  it('never reads fp-theme once fp-family exists', () => {
    expect(resolve({ 'fp-family': 'neutral', 'fp-theme': 'console' }).appearance).toMatchObject({ family: 'neutral', scheme: 'system' })
    expect(resolve({ 'fp-family': 'mono', 'fp-theme': 'daylight' }, true).attributes['data-scheme']).toBe('dark')
  })

  it('still reads fp-theme when fp-family is invalid, and prefers an explicit fp-scheme over it', () => {
    expect(resolve({ 'fp-family': 'gothic', 'fp-theme': 'console' }).appearance.scheme).toBe('dark')
    expect(resolve({ 'fp-theme': 'console', 'fp-scheme': 'light' }).appearance.scheme).toBe('light')
  })

  it('carries the light/dark choice into every family', () => {
    for (const family of ['neutral', 'mono', 'phosphor']) {
      expect(resolve({ 'fp-family': family, 'fp-scheme': 'dark' }).attributes).toMatchObject({ 'data-family': family, 'data-scheme': 'dark', 'data-theme': 'console' })
      expect(resolve({ 'fp-family': family, 'fp-scheme': 'light' }).attributes).toMatchObject({ 'data-family': family, 'data-scheme': 'light', 'data-theme': 'daylight' })
    }
  })
})

describe('resolveAppearance: system preferences', () => {
  it('follows prefers-color-scheme only for the system scheme', () => {
    expect(resolve({ 'fp-scheme': 'system' }, true).attributes['data-scheme']).toBe('dark')
    expect(resolve({ 'fp-scheme': 'system' }, false).attributes['data-scheme']).toBe('light')
    expect(resolve({ 'fp-scheme': 'light' }, true).attributes['data-scheme']).toBe('light')
    expect(resolve({ 'fp-scheme': 'dark' }, false).attributes['data-scheme']).toBe('dark')
  })

  it.each([
    [undefined, false, 'on'], ['on', false, 'on'], ['off', false, 'off'],
    [undefined, true, 'off'], ['on', true, 'off'], ['off', true, 'off']
  ])('fp-effects %s with reduced motion %s -> data-effects %s', (effects, reduced, expected) => {
    const { appearance, attributes } = resolve({ 'fp-effects': effects }, false, reduced)
    expect(attributes['data-effects']).toBe(expected)
    expect(appearance.effects).toBe(effects === 'off' ? 'off' : 'on') // the stored preference, not the reduced-motion result
  })
})

describe('resolveAppearance: chrome settings', () => {
  it('passes valid values through and ignores invalid ones', () => {
    expect(resolve({ 'fp-dock': 'left', 'fp-dock-labels': 'always', 'fp-density': 'compact', 'fp-font-size': 'large' }).attributes).toMatchObject({
      'data-dock': 'left', 'data-dock-labels': 'always', 'data-density': 'compact', 'data-font-size': 'large'
    })
    expect(resolve({ 'fp-dock': 'top', 'fp-dock-labels': 'never', 'fp-density': 'dense', 'fp-font-size': 'huge', 'fp-family': '', 'fp-scheme': 'auto' }).attributes).toMatchObject({
      'data-dock': 'bottom', 'data-dock-labels': 'hover', 'data-density': 'comfortable', 'data-font-size': 'default', 'data-family': DEFAULT_FAMILY
    })
  })
})

describe('platformAttribute (data-platform, never stored)', () => {
  it.each([
    [{ platform: 'MacIntel' }, 'mac'], [{ userAgentData: { platform: 'macOS' } }, 'mac'], [{ platform: 'Win32', userAgentData: { platform: 'macOS' } }, 'mac'],
    [{ platform: 'Win32' }, 'other'], [{ platform: 'Linux x86_64' }, 'other'], [{ userAgentData: { platform: '' }, platform: 'MacIntel' }, 'mac'], [{}, 'other'], [undefined, 'other']
  ])('%j -> %s', (nav, expected) => expect(platformAttribute(nav)).toBe(expected))
})

type FakeNavigator = Parameters<typeof platformAttribute>[0]

// theme-init.js is a plain script that cannot import theme-model.ts, so run it for real against a fake page.
function runThemeInit(stored: Stored, dark: boolean, reduced: boolean, storageThrows = false, navigator?: FakeNavigator) {
  const attributes: Record<string, string> = {}
  const writes: string[] = []
  const localStorage = {
    getItem: (key: string) => { if (storageThrows) throw new Error('denied'); return stored[key] ?? null },
    setItem: (key: string) => { writes.push(key) },
    removeItem: (key: string) => { writes.push(key) }
  }
  const matchMedia = (query: string) => ({ matches: query.includes('color-scheme') ? dark : query.includes('reduced-motion') ? reduced : false })
  const context = { document: { documentElement: { setAttribute: (name: string, value: string) => { attributes[name] = value } } }, localStorage, window: { matchMedia }, ...(navigator ? { navigator } : {}) }
  runInNewContext(THEME_INIT, context)
  return { attributes, writes }
}

describe('theme-init.js', () => {
  const stores: Stored[] = [
    {}, { 'fp-theme': 'console' }, { 'fp-theme': 'daylight' }, { 'fp-theme': 'system' }, { 'fp-theme': 'junk' }, { 'fp-theme': 'constructor' },
    { 'fp-family': 'neutral', 'fp-theme': 'console' }, { 'fp-family': 'mono', 'fp-scheme': 'dark' }, { 'fp-family': 'phosphor', 'fp-scheme': 'light' },
    { 'fp-family': 'gothic', 'fp-theme': 'daylight' }, { 'fp-theme': 'console', 'fp-scheme': 'light' }, { 'fp-scheme': 'system', 'fp-effects': 'off' },
    { 'fp-effects': 'on' }, { 'fp-dock': 'right', 'fp-dock-labels': 'always', 'fp-density': 'compact', 'fp-font-size': 'large' },
    { 'fp-dock': 'top', 'fp-dock-labels': 'x', 'fp-density': 'x', 'fp-font-size': 'x', 'fp-scheme': 'x', 'fp-effects': 'x' }
  ]

  it('sets exactly the attributes resolveAppearance returns, for every stored state x dark x reduced motion', () => {
    for (const stored of stores) {
      for (const dark of [false, true]) {
        for (const reduced of [false, true]) {
          expect(runThemeInit(stored, dark, reduced).attributes, JSON.stringify({ stored, dark, reduced })).toEqual({ ...resolve(stored, dark, reduced).attributes, 'data-platform': 'other' })
        }
      }
    }
  })

  it('derives data-platform exactly as platformAttribute does', () => {
    for (const nav of [{ platform: 'MacIntel' }, { userAgentData: { platform: 'macOS' } }, { platform: 'Win32' }, { platform: 'Linux x86_64' }, {}]) {
      expect(runThemeInit({}, false, false, false, nav).attributes['data-platform'], JSON.stringify(nav)).toBe(platformAttribute(nav))
    }
  })

  it('never writes storage', () => {
    expect(runThemeInit({ 'fp-theme': 'console' }, true, false).writes).toEqual([])
  })

  it('falls back to the default family, dark, effects off when storage throws', () => {
    expect(runThemeInit({}, false, false, true, { platform: 'MacIntel' }).attributes).toMatchObject({ 'data-family': DEFAULT_FAMILY, 'data-scheme': 'dark', 'data-theme': 'console', 'data-effects': 'off', 'data-kit': 'v2', 'data-platform': 'mac' })
  })
})
