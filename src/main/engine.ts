import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { classifyTask, estimateTokens } from '../shared/classify'
import type {
  ActivityEvent, AppSettings, AppSnapshot, ControlPlaneProfile, ConversationTurn, CreateTaskInput, ProviderConfig, ProviderPatch, ProviderRuntime, ProxyTask, StreamEvent, SubTask, TaskAttempt, UsageSample
} from '../shared/types'

// Tool names that mutate files, mapped to the change action to record.
const FILE_TOOL_ACTIONS: Record<string, 'create' | 'edit'> = {
  Write: 'create', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', 'str_replace_editor': 'edit'
}

function recordFileChange(task: ProxyTask, event: ActivityEvent): void {
  if (event.kind !== 'tool' || !event.detail) return
  const action = FILE_TOOL_ACTIONS[event.label]
  if (!action) return
  const path = event.detail
  const existing = (task.filesChanged ?? []).filter((change) => change.path !== path)
  task.filesChanged = [...existing, { path, action, at: event.at }].slice(-50)
}
import { buildProviderCommand, checkProvider, discoverModels, runProvider } from './providers'
import { rankProviders } from './router'
import { buildPlannerPrompt, buildSynthesisPrompt, parsePlan } from './orchestrate'
import { branchSlug, commitWorktree, createWorktree, isGitRepo, removeWorktree } from './worktree'
import { JsonStore } from './store'

function today(): string {
  return new Date().toLocaleDateString('en-CA')
}

function blankUsage(): ProviderRuntime['usage'] {
  return { date: today(), tasks: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, elapsedMs: 0 }
}

