import { describe, expect, it } from 'vitest'
import { SETTINGS_TABS, VIEWS, isSettingsTab, resolveView } from '../src/renderer/src/nav'

describe('resolveView (ui-plan §5): every old id still lands somewhere', () => {
  it.each([
    ['home', { view: 'home' }],
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

  it('the dock carries exactly the five sections; home stays only until P4', () => {
    expect(VIEWS.filter((view) => view !== 'home')).toEqual(['tasks', 'workspace', 'review', 'agents', 'settings'])
  })

  it('isSettingsTab', () => {
    expect(isSettingsTab('control')).toBe(true)
    expect(isSettingsTab('tasks')).toBe(false)
    expect(isSettingsTab(undefined)).toBe(false)
  })
})
