import { describe, expect, it } from 'vitest'
import { describeCandidate, desiredTier, isLocalModel, profileFor, tierFor } from '../src/shared/model-profiles'

describe('model tiers', () => {
  it('classifies known Claude ids by name', () => {
    expect(tierFor('claude-opus-5', 'claude')).toBe('frontier')
    expect(tierFor('claude-sonnet-5', 'claude')).toBe('standard')
    expect(tierFor('claude-haiku-4-5', 'claude')).toBe('fast')
  })

  it('classifies known GPT-5/codex/o-series ids', () => {
    expect(tierFor('gpt-5', 'codex')).toBe('frontier')
    expect(tierFor('gpt-5-codex', 'codex')).toBe('frontier')
    expect(tierFor('gpt-5-mini', 'copilot')).toBe('fast')
    expect(tierFor('o3', 'copilot')).toBe('standard')
  })

  it('treats any Ollama-backed model as local regardless of its name', () => {
    expect(tierFor('claude-opus-5', 'ollama')).toBe('local')
    expect(tierFor('gpt-5', 'codex-oss')).toBe('local')
    expect(tierFor('qwen2.5-coder', 'ollama')).toBe('local')
  })

  it('falls back to a regex guess for an unknown id', () => {
    expect(tierFor('claude-sonnet-4-5-20250514', 'claude')).toBe('standard')
    expect(tierFor('claude-opus-4-1-20250805', 'claude')).toBe('frontier')
    expect(tierFor('some-custom-haiku-variant', 'custom')).toBe('fast')
  })

  it('defaults an empty id to standard rather than throwing', () => {
    expect(tierFor(undefined, 'claude')).toBe('standard')
    expect(tierFor('', 'claude')).toBe('standard')
  })

  it('has a profile for every model providers.ts curates by default', () => {
    for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-4-5', 'gpt-5-codex', 'gpt-5', 'claude-sonnet-4.5', 'claude-sonnet-4', 'gpt-5-mini', 'o3']) {
      expect(profileFor(id), id).toBeDefined()
    }
  })
})

describe('OpenCode provider/model ids', () => {
  it('resolves a curated profile through the provider/ prefix', () => {
    expect(profileFor('anthropic/claude-sonnet-4-5')).toBe(profileFor('claude-sonnet-4-5'))
    expect(profileFor('openai/gpt-5-mini')).toBe(profileFor('gpt-5-mini'))
  })

  it('resolves a dotted version through the provider/ prefix against a dashed-only catalog entry', () => {
    expect(profileFor('anthropic/claude-opus-4.8')).toBe(profileFor('claude-opus-4-8'))
  })

  it('leaves an unprefixed id resolving exactly as before', () => {
    expect(profileFor('claude-sonnet-4-5')).toBeDefined()
    expect(tierFor('claude-sonnet-4-5', 'claude')).toBe('standard')
  })

  it('treats a local-runtime prefix as local regardless of the model name', () => {
    expect(isLocalModel('ollama/qwen3-coder', 'opencode')).toBe(true)
    expect(isLocalModel('lmstudio/qwen3-coder', 'opencode')).toBe(true)
    expect(isLocalModel('llama.cpp/qwen3-coder', 'opencode')).toBe(true)
    expect(isLocalModel('llamacpp/qwen3-coder', 'opencode')).toBe(true)
    expect(tierFor('ollama/qwen3-coder', 'opencode')).toBe('local')
  })

  it('leaves a non-local prefix classified by the model name', () => {
    expect(isLocalModel('anthropic/claude-sonnet-4-5', 'opencode')).toBe(false)
    expect(tierFor('anthropic/claude-sonnet-4-5', 'opencode')).toBe('standard')
    expect(tierFor('openai/gpt-5-mini', 'opencode')).toBe('fast')
  })

  it('still treats Ollama/Codex-OSS as local regardless of model id', () => {
    expect(isLocalModel('claude-opus-5', 'ollama')).toBe(true)
    expect(isLocalModel('gpt-5', 'codex-oss')).toBe(true)
    expect(isLocalModel(undefined, 'ollama')).toBe(true)
  })

  it('describes a local OpenCode model as a full agent, not a tool-less one', () => {
    const description = describeCandidate({ name: 'OpenCode', kind: 'opencode' }, 'ollama/qwen3-coder')
    expect(description).toContain('local tier')
    expect(description).not.toContain('no file-editing tools')
    expect(description).toContain('has file-editing tools')
  })
})

describe('desiredTier', () => {
  it('maps complexity to fast/standard/frontier under balanced mode', () => {
    expect(desiredTier(0, 'balanced')).toEqual({ tier: 'fast', frontierAlsoFits: false })
    expect(desiredTier(0.74, 'balanced')).toEqual({ tier: 'fast', frontierAlsoFits: false })
    expect(desiredTier(0.75, 'balanced')).toEqual({ tier: 'standard', frontierAlsoFits: false })
    expect(desiredTier(2.49, 'balanced').tier).toBe('standard')
    expect(desiredTier(2.5, 'balanced')).toEqual({ tier: 'frontier', frontierAlsoFits: false })
    expect(desiredTier(3, 'balanced')).toEqual({ tier: 'frontier', frontierAlsoFits: false })
  })

  it('marks the 1.75-2.5 band as also accepting frontier at full credit', () => {
    expect(desiredTier(1.0, 'balanced')).toEqual({ tier: 'standard', frontierAlsoFits: false })
    expect(desiredTier(1.75, 'balanced')).toEqual({ tier: 'standard', frontierAlsoFits: true })
    expect(desiredTier(2.4, 'balanced')).toEqual({ tier: 'standard', frontierAlsoFits: true })
  })

  it('shifts the desired tier down one step for saver and up one for quality', () => {
    // Balanced desires "standard" at complexity 1.0.
    expect(desiredTier(1.0, 'saver')).toEqual({ tier: 'fast', frontierAlsoFits: false })
    expect(desiredTier(1.0, 'quality')).toEqual({ tier: 'frontier', frontierAlsoFits: false })
    // A shift always drops the frontier-also-fits band, even from within it.
    expect(desiredTier(1.75, 'quality')).toEqual({ tier: 'frontier', frontierAlsoFits: false })
  })

  it('clamps the shift at the edges of the tier order', () => {
    expect(desiredTier(0, 'saver')).toEqual({ tier: 'local', frontierAlsoFits: false })
    expect(desiredTier(0, 'saver').tier).toBe('local') // already the lowest tier; saver cannot go lower
    expect(desiredTier(3, 'quality')).toEqual({ tier: 'frontier', frontierAlsoFits: false }) // already the highest; quality cannot go higher
  })
})

describe('describeCandidate', () => {
  it('is honest that an Ollama provider has no file tools', () => {
    const description = describeCandidate({ name: 'Ollama', kind: 'ollama' }, 'qwen2.5-coder')
    expect(description).toContain('no file-editing tools')
  })

  it('names the tier for a model outside the curated catalog', () => {
    const description = describeCandidate({ name: 'Custom CLI', kind: 'custom' }, 'some-unknown-model')
    expect(description).toContain('standard tier')
  })

  it('describes a cloud provider without the local caveat', () => {
    const description = describeCandidate({ name: 'Claude Code', kind: 'claude' }, 'claude-opus-5')
    expect(description).not.toContain('no file-editing tools')
    expect(description).toContain('frontier tier')
  })
})