function blankRuntime(): ProviderRuntime {
  return { available: false, running: 0, usage: blankUsage() }
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
      modelOverride: input.model?.trim() || undefined,
      status: 'queued',
      createdAt: new Date().toISOString(),
      output: '',
      attempts: [],
      estimatedInputTokens: estimateTokens(input.prompt),
      estimatedOutputTokens: 0,
      activity: [],
      filesChanged: [],
      orchestrated: input.orchestrate || undefined,
      subtasks: input.orchestrate ? [] : undefined,
      turns: [{ id: randomUUID(), role: 'user', content: input.prompt.trim(), at: new Date().toISOString() }]
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
      runtime.models = await discoverModels(provider)
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

  async updateSettings(changes: Partial<Pick<AppSettings, 'maxParallelTasks' | 'quotaCooldownMinutes' | 'memory'>>): Promise<AppSnapshot> {
    if (changes.maxParallelTasks !== undefined) this.settings.maxParallelTasks = Math.max(1, Math.min(8, changes.maxParallelTasks))
    if (changes.quotaCooldownMinutes !== undefined) this.settings.quotaCooldownMinutes = Math.max(1, Math.min(1_440, changes.quotaCooldownMinutes))
    if (changes.memory !== undefined) this.settings.memory = changes.memory
    await this.persistAndEmit()
    void this.pump()
    return this.snapshot()
  }

  async updateControlPlane(profile: ControlPlaneProfile): Promise<AppSnapshot> {
    this.settings.controlPlane = {
      systemPrompt: profile.systemPrompt ?? '',
      addDirs: (profile.addDirs ?? []).map((dir) => dir.trim()).filter(Boolean),
      allowedTools: (profile.allowedTools ?? []).map((tool) => tool.trim()).filter(Boolean),
      disallowedTools: (profile.disallowedTools ?? []).map((tool) => tool.trim()).filter(Boolean),
      mcpServers: profile.mcpServers ?? [],
      strictMcp: Boolean(profile.strictMcp)
    }
    await this.persistAndEmit()
    return this.snapshot()
  }

  // The exact flags this provider would be launched with, for the UI preview.
  // Accepts an unsaved draft profile so the UI can preview edits live.
  previewControlPlane(providerId: string, profile?: ControlPlaneProfile): string[] {
    const provider = this.settings.providers.find((item) => item.id === providerId)
    if (!provider) throw new Error(`Unknown provider: ${providerId}`)
    return buildProviderCommand(provider, '<working directory>', '<task prompt>', profile ?? this.settings.controlPlane).args
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
        if (task.orchestrated) void this.orchestrate(task)
        else void this.execute(task, ranked.map((provider) => provider.id))
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
    this.startAssistantTurn(task)
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

      const result = await runProvider(this.withModel(provider, task.modelOverride), {
        prompt: this.promptWithMemory(task.prompt),
        cwd: task.cwd,
        signal: controller.signal,
        controlPlane: this.settings.controlPlane,
        onOutput: (text) => {
          task.output += text
          task.estimatedOutputTokens = estimateTokens(task.output)
          this.emit('stream', { taskId: task.id, kind: 'output', data: text } satisfies StreamEvent)
          this.emitSnapshot()
        },
        onModel: (model) => { task.model = model; this.emitSnapshot() },
        onActivity: (event) => {
          task.activity = [...(task.activity ?? []), event].slice(-100)
          recordFileChange(task, event)
          this.emitSnapshot()
        },
        onUsage: (usage) => { this.applyUsage(runtime, usage, task) },
        onSession: (session) => { runtime.session = session; this.emitSnapshot() },
        onSessionId: (sessionId) => { task.sessionId = sessionId; task.sessionProviderId = provider.id }
      })
      if (!task.model) task.model = result.model ?? provider.model

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
    this.finalizeAssistantTurn(task)
    this.controllers.delete(task.id)
    await this.persistAndEmit()
    void this.pump()
  }

  private startAssistantTurn(task: ProxyTask): ConversationTurn {
    const turn: ConversationTurn = { id: randomUUID(), role: 'assistant', content: '', status: 'running', at: new Date().toISOString() }
    task.turns = [...(task.turns ?? []), turn]
    return turn
  }

  private finalizeAssistantTurn(task: ProxyTask): void {
    const turn = [...(task.turns ?? [])].reverse().find((item) => item.role === 'assistant' && item.status === 'running')
    if (!turn) return
    turn.content = task.output
    turn.status = task.status === 'running' ? 'completed' : task.status
    turn.model = task.model
    turn.providerId = task.selectedProviderId
  }

  // Continue a finished task with a follow-up message — a real multi-turn
  // conversation. Resumes the CLI session in-context (Claude --resume) when the
  // owning provider is available; otherwise replays the transcript as context.
  async continueTask(taskId: string, message: string): Promise<ProxyTask> {
    const text = message.trim()
    if (!text) throw new Error('A follow-up message is required.')
    const task = this.findTask(taskId)
    if (task.status === 'running' || task.status === 'queued') throw new Error('Wait for the current turn to finish before continuing.')

    task.turns = [...(task.turns ?? []), { id: randomUUID(), role: 'user', content: text, at: new Date().toISOString() }]
    task.status = 'running'
    task.error = undefined
    task.finishedAt = undefined
    task.output = ''
    task.orchestrated = false
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    this.startAssistantTurn(task)
    await this.persistAndEmit()

    // Prefer resuming with the provider that owns the session.
    const sessionProvider = task.sessionId
      ? this.settings.providers.find((item) => item.id === task.sessionProviderId)
      : undefined
    const resumable = sessionProvider && (this.runtimes.get(sessionProvider.id)?.available ?? false)
    const provider = resumable ? sessionProvider! : this.pickProvider(task)
    if (!provider) { this.finishTask(task, 'failed', 'No eligible provider is available to continue.'); this.finalizeAssistantTurn(task); this.controllers.delete(task.id); await this.persistAndEmit(); return structuredClone(task) }

    task.selectedProviderId = provider.id
    const runtime = this.runtimes.get(provider.id)
    if (runtime) runtime.running += 1
    const started = Date.now()
    // When we can't resume the CLI session, replay the conversation as context.
    const prompt = resumable ? text : `${this.transcript(task)}\n\nContinue. New message:\n${text}`
    const result = await runProvider(this.withModel(provider, task.modelOverride), {
      prompt, cwd: task.cwd, signal: controller.signal, controlPlane: this.settings.controlPlane,
      resumeSessionId: resumable ? task.sessionId : undefined,
      onOutput: (chunk) => { task.output += chunk; task.estimatedOutputTokens = estimateTokens(task.output); this.emit('stream', { taskId: task.id, kind: 'output', data: chunk } satisfies StreamEvent); this.emitSnapshot() },
      onModel: (model) => { task.model = model; this.emitSnapshot() },
      onActivity: (event) => { task.activity = [...(task.activity ?? []), event].slice(-100); recordFileChange(task, event); this.emitSnapshot() },
      onUsage: (usage) => { if (runtime) this.applyUsage(runtime, usage, task) },
      onSession: (session) => { if (runtime) { runtime.session = session; this.emitSnapshot() } },
      onSessionId: (sessionId) => { task.sessionId = sessionId; task.sessionProviderId = provider.id }
    })
    if (runtime) {
      runtime.running = Math.max(0, runtime.running - 1)
      runtime.usage.tasks += 1
      runtime.usage.elapsedMs += Date.now() - started
      runtime.usage.estimatedInputTokens += estimateTokens(prompt)
      runtime.usage.estimatedOutputTokens += estimateTokens(result.output)
    }
    this.finishTask(task, controller.signal.aborted ? 'cancelled' : result.ok ? 'completed' : 'failed', result.ok ? undefined : result.error)
    this.finalizeAssistantTurn(task)
    this.controllers.delete(task.id)
    await this.persistAndEmit()
    void this.pump()
    return structuredClone(task)
  }

  private transcript(task: ProxyTask): string {
    return (task.turns ?? []).filter((turn) => turn.content.trim())
      .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`).join('\n\n')
  }

  // Planner-delegates orchestration: one provider decomposes the task, Frontier
  // dispatches the subtasks to best-fit providers in parallel, then a provider
  // synthesizes the results into the final answer.
  private async orchestrate(task: ProxyTask): Promise<void> {
    task.status = 'running'
    task.startedAt = new Date().toISOString()
    task.orchestrationStage = 'planning'
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    this.startAssistantTurn(task)
    await this.persistAndEmit()

    try {
      const planner = this.pickProvider(task)
      if (!planner) { this.finishTask(task, 'failed', 'No eligible provider is available to plan this task.'); return }
      task.selectedProviderId = planner.id
      const planResult = await this.runOne(planner, buildPlannerPrompt(this.promptWithMemory(task.prompt)), task, controller)
      if (controller.signal.aborted) { this.finishTask(task, 'cancelled', 'Task cancelled.'); return }

      let plan = parsePlan(planResult.output)
      if (!plan.length) plan = [{ title: task.prompt.slice(0, 48), prompt: task.prompt, type: task.type }]
      task.subtasks = plan.map((item) => ({ id: randomUUID(), title: item.title, prompt: item.prompt, type: item.type, status: 'queued', output: '' }))
      task.orchestrationStage = 'delegating'
      await this.persistAndEmit()

      await this.runSubtasks(task, controller)
      if (controller.signal.aborted) { this.finishTask(task, 'cancelled', 'Task cancelled.'); return }

      task.orchestrationStage = 'synthesizing'
      task.output = ''
      await this.persistAndEmit()
      const synthesizer = this.pickProvider(task) ?? planner
      task.selectedProviderId = synthesizer.id
      await this.runOne(synthesizer, buildSynthesisPrompt(task.prompt, task.subtasks), task, controller, (text) => {
        task.output += text
        task.estimatedOutputTokens = estimateTokens(task.output)
        this.emitSnapshot()
      })

      task.orchestrationStage = 'done'
      const allDone = task.subtasks.every((subtask) => subtask.status === 'completed')
      this.finishTask(task, controller.signal.aborted ? 'cancelled' : allDone ? 'completed' : 'failed', allDone ? undefined : 'One or more subtasks did not complete.')
    } catch (error) {
      this.finishTask(task, 'failed', error instanceof Error ? error.message : String(error))
    } finally {
      this.finalizeAssistantTurn(task)
      this.controllers.delete(task.id)
      await this.persistAndEmit()
      void this.pump()
    }
  }

  private async runSubtasks(task: ProxyTask, controller: AbortController): Promise<void> {
    const subtasks = task.subtasks ?? []
    // Isolate each subtask in its own git worktree so parallel agents editing
    // files can't collide. Falls back to the shared cwd when not a git repo.
    const worktrees = new Map<string, string>()
    const git = await isGitRepo(task.cwd)
    if (git) {
      for (let index = 0; index < subtasks.length; index += 1) {
        const subtask = subtasks[index]
        const branch = `frontier/${task.id.slice(0, 8)}/${index + 1}-${branchSlug(subtask.title)}`
        try { worktrees.set(subtask.id, await createWorktree(task.cwd, branch)); subtask.branch = branch }
        catch { /* keep shared cwd for this subtask */ }
      }
      this.emitSnapshot()
    }

    const queue = [...subtasks]
    const runNext = async (): Promise<void> => {
      const subtask = queue.shift()
      if (!subtask || controller.signal.aborted) return
      const ranked = rankProviders({ ...task, type: subtask.type, preferredProviderId: undefined, orchestrated: false }, this.snapshot().providers)
      const provider = this.settings.providers.find((item) => item.id === ranked[0]?.id)
      if (!provider) { subtask.status = 'failed'; subtask.error = 'No eligible provider.'; this.emitSnapshot(); return runNext() }
      subtask.status = 'running'; subtask.providerId = provider.id; this.emitSnapshot()
      const workdir = worktrees.get(subtask.id) ?? task.cwd
      try {
        const result = await this.runOne(provider, subtask.prompt, task, controller, (text) => { subtask.output += text; this.emitSnapshot() }, workdir)
        if (!subtask.output.trim()) subtask.output = result.output
        subtask.model = result.model
        subtask.status = controller.signal.aborted ? 'cancelled' : result.ok ? 'completed' : 'failed'
        if (!result.ok) subtask.error = result.error
        // Commit the subtask's changes onto its branch before the worktree is torn down.
        if (worktrees.has(subtask.id) && result.ok) subtask.committed = await commitWorktree(workdir, `Frontier subtask: ${subtask.title}`)
      } catch (error) {
        subtask.status = 'failed'; subtask.error = error instanceof Error ? error.message : String(error)
      }
      this.emitSnapshot()
      return runNext()
    }
    const lanes = Math.min(Math.max(1, this.settings.maxParallelTasks), queue.length)
    try {
      await Promise.all(Array.from({ length: lanes }, () => runNext()))
    } finally {
      for (const dir of worktrees.values()) await removeWorktree(task.cwd, dir)
    }
  }

  private async runOne(
    provider: ProviderConfig,
    prompt: string,
    task: ProxyTask,
    controller: AbortController,
    onText?: (text: string) => void,
    cwd?: string
  ): Promise<{ output: string; model?: string; ok: boolean; error?: string }> {
    const runtime = this.runtimes.get(provider.id)
    if (runtime) runtime.running += 1
    const started = Date.now()
    let output = ''
    const result = await runProvider(this.withModel(provider, task.modelOverride), {
      prompt, cwd: cwd ?? task.cwd, signal: controller.signal, controlPlane: this.settings.controlPlane,
      onOutput: (text) => { output += text; onText?.(text) },
      onModel: (model) => { if (!task.model) task.model = model; this.emitSnapshot() },
      onActivity: (event) => { task.activity = [...(task.activity ?? []), event].slice(-100); recordFileChange(task, event); this.emitSnapshot() },
      onUsage: (usage) => { if (runtime) this.applyUsage(runtime, usage, task) },
      onSession: (session) => { if (runtime) { runtime.session = session; this.emitSnapshot() } },
      onSessionId: (sessionId) => { task.sessionId = sessionId; task.sessionProviderId = provider.id }
    })
    if (runtime) {
      runtime.running = Math.max(0, runtime.running - 1)
      runtime.usage.tasks += 1
      runtime.usage.elapsedMs += Date.now() - started
      runtime.usage.estimatedInputTokens += estimateTokens(prompt)
      runtime.usage.estimatedOutputTokens += estimateTokens(result.output)
    }
    return { output: result.output || output, model: result.model, ok: result.ok, error: result.error }
  }

  private pickProvider(task: ProxyTask): ProviderConfig | undefined {
    const ranked = rankProviders({ ...task, orchestrated: false }, this.snapshot().providers)
    return this.settings.providers.find((item) => item.id === ranked[0]?.id)
  }

  private withModel(provider: ProviderConfig, model?: string): ProviderConfig {
    return model ? { ...provider, model } : provider
  }

  private applyUsage(runtime: ProviderRuntime, usage: UsageSample, task?: ProxyTask): void {
    runtime.usage.inputTokens += usage.inputTokens
    runtime.usage.outputTokens += usage.outputTokens
    runtime.usage.costUsd += usage.costUsd
    if (task) {
      if (usage.contextWindow) task.contextWindow = usage.contextWindow
      if (usage.contextTokens) task.contextTokens = usage.contextTokens
    }
    this.emitSnapshot()
  }

  // Prepend Frontier's persistent memory as context for a fresh task.
  private promptWithMemory(prompt: string): string {
    const memory = this.settings.memory?.trim()
    return memory ? `[Frontier memory — persistent context you should use]\n${memory}\n\n[Task]\n${prompt}` : prompt
  }

  private finishTask(task: ProxyTask, status: ProxyTask['status'], error?: string): void {
    task.status = status
    task.error = error
    task.finishedAt = new Date().toISOString()
  }

  private findTask(taskId: string): ProxyTask {
    const task = this.tasks.find((item) => item.id === taskId)
    if (!task) throw new Error(`Unknown task: ${taskId}`)
    return task
  }

  private rollUsageDays(): void {
    const current = today()
    for (const runtime of this.runtimes.values()) {
      if (runtime.usage.date !== current) runtime.usage = blankUsage()
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
