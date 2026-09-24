import { describe, expect, it } from 'vitest'
import { describeCandidate, profileFor, tierFor } from '../src/shared/model-profiles'

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
