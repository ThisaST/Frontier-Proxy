import type { ModelTier, ProviderKind, RoutingMode } from './types'

export interface ModelProfile {
  tier: ModelTier
  // What this model is good at, in a few words — feeds Jev's `target` question
  // and the Agents & models catalog.
  strengths: string
  description: string
}

// The one place that says what a model id is good at. Curated rather than
// derived: none of these CLIs expose a capability manifest, so this catalog is
// the closest thing Frontier has to one. Keep entries short — they are spliced
// into Jev's `target` choice criteria, which has a combined budget.
const PROFILES: Record<string, ModelProfile> = {
  // ---- Claude (KNOWN_MODELS.claude in providers.ts) ----
  'claude-opus-5': { tier: 'frontier', strengths: 'hardest problems, architecture, deep reasoning', description: "Anthropic's top-tier Claude model — slowest and most capable." },
  'claude-opus-4-8': { tier: 'frontier', strengths: 'hardest problems, architecture, deep reasoning', description: 'A previous-generation Claude frontier model.' },
  'claude-sonnet-5': { tier: 'standard', strengths: 'general coding, debugging, most day-to-day tasks', description: "Anthropic's balanced coding model — the usual default." },
  'claude-sonnet-4-5': { tier: 'standard', strengths: 'general coding, debugging, most day-to-day tasks', description: 'A previous-generation balanced Claude model.' },
  'claude-haiku-4-5': { tier: 'fast', strengths: 'quick, cheap edits and simple questions', description: "Anthropic's fastest Claude model — light tasks only." },

  // ---- GPT-5 / Codex / o-series (KNOWN_MODELS.codex, KNOWN_MODELS.copilot) ----
  'gpt-5': { tier: 'frontier', strengths: 'hardest problems, architecture, deep reasoning', description: "OpenAI's flagship reasoning model." },
  'gpt-5-codex': { tier: 'frontier', strengths: 'agentic coding, large multi-file changes', description: 'GPT-5 tuned for the Codex CLI\'s agentic coding workflow.' },
  'gpt-5-mini': { tier: 'fast', strengths: 'quick, cheap edits and simple questions', description: 'A smaller, faster GPT-5 variant.' },
  'o3': { tier: 'standard', strengths: 'general coding, debugging, most day-to-day tasks', description: "OpenAI's balanced reasoning model." },
  'o3-mini': { tier: 'fast', strengths: 'quick, cheap edits and simple questions', description: 'A faster, cheaper o-series model.' },
  'o4-mini': { tier: 'fast', strengths: 'quick, cheap edits and simple questions', description: 'A faster, cheaper o-series model.' },

  // ---- Copilot's own ids (KNOWN_MODELS.copilot) ----
  'claude-sonnet-4.5': { tier: 'standard', strengths: 'general coding, debugging, most day-to-day tasks', description: 'Claude Sonnet 4.5 as offered through Copilot.' },
  'claude-sonnet-4': { tier: 'standard', strengths: 'general coding, debugging, most day-to-day tasks', description: 'Claude Sonnet 4 as offered through Copilot.' },

  // ---- Common local coders pulled through Ollama / Codex+Ollama ----
  'qwen3-coder': { tier: 'local', strengths: 'local agentic coding, no cloud subscription', description: 'A coding-tuned local model, run through Ollama.' },
  'qwen2.5-coder': { tier: 'local', strengths: 'local coding help, no cloud subscription', description: 'A coding-tuned local model, run through Ollama.' },
  'deepseek-coder': { tier: 'local', strengths: 'local coding help, no cloud subscription', description: 'A coding-tuned local model, run through Ollama.' },
  'deepseek-coder-v2': { tier: 'local', strengths: 'local coding help, no cloud subscription', description: 'A coding-tuned local model, run through Ollama.' },
  'deepseek-r1': { tier: 'local', strengths: 'local reasoning, no cloud subscription', description: 'A reasoning-tuned local model, run through Ollama.' },
  codellama: { tier: 'local', strengths: 'local coding help, no cloud subscription', description: 'A coding-tuned local model, run through Ollama.' },
  'llama3.1': { tier: 'local', strengths: 'local general-purpose help, no cloud subscription', description: 'A general-purpose local model, run through Ollama.' },
  'llama3.2': { tier: 'local', strengths: 'local general-purpose help, no cloud subscription', description: 'A general-purpose local model, run through Ollama.' },
  llama3: { tier: 'local', strengths: 'local general-purpose help, no cloud subscription', description: 'A general-purpose local model, run through Ollama.' },
  mistral: { tier: 'local', strengths: 'local general-purpose help, no cloud subscription', description: 'A general-purpose local model, run through Ollama.' },
  mixtral: { tier: 'local', strengths: 'local general-purpose help, no cloud subscription', description: 'A general-purpose local model, run through Ollama.' },
  'starcoder2': { tier: 'local', strengths: 'local coding help, no cloud subscription', description: 'A coding-tuned local model, run through Ollama.' }
}

// Regex fallback for a model id this catalog does not know by name — a custom
// id, a dated snapshot ("claude-sonnet-4-5-20250514"), or a newly released
// model. Order matters: more specific patterns first.
const REGEX_TIERS: Array<[RegExp, ModelTier]> = [
  [/opus/i, 'frontier'],
  [/\bgpt-5-codex\b/i, 'frontier'],
  [/\bo3\b(?!-mini)/i, 'standard'],
  [/haiku/i, 'fast'],
  [/-mini\b/i, 'fast'],
  [/sonnet/i, 'standard'],
  [/\bgpt-5\b/i, 'frontier'],
  [/\bgpt-4/i, 'standard'],
  [/\bo4-mini\b/i, 'fast']
]

