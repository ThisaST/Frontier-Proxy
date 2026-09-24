import type { AdvisorMode, ModelTier, OutcomeStats, ProviderConfig, ProviderRuntime, ProxyTask, RoutingAdvice, RoutingCandidate, RoutingDecision, RoutingFactor, RoutingMode, TaskType } from '../shared/types'
import { activeSessions, sessionBlocked } from '../shared/sessions'
import { efficiencyBaselines, efficiencyFactors, type EfficiencyBaselines } from './evidence'
import { desiredTier, TIER_ORDER, tierFor, type DesiredTier } from '../shared/model-profiles'

export interface RoutableProvider extends ProviderConfig {
  runtime: ProviderRuntime
}

const affinity: Record<TaskType, Partial<Record<ProviderConfig['kind'], number>>> = {
  coding: { codex: 18, copilot: 16, claude: 14, 'codex-oss': 8, ollama: -8 },
  debugging: { codex: 18, copilot: 16, claude: 15, 'codex-oss': 7, ollama: -8 },
  review: { claude: 18, copilot: 16, codex: 14, 'codex-oss': 8, ollama: 5 },
  planning: { claude: 18, copilot: 14, codex: 12, 'codex-oss': 7, ollama: 8 },
  documentation: { claude: 17, copilot: 14, codex: 10, 'codex-oss': 8, ollama: 10 },
  general: { claude: 14, copilot: 14, codex: 12, 'codex-oss': 8, ollama: 9 }
}

const MODE_LABEL: Record<ProxyTask['mode'], string> = { balanced: 'Balanced', quality: 'Quality first', saver: 'Token saver' }

function isCoolingDown(runtime: ProviderRuntime, now: number): boolean {
  return Boolean(runtime.cooldownUntil && Date.parse(runtime.cooldownUntil) > now)
}

function sessionLimitReached(runtime: ProviderRuntime, now: number): boolean {
  return activeSessions(runtime, now).some((session) => sessionBlocked(session, now))
}

function trackedTokens(runtime: ProviderRuntime): number {
  const actual = runtime.usage.inputTokens + runtime.usage.outputTokens
  return actual || runtime.usage.estimatedInputTokens + runtime.usage.estimatedOutputTokens
}

// Why this provider cannot take the task right now, in the user's words.
// Returning undefined means it is eligible.
function skipReason(task: ProxyTask, provider: RoutableProvider, now: number): string | undefined {
  if (!provider.enabled) return 'Turned off in Providers'
  if (!provider.runtime.available) return 'CLI not detected on this machine'
  if (isCoolingDown(provider.runtime, now)) return 'Cooling down after a usage limit'
  if (!provider.capabilities.includes(task.type)) return `Not enabled for ${task.type} work`
  if (provider.runtime.running >= provider.maxConcurrent) return `Already running ${provider.runtime.running} of ${provider.maxConcurrent} allowed tasks`
  if (sessionLimitReached(provider.runtime, now)) return 'Reported plan usage limit reached'
  if (provider.dailyTokenBudget && trackedTokens(provider.runtime) + task.estimatedInputTokens > provider.dailyTokenBudget) return 'Tracked usage limit reached'
  return undefined
}

// How well this provider's recent runs of this kind of work actually went. Three
// signals, strongest last: did the run finish, did the repo's own checks pass,
// and did the user merge the branch it produced or throw it away. The merge
// verdict is weighted highest because it is the only one a human made.
//
// Deliberately bounded to ±MAX_OUTCOME_POINTS and gated behind a minimum sample
// count: this nudges the ranking, it never overrides configured priority, mode
// policy, or an explicit choice — and it stays visible as one labelled factor.
const MIN_OUTCOME_RUNS = 3
const MAX_OUTCOME_POINTS = 14

// Shared by the provider-level factor below, the per-model factor, and
// pickModel's own tie-break — one formula for "how well did this actually
// go", whatever it's keyed by.
function outcomePoints(stats: OutcomeStats): number {
  const completion = stats.completed / stats.runs
  const reviewed = stats.merged + stats.discarded
  const checked = stats.verified + stats.verifyFailed
  // Each ratio is centred on 0 so "no better than a coin toss" scores nothing.
  const parts = [{ weight: 1, ratio: completion }]
  if (checked) parts.push({ weight: 1.5, ratio: stats.verified / checked })
  if (reviewed) parts.push({ weight: 2.5, ratio: stats.merged / reviewed })
  const weight = parts.reduce((total, part) => total + part.weight, 0)
  const score = parts.reduce((total, part) => total + part.weight * (part.ratio - 0.5), 0) / weight
  return Math.round(score * 2 * MAX_OUTCOME_POINTS)
}

