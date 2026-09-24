import { describe, expect, it } from 'vitest'
import { outcomeFactor, pickModel, rankProviders, routeTask, type RoutableProvider } from '../src/main/router'
import type { ProviderKind, ProxyTask, RoutingAdvice, TaskType } from '../src/shared/types'

function provider(id: string, kind: ProviderKind, tasks = 0, available = true): RoutableProvider {
  return {
    id, name: id, kind, enabled: true, executable: id, priority: 80, maxConcurrent: 1,
    capabilities: ['coding', 'debugging', 'review', 'planning', 'documentation', 'general'],
    runtime: {
      available, running: 0,
      usage: { date: '2026-07-20', tasks, estimatedInputTokens: 0, estimatedOutputTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, elapsedMs: 0 }
    }
  }
}

function task(mode: ProxyTask['mode'], type: TaskType = 'coding'): ProxyTask {
  return {
    id: 'task', prompt: 'Implement a feature', cwd: '/tmp', mode, type, status: 'queued',
    createdAt: new Date().toISOString(), output: '', attempts: [], estimatedInputTokens: 10, estimatedOutputTokens: 0
  }
}

describe('provider routing', () => {
  it('prefers an agentic local provider in saver mode', () => {
    const ranked = rankProviders(task('saver'), [provider('codex', 'codex'), provider('local', 'codex-oss')])
    expect(ranked[0].id).toBe('local')
  })

  it('prefers frontier providers in quality mode', () => {
    const ranked = rankProviders(task('quality'), [provider('local', 'codex-oss'), provider('codex', 'codex')])
    expect(ranked[0].id).toBe('codex')
  })

  it('honors an available provider override', () => {
    const value = task('quality')
    value.preferredProviderId = 'claude'
    const ranked = rankProviders(value, [provider('codex', 'codex'), provider('claude', 'claude')])
    expect(ranked[0].id).toBe('claude')
  })

  it('excludes offline, cooling, busy, and over-budget providers', () => {
    const offline = provider('offline', 'codex', 0, false)
    const cooling = provider('cooling', 'claude'); cooling.runtime.cooldownUntil = new Date(Date.now() + 60_000).toISOString()
    const busy = provider('busy', 'codex'); busy.runtime.running = 1
    const budget = provider('budget', 'codex'); budget.dailyTokenBudget = 5
    expect(rankProviders(task('balanced'), [offline, cooling, busy, budget])).toEqual([])
  })

  it('uses reported tokens when enforcing a tracked usage limit', () => {
    const limited = provider('limited', 'claude')
    limited.dailyTokenBudget = 1_000
    limited.runtime.usage.inputTokens = 995
    expect(rankProviders(task('balanced'), [limited])).toEqual([])
  })

  it('skips a provider when any active CLI plan window is fully used', () => {
    const limited = provider('limited', 'claude')
    limited.runtime.sessions = [
      { limitType: 'five hour', utilizationPercent: 45, updatedAt: new Date().toISOString() },
      { limitType: 'seven day', utilizationPercent: 100, resetsAt: new Date(Date.now() + 60_000).toISOString(), updatedAt: new Date().toISOString() }
    ]
    expect(rankProviders(task('balanced'), [limited])).toEqual([])
  })

  it('allows a provider again after its fully used window has reset', () => {
    const providerAfterReset = provider('available', 'claude')
    providerAfterReset.runtime.sessions = [{ utilizationPercent: 100, resetsAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date().toISOString() }]
    expect(rankProviders(task('balanced'), [providerAfterReset])).toHaveLength(1)
  })

  it('skips a provider whose CLI rejects the window without giving a percentage', () => {
    const rejected = provider('rejected', 'claude')
    rejected.runtime.sessions = [{ limitType: '5-hour', status: 'rejected', resetsAt: new Date(Date.now() + 60_000).toISOString(), updatedAt: new Date().toISOString() }]
    expect(rankProviders(task('balanced'), [rejected])).toEqual([])
  })

  it('keeps routing to a provider whose overage — not its plan — is rejected', () => {
    const allowed = provider('allowed', 'claude')
    allowed.runtime.sessions = [{ limitType: '5-hour', status: 'allowed', overageStatus: 'rejected', resetsAt: new Date(Date.now() + 60_000).toISOString(), updatedAt: new Date().toISOString() }]
    expect(rankProviders(task('balanced'), [allowed])).toHaveLength(1)
  })

  it('spreads otherwise similar subscription usage', () => {
    const ranked = rankProviders(task('balanced', 'general'), [provider('used', 'codex', 20), provider('fresh', 'codex', 0)])
    expect(ranked[0].id).toBe('fresh')
  })
})

