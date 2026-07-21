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
})
