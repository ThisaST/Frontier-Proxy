import { describe, expect, it } from 'vitest'
import { advisorCalibration } from '../src/shared/calibration'
import type { ProxyTask, RoutingAdvice, TaskStatus } from '../src/shared/types'

function jevAdvice(overrides: Partial<RoutingAdvice> = {}): RoutingAdvice {
  return { source: 'jev', at: new Date().toISOString(), taskType: 'coding', heuristicTaskType: 'coding', taskTypeConfidence: 0.6, ...overrides }
}

function task(overrides: Partial<ProxyTask> = {}): ProxyTask {
  return {
    id: overrides.id ?? 'task', prompt: 'Do work', cwd: '/tmp', mode: 'balanced', type: 'coding',
    status: 'completed', createdAt: new Date().toISOString(), output: '', attempts: [],
    estimatedInputTokens: 10, estimatedOutputTokens: 0, selectedProviderId: 'claude',
    ...overrides
  }
}

describe('advisorCalibration', () => {
  it('ignores tasks with no advice, heuristic-only advice, and non-terminal tasks', () => {
    const noAdvice = task({ id: 'a' })
    const heuristic = task({ id: 'b', advice: { source: 'heuristic', at: '', taskType: 'coding', heuristicTaskType: 'coding' } })
    const running = task({ id: 'c', status: 'running', advice: jevAdvice() })
    const { buckets } = advisorCalibration([noAdvice, heuristic, running])
    expect(buckets.every((bucket) => bucket.tasks === 0)).toBe(true)
  })

  it('buckets by the target confidence, falling back to task-type confidence when there is no target', () => {
    const low = task({ id: 'low', advice: jevAdvice({ target: { choice: 'claude::x', probabilities: {}, confidence: 0.2 } }) })
    const medium = task({ id: 'medium', advice: jevAdvice({ target: { choice: 'claude::x', probabilities: {}, confidence: 0.65 } }) })
    const high = task({ id: 'high', advice: jevAdvice({ target: { choice: 'claude::x', probabilities: {}, confidence: 0.95 } }) })
    // No target at all (below two candidates) — falls back to task-type confidence.
    const noTarget = task({ id: 'no-target', advice: jevAdvice({ taskTypeConfidence: 0.9 }) })

    const { buckets } = advisorCalibration([low, medium, high, noTarget])
    expect(buckets.map((bucket) => bucket.label)).toEqual(['< 0.5', '0.5 – 0.8', '≥ 0.8'])
    expect(buckets[0].tasks).toBe(1)
    expect(buckets[1].tasks).toBe(1)
    expect(buckets[2].tasks).toBe(2) // high + noTarget (0.9 task-type confidence)
  })

  it('counts completed and failed status per bucket, leaving cancelled out of both', () => {
    const completed = task({ id: 'c1', status: 'completed', advice: jevAdvice({ taskTypeConfidence: 0.9 }) })
    const failed = task({ id: 'c2', status: 'failed', advice: jevAdvice({ taskTypeConfidence: 0.9 }) })
    const cancelled = task({ id: 'c3', status: 'cancelled', advice: jevAdvice({ taskTypeConfidence: 0.9 }) })
    const { buckets } = advisorCalibration([completed, failed, cancelled])
    const high = buckets[2]
    expect(high.tasks).toBe(3)
    expect(high.completed).toBe(1)
    expect(high.failed).toBe(1)
  })

  it('rolls verification up from a task\'s subtasks, allowing both verified and verifyFailed on one task', () => {
    const withMixedSubtasks = task({
      id: 'mixed', advice: jevAdvice({ taskTypeConfidence: 0.9 }),
      subtasks: [
        { id: 's1', title: 'a', prompt: 'a', type: 'coding', status: 'completed', output: '', verification: { ran: true, ok: true, checks: [], at: '' } },
        { id: 's2', title: 'b', prompt: 'b', type: 'coding', status: 'completed', output: '', verification: { ran: true, ok: false, checks: [], at: '' } }
      ]
    })
    const { buckets } = advisorCalibration([withMixedSubtasks])
    expect(buckets[2].verified).toBe(1)
    expect(buckets[2].verifyFailed).toBe(1)
  })

  it('never counts an undetected check (ran: false) as verified or failed', () => {
    const notRun = task({
      id: 'not-run', advice: jevAdvice({ taskTypeConfidence: 0.9 }),
      subtasks: [{ id: 's1', title: 'a', prompt: 'a', type: 'coding', status: 'completed', output: '', verification: { ran: false, ok: false, checks: [], at: '' } }]
    })
    const { buckets } = advisorCalibration([notRun])
    expect(buckets[2].verified).toBe(0)
    expect(buckets[2].verifyFailed).toBe(0)
  })

  it('counts agreement when Jev\'s top target provider is the one that actually ran', () => {
    const agreed = task({ id: 'agree', selectedProviderId: 'claude', advice: jevAdvice({ target: { choice: 'claude::claude-opus-5', probabilities: {}, confidence: 0.9 } }) })
    const disagreed = task({ id: 'disagree', selectedProviderId: 'codex', advice: jevAdvice({ target: { choice: 'claude::claude-opus-5', probabilities: {}, confidence: 0.9 } }) })
    const { buckets } = advisorCalibration([agreed, disagreed])
    expect(buckets[2].tasks).toBe(2)
    expect(buckets[2].agreedWithRoute).toBe(1)
  })

  it('falls back to the routing decision\'s chosen provider when selectedProviderId is unset', () => {
    const agreed = task({
      id: 'agree', selectedProviderId: undefined,
      routing: { at: '', taskType: 'coding', mode: 'balanced', chosenProviderId: 'claude', candidates: [] },
      advice: jevAdvice({ target: { choice: 'claude::claude-opus-5', probabilities: {}, confidence: 0.9 } })
    })
    const { buckets } = advisorCalibration([agreed])
    expect(buckets[2].agreedWithRoute).toBe(1)
  })

  it('reports the overall shadow agreement from the recorded would-choose decision, separate from the buckets', () => {
    const agreedShadow = task({
      id: 'shadow-agree',
      routing: { at: '', taskType: 'coding', mode: 'balanced', chosenProviderId: 'claude', candidates: [], advisor: { mode: 'shadow', applied: false, wouldChooseProviderId: 'claude' } }
    })
    const disagreedShadow = task({
      id: 'shadow-disagree',
      routing: { at: '', taskType: 'coding', mode: 'balanced', chosenProviderId: 'claude', candidates: [], advisor: { mode: 'shadow', applied: false, wouldChooseProviderId: 'codex' } }
    })
    const noShadow = task({ id: 'no-shadow' })
    const { shadowAgreement } = advisorCalibration([agreedShadow, disagreedShadow, noShadow])
    expect(shadowAgreement).toEqual({ agreed: 1, total: 2 })
  })

  it('returns an honest empty result for no tasks at all', () => {
    const { buckets, shadowAgreement } = advisorCalibration([])
    expect(buckets.every((bucket) => bucket.tasks === 0)).toBe(true)
    expect(shadowAgreement).toEqual({ agreed: 0, total: 0 })
  })
})

// Not part of the calibration domain, but keeps the terminal-status helper
// honest against every status the type allows.
describe('terminal task statuses considered', () => {
  it('excludes queued and running, includes completed/failed/cancelled', () => {
    const statuses: TaskStatus[] = ['queued', 'running', 'completed', 'failed', 'cancelled']
    const tasks = statuses.map((status) => task({ id: status, status, advice: jevAdvice({ taskTypeConfidence: 0.9 }) }))
    const { buckets } = advisorCalibration(tasks)
    expect(buckets[2].tasks).toBe(3)
  })
})