describe('routing explanation', () => {
  it('breaks the winning score into factors that sum to it', () => {
    const chosen = task('quality', 'review')
    const { ranked, decision } = routeTask(chosen, [provider('claude', 'claude'), provider('codex', 'codex')])
    const winner = decision.candidates.find((candidate) => candidate.providerId === ranked[0].id)!
    expect(decision.chosenProviderId).toBe('claude')
    expect(winner.eligible).toBe(true)
    expect(winner.factors?.reduce((sum, factor) => sum + factor.points, 0)).toBeCloseTo(winner.score!)
    expect(winner.factors).toEqual(expect.arrayContaining([
      { label: 'Configured priority', points: 80 },
      { label: 'review affinity', points: 18 },
      { label: 'Quality first policy', points: 18 }
    ]))
  })

  it('credits an explicit override to the user', () => {
    const chosen = task('balanced')
    chosen.preferredProviderId = 'claude'
    const { decision } = routeTask(chosen, [provider('claude', 'claude'), provider('codex', 'codex')])
    const winner = decision.candidates.find((candidate) => candidate.providerId === 'claude')!
    expect(winner.factors).toContainEqual({ label: 'Chosen by you', points: 1_000 })
  })

  it('records a plain-language reason for every skipped provider', () => {
    const offline = provider('offline', 'codex', 0, false)
    const cooling = provider('cooling', 'claude'); cooling.runtime.cooldownUntil = new Date(Date.now() + 60_000).toISOString()
    const busy = provider('busy', 'copilot'); busy.runtime.running = 1
    const narrow = provider('narrow', 'ollama'); narrow.capabilities = ['documentation']
    const off = provider('off', 'codex'); off.enabled = false

    const { ranked, decision } = routeTask(task('balanced', 'coding'), [offline, cooling, busy, narrow, off])
    expect(ranked).toEqual([])
    const reasons = Object.fromEntries(decision.candidates.map((candidate) => [candidate.providerId, candidate.skippedReason]))
    expect(reasons.offline).toBe('CLI not detected on this machine')
    expect(reasons.cooling).toBe('Cooling down after a usage limit')
    expect(reasons.busy).toBe('Already running 1 of 1 allowed tasks')
    expect(reasons.narrow).toBe('Not enabled for coding work')
    expect(reasons.off).toBe('Turned off in Providers')
    expect(decision.candidates.every((candidate) => candidate.eligible === false)).toBe(true)
  })

  it('lists eligible providers ahead of skipped ones, best first', () => {
    const offline = provider('offline', 'codex', 0, false)
    const { decision } = routeTask(task('saver'), [offline, provider('cloud', 'claude'), provider('local', 'codex-oss')])
    expect(decision.candidates.map((candidate) => candidate.providerId)).toEqual(['local', 'cloud', 'offline'])
  })
})

describe('model-aware routing', () => {
  it('tries the agent that can run the picked model first, without excluding others', () => {
    const value = task('balanced')
    value.modelOverride = 'claude-opus-5'
    value.modelOverrideProviderId = 'claude'
    const ranked = rankProviders(value, [provider('codex', 'codex'), provider('claude', 'claude')])
    expect(ranked.map((item) => item.id)).toEqual(['claude', 'codex'])
  })
})

// --- Outcome-aware routing ---
// The Review inbox already records the user's verdict on each agent's branch;
// these tests pin down how much that verdict is allowed to move the ranking.

function withOutcomes(id: string, outcomes: RoutableProvider['runtime']['outcomes']): RoutableProvider {
  const value = provider(id, 'claude')
  value.runtime.outcomes = outcomes
  return value
}