export function outcomeFactor(stats: OutcomeStats | undefined, taskType: TaskType): RoutingFactor | undefined {
  if (!stats || stats.runs < MIN_OUTCOME_RUNS) return undefined
  const points = outcomePoints(stats)
  if (!points) return undefined
  return { label: `Recent ${taskType} outcomes (${stats.runs} runs)`, points }
}

// The same factor, but keyed by the specific model this provider would
// actually run (`pickModel`'s own pick) instead of the provider as a whole —
// replaces the provider-level factor above rather than stacking with it, so
// "learn from outcomes" never double-counts one set of runs.
function modelOutcomeFactor(stats: OutcomeStats | undefined, taskType: TaskType, model: string): RoutingFactor | undefined {
  if (!stats || stats.runs < MIN_OUTCOME_RUNS) return undefined
  const points = outcomePoints(stats)
  if (!points) return undefined
  return { label: `Recent ${taskType} outcomes on ${model} (${stats.runs} runs)`, points }
}

// Inputs pickModel needs to break a tie between equally tier-fit models with
// what has actually happened when each one ran this kind of task before.
export interface ModelOutcomeOptions {
  taskType: TaskType
  modelOutcomes?: Record<string, Partial<Record<TaskType, OutcomeStats>>>
  learnFromOutcomes?: boolean
}

// ---- Jev advisor factors ----
// Jev advises, the router decides: every answer becomes a small, bounded,
// labelled factor here — never an override of eligibility, an explicit pick,
// or the model the user chose. Applied only when routeTask is told the
// advisor is active AND the task's advice actually came from Jev (routeTask
// gates this; the functions below assume both are already true).

const MAX_TIER_FIT_POINTS = 20
const MAX_TARGET_FIT_POINTS = 15
const READ_ONLY_LOCAL_BONUS = 8
// A noul below this reads as "probably will not edit files". 0.2 leaves a wide
// margin above 0 so an uncertain-but-leaning-false answer still counts.
const READ_ONLY_THRESHOLD = 0.2

// `desiredTier` (the tier a task calls for, from Jev's complexity score and
// the routing mode) lives in `src/shared/model-profiles.ts` — it is also used
// to display the same tier on the Routing screen and the Route tab, so the
// rule can never drift between what the router scores and what the UI shows.

// Distance (in tier steps) from one tier to the desired one — 0 when they
// match, or when the "frontier also fits" band applies. Shared by tier-fit
// scoring and pickModel so the two can never disagree about which model a
// provider would actually run for a given desire.
function tierDistance(tier: ModelTier, desired: DesiredTier): number {
  if (tier === desired.tier) return 0
  if (desired.frontierAlsoFits && tier === 'frontier' && desired.tier === 'standard') return 0
  return Math.abs(TIER_ORDER.indexOf(tier) - TIER_ORDER.indexOf(desired.tier))
}

// The minimum tier distance among a provider's own discovered/known models
// (plus its configured default) to the desired tier — i.e. the distance of
// the model this provider would *actually* run there, per pickModel's own
// rule. Scoring on the provider's *best* tier instead would give a provider
// like Claude, which owns both opus and haiku, zero credit for a trivial task
// even though it would run haiku for it. A provider with no known models at
// all falls back to its kind's natural tier (local for Ollama-backed CLIs,
// standard otherwise) rather than being penalised for a discovery gap.
function closestTierDistance(models: string[], kind: ProviderConfig['kind'], defaultModel: string | undefined, desired: DesiredTier): number {
  const candidates = [...new Set([...(models ?? []), defaultModel].filter((value): value is string => Boolean(value)))]
  if (!candidates.length) return tierDistance(kind === 'ollama' || kind === 'codex-oss' ? 'local' : 'standard', desired)
  let best = Number.POSITIVE_INFINITY
  for (const model of candidates) {
    const distance = tierDistance(tierFor(model, kind), desired)
    if (distance < best) best = distance
  }
  return best
}

