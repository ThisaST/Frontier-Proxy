import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OrchestrationEngine } from '../src/main/engine'
import { JsonStore } from '../src/main/store'
import { freshDefaults } from '../src/shared/defaults'
import type { ProviderConfig, ProxyTask } from '../src/shared/types'

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
})
