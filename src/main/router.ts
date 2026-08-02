import type { ProviderConfig, ProviderRuntime, ProxyTask, RoutingCandidate, RoutingDecision, RoutingFactor, TaskType } from '../shared/types'
import { activeSessions, sessionBlocked } from '../shared/sessions'

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

// The score breakdown, kept as labelled parts so the UI can show exactly why a
// provider won. The sum is the score the router actually sorts on.
function scoreFactors(task: ProxyTask, provider: RoutableProvider): RoutingFactor[] {
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
  return factors
}

function total(factors: RoutingFactor[]): number {
  return factors.reduce((sum, factor) => sum + factor.points, 0)
}

// One pass produces both the ranking the engine acts on and the explanation the
// UI shows, so a routing receipt can never drift from the real decision.
export function routeTask(task: ProxyTask, providers: RoutableProvider[], now = Date.now()): { ranked: RoutableProvider[]; decision: RoutingDecision } {
  const evaluated = providers.map((provider) => {
    const reason = skipReason(task, provider, now)
    const factors = reason ? undefined : scoreFactors(task, provider)
    return { provider, reason, factors, score: factors ? total(factors) : undefined }
  })
  const ranked = evaluated
    .filter((item): item is typeof item & { score: number } => item.score !== undefined)
    .sort((left, right) => right.score - left.score || left.provider.runtime.usage.tasks - right.provider.runtime.usage.tasks)

  const candidates: RoutingCandidate[] = [
    ...ranked.map(({ provider, score, factors }) => ({ providerId: provider.id, providerName: provider.name, eligible: true, score, factors })),
    ...evaluated.filter((item) => item.score === undefined)
      .map(({ provider, reason }) => ({ providerId: provider.id, providerName: provider.name, eligible: false, skippedReason: reason }))
  ]
  return {
    ranked: ranked.map(({ provider }) => provider),
    decision: { at: new Date(now).toISOString(), taskType: task.type, mode: task.mode, chosenProviderId: ranked[0]?.provider.id, candidates }
  }
}

export function rankProviders(task: ProxyTask, providers: RoutableProvider[], now = Date.now()): RoutableProvider[] {
  return routeTask(task, providers, now).ranked
}