function pointsForDistance(distance: number): number {
  return Math.max(-MAX_TIER_FIT_POINTS, MAX_TIER_FIT_POINTS - distance * 10)
}

function tierFitFactor(task: ProxyTask, provider: RoutableProvider, advice: RoutingAdvice, minConfidence: number): RoutingFactor | undefined {
  if (advice.complexity === undefined || (advice.complexityConfidence ?? 0) < minConfidence) return undefined
  const desired = desiredTier(advice.complexity, task.mode)
  const points = pointsForDistance(closestTierDistance(provider.runtime.models ?? [], provider.kind, provider.model, desired))
  if (!points) return undefined
  return { label: `Jev: complexity ${advice.complexity.toFixed(1)} → ${desired.tier} tier`, points }
}

// Sums the target choice's probability mass over every (provider, model)
// option this provider owns — a provider can appear under several models, and
// each contributes to how much Jev likes sending this task to it at all,
// independent of which specific model wins.
function jevBestFitFactor(provider: RoutableProvider, advice: RoutingAdvice): RoutingFactor | undefined {
  if (!advice.target) return undefined
  const prefix = `${provider.id}::`
  const share = Object.entries(advice.target.probabilities)
    .filter(([key]) => key.startsWith(prefix))
    .reduce((sum, [, value]) => sum + value, 0)
  if (!share) return undefined
  const points = Math.round(share * advice.target.confidence * MAX_TARGET_FIT_POINTS)
  if (!points) return undefined
  return { label: `Jev best fit (${Math.round(share * 100)}%)`, points }
}

function readOnlyFactor(provider: RoutableProvider, advice: RoutingAdvice): RoutingFactor | undefined {
  if (advice.editsFiles === undefined || advice.editsFiles >= READ_ONLY_THRESHOLD) return undefined
  if (provider.kind !== 'ollama' && provider.kind !== 'codex-oss') return undefined
  return { label: 'Read-only task → local OK', points: READ_ONLY_LOCAL_BONUS }
}

function advisorFactors(task: ProxyTask, provider: RoutableProvider, advice: RoutingAdvice, minConfidence: number): RoutingFactor[] {
  const factors: RoutingFactor[] = []
  const tier = tierFitFactor(task, provider, advice, minConfidence)
  if (tier) factors.push(tier)
  const target = jevBestFitFactor(provider, advice)
  if (target) factors.push(target)
  const readOnly = readOnlyFactor(provider, advice)
  if (readOnly) factors.push(readOnly)
  return factors
}

// Which model this provider should run for the task, from Jev's complexity
// signal alone — the tier closest to what the task calls for among this
// provider's own discovered/known models. Pure and provider-scoped: it can
// never suggest a model belonging to a different agent. Returns undefined
// (keep the provider default) whenever there is no usable signal.
//
// When two or more of those models land equally close to the desired tier,
// the tie is broken by which one has actually gone better for this kind of
// task — same bounded, sample-gated signal as the routing factor, silent
// (falls back to the first tied model, same as before this existed) below
// the sample size or when outcome learning is off.
export function pickModel(
  provider: Pick<ProviderConfig, 'id' | 'kind' | 'model'>,
  models: string[],
  advice: RoutingAdvice | undefined,
  mode: RoutingMode,
  outcomes?: ModelOutcomeOptions
): string | undefined {
  if (!advice || advice.source !== 'jev' || advice.complexity === undefined) return undefined
  const desired = desiredTier(advice.complexity, mode)
  const candidates = [...new Set([...(models ?? []), provider.model].filter((value): value is string => Boolean(value)))]
  if (!candidates.length) return undefined
  let bestDistance = Number.POSITIVE_INFINITY
  let tied: string[] = []
  for (const model of candidates) {
    const distance = tierDistance(tierFor(model, provider.kind), desired)
    if (distance < bestDistance) { bestDistance = distance; tied = [model] }
    else if (distance === bestDistance) tied.push(model)
  }
  if (tied.length < 2 || !outcomes?.learnFromOutcomes) return tied[0]
  let best = tied[0]
  let bestScore = Number.NEGATIVE_INFINITY
  let found = false
  for (const model of tied) {
    const stats = outcomes.modelOutcomes?.[model]?.[outcomes.taskType]
    if (!stats || stats.runs < MIN_OUTCOME_RUNS) continue
    const score = outcomePoints(stats)
    if (!found || score > bestScore) { best = model; bestScore = score; found = true }
  }
  return best
}

