import { describe, expect, it } from 'vitest'
import { buildPlannerPrompt, buildSynthesisPrompt, parsePlan } from '../src/main/orchestrate'
import type { SubTask } from '../src/shared/types'

describe('orchestration planning', () => {
  it('parses a plain JSON array of subtasks', () => {
    const plan = parsePlan('[{"title":"A","prompt":"do a","type":"coding"},{"title":"B","prompt":"do b","type":"review"}]')
    expect(plan).toHaveLength(2)
    expect(plan[0]).toEqual({ title: 'A', prompt: 'do a', type: 'coding' })
    expect(plan[1].type).toBe('review')
  })

  it('extracts JSON from a fenced code block wrapped in prose', () => {
    const text = 'Sure! Here is the plan:\n```json\n[{"title":"X","prompt":"build x"}]\n```\nHope that helps.'
    const plan = parsePlan(text)
    expect(plan).toHaveLength(1)
    expect(plan[0].prompt).toBe('build x')
    expect(plan[0].type).toBe('general') // defaulted
  })

  it('drops entries without a prompt and defaults an invalid type', () => {
    const plan = parsePlan('[{"title":"no prompt"},{"prompt":"keep","type":"nonsense"}]')
    expect(plan).toHaveLength(1)
    expect(plan[0]).toEqual({ title: 'keep', prompt: 'keep', type: 'general' })
  })

  it('returns an empty plan when there is no JSON', () => {
    expect(parsePlan('I could not create a plan.')).toEqual([])
  })

  it('builds a planner prompt that requests JSON only', () => {
    expect(buildPlannerPrompt('Refactor auth')).toContain('JSON array')
    expect(buildPlannerPrompt('Refactor auth')).toContain('Refactor auth')
  })

  it('builds a synthesis prompt including each subtask result', () => {
    const subtasks: SubTask[] = [
      { id: '1', title: 'Frontend', prompt: '', type: 'coding', status: 'completed', output: 'did frontend' },
      { id: '2', title: 'Backend', prompt: '', type: 'coding', status: 'failed', output: '', error: 'timeout' }
    ]
    const prompt = buildSynthesisPrompt('Build the app', subtasks)
    expect(prompt).toContain('ORIGINAL GOAL:')
    expect(prompt).toContain('Build the app')
    expect(prompt).toContain('## Frontend')
    expect(prompt).toContain('did frontend')
    expect(prompt).toContain('did not complete: timeout')
  })

  // Observed live: the synthesizer is a full agent with file tools running in the
  // task cwd. Seeing the subtasks' files "missing" (they are committed on their
  // worktree branches), it redid all of the work in the main tree — defeating the
  // isolation and paying for the work twice.
  it('tells the synthesizer not to touch files and names the committed branches', () => {
    const subtasks: SubTask[] = [
      { id: '1', title: 'Docs', prompt: '', type: 'documentation', status: 'completed', output: 'wrote docs', branch: 'frontier/abc/1-docs', committed: true },
      { id: '2', title: 'Tests', prompt: '', type: 'coding', status: 'completed', output: 'wrote tests', branch: 'frontier/abc/2-tests', committed: false }
    ]
    const prompt = buildSynthesisPrompt('Improve the repo', subtasks)
    expect(prompt).toContain('Do NOT create, edit, or delete any file')
    expect(prompt).toContain('isolated git worktree')
    expect(prompt).toContain('## Docs (committed to branch `frontier/abc/1-docs`)')
    // Only branches that actually carry a commit are offered for merging.
    expect(prompt).toContain('- frontier/abc/1-docs — Docs')
    expect(prompt).not.toContain('- frontier/abc/2-tests — Tests')
  })
})
