import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
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

  // The engine saves from several concurrent paths at once. With a shared temp
  // filename these overlapped: one rename moved the file another was still
  // counting on, throwing ENOENT and losing that write.
  it('survives overlapping saves and keeps the last one intact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-store-race-'))
    const path = join(directory, 'state.json')
    const store = new JsonStore(path)
    const settings = freshDefaults()

    await Promise.all(Array.from({ length: 25 }, (_unused, index) =>
      store.save({ settings: { ...settings, maxParallelTasks: (index % 8) + 1 }, tasks: [] })))

    // Whatever landed last, the file must be complete and parseable — never a
    // partial write and never missing.
    const raw = await readFile(path, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect((await store.load()).settings.providers.length).toBeGreaterThan(0)
    // No temp files may be left behind.
    expect((await readdir(directory)).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  // The top-level-defaulting claim `activeRunProfile`/`initialize` lean on: a
  // state file written before skills existed must still load with a usable
  // SkillSettings rather than undefined.
  it('defaults settings.skills when loading a state file written before skills existed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-store-legacy-'))
    const path = join(directory, 'state.json')
    const legacy = freshDefaults() as unknown as Record<string, unknown>
    delete legacy.skills
    await writeFile(path, JSON.stringify({ settings: legacy, tasks: [] }), 'utf8')
    const store = new JsonStore(path)
    expect((await store.load()).settings.skills).toEqual({ disabledIds: [] })
  })

  it('defaults workspaces to [] when loading a state file written before workspaces existed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-store-legacy-ws-'))
    const path = join(directory, 'state.json')
    await writeFile(path, JSON.stringify({ settings: freshDefaults(), tasks: [] }), 'utf8')
    const store = new JsonStore(path)
    expect((await store.load()).workspaces).toEqual([])
  })

  it('marks a workspace turn that was running at shutdown as failed on load', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-store-ws-turn-'))
    const path = join(directory, 'state.json')
    const workspaces = [{
      id: 'ws-1', name: 'Repo chat', cwd: '/repo', createdAt: new Date().toISOString(), nextSeq: 2,
      participants: [],
      messages: [],
      turns: [{ id: 't-1', workspaceId: 'ws-1', messageId: 'm-1', participantId: 'p-1', providerId: 'claude', status: 'running' as const, output: '' }]
    }]
    await writeFile(path, JSON.stringify({ settings: freshDefaults(), tasks: [], workspaces }), 'utf8')
    const store = new JsonStore(path)
    const loaded = await store.load()
    expect(loaded.workspaces?.[0].turns[0].status).toBe('failed')
    expect(loaded.workspaces?.[0].turns[0].error).toMatch(/closed/i)
    expect(loaded.workspaces?.[0].turns[0].finishedAt).toBeTruthy()
  })

  it('round-trips a workspace with messages, turns, participants, and a branch unchanged', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-store-ws-roundtrip-'))
    const path = join(directory, 'state.json')
    const store = new JsonStore(path)
    const workspace = {
      id: 'ws-1', name: 'Payments Team', cwd: '/repo/payments', createdAt: new Date().toISOString(), nextSeq: 3,
      participants: [
        { id: 'p-human', handle: 'you', name: 'You', kind: 'human' as const, role: 'Local user', capabilities: [], enabled: true },
        { id: 'p-nova', handle: 'nova', name: 'Nova', kind: 'agent' as const, role: 'Backend reviewer', providerId: 'claude', model: 'claude-opus-5', capabilities: ['edit-files' as const], enabled: true }
      ],
      messages: [
        { id: 'm-1', seq: 1, author: 'human' as const, participantId: 'p-human', text: 'hey @nova look at this', createdAt: new Date().toISOString(), addressed: ['p-nova'] },
        { id: 'm-2', seq: 2, author: 'agent' as const, participantId: 'p-nova', text: 'on it', createdAt: new Date().toISOString(), addressed: [] }
      ],
      turns: [{
        id: 't-1', workspaceId: 'ws-1', messageId: 'm-1', participantId: 'p-nova', providerId: 'claude',
        status: 'completed' as const, output: 'on it', model: 'claude-opus-5', branch: 'frontier/ws-payments-team/1-nova', committed: true,
        filesChanged: [{ path: 'src/index.ts', action: 'edit' as const, at: new Date().toISOString() }],
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
      }]
    }
    await store.save({ settings: freshDefaults(), tasks: [], workspaces: [workspace] })
    const loaded = await store.load()
    expect(loaded.workspaces).toEqual([workspace])
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
