import { describe, expect, it } from 'vitest'
import {
  activeSessions, parseLimitWindow, sessionBlocked, sessionStatusNote, sessionWindowElapsedPercent,
  sessionWindowExpired, sessionWindowLabel, sessionWindowPercent, windowLabelFromMinutes
} from '../src/shared/sessions'
import type { ProviderRuntime, SessionInfo } from '../src/shared/types'

const NOW = Date.parse('2026-08-02T12:00:00.000Z')

function runtime(sessions: SessionInfo[], legacy?: SessionInfo): ProviderRuntime {
  return { available: true, running: 0, sessions, session: legacy, usage: { date: '2026-08-02', tasks: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, elapsedMs: 0 } }
}

describe('plan window naming', () => {
  it('reads the window length out of the name the CLI uses', () => {
    expect(parseLimitWindow('five_hour')).toEqual({ label: '5-hour', minutes: 300 })
    expect(parseLimitWindow('seven_day')).toEqual({ label: '7-day', minutes: 10_080 })
    expect(parseLimitWindow('weekly')).toEqual({ label: '7-day', minutes: 10_080 })
    expect(parseLimitWindow('30_minutes')).toEqual({ label: '30-minute', minutes: 30 })
  })

  it('falls back to a readable label when the name states no length', () => {
    expect(parseLimitWindow('org_quota')).toEqual({ label: 'org quota' })
    expect(parseLimitWindow(undefined)).toEqual({ label: 'Plan' })
  })

  it('names a window given only its length in minutes', () => {
    expect(windowLabelFromMinutes(300)).toBe('5-hour')
    expect(windowLabelFromMinutes(10_080)).toBe('7-day')
    expect(windowLabelFromMinutes(45)).toBe('45-minute')
    expect(windowLabelFromMinutes(0)).toBeUndefined()
  })
})

describe('plan window expiry', () => {
  const expired: SessionInfo = { limitType: '5-hour', resetsAt: '2026-08-01T09:10:00.000Z', updatedAt: '2026-08-01T07:31:00.000Z', utilizationPercent: 80 }
  const live: SessionInfo = { limitType: '7-day', resetsAt: '2026-08-04T00:00:00.000Z', updatedAt: '2026-08-02T11:00:00.000Z', utilizationPercent: 40 }

  it('treats a window past its reset as gone, not as 0% used', () => {
    expect(sessionWindowExpired(expired, NOW)).toBe(true)
    expect(sessionWindowExpired(live, NOW)).toBe(false)
    expect(sessionWindowPercent(expired, NOW)).toBeUndefined()
    expect(sessionWindowPercent(live, NOW)).toBe(40)
  })

  it('drops expired windows and still accepts legacy single-window state', () => {
    expect(activeSessions(runtime([expired, live]), NOW)).toEqual([live])
    expect(activeSessions(runtime([], live), NOW)).toEqual([live])
    expect(activeSessions(runtime([], expired), NOW)).toEqual([])
  })
})

describe('windows without a reported percentage', () => {
  // Claude's stream names the window and its reset but never a utilization, so
  // the only honest progress available is the window's own clock.
  const claude: SessionInfo = { limitType: '5-hour', windowMinutes: 300, status: 'allowed', overageStatus: 'rejected', resetsAt: '2026-08-02T14:00:00.000Z', updatedAt: '2026-08-02T11:59:00.000Z' }

  it('measures how far through the window the clock is', () => {
    expect(sessionWindowElapsedPercent(claude, NOW)).toBe(60)
    expect(sessionWindowPercent(claude, NOW)).toBeUndefined()
    expect(sessionWindowLabel(claude)).toBe('5-hour')
  })

  it('reports no elapsed progress when the window length is unknown', () => {
    expect(sessionWindowElapsedPercent({ ...claude, windowMinutes: undefined }, NOW)).toBeUndefined()
    expect(sessionWindowElapsedPercent({ ...claude, resetsAt: undefined }, NOW)).toBeUndefined()
  })

  it('says nothing about a healthy window and repeats anything else', () => {
    expect(sessionStatusNote(claude)).toBeUndefined()
    expect(sessionStatusNote({ ...claude, status: 'allowed_warning' })).toBe('allowed warning')
  })

  it('blocks on a rejecting plan status, but never on a rejected overage', () => {
    expect(sessionBlocked(claude, NOW)).toBe(false)
    expect(sessionBlocked({ ...claude, status: 'rejected' }, NOW)).toBe(true)
    expect(sessionBlocked({ ...claude, utilizationPercent: 100 }, NOW)).toBe(true)
    // Once the window has reset the same status no longer holds anyone back.
    expect(sessionBlocked({ ...claude, status: 'rejected', resetsAt: '2026-08-02T11:00:00.000Z' }, NOW)).toBe(false)
  })
})
