// Pure text builders for the Agents login column and the Review check line. DOM-free so they are
// unit-tested in the node project (tests/review-agents-helpers.test.ts); the renderer wraps them in `status()`.
import type { AuthStatus, VerificationReport } from './types'

export type LineTone = 'ok' | 'danger' | 'neutral'

// The login column as a tone and a word. `unknown` is the honest answer whenever the CLI's own session
// store could not be read (and for providers with no account at all), so it is never shown as logged out.
export function loginState(auth?: Pick<AuthStatus, 'state'>): { tone: LineTone; label: string } {
  if (auth?.state === 'logged-in') return { tone: 'ok', label: 'Signed in' }
  if (auth?.state === 'logged-out') return { tone: 'danger', label: 'Logged out' }
  return { tone: 'neutral', label: 'Unknown' }
}

// A verification report as one line. "No checks detected" is never `ok`: a repo with no detected
// checks has proved nothing about the branch, so `ran === false` reads neutral, not passing.
export function checkLine(report: Pick<VerificationReport, 'ran' | 'checks'>): { tone: LineTone; text: string } {
  if (!report.ran || !report.checks.length) return { tone: 'neutral', text: 'No checks detected' }
  const failed = report.checks.filter((check) => !check.ok)
  return failed.length
    ? { tone: 'danger', text: `Checks failed: ${failed.map((check) => check.name).join(', ')}` }
    : { tone: 'ok', text: `Checks passed: ${report.checks.map((check) => check.name).join(', ')}` }
}
