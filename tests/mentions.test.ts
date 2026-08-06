import { describe, expect, it } from 'vitest'
import { handleFromName, isValidHandle, normalizeHandle, parseMentions } from '../src/shared/mentions'
import type { WorkspaceParticipant } from '../src/shared/types'

function participant(overrides: Partial<WorkspaceParticipant>): WorkspaceParticipant {
  return {
    id: overrides.id ?? overrides.handle ?? 'p',
    handle: 'p',
    name: 'P',
    kind: 'agent',
    role: 'Reviewer',
    capabilities: [],
    enabled: true,
    ...overrides
  }
}

const nova = participant({ id: 'p-nova', handle: 'nova' })
const doc = participant({ id: 'p-doc', handle: 'doc' })
const participants = [nova, doc]

describe('parseMentions', () => {
  it('resolves a single mention', () => {
    expect(parseMentions('hey @nova can you look at this', participants)).toEqual({ addressed: ['p-nova'], unknown: [] })
  })

  it('preserves first-occurrence order across distinct mentions', () => {
    expect(parseMentions('@doc then @nova then @doc again', participants).addressed).toEqual(['p-doc', 'p-nova'])
  })

  it('de-duplicates the same handle mentioned twice', () => {
    expect(parseMentions('@nova please, @nova urgent', participants).addressed).toEqual(['p-nova'])
  })

  it('collects an unknown handle separately', () => {
    expect(parseMentions('@ghost are you there', participants)).toEqual({ addressed: [], unknown: ['ghost'] })
  })

  it('does not match an email address', () => {
    expect(parseMentions('reach me at email@nova.com please', participants)).toEqual({ addressed: [], unknown: [] })
  })

  it('strips trailing punctuation from a handle', () => {
    expect(parseMentions('@nova, @nova. @nova?', participants).addressed).toEqual(['p-nova'])
  })

  it('ignores a mention inside a fenced code block', () => {
    const text = 'see below\n```\n@nova do not run this\n```\nthanks'
    expect(parseMentions(text, participants)).toEqual({ addressed: [], unknown: [] })
  })

  it('ignores a mention inside an inline code span', () => {
    expect(parseMentions('use `@nova` as an example handle', participants)).toEqual({ addressed: [], unknown: [] })
  })

  it('returns empty arrays for empty text', () => {
    expect(parseMentions('', participants)).toEqual({ addressed: [], unknown: [] })
  })

  it('returns empty arrays when there are no mentions at all', () => {
    expect(parseMentions('just a normal message with no addressing', participants)).toEqual({ addressed: [], unknown: [] })
  })

  it('matches case-insensitively', () => {
    expect(parseMentions('@NOVA can you check this', participants)).toEqual({ addressed: ['p-nova'], unknown: [] })
  })

  it('matches a mention at the start of a bracket or parenthesis', () => {
    expect(parseMentions('(@nova) [@doc]', participants).addressed).toEqual(['p-nova', 'p-doc'])
  })
})

describe('normalizeHandle', () => {
  it('lowercases and strips a leading @', () => {
    expect(normalizeHandle('@Nova')).toBe('nova')
    expect(normalizeHandle('  Nova ')).toBe('nova')
  })
})

describe('isValidHandle', () => {
  it('accepts a simple lowercase handle', () => {
    expect(isValidHandle('nova')).toBe(true)
    expect(isValidHandle('@Docs-2')).toBe(true)
  })

  it('rejects a handle that does not start with a letter or contains invalid characters', () => {
    expect(isValidHandle('2nova')).toBe(false)
    expect(isValidHandle('nova!')).toBe(false)
    expect(isValidHandle('')).toBe(false)
  })
})

describe('handleFromName', () => {
  it('slugifies a display name with spaces into a valid handle', () => {
    expect(handleFromName('GitHub Copilot')).toBe('github-copilot')
    expect(isValidHandle(handleFromName('GitHub Copilot'))).toBe(true)
  })
  it('keeps a name that is already handle-shaped', () => {
    expect(handleFromName('claude-code-opus-5')).toBe('claude-code-opus-5')
  })
  it('drops leading non-letters and trailing dashes', () => {
    expect(handleFromName('  42 Nova!  ')).toBe('nova')
  })
  it('returns empty for a name with no usable characters', () => {
    expect(handleFromName('!!!')).toBe('')
  })
  it('does not weaken isValidHandle — a raw name with a space is still rejected', () => {
    expect(isValidHandle('github copilot')).toBe(false)
  })
})