// The score breakdown, kept as labelled parts so the UI can show exactly why a
// provider won. The sum is the score the router actually sorts on.
function scoreFactors(task: ProxyTask, provider: RoutableProvider, learnFromOutcomes: boolean, baselines: EfficiencyBaselines, advisor?: { advice: RoutingAdvice; minConfidence: number }): RoutingFactor[] {
  const factors: RoutingFactor[] = [{ label: 'Configured priority', points: provider.priority }]
  const affinityPoints = affinity[task.type][provider.kind] ?? 0
  if (affinityPoints) factors.push({ label: `${task.type} affinity`, points: affinityPoints })

  const isLocal = provider.kind === 'ollama' || provider.kind === 'codex-oss'
  const modePoints = task.mode === 'saver' ? (isLocal ? 55 : -12) : task.mode === 'quality' ? (isLocal ? -20 : 18) : isLocal ? 10 : 0
  if (modePoints) factors.push({ label: `${MODE_LABEL[task.mode]} policy`, points: modePoints })
  if (task.preferredProviderId === provider.id) factors.push({ label: 'Chosen by you', points: 1_000 })
  // Only this agent can serve the model the user picked; others would have to
  // fall back to their own, so try it first while still allowing failover.
  if (task.modelOverrideProviderId === provider.id) factors.push({ label: 'Runs the model you picked', points: 60 })

  const used = trackedTokens(provider.runtime)
  const utilization = provider.dailyTokenBudget ? used / provider.dailyTokenBudget : provider.runtime.usage.tasks / 20
  const usagePenalty = Math.min(25, utilization * 20)
  if (usagePenalty) factors.push({ label: 'Spreading usage across subscriptions', points: -usagePenalty })
  if (provider.runtime.running) factors.push({ label: 'Currently busy', points: -provider.runtime.running * 30 })
  if (learnFromOutcomes) {
    // When advice picks a specific model for this provider, its own outcomes
    // (if any) replace the provider-wide figure rather than stacking with it
    // — one learned signal per provider, just a more specific one when there
    // is enough to go on.
    const pickedModel = advisor ? pickModel(provider, provider.runtime.models ?? [], advisor.advice, task.mode, { taskType: task.type, modelOutcomes: provider.runtime.modelOutcomes, learnFromOutcomes }) : undefined
    const outcome = (pickedModel && modelOutcomeFactor(provider.runtime.modelOutcomes?.[pickedModel]?.[task.type], task.type, pickedModel))
      ?? outcomeFactor(provider.runtime.outcomes?.[task.type], task.type)
    if (outcome) factors.push(outcome)
    factors.push(...efficiencyFactors(provider.runtime, baselines))
  }
  if (advisor) factors.push(...advisorFactors(task, provider, advisor.advice, advisor.minConfidence))
  return factors
}

function total(factors: RoutingFactor[]): number {
  return factors.reduce((sum, factor) => sum + factor.points, 0)
}

// One pass produces both the ranking the engine acts on and the explanation the
// UI shows, so a routing receipt can never drift from the real decision.
export interface RoutingOptions {
  now?: number
  learnFromOutcomes?: boolean
  advisorMode?: AdvisorMode
  advisorMinConfidence?: number
}

function rank(
  task: ProxyTask,
  preflight: Array<{ provider: RoutableProvider; reason: string | undefined }>,
  learnFromOutcomes: boolean,
  baselines: EfficiencyBaselines,
  advisor?: { advice: RoutingAdvice; minConfidence: number }
): Array<{ provider: RoutableProvider; factors: RoutingFactor[]; score: number }> {
  return preflight
    .flatMap(({ provider, reason }) => {
      if (reason) return []
      const factors = scoreFactors(task, provider, learnFromOutcomes, baselines, advisor)
      return [{ provider, factors, score: total(factors) }]
    })
    .sort((left, right) => right.score - left.score || left.provider.runtime.usage.tasks - right.provider.runtime.usage.tasks)
}

