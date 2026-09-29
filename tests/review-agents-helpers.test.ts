import { describe, expect, it } from 'vitest'
import { checkLine, loginState } from '../src/shared/review-agents'
import type { VerificationReport, VerificationResult } from '../src/shared/types'

const result = (name: string, ok: boolean): VerificationResult => ({ name, command: `pnpm ${name}`, ok, exitCode: ok ? 0 : 1, durationMs: 1200, output: '' })
const report = (checks: VerificationResult[], ran = true): VerificationReport => ({ ran, ok: ran && checks.every((check) => check.ok), checks, at: '2026-09-30T10:00:00.000Z' })

describe('loginState', () => {
  it('reads each CLI login state as a tone and a word', () => {
    expect(loginState({ state: 'logged-in' })).toEqual({ tone: 'ok', label: 'Signed in' })
    expect(loginState({ state: 'unknown' })).toEqual({ tone: 'neutral', label: 'Unknown' })
    expect(loginState({ state: 'logged-out' })).toEqual({ tone: 'danger', label: 'Logged out' })
  })

  it('treats a provider with no probe at all (Ollama, custom) as unknown, never logged out', () => {
    expect(loginState(undefined)).toEqual({ tone: 'neutral', label: 'Unknown' })
  })
})

describe('checkLine', () => {
  it('names every check when they all passed', () => {
    expect(checkLine(report([result('typecheck', true), result('test', true)]))).toEqual({ tone: 'ok', text: 'Checks passed: typecheck, test' })
  })

  it('names only the checks that failed', () => {
    expect(checkLine(report([result('typecheck', true), result('test', false)]))).toEqual({ tone: 'danger', text: 'Checks failed: test' })
    expect(checkLine(report([result('lint', false), result('test', false)]))).toEqual({ tone: 'danger', text: 'Checks failed: lint, test' })
  })

  it('never reports "no checks detected" as a pass', () => {
    const none = checkLine(report([], false))
    expect(none).toEqual({ tone: 'neutral', text: 'No checks detected' })
    expect(none.tone).not.toBe('ok')
  })

  it('does not trust a report that says it ran but carries no checks', () => {
    expect(checkLine(report([], true)).tone).toBe('neutral')
  })
})
