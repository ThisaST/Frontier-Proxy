import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { JsonStore } from '../src/main/store'
import { freshDefaults } from '../src/shared/defaults'

describe('persistent store', () => {
  it('writes valid state atomically and loads it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-store-'))
    const path = join(directory, 'state.json')
    const store = new JsonStore(path)
    const settings = freshDefaults()
    settings.maxParallelTasks = 3
    await store.save({ settings, tasks: [] })
    expect(JSON.parse(await readFile(path, 'utf8')).settings.maxParallelTasks).toBe(3)
    expect((await store.load()).settings.maxParallelTasks).toBe(3)
  })

  it('falls back to defaults for a missing file', async () => {
    const store = new JsonStore(join(tmpdir(), `missing-${Date.now()}`, 'state.json'))
    expect((await store.load()).settings.providers.map((provider) => provider.id)).toEqual(expect.arrayContaining(['codex', 'claude', 'copilot']))
  })

  it('persists daily usage and separate provider plan windows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-store-runtime-'))
    const store = new JsonStore(join(directory, 'state.json'))
    const settings = freshDefaults()
    const usage = { date: new Date().toLocaleDateString('en-CA'), tasks: 2, estimatedInputTokens: 0, estimatedOutputTokens: 0, inputTokens: 1200, outputTokens: 80, costUsd: 0.04, elapsedMs: 1000 }
    const sessions = [
      { limitType: 'five hour', utilizationPercent: 20, updatedAt: new Date().toISOString() },
      { limitType: 'seven day', utilizationPercent: 60, updatedAt: new Date().toISOString() }
    ]
    await store.save({ settings, tasks: [], providerRuntime: { claude: { usage, sessions } } })
    const loaded = await store.load()
    expect(loaded.providerRuntime?.claude.usage.inputTokens).toBe(1200)
    expect(loaded.providerRuntime?.claude.sessions).toHaveLength(2)
  })
})