describe('outcome-aware routing', () => {
  it('says nothing until there are enough runs to mean anything', () => {
    expect(outcomeFactor({ runs: 2, completed: 2, merged: 2, discarded: 0, verified: 2, verifyFailed: 0 }, 'coding')).toBeUndefined()
    expect(outcomeFactor(undefined, 'coding')).toBeUndefined()
  })

  it('rewards an agent whose branches get merged and whose checks pass', () => {
    const factor = outcomeFactor({ runs: 8, completed: 8, merged: 6, discarded: 0, verified: 6, verifyFailed: 0 }, 'coding')
    expect(factor?.points).toBeGreaterThan(0)
    expect(factor?.label).toContain('8 runs')
  })

  it('penalizes an agent whose work keeps being thrown away', () => {
    const factor = outcomeFactor({ runs: 8, completed: 6, merged: 0, discarded: 6, verified: 1, verifyFailed: 5 }, 'coding')
    expect(factor?.points).toBeLessThan(0)
  })

  // A learned signal must never be able to overrule configured priority, a mode
  // policy, or an explicit pick — so it stays inside a fixed band.
  it('never exceeds the bounded band in either direction', () => {
    const best = outcomeFactor({ runs: 100, completed: 100, merged: 100, discarded: 0, verified: 100, verifyFailed: 0 }, 'coding')
    const worst = outcomeFactor({ runs: 100, completed: 0, merged: 0, discarded: 100, verified: 0, verifyFailed: 100 }, 'coding')
    expect(best?.points).toBeLessThanOrEqual(14)
    expect(worst?.points).toBeGreaterThanOrEqual(-14)
  })

  it('reorders two otherwise identical agents, and shows why on the decision', () => {
    const good = withOutcomes('trusted', { coding: { runs: 10, completed: 10, merged: 8, discarded: 0, verified: 8, verifyFailed: 0 } })
    const bad = withOutcomes('rejected', { coding: { runs: 10, completed: 8, merged: 0, discarded: 8, verified: 0, verifyFailed: 8 } })
    const { ranked, decision } = routeTask(task('balanced', 'coding'), [bad, good])
    expect(ranked[0].id).toBe('trusted')
    expect(decision.candidates.find((candidate) => candidate.providerId === 'trusted')?.factors?.some((factor) => factor.label.includes('outcomes'))).toBe(true)
  })

  it('scores exactly as before when outcome learning is turned off', () => {
    const good = withOutcomes('trusted', { coding: { runs: 10, completed: 10, merged: 8, discarded: 0, verified: 8, verifyFailed: 0 } })
    const plain = provider('plain', 'claude')
    const [withLearning] = routeTask(task('balanced', 'coding'), [good], { learnFromOutcomes: true }).decision.candidates
    const [without] = routeTask(task('balanced', 'coding'), [good], { learnFromOutcomes: false }).decision.candidates
    expect(withLearning.score).toBeGreaterThan(without.score!)
    expect(without.score).toBe(routeTask(task('balanced', 'coding'), [plain]).decision.candidates[0].score)
  })

  // Outcomes are recorded per task type: being good at review says nothing about
  // being good at debugging.
  it('only applies the outcomes recorded for the task type being routed', () => {
    const value = withOutcomes('claude', { review: { runs: 10, completed: 10, merged: 10, discarded: 0, verified: 10, verifyFailed: 0 } })
    const coding = routeTask(task('balanced', 'coding'), [value]).decision.candidates[0]
    expect(coding.factors?.some((factor) => factor.label.includes('outcomes'))).toBe(false)
  })
})

// --- Jev-advised routing ---
// Jev advises, the router decides: these factors only ever apply when the
// mode is active AND the task's advice actually came from Jev, and they stay
// inside a fixed band next to every other factor.

function jevAdvice(overrides: Partial<RoutingAdvice> = {}): RoutingAdvice {
  return { source: 'jev', at: new Date().toISOString(), taskType: 'coding', heuristicTaskType: 'coding', ...overrides }
}

function withModels(id: string, kind: ProviderKind, models: string[], model?: string): RoutableProvider {
  const value = provider(id, kind)
  value.runtime.models = models
  value.model = model
  return value
}

