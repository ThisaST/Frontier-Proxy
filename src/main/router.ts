import type { ProviderConfig, ProviderRuntime, ProxyTask, TaskType } from '../shared/types'

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

function isCoolingDown(runtime: ProviderRuntime, now: number): boolean {
  return Boolean(runtime.cooldownUntil && Date.parse(runtime.cooldownUntil) > now)
}

function sessionLimitReached(runtime: ProviderRuntime, now: number): boolean {
  if ((runtime.session?.utilizationPercent ?? 0) < 100) return false
  return !runtime.session?.resetsAt || Date.parse(runtime.session.resetsAt) > now
}

export function rankProviders(task: ProxyTask, providers: RoutableProvider[], now = Date.now()): RoutableProvider[] {
  return providers
    .filter((provider) => {
      if (!provider.enabled || !provider.runtime.available || isCoolingDown(provider.runtime, now)) return false
      if (!provider.capabilities.includes(task.type) || provider.runtime.running >= provider.maxConcurrent) return false
      if (sessionLimitReached(provider.runtime, now)) return false
      const actual = provider.runtime.usage.inputTokens + provider.runtime.usage.outputTokens
      const used = actual || provider.runtime.usage.estimatedInputTokens + provider.runtime.usage.estimatedOutputTokens
      return !provider.dailyTokenBudget || used + task.estimatedInputTokens <= provider.dailyTokenBudget
    })
    .map((provider) => {
      let score = provider.priority + (affinity[task.type][provider.kind] ?? 0)
      const isLocal = provider.kind === 'ollama' || provider.kind === 'codex-oss'
      if (task.mode === 'saver') score += isLocal ? 55 : -12
      if (task.mode === 'quality') score += isLocal ? -20 : 18
      if (task.mode === 'balanced') score += isLocal ? 10 : 0
      if (task.preferredProviderId === provider.id) score += 1_000

      // Prefer the less-used subscription when otherwise close, stretching both quota windows.
      const actual = provider.runtime.usage.inputTokens + provider.runtime.usage.outputTokens
      const used = actual || provider.runtime.usage.estimatedInputTokens + provider.runtime.usage.estimatedOutputTokens
      const utilization = provider.dailyTokenBudget ? used / provider.dailyTokenBudget : provider.runtime.usage.tasks / 20
      score -= Math.min(25, utilization * 20)
      score -= provider.runtime.running * 30
      return { provider, score }
    })
    .sort((a, b) => b.score - a.score || a.provider.runtime.usage.tasks - b.provider.runtime.usage.tasks)
    .map(({ provider }) => provider)
}