export function routeTask(task: ProxyTask, providers: RoutableProvider[], options: RoutingOptions = {}): { ranked: RoutableProvider[]; decision: RoutingDecision } {
  const now = options.now ?? Date.now()
  const advisorMode = options.advisorMode ?? 'off'
  const minConfidence = options.advisorMinConfidence ?? 0.5
  // Gate: an advisor factor is only ever scored when the mode is active AND
  // this task's advice actually came from Jev (never the heuristic fallback,
  // which carries no complexity/target signal worth trusting for this).
  const activeAdvice = advisorMode === 'active' && task.advice?.source === 'jev' ? task.advice : undefined
  const shadowAdvice = advisorMode === 'shadow' && task.advice?.source === 'jev' ? task.advice : undefined

  const preflight = providers.map((provider) => ({ provider, reason: skipReason(task, provider, now) }))
  const eligible = preflight.filter((item) => !item.reason).map((item) => item.provider)
  const learnFromOutcomes = options.learnFromOutcomes !== false
  const baselines = learnFromOutcomes ? efficiencyBaselines(eligible.map((provider) => provider.runtime)) : {}

  const ranked = rank(task, preflight, learnFromOutcomes, baselines, activeAdvice ? { advice: activeAdvice, minConfidence } : undefined)

  const candidates: RoutingCandidate[] = [
    ...ranked.map(({ provider, score, factors }) => ({ providerId: provider.id, providerName: provider.name, eligible: true, score, factors })),
    ...preflight.filter(({ reason }) => reason)
      .map(({ provider, reason }) => ({ providerId: provider.id, providerName: provider.name, eligible: false, skippedReason: reason }))
  ]

  let advisor: RoutingDecision['advisor']
  if (advisorMode !== 'off') {
    advisor = { mode: advisorMode, applied: Boolean(activeAdvice) }
    if (shadowAdvice) {
      // Shadow mode never changes `ranked`/`chosenProviderId` above — this is a
      // second, throwaway ranking purely for the "what would Jev have chosen"
      // comparison shown in the UI.
      const shadowRanked = rank(task, preflight, learnFromOutcomes, baselines, { advice: shadowAdvice, minConfidence })
      const winner = shadowRanked[0]
      if (winner) {
        advisor.wouldChooseProviderId = winner.provider.id
        advisor.wouldChooseModel = pickModel(winner.provider, winner.provider.runtime.models ?? [], shadowAdvice, task.mode, { taskType: task.type, modelOutcomes: winner.provider.runtime.modelOutcomes, learnFromOutcomes })
        advisor.note = winner.provider.id === ranked[0]?.provider.id ? 'Agrees with the current route.' : 'Would route differently.'
      } else {
        advisor.note = 'No eligible provider even with advice applied.'
      }
    } else if (!task.advice) {
      advisor.note = 'No advice yet.'
    } else if (task.advice.source === 'heuristic') {
      // A missing key and a genuine Jev failure read very differently to the
      // user: the first has an obvious fix (add a key), the second doesn't.
      advisor.note = task.advice.error ? `Jev unavailable: ${task.advice.error}` : 'No Jev key stored; using the heuristic.'
    } else {
      // source === 'jev' here in active mode — shadow+jev is handled by the
      // branch above. A low-confidence answer still carries `source: 'jev'`
      // (only task_type itself falls back to the heuristic below threshold),
      // so say so explicitly rather than implying nothing was asked.
      const complexityConfident = (task.advice.complexityConfidence ?? 0) >= minConfidence
      const targetConfident = (task.advice.target?.confidence ?? 0) >= minConfidence
      if (!complexityConfident && !targetConfident) advisor.note = 'Jev was not confident enough to change this route.'
    }
  }

  return {
    ranked: ranked.map(({ provider }) => provider),
    decision: { at: new Date(now).toISOString(), taskType: task.type, mode: task.mode, chosenProviderId: ranked[0]?.provider.id, candidates, advisor }
  }
}

export function rankProviders(task: ProxyTask, providers: RoutableProvider[], options: RoutingOptions = {}): RoutableProvider[] {
  return routeTask(task, providers, options).ranked
}
