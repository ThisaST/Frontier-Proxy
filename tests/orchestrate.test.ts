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
})
