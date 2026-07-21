import { describe, expect, it } from 'vitest'
import { classifyTask, estimateTokens } from '../src/shared/classify'

describe('task classification', () => {
  it.each([
    ['Fix the crash in the login handler', 'debugging'],
    ['Review this pull request for security issues', 'review'],
    ['Write a README and migration guide', 'documentation'],
    ['Design an architecture for the worker queue', 'planning'],
    ['Implement a React component with tests', 'coding'],
    ['Tell me what this project does', 'general']
  ] as const)('classifies %s as %s', (prompt, expected) => {
    expect(classifyTask(prompt)).toBe(expected)
  })

  it('uses a conservative character-based token estimate', () => {
    expect(estimateTokens('12345678')).toBe(2)
    expect(estimateTokens('')).toBe(1)
  })
})