describe('Jev advisor routing', () => {
  it('scores identically to no-advice routing when the advisor is off', () => {
    const providers = [provider('claude', 'claude'), provider('codex', 'codex')]
    const value = task('balanced', 'coding')
    value.advice = jevAdvice({ complexity: 2.8, complexityConfidence: 0.9, target: { choice: 'claude::claude-opus-5', probabilities: { 'claude::claude-opus-5': 0.9 }, confidence: 0.9 } })
    const withoutAdviceAtAll = routeTask(task('balanced', 'coding'), providers)
    const withAdviceButOff = routeTask(value, providers, { advisorMode: 'off' })
    expect(withAdviceButOff.decision.candidates.map((c) => c.score)).toEqual(withoutAdviceAtAll.decision.candidates.map((c) => c.score))
    expect(withAdviceButOff.decision.advisor).toBeUndefined()
  })

  it('scores identically to no-advice routing in shadow mode — it never changes the real ranking', () => {
    const providers = [provider('claude', 'claude'), provider('codex', 'codex')]
    const value = task('balanced', 'coding')
    value.advice = jevAdvice({ complexity: 2.8, complexityConfidence: 0.9, target: { choice: 'claude::claude-opus-5', probabilities: { 'claude::claude-opus-5': 0.9 }, confidence: 0.9 } })
    const withoutAdvice = routeTask(task('balanced', 'coding'), providers, { advisorMode: 'shadow' })
    const shadow = routeTask(value, providers, { advisorMode: 'shadow' })
    expect(shadow.decision.candidates.map((c) => c.score)).toEqual(withoutAdvice.decision.candidates.map((c) => c.score))
    expect(shadow.decision.chosenProviderId).toBe(withoutAdvice.decision.chosenProviderId)
    expect(shadow.decision.advisor?.mode).toBe('shadow')
    expect(shadow.decision.advisor?.applied).toBe(false)
  })

  it('records what shadow mode would have chosen without changing the actual route', () => {
    const local = withModels('local', 'codex-oss', ['qwen3-coder'])
    const cloud = withModels('cloud', 'claude', ['claude-opus-5'])
    // A modest, non-advisor edge for "cloud" (priority, affinity) is enough to
    // win the real ranking. Jev's advice — a trivial task it is very sure
    // "local" is the right target for — outweighs that edge only in the
    // shadow calculation, never in `ranked` itself.
    cloud.priority = 95
    const value = task('balanced', 'coding')
    value.advice = jevAdvice({
      complexity: 0, complexityConfidence: 0.95,
      target: { choice: 'local::qwen3-coder', probabilities: { 'local::qwen3-coder': 0.95, 'cloud::claude-opus-5': 0.05 }, confidence: 0.95 }
    })
    const withoutAdvice = routeTask(task('balanced', 'coding'), [local, cloud])
    expect(withoutAdvice.ranked[0].id).toBe('cloud')

    const { ranked, decision } = routeTask(value, [local, cloud], { advisorMode: 'shadow' })
    expect(ranked[0].id).toBe('cloud')
    expect(decision.advisor?.wouldChooseProviderId).toBe('local')
    expect(decision.advisor?.note).toBe('Would route differently.')
  })

  it('never applies advisor factors when the task advice is only heuristic', () => {
    const providers = [provider('claude', 'claude'), provider('codex', 'codex')]
    const value = task('balanced', 'coding')
    value.advice = { source: 'heuristic', at: new Date().toISOString(), taskType: 'coding', heuristicTaskType: 'coding' }
    const { decision } = routeTask(value, providers, { advisorMode: 'active' })
    expect(decision.advisor?.applied).toBe(false)
    expect(decision.candidates.every((candidate) => !candidate.factors?.some((factor) => factor.label.startsWith('Jev')))).toBe(true)
  })

  it('gives a frontier-tier provider a tier-fit bonus for high complexity, and a local provider a penalty', () => {
    const frontierProvider = withModels('frontier', 'claude', ['claude-opus-5'])
    const localProvider = withModels('local', 'codex-oss', ['qwen3-coder'])
    const value = task('balanced', 'coding')
    value.advice = jevAdvice({ complexity: 2.8, complexityConfidence: 0.9 })
    const { decision } = routeTask(value, [frontierProvider, localProvider], { advisorMode: 'active' })
    const frontierFactor = decision.candidates.find((c) => c.providerId === 'frontier')?.factors?.find((f) => f.label.includes('tier'))
    const localFactor = decision.candidates.find((c) => c.providerId === 'local')?.factors?.find((f) => f.label.includes('tier'))
    expect(frontierFactor?.points).toBe(20)
    expect(localFactor?.points).toBeLessThan(frontierFactor!.points)
  })

  // Regression: tier fit must score a provider on the *closest* model it
  // owns, not its best one — otherwise Claude (which owns both opus and
  // haiku) would score zero on a trivial task just because it also has opus,
  // even though it would actually run haiku for it (pickModel's own rule).
  it('scores tier fit on the closest model a provider owns, not its best one', () => {
    const claude = withModels('claude', 'claude', ['claude-opus-5', 'claude-haiku-4-5'])
    const frontierOnly = withModels('frontier-only', 'codex', ['gpt-5'])
    const value = task('balanced', 'coding')
    value.advice = jevAdvice({ complexity: 0.3, complexityConfidence: 0.9 }) // desired tier: fast
    const { decision } = routeTask(value, [claude, frontierOnly], { advisorMode: 'active' })
    const claudeTier = decision.candidates.find((c) => c.providerId === 'claude')?.factors?.find((f) => f.label.includes('tier'))?.points ?? 0
    const frontierOnlyTier = decision.candidates.find((c) => c.providerId === 'frontier-only')?.factors?.find((f) => f.label.includes('tier'))?.points ?? 0
    expect(claudeTier).toBe(20)
    expect(frontierOnlyTier).toBeLessThan(20)
  })

  it('ignores the tier-fit signal when complexity confidence is below the threshold', () => {
    const frontierProvider = withModels('frontier', 'claude', ['claude-opus-5'])
    const value = task('balanced', 'coding')
    value.advice = jevAdvice({ complexity: 2.8, complexityConfidence: 0.2 })
    const { decision } = routeTask(value, [frontierProvider], { advisorMode: 'active', advisorMinConfidence: 0.5 })
    expect(decision.candidates[0].factors?.some((f) => f.label.includes('tier'))).toBe(false)
  })

  it('shifts the desired tier down for saver mode and up for quality mode', () => {
    const fastProvider = withModels('fast', 'claude', ['claude-haiku-4-5'])
    const standardProvider = withModels('standard', 'claude', ['claude-sonnet-5'])
    const frontierProvider = withModels('frontier', 'claude', ['claude-opus-5'])
    const advice = jevAdvice({ complexity: 1.0, complexityConfidence: 0.9 }) // desired tier is "standard" at complexity 1.0, balanced mode
    const providers = [fastProvider, standardProvider, frontierProvider]

    const tierPoints = (mode: ProxyTask['mode'], providerId: string): number => {
      const { decision } = routeTask({ ...task(mode, 'coding'), advice }, providers, { advisorMode: 'active' })
      // A tier that lands exactly on 0 net points is omitted from the factor
      // list (like every other zero-point factor in this router), so absence
      // here means "no signal", not "undefined".
      return decision.candidates.find((c) => c.providerId === providerId)?.factors?.find((f) => f.label.includes('tier'))?.points ?? 0
    }

    // Balanced wants "standard"; saver shifts the desire down to "fast";
    // quality shifts it up to "frontier".
    expect(tierPoints('balanced', 'standard')).toBe(20)
    expect(tierPoints('saver', 'fast')).toBe(20)
    expect(tierPoints('saver', 'frontier')).toBeLessThan(tierPoints('balanced', 'frontier'))
    expect(tierPoints('quality', 'frontier')).toBe(20)
    expect(tierPoints('quality', 'fast')).toBeLessThan(tierPoints('balanced', 'fast'))
  })

  it('sums target probability across a provider\'s own options into one bounded "best fit" factor', () => {
    const claude = withModels('claude', 'claude', ['claude-sonnet-5', 'claude-opus-5'])
    const codex = withModels('codex', 'codex', ['gpt-5-codex'])
    const value = task('balanced', 'coding')
    value.advice = jevAdvice({
      target: {
        choice: 'claude::claude-opus-5',
        probabilities: { 'claude::claude-sonnet-5': 0.3, 'claude::claude-opus-5': 0.5, 'codex::gpt-5-codex': 0.2 },
        confidence: 0.9
      }
    })
    const { decision } = routeTask(value, [claude, codex], { advisorMode: 'active' })
    const claudeFactor = decision.candidates.find((c) => c.providerId === 'claude')?.factors?.find((f) => f.label.includes('best fit'))
    const codexFactor = decision.candidates.find((c) => c.providerId === 'codex')?.factors?.find((f) => f.label.includes('best fit'))
    expect(claudeFactor?.points).toBeGreaterThan(0)
    expect(claudeFactor?.points).toBeGreaterThan(codexFactor?.points ?? 0)
    expect(claudeFactor?.points).toBeLessThanOrEqual(15)
  })

  it('gives a small read-only bonus to local providers only, when edits_files is low', () => {
    const local = withModels('local', 'ollama', ['qwen3-coder'])
    const cloud = withModels('cloud', 'claude', ['claude-sonnet-5'])
    const value = task('balanced', 'review')
    value.advice = jevAdvice({ editsFiles: 0.05 })
    const { decision } = routeTask(value, [local, cloud], { advisorMode: 'active' })
    expect(decision.candidates.find((c) => c.providerId === 'local')?.factors?.some((f) => f.label === 'Read-only task → local OK')).toBe(true)
    expect(decision.candidates.find((c) => c.providerId === 'cloud')?.factors?.some((f) => f.label === 'Read-only task → local OK')).toBe(false)
  })

  it('never gives the read-only bonus when edits_files is high', () => {
    const local = withModels('local', 'ollama', ['qwen3-coder'])
    const value = task('balanced', 'review')
    value.advice = jevAdvice({ editsFiles: 0.9 })
    const { decision } = routeTask(value, [local], { advisorMode: 'active' })
    expect(decision.candidates[0].factors?.some((f) => f.label.includes('Read-only'))).toBe(false)
  })

  it('never lets an advisor factor overrule an explicit pick', () => {
    const preferred = withModels('local', 'codex-oss', ['qwen3-coder'])
    const other = withModels('cloud', 'claude', ['claude-opus-5'])
    const value = task('balanced', 'coding')
    value.preferredProviderId = 'cloud'
    value.advice = jevAdvice({ complexity: 0.1, complexityConfidence: 0.99 }) // strongly favours the local/fast tier
    const { ranked } = routeTask(value, [preferred, other], { advisorMode: 'active' })
    expect(ranked[0].id).toBe('cloud')
  })

  it('leaves an ineligible provider ineligible regardless of advice', () => {
    const off = provider('off', 'codex'); off.enabled = false
    const value = task('balanced', 'coding')
    value.advice = jevAdvice({ complexity: 2.9, complexityConfidence: 0.99 })
    const { ranked, decision } = routeTask(value, [off], { advisorMode: 'active' })
    expect(ranked).toEqual([])
    expect(decision.candidates[0].eligible).toBe(false)
  })

  it('bounds the tier-fit factor within the documented band regardless of tier distance', () => {
    const local = withModels('local', 'codex-oss', ['qwen3-coder'])
    const value = task('balanced', 'coding')
    value.advice = jevAdvice({ complexity: 2.9, complexityConfidence: 0.99 }) // desires frontier, provider is local — max distance
    const { decision } = routeTask(value, [local], { advisorMode: 'active' })
    const tierFactor = decision.candidates[0].factors?.find((f) => f.label.includes('tier'))
    expect(Math.abs(tierFactor?.points ?? 0)).toBeLessThanOrEqual(20)
  })
})

