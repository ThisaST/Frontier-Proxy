import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { freshDefaults } from '../shared/defaults'
import type { AppSettings, ProxyTask } from '../shared/types'

interface PersistedState {
  settings: AppSettings
  tasks: ProxyTask[]
}

export class JsonStore {
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
          : task)
      }
    } catch {
      return { settings: freshDefaults(), tasks: [] }
    }
  }

  async save(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(temporaryPath, JSON.stringify(state, null, 2), 'utf8')
    await rename(temporaryPath, this.filePath)
  }
}
