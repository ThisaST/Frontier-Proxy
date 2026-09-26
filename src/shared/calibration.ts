// Pure calibration data for the Routing screen's "Would Jev have agreed?"
// card: buckets Jev-advised tasks by how confident its TARGET answer was
// (falling back to task-type confidence when no target was asked, e.g. below
// two eligible candidates), and reports how those buckets actually turned
// out — so "Jev was ≥0.8 confident" can be checked against reality instead of
// taken on faith.
import type { ProxyTask, TaskStatus, VerificationReport } from './types'

export interface CalibrationBucket {
  // "< 0.5", "0.5 – 0.8", "≥ 0.8" — fixed, ordered low to high.
  label: string
  tasks: number
  completed: number
  failed: number
  verified: number
  verifyFailed: number
  // Jev's top TARGET pick (the provider half of `target.choice`) matched the
  // provider that actually ran the task.
  agreedWithRoute: number
}

export interface AdvisorCalibration {
  buckets: CalibrationBucket[]
  // Shadow mode's own agreement signal (routeTask's `decision.advisor.
  // wouldChooseProviderId` vs the real `chosenProviderId`) — the same figure
  // the Routing screen already showed, folded in here so the view has one
  // source for both instead of computing this half itself.
  shadowAgreement: { agreed: number; total: number }
}

const BUCKET_LABELS = ['< 0.5', '0.5 – 0.8', '≥ 0.8'] as const

function bucketIndex(confidence: number): number {
  if (confidence < 0.5) return 0
  if (confidence < 0.8) return 1
  return 2
}

function terminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

// A plain (non-orchestrated) task carries no verification of its own — only
// isolated runs (subtasks, bench lanes, workspace turns) ever get checked.
// Rolled up across a task's subtasks: "verified" if any subtask's checks ran
// and passed, "verifyFailed" if any ran and failed — a task can be both if
// its subtasks disagreed.
function taskVerification(task: ProxyTask): { verified: boolean; verifyFailed: boolean } {
  const reports = (task.subtasks ?? [])
    .map((subtask) => subtask.verification)
    .filter((report): report is VerificationReport => Boolean(report?.ran))
  return { verified: reports.some((report) => report.ok), verifyFailed: reports.some((report) => !report.ok) }
}

function targetProviderId(task: ProxyTask): string | undefined {
  return task.advice?.target?.choice.split('::')[0]
}

export function advisorCalibration(tasks: ProxyTask[]): AdvisorCalibration {
  const buckets: CalibrationBucket[] = BUCKET_LABELS.map((label) => ({
    label, tasks: 0, completed: 0, failed: 0, verified: 0, verifyFailed: 0, agreedWithRoute: 0
  }))

  for (const task of tasks) {
    const advice = task.advice
    if (!advice || advice.source !== 'jev' || !terminal(task.status)) continue
    const confidence = advice.target?.confidence ?? advice.taskTypeConfidence ?? 0
    const bucket = buckets[bucketIndex(confidence)]
    bucket.tasks += 1
    if (task.status === 'completed') bucket.completed += 1
    if (task.status === 'failed') bucket.failed += 1
    const { verified, verifyFailed } = taskVerification(task)
    if (verified) bucket.verified += 1
    if (verifyFailed) bucket.verifyFailed += 1
    const ranProviderId = task.selectedProviderId ?? task.routing?.chosenProviderId
    const advised = targetProviderId(task)
    if (advised && advised === ranProviderId) bucket.agreedWithRoute += 1
  }

  const withShadow = tasks.filter((task) => task.routing?.advisor?.wouldChooseProviderId !== undefined)
  const shadowAgreement = {
    agreed: withShadow.filter((task) => task.routing?.advisor?.wouldChooseProviderId === task.routing?.chosenProviderId).length,
    total: withShadow.length
  }

  return { buckets, shadowAgreement }
}
