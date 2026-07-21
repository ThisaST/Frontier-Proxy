import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { classifyTask, estimateTokens } from '../shared/classify'
import type {
  AppSettings, AppSnapshot, CreateTaskInput, ProviderConfig, ProviderPatch, ProviderRuntime, ProxyTask, StreamEvent, TaskAttempt
} from '../shared/types'
import { checkProvider, runProvider } from './providers'
import { rankProviders } from './router'
import { JsonStore } from './store'

function today(): string {
  return new Date().toLocaleDateString('en-CA')
}

function blankRuntime(): ProviderRuntime {
  return {
    available: false,
    running: 0,
    usage: { date: today(), tasks: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0, elapsedMs: 0 }
  }
}

export class OrchestrationEngine extends EventEmitter {
  private settings!: AppSettings
  private tasks: ProxyTask[] = []
  private readonly runtimes = new Map<string, ProviderRuntime>()
  private readonly controllers = new Map<string, AbortController>()
  private pumping = false

  constructor(private readonly store: JsonStore) { super() }

  async initialize(): Promise<void> {
    const state = await this.store.load()
    this.settings = state.settings
    this.tasks = state.tasks
    for (const provider of this.settings.providers) this.runtimes.set(provider.id, blankRuntime())
    await this.checkProviders()
  }

  snapshot(): AppSnapshot {
    this.rollUsageDays()
    return structuredClone({
      tasks: this.tasks,
      providers: this.settings.providers.map((provider) => ({ ...provider, runtime: this.runtimes.get(provider.id) ?? blankRuntime() })),
      settings: this.settings
    })
  }

  async createTask(input: CreateTaskInput): Promise<ProxyTask> {
    if (!input.prompt.trim()) throw new Error('A task prompt is required.')
    if (!input.cwd.trim()) throw new Error('A working directory is required.')
    try {
      const directory = await stat(input.cwd)
      if (!directory.isDirectory()) throw new Error('not a directory')
    } catch {
      throw new Error('The working directory does not exist or cannot be accessed.')
    }
    const task: ProxyTask = {
      id: randomUUID(),
      prompt: input.prompt.trim(),
      cwd: input.cwd,
      mode: input.mode,
      type: classifyTask(input.prompt),
      preferredProviderId: input.preferredProviderId || undefined,
      status: 'queued',
      createdAt: new Date().toISOString(),
      output: '',
      attempts: [],
      estimatedInputTokens: estimateTokens(input.prompt),
      estimatedOutputTokens: 0
    }
    this.tasks.unshift(task)
    await this.persistAndEmit()
    void this.pump()
    return structuredClone(task)
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = this.findTask(taskId)
    if (task.status === 'queued') {
      task.status = 'cancelled'
      task.finishedAt = new Date().toISOString()
      await this.persistAndEmit()
      return
    }
    this.controllers.get(taskId)?.abort()
  }

  async retryTask(taskId: string): Promise<ProxyTask> {
    const original = this.findTask(taskId)
    return await this.createTask({
      prompt: original.prompt,
      cwd: original.cwd,
      mode: original.mode,
      preferredProviderId: original.preferredProviderId
    })
  }

  async clearFinishedTasks(): Promise<void> {
    this.tasks = this.tasks.filter((task) => task.status === 'queued' || task.status === 'running')
    await this.persistAndEmit()
  }

  async checkProviders(): Promise<AppSnapshot> {
    await Promise.all(this.settings.providers.map(async (provider) => {
      const runtime = this.runtimes.get(provider.id) ?? blankRuntime()
      this.runtimes.set(provider.id, runtime)
      if (!provider.enabled) {
        runtime.available = false
        runtime.lastCheckedAt = new Date().toISOString()
        return
      }
      const health = await checkProvider(provider)
      runtime.available = health.available
      runtime.version = health.version
      runtime.lastCheckedAt = new Date().toISOString()
    }))
    this.emitSnapshot()
    void this.pump()
    return this.snapshot()
  }

  async updateProvider(patch: ProviderPatch): Promise<AppSnapshot> {
    const provider = this.settings.providers.find((item) => item.id === patch.id)
    if (!provider) throw new Error(`Unknown provider: ${patch.id}`)
    if (patch.changes.enabled && !(patch.changes.executable ?? provider.executable).trim()) throw new Error('An executable is required before enabling this provider.')
    Object.assign(provider, patch.changes)
    await this.persistAndEmit()
    await this.checkProviders()
    return this.snapshot()
  }

  async addCustomProvider(): Promise<AppSnapshot> {
    const provider: ProviderConfig = {
      id: `custom-${randomUUID()}`,
      name: 'Custom CLI',
      kind: 'custom',
      enabled: false,
      executable: '',
      priority: 50,
      maxConcurrent: 1,
      capabilities: ['coding', 'debugging', 'review', 'planning', 'documentation', 'general']
    }
    this.settings.providers.push(provider)
    this.runtimes.set(provider.id, blankRuntime())
    await this.persistAndEmit()
    return this.snapshot()
  }

