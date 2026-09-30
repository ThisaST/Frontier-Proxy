import { describe, expect, it } from 'vitest'
import { advisorDisclosure } from '../src/renderer/src/advisor-disclosure'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import type { AdvisorMode, AppSettings } from '../src/shared/types'

const settings = (mode: AdvisorMode, shareRepoFacts = true): AppSettings => ({ ...DEFAULT_SETTINGS, advisor: { ...DEFAULT_SETTINGS.advisor, mode, shareRepoFacts } })
const LOCAL = { label: 'Local', tone: 'ok', sentence: 'Local process mode. Prompts stay between this app and your CLIs.' }

// ADR 0002 / CLAUDE.md "The sidebar privacy line must stay truthful" — now the header chip.
describe('advisorDisclosure', () => {
  it('is Local when the advisor is off', () => expect(advisorDisclosure(settings('off'), false)).toEqual(LOCAL))
  it('is Local when the advisor is off even with a key stored', () => expect(advisorDisclosure(settings('off'), true)).toEqual(LOCAL))
  it.each<AdvisorMode>(['shadow', 'active'])('is Local in %s mode with no key (nothing can be sent)', (mode) => {
    expect(advisorDisclosure(settings(mode), false)).toEqual(LOCAL)
  })

  it('names Jev and Shadow mode', () => {
    expect(advisorDisclosure(settings('shadow'), true)).toEqual({
      label: 'Jev · Shadow', tone: 'info',
      sentence: 'Routing advisor: Jev (Shadow). Prompt text, repo facts and split-run subtask prompts are sent to TypeSafe.'
    })
  })

  it('names Jev and Active mode, with repo facts', () => {
    expect(advisorDisclosure(settings('active', true), true)).toEqual({
      label: 'Jev · Active', tone: 'info',
      sentence: 'Routing advisor: Jev (Active). Prompt text, repo facts and split-run subtask prompts are sent to TypeSafe.'
    })
  })

  it('drops repo facts from the sentence when they are not shared', () => {
    expect(advisorDisclosure(settings('active', false), true).sentence).toBe('Routing advisor: Jev (Active). Prompt text and split-run subtask prompts are sent to TypeSafe.')
  })

  it('never says "local" while an advisor is on with a key, and always names the split-run subtask prompts', () => {
    for (const mode of ['shadow', 'active'] as const) {
      for (const share of [true, false]) {
        const { label, sentence } = advisorDisclosure(settings(mode, share), true)
        expect(`${label} ${sentence}`.toLowerCase()).not.toContain('local')
        expect(sentence).toContain('split-run subtask prompts')
        expect(sentence).toContain('TypeSafe')
      }
    }
  })
})