describe('advisor route notes', () => {
  it('says no key is stored when the fallback advice carries no error', () => {
    const value = task('balanced', 'coding')
    value.advice = { source: 'heuristic', at: new Date().toISOString(), taskType: 'coding', heuristicTaskType: 'coding' }
    const { decision } = routeTask(value, [provider('claude', 'claude')], { advisorMode: 'active' })
    expect(decision.advisor?.note).toBe('No Jev key stored; using the heuristic.')
  })

  it('keeps the "Jev unavailable" wording when the fallback advice carries an error', () => {
    const value = task('balanced', 'coding')
    value.advice = { source: 'heuristic', at: new Date().toISOString(), taskType: 'coding', heuristicTaskType: 'coding', error: 'Jev rejected the API key.' }
    const { decision } = routeTask(value, [provider('claude', 'claude')], { advisorMode: 'active' })
    expect(decision.advisor?.note).toBe('Jev unavailable: Jev rejected the API key.')
  })

  it('says Jev was not confident enough when both complexity and target confidence are below the threshold', () => {
    const value = task('balanced', 'coding')
    value.advice = jevAdvice({
      complexity: 2.0, complexityConfidence: 0.2,
      target: { choice: 'claude::claude-sonnet-5', probabilities: { 'claude::claude-sonnet-5': 0.4 }, confidence: 0.2 }
    })
    const { decision } = routeTask(value, [provider('claude', 'claude')], { advisorMode: 'active', advisorMinConfidence: 0.5 })
    expect(decision.advisor?.note).toBe('Jev was not confident enough to change this route.')
  })

  it('gives no low-confidence note when either signal clears the threshold', () => {
    const value = task('balanced', 'coding')
    value.advice = jevAdvice({ complexity: 2.0, complexityConfidence: 0.9 })
    const { decision } = routeTask(value, [provider('claude', 'claude')], { advisorMode: 'active', advisorMinConfidence: 0.5 })
    expect(decision.advisor?.note).toBeUndefined()
  })
})

