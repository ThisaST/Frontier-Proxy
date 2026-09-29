// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { AdvisorPreviewResult, ProxyTask } from '../src/shared/types'
import {
  benchPreviewText, queueGroups, routePreview, routePreviewText, taskGroup, taskMatchesQuery, taskNeedsReview,
  taskStatusIndicator, taskStatusTone, taskStatusWord
} from '../src/renderer/src/task-helpers'

function task(id: string, overrides: Partial<ProxyTask> = {}): ProxyTask {
  return {
    id, prompt: `Task ${id}`, cwd: '/repo', mode: 'balanced', type: 'coding', status: 'completed', createdAt: '2026-09-30T10:00:00Z',
    output: '', attempts: [], estimatedInputTokens: 0, estimatedOutputTokens: 0, ...overrides
  }
}

const NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' }
const agentName = (id?: string): string => (id ? NAMES[id] ?? id : 'Routing…')

describe('queueGroups: the work queue\'s status groups', () => {
  const tasks = [
    task('queued', { status: 'queued' }),
    task('running', { status: 'running', selectedProviderId: 'claude' }),
    task('edited', { filesChanged: [{ path: 'a.ts', action: 'edit', at: '2026-09-30T10:01:00Z' }], selectedProviderId: 'codex' }),
    task('branch', { orchestrated: true, subtasks: [{ id: 's', title: 's', prompt: 's', type: 'coding', status: 'completed', output: '', branch: 'frontier/x/1-s', committed: true }] }),
    task('uncommitted', { bench: true, subtasks: [{ id: 's', title: 's', prompt: 's', type: 'coding', status: 'completed', output: '', branch: 'frontier/x/bench-a', committed: false }] }),
    task('answered', { prompt: 'Explain the retry policy', type: 'review' }),
    task('failed', { status: 'failed' }),
    task('cancelled', { status: 'cancelled' })
  ]

  it('returns every group, in display order, with the tasks in their original order', () => {
    const groups = queueGroups(tasks, '')
    expect(groups.map((group) => group.id)).toEqual(['running', 'needs-review', 'done', 'failed'])
    expect(groups.map((group) => group.label)).toEqual(['Running', 'Needs review', 'Done', 'Failed'])
    expect(groups.map((group) => group.tasks.map((item) => item.id))).toEqual([
      ['queued', 'running'], ['edited', 'branch'], ['uncommitted', 'answered'], ['failed', 'cancelled']
    ])
  })

  it('"Needs review" is completed work that left files or a committed branch behind', () => {
    expect(taskNeedsReview(tasks[2])).toBe(true)
    expect(taskNeedsReview(tasks[3])).toBe(true)
    expect(taskNeedsReview(tasks[4])).toBe(false) // a branch with nothing committed is not waiting
    expect(taskNeedsReview(task('x', { status: 'failed', filesChanged: [{ path: 'a', action: 'create', at: '' }] }))).toBe(false)
    expect(taskGroup(tasks[0])).toBe('running')
  })

  it('filters by a case-insensitive query over prompt, type, policy, status and agent name', () => {
    const ids = (query: string): string[] => queueGroups(tasks, query, agentName).flatMap((group) => group.tasks.map((item) => item.id))
    expect(ids('RETRY')).toEqual(['answered'])
    expect(ids('review')).toEqual(['answered'])
    expect(ids('codex')).toEqual(['edited'])
    expect(ids('claude code')).toEqual(['running'])
    expect(ids('cancelled')).toEqual(['cancelled'])
    expect(ids('   ')).toHaveLength(tasks.length)
    expect(ids('nothing like this')).toEqual([])
  })

  it('keeps empty groups so callers can count, and never mutates its input', () => {
    const groups = queueGroups([task('only', { status: 'running' })], '')
    expect(groups.map((group) => group.tasks.length)).toEqual([1, 0, 0, 0])
    const input = [...tasks]
    queueGroups(input, 'codex', agentName)
    expect(input).toEqual(tasks)
  })

  it('matches the agent name only through the resolver it is given', () => {
    expect(taskMatchesQuery(tasks[1], 'claude')).toBe(true) // default resolver: the raw provider id
    expect(taskMatchesQuery(tasks[1], 'claude code')).toBe(false)
    expect(taskMatchesQuery(tasks[1], 'claude code', agentName)).toBe(true)
  })
})