  async removeProvider(providerId: string): Promise<AppSnapshot> {
    const provider = this.settings.providers.find((item) => item.id === providerId)
    if (!provider || provider.kind !== 'custom') throw new Error('Only custom providers can be removed.')
    if ((this.runtimes.get(providerId)?.running ?? 0) > 0) throw new Error('Wait for the provider task to finish before removing it.')
    this.settings.providers = this.settings.providers.filter((item) => item.id !== providerId)
    this.runtimes.delete(providerId)
    await this.persistAndEmit()
    return this.snapshot()
  }

  async updateSettings(changes: Partial<Pick<AppSettings, 'maxParallelTasks' | 'quotaCooldownMinutes'>>): Promise<AppSnapshot> {
    if (changes.maxParallelTasks !== undefined) this.settings.maxParallelTasks = Math.max(1, Math.min(8, changes.maxParallelTasks))
    if (changes.quotaCooldownMinutes !== undefined) this.settings.quotaCooldownMinutes = Math.max(1, Math.min(1_440, changes.quotaCooldownMinutes))
    await this.persistAndEmit()
    void this.pump()
    return this.snapshot()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.tasks.filter((task) => task.status === 'running').length < this.settings.maxParallelTasks) {
        const task = [...this.tasks].reverse().find((item) => item.status === 'queued')
        if (!task) break
        const ranked = rankProviders(task, this.snapshot().providers)
        if (!ranked.length) break
        void this.execute(task, ranked.map((provider) => provider.id))
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    } finally {
      this.pumping = false
    }
  }

  private async execute(task: ProxyTask, providerIds: string[]): Promise<void> {
    task.status = 'running'
    task.startedAt = new Date().toISOString()
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    await this.persistAndEmit()

    for (const providerId of providerIds) {
      const provider = this.settings.providers.find((item) => item.id === providerId)
      const runtime = this.runtimes.get(providerId)
      if (!provider || !runtime || controller.signal.aborted) break
      task.selectedProviderId = providerId
      runtime.running += 1
      const attempt: TaskAttempt = { providerId, startedAt: new Date().toISOString(), status: 'running' }
      task.attempts.push(attempt)
      const started = Date.now()
      this.emitSnapshot()

      const result = await runProvider(provider, {
        prompt: task.prompt,
        cwd: task.cwd,
        signal: controller.signal,
        onOutput: (text) => {
          task.output += text
          task.estimatedOutputTokens = estimateTokens(task.output)
          this.emit('stream', { taskId: task.id, kind: 'output', data: text } satisfies StreamEvent)
          this.emitSnapshot()
        }
      })

      runtime.running = Math.max(0, runtime.running - 1)
      runtime.usage.tasks += 1
      runtime.usage.elapsedMs += Date.now() - started
      runtime.usage.estimatedInputTokens += task.estimatedInputTokens
      runtime.usage.estimatedOutputTokens += estimateTokens(result.output)
      attempt.finishedAt = new Date().toISOString()

      if (result.ok) {
        attempt.status = 'completed'
        task.status = 'completed'
        task.finishedAt = new Date().toISOString()
        task.error = undefined
        break
      }

      attempt.status = result.failureKind === 'cancelled' ? 'cancelled' : 'failed'
      attempt.error = result.error
      if (result.failureKind === 'quota') {
        runtime.cooldownUntil = new Date(Date.now() + this.settings.quotaCooldownMinutes * 60_000).toISOString()
        runtime.cooldownReason = result.error
        task.output += `\n\n[${provider.name} reached a usage limit; routing to the next provider.]\n\n`
        continue
      }
      if (result.failureKind === 'unavailable') {
        runtime.available = false
        task.output += `\n\n[${provider.name} is unavailable; routing to the next provider.]\n\n`
        continue
      }
      task.status = result.failureKind === 'cancelled' ? 'cancelled' : 'failed'
      task.error = result.error
      task.finishedAt = new Date().toISOString()
      break
    }

    if (task.status === 'running') {
      task.status = controller.signal.aborted ? 'cancelled' : 'failed'
      task.error = controller.signal.aborted ? 'Task cancelled.' : 'No eligible provider could complete this task.'
      task.finishedAt = new Date().toISOString()
    }
    this.controllers.delete(task.id)
    await this.persistAndEmit()
    void this.pump()
  }

  private findTask(taskId: string): ProxyTask {
    const task = this.tasks.find((item) => item.id === taskId)
    if (!task) throw new Error(`Unknown task: ${taskId}`)
    return task
  }

  private rollUsageDays(): void {
    const current = today()
    for (const runtime of this.runtimes.values()) {
      if (runtime.usage.date !== current) runtime.usage = { date: current, tasks: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0, elapsedMs: 0 }
    }
  }

  private async persistAndEmit(): Promise<void> {
    await this.store.save({ settings: this.settings, tasks: this.tasks.slice(0, 200) })
    this.emitSnapshot()
  }

  private emitSnapshot(): void {
    this.emit('snapshot', this.snapshot())
  }
}
