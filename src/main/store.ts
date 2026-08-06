import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { freshDefaults } from '../shared/defaults'
import type { AppSettings, ProviderRuntime, ProxyTask, Workspace } from '../shared/types'

export interface PersistedState {
  settings: AppSettings
  tasks: ProxyTask[]
  providerRuntime?: Record<string, Pick<ProviderRuntime, 'usage' | 'sessions' | 'session'>>
  // Optional so existing save() call sites (and pre-workspace state files) need no
  // change; load() always fills this in, so an existing frontier-state.json needs no
  // migration.
  workspaces?: Workspace[]
}

export class JsonStore {
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async load(): Promise<PersistedState> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<PersistedState>
      const defaults = freshDefaults()
      const savedProviders = raw.settings?.providers ?? []
      const providerMap = new Map(savedProviders.map((provider) => [provider.id, provider]))
      const providers = defaults.providers.map((provider) => ({ ...provider, ...providerMap.get(provider.id) }))
      for (const provider of savedProviders) if (!providers.some((item) => item.id === provider.id)) providers.push(provider)

      return {
        settings: { ...defaults, ...raw.settings, providers },
        tasks: (raw.tasks ?? []).map((task) => task.status === 'running'
          ? { ...task, status: 'failed', error: 'Frontier Proxy closed while this task was running.', finishedAt: new Date().toISOString() }
          : task),
        providerRuntime: raw.providerRuntime ?? {},
        // A turn still 'running' at shutdown mirrors the task rule above: it never
        // finished, so rerunning it silently would replay a partial reply.
        workspaces: (raw.workspaces ?? []).map((workspace) => ({
          ...workspace,
          turns: workspace.turns.map((turn) => turn.status === 'running'
            ? { ...turn, status: 'failed' as const, error: 'Frontier Proxy closed while this turn was running.', finishedAt: new Date().toISOString() }
            : turn)
        }))
      }
    } catch {
      return { settings: freshDefaults(), tasks: [], providerRuntime: {}, workspaces: [] }
    }
  }

  // The engine persists from several concurrent paths (streaming callbacks,
  // task completion, settings edits). Sharing one temp filename let two writes
  // overlap, so the second rename could hit a file the first had already moved
  // — losing a write and throwing ENOENT. Saves are serialized, and each gets
  // its own temp file.
  async save(state: PersistedState): Promise<void> {
    const write = this.writing.then(() => this.writeState(state), () => this.writeState(state))
    this.writing = write.then(() => undefined, () => undefined)
    await write
  }

  private async writeState(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${randomUUID().slice(0, 8)}.tmp`
    try {
      await writeFile(temporaryPath, JSON.stringify(state, null, 2), 'utf8')
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