describe('pickModel', () => {
  it('returns undefined when there is no jev-sourced advice', () => {
    expect(pickModel({ id: 'claude', kind: 'claude', model: 'claude-sonnet-5' }, ['claude-opus-5', 'claude-sonnet-5'], undefined, 'balanced')).toBeUndefined()
    expect(pickModel({ id: 'claude', kind: 'claude', model: 'claude-sonnet-5' }, ['claude-opus-5'], { source: 'heuristic', at: '', taskType: 'coding', heuristicTaskType: 'coding' }, 'balanced')).toBeUndefined()
  })

  it('returns undefined when complexity is missing', () => {
    expect(pickModel({ id: 'claude', kind: 'claude', model: 'claude-sonnet-5' }, ['claude-opus-5'], jevAdvice(), 'balanced')).toBeUndefined()
  })

  it('picks the model on this provider whose tier is closest to the desired one', () => {
    const advice = jevAdvice({ complexity: 2.9, complexityConfidence: 0.9 })
    const picked = pickModel({ id: 'claude', kind: 'claude', model: 'claude-sonnet-5' }, ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'], advice, 'balanced')
    expect(picked).toBe('claude-opus-5')
  })

  it('never crosses providers — it only ever picks from the models it was given', () => {
    const advice = jevAdvice({ complexity: 2.9, complexityConfidence: 0.9 })
    // Only Codex models are offered even though the advice would want "frontier";
    // pickModel must not reach for a Claude id it was never given.
    const picked = pickModel({ id: 'codex', kind: 'codex', model: 'gpt-5-codex' }, ['gpt-5-codex', 'gpt-5-mini'], advice, 'balanced')
    expect(['gpt-5-codex', 'gpt-5-mini']).toContain(picked)
  })

  it('shifts its pick down for saver mode and up for quality mode', () => {
    const advice = jevAdvice({ complexity: 1.0, complexityConfidence: 0.9 })
    const models = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5']
    const saverPick = pickModel({ id: 'claude', kind: 'claude', model: 'claude-sonnet-5' }, models, advice, 'saver')
    const qualityPick = pickModel({ id: 'claude', kind: 'claude', model: 'claude-sonnet-5' }, models, advice, 'quality')
    expect(saverPick).toBe('claude-haiku-4-5')
    expect(qualityPick).toBe('claude-opus-5')
  })
})