const LOCAL_KINDS: ProviderKind[] = ['ollama', 'codex-oss']

// OpenCode addresses every model as `<provider>/<model>` (`opencode models`'s
// only output form), including local inference runtimes it can drive the same
// way as a cloud one — `ollama/qwen3-coder`, `lmstudio/qwen3-coder`. A
// `provider/` segment naming one of these means the model runs locally
// regardless of what the model half looks like, same as an Ollama-backed
// provider kind. Exported so `src/main/router.ts` never re-derives the rule.
export const LOCAL_RUNTIME_PREFIXES: ReadonlySet<string> = new Set(['ollama', 'lmstudio', 'llama.cpp', 'llamacpp'])

// Tier order, low to high — shared by `desiredTier`'s own shift/band logic
// below and by `src/main/router.ts`'s tier-distance scoring, so the two can
// never disagree about which tier is "one up" or "one down".
export const TIER_ORDER: ModelTier[] = ['local', 'fast', 'standard', 'frontier']

export interface DesiredTier {
  tier: ModelTier
  // Between 1.75 and 2.5 complexity a "standard" desire also accepts
  // "frontier" at full credit — see `desiredTier` below.
  frontierAlsoFits: boolean
}

// The tier a task calls for, from Jev's complexity score (0-3), shifted by
// the routing mode. Pure and shared: `src/main/router.ts` scores providers
// against it, and the Routing screen / Route tab display the same tier a
// route would actually use, so the two can never drift apart.
export function desiredTier(complexity: number, mode: RoutingMode): DesiredTier {
  const base: ModelTier = complexity < 0.75 ? 'fast' : complexity < 2.5 ? 'standard' : 'frontier'
  const frontierAlsoFits = base === 'standard' && complexity >= 1.75
  const shift = mode === 'saver' ? -1 : mode === 'quality' ? 1 : 0
  if (!shift) return { tier: base, frontierAlsoFits }
  const shifted = TIER_ORDER[Math.max(0, Math.min(TIER_ORDER.length - 1, TIER_ORDER.indexOf(base) + shift))]
  return { tier: shifted, frontierAlsoFits: false }
}

// Every form of an id worth trying against the curated catalog: the id
// itself, the segment after OpenCode's `provider/` prefix (an id this catalog
// already knows, e.g. `claude-sonnet-4-5`, addressed as
// `anthropic/claude-sonnet-4-5`), and each of those with '.'/'-' swapped
// around a single version number — Copilot spells the same Claude model
// `claude-sonnet-4.5` where the base catalog spells it `claude-sonnet-4-5`,
// and OpenCode's provider catalog may use either. Order matters: the exact id
// is always tried first.
function profileLookupCandidates(id: string): string[] {
  const bases = id.includes('/') ? [id, id.slice(id.lastIndexOf('/') + 1)] : [id]
  const variants = new Set<string>()
  for (const base of bases) {
    variants.add(base)
    variants.add(base.replace(/(\d)-(\d)/, '$1.$2'))
    variants.add(base.replace(/(\d)\.(\d)/, '$1-$2'))
  }
  return [...variants]
}

export function profileFor(modelId: string): ModelProfile | undefined {
  const trimmed = modelId.trim()
  for (const candidate of profileLookupCandidates(trimmed)) {
    const hit = PROFILES[candidate]
    if (hit) return hit
  }
  return undefined
}

// Whether this model id, as this provider kind would run it, runs on the
// user's own machine. A provider's kind decides local-ness outright for
// Ollama (directly, or via Codex+Ollama) — there is no cloud tier to speak of.
// OpenCode instead names the runtime in the id itself (`ollama/qwen3-coder`),
// so a `provider/` prefix naming a local runtime is local too, whatever the
// model half looks like.
export function isLocalModel(modelId: string | undefined, providerKind?: ProviderKind): boolean {
  if (providerKind && LOCAL_KINDS.includes(providerKind)) return true
  const trimmed = modelId?.trim()
  const slash = trimmed?.indexOf('/') ?? -1
  if (!trimmed || slash <= 0) return false
  return LOCAL_RUNTIME_PREFIXES.has(trimmed.slice(0, slash).toLowerCase())
}

export function tierFor(modelId: string | undefined, providerKind?: ProviderKind): ModelTier {
  if (isLocalModel(modelId, providerKind)) return 'local'
  const trimmed = modelId?.trim()
  if (!trimmed) return 'standard'
  const known = profileFor(trimmed)
  if (known) return known.tier
  for (const [pattern, tier] of REGEX_TIERS) if (pattern.test(trimmed)) return tier
  return 'standard'
}

// Honest, one-line description for Jev's `target` choice and the Agents &
// models catalog. Deliberately names what the agent *can't* do too — an
// Ollama-backed provider has no file-editing tools, so the description says so
// rather than implying it can act like a full coding agent.
export function describeCandidate(provider: { name: string; kind: ProviderKind }, modelId: string): string {
  const profile = profileFor(modelId)
  const tier = tierFor(modelId, provider.kind)
  const toolNote = provider.kind === 'ollama'
    ? ' Runs locally through Ollama; no file-editing tools, review/planning/docs/general only.'
    : provider.kind === 'codex-oss'
      ? ' Runs locally through Codex + Ollama; has file-editing tools.'
      : provider.kind === 'opencode' && tier === 'local'
        ? ' Runs locally through OpenCode; has file-editing tools, same as any other OpenCode model.'
        : ''
  const summary = profile ? `Best for ${profile.strengths}.` : `A ${tier}-tier model.`
  return `${provider.name} running ${modelId} (${tier} tier). ${summary}${toolNote}`
}
