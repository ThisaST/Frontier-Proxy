import { describe, expect, it } from 'vitest'
import { SETTINGS_TABS, VIEWS, isSettingsTab, nextTaskSurface, resolveView, type TaskSurface } from '../src/renderer/src/nav'

describe('resolveView (ui-plan §5): every old id still lands somewhere', () => {
  it.each([
    ['home', { view: 'tasks', compose: true }],
    ['tasks', { view: 'tasks' }],
    ['workspace', { view: 'workspace' }],
    ['review', { view: 'review' }],
    ['agents', { view: 'agents' }],
    ['settings', { view: 'settings' }],
    ['routing', { view: 'settings', tab: 'routing' }],
    ['control', { view: 'settings', tab: 'control' }],
    ['skills', { view: 'settings', tab: 'skills' }]
  ])('old id %s', (id, expected) => expect(resolveView(id)).toEqual(expected))

  it.each([
    ['general', { view: 'settings', tab: 'general' }],
    ['appearance', { view: 'settings', tab: 'appearance' }],
    ['verification', { view: 'settings', tab: 'verification' }]
  ])('new Settings tab id %s', (id, expected) => expect(resolveView(id)).toEqual(expected))

  it('resolves every view to itself, with no tab (Settings keeps its remembered one)', () => {
    for (const view of VIEWS) expect(resolveView(view)).toEqual({ view })
  })

  it('resolves every Settings tab into Settings', () => {
    for (const tab of SETTINGS_TABS) expect(resolveView(tab)).toEqual({ view: 'settings', tab })
  })

  it.each(['', 'workspaces', 'Tasks', 'usage', 'context', 'settings/routing', 'constructor', '__proto__', 'toString'])('unknown id %j', (id) => {
    expect(resolveView(id)).toBeUndefined()
  })

  it('the dock carries exactly the five sections; home is not one of them since P4', () => {
    expect(VIEWS).toEqual(['tasks', 'workspace', 'review', 'agents', 'settings'])
    expect((VIEWS as readonly string[]).includes('home')).toBe(false)
  })

  it('isSettingsTab', () => {
    expect(isSettingsTab('control')).toBe(true)
    expect(isSettingsTab('tasks')).toBe(false)
    expect(isSettingsTab(undefined)).toBe(false)
  })
})

describe('nextTaskSurface (ui-plan §10.1 row 1): the Tasks centre is the composer or one task, never neither', () => {
  const composing: TaskSurface = { composing: true }
  const onTask: TaskSurface = { composing: false, selectedTaskId: 't1' }

  it('selecting a task leaves compose', () => {
    expect(nextTaskSurface(composing, { kind: 'select', taskId: 't2' })).toEqual({ composing: false, selectedTaskId: 't2' })
    expect(nextTaskSurface(onTask, { kind: 'select', taskId: 't2' })).toEqual({ composing: false, selectedTaskId: 't2' })
  })

  it('entering compose clears the selection', () => {
    expect(nextTaskSurface(onTask, { kind: 'compose' })).toEqual({ composing: true })
    expect(nextTaskSurface(composing, { kind: 'compose' })).toEqual({ composing: true })
  })

  it('reconciling never auto-selects a task while composing, however many tasks exist', () => {
    expect(nextTaskSurface(composing, { kind: 'reconcile', taskIds: ['t1', 't2', 't3'] })).toEqual({ composing: true })
    expect(nextTaskSurface(composing, { kind: 'reconcile', taskIds: [] })).toEqual({ composing: true })
  })

  it('reconciling keeps a selection that is still in scope', () => {
    expect(nextTaskSurface(onTask, { kind: 'reconcile', taskIds: ['t0', 't1'] })).toBe(onTask)
  })

  it('a selection that left scope (cleared, deleted, other project) falls back to compose, not to another task', () => {
    expect(nextTaskSurface(onTask, { kind: 'reconcile', taskIds: ['t2', 't3'] })).toEqual({ composing: true })
    expect(nextTaskSurface(onTask, { kind: 'reconcile', taskIds: [] })).toEqual({ composing: true })
    expect(nextTaskSurface({ composing: false }, { kind: 'reconcile', taskIds: ['t1'] })).toEqual({ composing: true })
  })
})
