import type { ProviderRuntime, SessionInfo } from './types'

const WINDOW_UNIT_MINUTES: Record<string, number> = { minute: 1, hour: 60, day: 1_440, week: 10_080, month: 43_200 }
const WINDOW_WORD_COUNTS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, twenty: 20, thirty: 30 }
const WINDOW_ALIASES: Record<string, string> = { hourly: '1_hour', daily: '1_day', weekly: '7_day', monthly: '30_day', session: '5_hour' }

// A CLI names its plan window ("five_hour", "weekly") and that name is also the
// only statement of how long the window is — which is what makes a countdown
// mean something rather than a bare timestamp.
export function parseLimitWindow(raw?: string): { label: string; minutes?: number } {
  const key = (raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!key) return { label: 'Plan' }
  const match = /^(\d+|[a-z]+)_(minute|hour|day|week|month)s?$/.exec(WINDOW_ALIASES[key] ?? key)
  const count = match ? (/^\d+$/.test(match[1]) ? Number(match[1]) : WINDOW_WORD_COUNTS[match[1]]) : undefined
  if (!match || !count) return { label: key.replaceAll('_', ' ') }
  return { label: `${count}-${match[2]}`, minutes: count * WINDOW_UNIT_MINUTES[match[2]] }
}

// Codex reports a window length instead of a name; say it the same way.
export function windowLabelFromMinutes(minutes: number): string | undefined {
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day`
  if (minutes % 60 === 0) return `${minutes / 60}-hour`
  return `${Math.round(minutes)}-minute`
}

export function sessionResetAt(session: SessionInfo): string | undefined {
  return session.usingOverage ? session.overageResetsAt ?? session.resetsAt : session.resetsAt ?? session.overageResetsAt
}

// A window whose reset time has passed is over — not sitting at 0%. Keeping it
// would show a countdown that never counts and a limit that no longer applies.
export function sessionWindowExpired(session: SessionInfo, now = Date.now()): boolean {
  const reset = sessionResetAt(session)
  return Boolean(reset && Date.parse(reset) <= now)
}

// Every plan window the provider is inside right now, newest schema first and
// legacy single-window state still accepted.
export function activeSessions(runtime: ProviderRuntime, now = Date.now()): SessionInfo[] {
  const windows = runtime.sessions?.length ? runtime.sessions : runtime.session ? [runtime.session] : []
  return windows.filter((session) => !sessionWindowExpired(session, now))
}

// Only a percentage the CLI actually reported. Claude's stream carries a window
// and its status but no utilization, so this is often undefined on purpose.
export function sessionWindowPercent(session: SessionInfo, now = Date.now()): number | undefined {
  if (session.utilizationPercent === undefined || sessionWindowExpired(session, now)) return undefined
  return session.utilizationPercent
}

// How far through the window the clock is — a real, derivable fact when the CLI
// names the window length. It is time, never usage; label it as such.
export function sessionWindowElapsedPercent(session: SessionInfo, now = Date.now()): number | undefined {
  const reset = sessionResetAt(session)
  if (!session.windowMinutes || !reset) return undefined
  const span = session.windowMinutes * 60_000
  const remaining = Date.parse(reset) - now
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > span) return undefined
  return Math.min(100, Math.max(0, ((span - remaining) / span) * 100))
}

const BLOCKED_STATUS = /reject|exceed|exhaust|block|denied|over_limit|limit_reached/i

// The CLI can say the window is spent without ever giving a percentage.
export function sessionBlocked(session: SessionInfo, now = Date.now()): boolean {
  if (sessionWindowExpired(session, now)) return false
  if ((session.utilizationPercent ?? 0) >= 100) return true
  return Boolean(session.status && BLOCKED_STATUS.test(session.status))
}

export function sessionWindowLabel(session: SessionInfo): string {
  return session.limitType ?? 'Plan'
}

// "allowed" is the resting state and worth no words; anything else is news.
export function sessionStatusNote(session: SessionInfo): string | undefined {
  const status = session.status?.trim()
  if (!status || /^(allowed|ok|active|normal)$/i.test(status)) return undefined
  return status.replaceAll('_', ' ')
}