function preview(overrides: Partial<AdvisorPreviewResult> = {}, error?: string): AdvisorPreviewResult {
  return {
    request: { state: {}, model: 'jev-1.13.0', questions: {} },
    heuristic: { source: 'heuristic', at: '2026-09-30T10:00:00Z', taskType: 'coding', heuristicTaskType: 'coding', error },
    decision: { at: '2026-09-30T10:00:00Z', taskType: 'coding', mode: 'balanced', chosenProviderId: 'claude', candidates: [] },
    ...overrides
  }
}
const claude = { name: 'Claude Code', kind: 'claude' as const, model: 'claude-sonnet-4-5' }

describe('routePreviewText: the composer\'s one-line route preview', () => {
  it('names the agent, the model and its tier', () => {
    expect(routePreviewText(preview({ model: 'claude-opus-4-1' }), claude)).toMatch(/^Will run on Claude Code · claude-opus-4-1 · \w+ tier$/)
  })

  it('falls back to the provider\'s own model, then to "default model"', () => {
    expect(routePreviewText(preview(), claude)).toContain('· claude-sonnet-4-5 ·')
    expect(routePreviewText(preview(), { name: 'Custom', kind: 'custom', model: undefined })).toBe('Will run on Custom · default model · standard tier')
  })

  it('an Ollama-backed agent reads as the local tier', () => {
    expect(routePreviewText(preview({ model: 'qwen2.5-coder:7b' }), { name: 'Ollama', kind: 'ollama', model: undefined })).toBe('Will run on Ollama · qwen2.5-coder:7b · local tier')
  })

  it('split & delegate plans on the chosen agent', () => {
    expect(routePreviewText(preview(), claude, { runMode: 'orchestrate' })).toMatch(/^Will plan on Claude Code/)
  })

  it('says when Jev decides at start, and passes the heuristic\'s error through', () => {
    expect(routePreviewText(preview(), claude, { advisorDecidesAtStart: true })).toMatch(/ — Jev decides at start$/)
    expect(routePreviewText(preview({}, 'Jev timed out'), claude, { advisorDecidesAtStart: true })).toMatch(/ — Jev decides at start\. Jev timed out$/)
  })

  it('with no eligible agent it says so rather than naming one', () => {
    expect(routePreviewText(preview(), undefined)).toBe('No agent is currently eligible to run this.')
    expect(routePreview(preview(), undefined)).toBeUndefined()
  })

  it('exposes the same content as parts, so the view can emphasise the agent', () => {
    expect(routePreview(preview({ model: 'claude-opus-4-1' }), claude, { advisorDecidesAtStart: true })).toMatchObject({ lead: 'Will run on', agent: 'Claude Code', model: 'claude-opus-4-1', notes: ['Jev decides at start'] })
  })

  it('compare mode is not routed: it names the ticked agents, or asks for two', () => {
    expect(benchPreviewText([])).toBe('Choose at least two agents to compare.')
    expect(benchPreviewText(['Codex'])).toBe('Choose at least two agents to compare.')
    expect(benchPreviewText(['Claude Code', 'Codex'])).toBe('Will send the same prompt to Claude Code, Codex, each on its own branch, with no failover.')
  })
})

describe('taskStatusIndicator: a dot and a word', () => {
  it('maps each status to a kit tone, and completed work waiting for review to warn', () => {
    expect(taskStatusTone('running')).toBe('running')
    expect(taskStatusTone('queued')).toBe('neutral')
    expect(taskStatusTone('completed')).toBe('ok')
    expect(taskStatusTone('completed', true)).toBe('warn')
    expect(taskStatusTone('failed')).toBe('danger')
    expect(taskStatusTone('cancelled')).toBe('neutral')
    expect(taskStatusWord('completed', true)).toBe('Needs review')
    expect(taskStatusWord('queued')).toBe('Queued')
  })

  it('is a dot only by default, named for assistive tech', () => {
    const node = taskStatusIndicator('failed')
    expect(node.className).toBe('status danger')
    expect(node.textContent).toBe('')
    expect(node.getAttribute('role')).toBe('img')
    expect(node.getAttribute('aria-label')).toBe('Failed')
  })

  it('carries its word when asked (the conversation header)', () => {
    const node = taskStatusIndicator('completed', { needsReview: true, withText: true })
    expect(node.className).toBe('status warn')
    expect(node.textContent).toBe('Needs review')
    expect(node.hasAttribute('role')).toBe(false)
  })
})
