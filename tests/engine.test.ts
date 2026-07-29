import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeSessionWindows, OrchestrationEngine } from '../src/main/engine'
import { JsonStore } from '../src/main/store'
import { freshDefaults } from '../src/shared/defaults'
import type { ProviderConfig, ProxyTask } from '../src/shared/types'

describe('provider session windows', () => {
  it('retains different limits and updates only the matching window', () => {
    const initial = [
      { limitType: 'five hour', utilizationPercent: 20, updatedAt: '2026-07-27T00:00:00.000Z' },
      { limitType: 'seven day', utilizationPercent: 60, updatedAt: '2026-07-27T00:00:00.000Z' }
    ]
    const merged = mergeSessionWindows(initial, { limitType: 'five hour', utilizationPercent: 25, updatedAt: '2026-07-27T01:00:00.000Z' })
    expect(merged).toHaveLength(2)
    expect(merged.find((window) => window.limitType === 'five hour')?.utilizationPercent).toBe(25)
    expect(merged.find((window) => window.limitType === 'seven day')?.utilizationPercent).toBe(60)
  })
})

function provider(id: string, priority: number, args: string[] = []): ProviderConfig {
  return {
    id, name: id === 'first' ? 'First Provider' : 'Second Provider', kind: 'custom', enabled: true,
    executable: process.execPath, args, priority, maxConcurrent: 1,
    capabilities: ['coding', 'debugging', 'review', 'planning', 'documentation', 'general']
  }
}

describe('conversation provider selection', () => {
  it('keeps an intentionally cancelled conversation on its current provider', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-engine-cancel-'))
    const store = new JsonStore(join(directory, 'state.json'))
    const settings = freshDefaults()
    settings.providers = [
      provider('first', 1, ['-e', 'process.stdin.pipe(process.stdout)']),
      provider('second', 100, ['-e', 'process.stdin.pipe(process.stdout)'])
    ]
    const task: ProxyTask = {
      id: 'cancelled-conversation', prompt: 'Initial question', cwd: directory, mode: 'balanced', type: 'general',
      status: 'cancelled', selectedProviderId: 'first', createdAt: new Date().toISOString(),
      output: 'Partial answer', attempts: [], estimatedInputTokens: 4, estimatedOutputTokens: 2,
      turns: [
        { id: 'user-1', role: 'user', content: 'Initial question', at: new Date().toISOString() },
        { id: 'assistant-1', role: 'assistant', content: 'Partial answer', providerId: 'first', status: 'cancelled', at: new Date().toISOString() }
      ]
    }
    await store.save({ settings, tasks: [task] })
    const engine = new OrchestrationEngine(store)
    await engine.initialize()

    const continued = await engine.continueTask(task.id, 'Continue here')
    expect(continued.status).toBe('completed')
    expect(continued.selectedProviderId).toBe('first')
    expect(continued.output).toContain('First Provider (cancelled): Partial answer')
  })

  it('switches only when requested and transfers the complete transcript', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-engine-'))
    const store = new JsonStore(join(directory, 'state.json'))
    const settings = freshDefaults()
    settings.providers = [
      provider('first', 100),
      provider('second', 10, ['-e', 'process.stdin.pipe(process.stdout)'])
    ]
    const task: ProxyTask = {
      id: 'conversation', prompt: 'Initial question', cwd: directory, mode: 'balanced', type: 'general',
      status: 'cancelled', selectedProviderId: 'first', createdAt: new Date().toISOString(),
      output: 'Earlier answer', attempts: [], estimatedInputTokens: 4, estimatedOutputTokens: 3,
      sessionId: 'first-session', sessionProviderId: 'first',
      turns: [
        { id: 'user-1', role: 'user', content: 'Initial question', at: new Date().toISOString() },
        { id: 'assistant-1', role: 'assistant', content: 'Earlier answer', providerId: 'first', model: 'model-one', status: 'cancelled', at: new Date().toISOString() }
      ]
    }
    await store.save({ settings, tasks: [task] })
    const engine = new OrchestrationEngine(store)
    await engine.initialize()

    const changed = await engine.changeTaskProvider(task.id, 'second')
    expect(changed.continuationProviderId).toBe('second')
    expect(changed.sessionId).toBeUndefined()
    expect(changed.selectedProviderId).toBe('first')

    const continued = await engine.continueTask(task.id, 'New question')
    expect(continued.status).toBe('completed')
    expect(continued.selectedProviderId).toBe('second')
    expect(continued.output).toContain('User: Initial question')
    expect(continued.output).toContain('First Provider (model-one, cancelled): Earlier answer')
    expect(continued.output).toContain('User: New question')
    expect(continued.output).toContain('Full conversation history transferred by Frontier')
  })

  it('persists @ references and includes their resolved workspace context', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-engine-context-'))
    await writeFile(join(directory, 'notes.md'), '# Notes', 'utf8')
    const store = new JsonStore(join(directory, 'state.json'))
    const settings = freshDefaults()
    settings.providers = [provider('first', 1, ['-e', 'process.stdin.pipe(process.stdout)'])]
    const task: ProxyTask = {
      id: 'referenced-conversation', prompt: 'Initial question', cwd: directory, mode: 'balanced', type: 'general',
      status: 'completed', selectedProviderId: 'first', createdAt: new Date().toISOString(), output: 'Done', attempts: [],
      estimatedInputTokens: 4, estimatedOutputTokens: 1,
      turns: [
        { id: 'user-1', role: 'user', content: 'Initial question', at: new Date().toISOString() },
        { id: 'assistant-1', role: 'assistant', content: 'Done', providerId: 'first', status: 'completed', at: new Date().toISOString() }
      ]
    }
    await store.save({ settings, tasks: [task] })
    const engine = new OrchestrationEngine(store)
    await engine.initialize()

    const continued = await engine.continueTask(task.id, 'Review @notes.md', [{ id: 'ref-1', kind: 'file', name: 'notes.md', path: 'notes.md' }])
    expect(continued.turns?.at(-2)?.attachments).toEqual([{ id: 'ref-1', kind: 'file', name: 'notes.md', path: 'notes.md' }])
    expect(continued.output).toContain('[Referenced workspace items]')
    expect(continued.output).toContain('file: @notes.md')
    expect(continued.output).toContain(join(directory, 'notes.md'))
  })
})
