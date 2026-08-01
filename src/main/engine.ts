import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { classifyTask, estimateTokens } from '../shared/classify'
import type {
  ActivityEvent, AppSettings, AppSnapshot, BranchRepo, ChatContextItem, ContextSample, ControlPlaneProfile, ConversationTurn, CreateTaskInput, ProviderConfig, ProviderPatch, ProviderRuntime, ProxyTask, SessionInfo, StreamEvent, SubTask, TaskAttempt, TaskFileContent, TaskType, TaskWorkspaceSnapshot, UsageSample, WorkspaceEntry
} from '../shared/types'

// Tool names that mutate files, mapped to the change action to record.
const FILE_TOOL_ACTIONS: Record<string, 'create' | 'edit' | 'delete'> = {
  Write: 'create', Edit: 'edit', Delete: 'delete', MultiEdit: 'edit', NotebookEdit: 'edit', 'str_replace_editor': 'edit'
}

function recordFileChange(task: ProxyTask, event: ActivityEvent): void {
  if (event.kind !== 'tool' || !event.detail) return
  const action = FILE_TOOL_ACTIONS[event.label]
  if (!action) return
  const path = event.detail
  const existing = (task.filesChanged ?? []).filter((change) => change.path !== path)
  task.filesChanged = [...existing, { path, action, at: event.at }].slice(-50)
}
import { buildProviderCommand, checkProvider, discoverModels, resolveTaskModel, runProvider, type ModelOwner } from './providers'
import { hydrateExecutablePath } from './env'
import { rankProviders, routeTask } from './router'
import { buildPlannerPrompt, buildSynthesisPrompt, parsePlan } from './orchestrate'
import { branchSlug, commitWorktree, createWorktree, isGitRepo, removeWorktree } from './worktree'
import { branchFileDiff, deleteTaskBranch, listBranchInbox, mergeTaskBranch } from './branches'
import { JsonStore } from './store'
import { contextPrompt, listWorkspaceEntries, loadTaskFile, loadTaskWorkspace, validateChatContext } from './taskfiles'
import type { McpAuthManager } from './mcp-auth'

function today(): string {
  return new Date().toLocaleDateString('en-CA')
}

function blankUsage(): ProviderRuntime['usage'] {
  return { date: today(), tasks: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, elapsedMs: 0 }
}

function blankRuntime(): ProviderRuntime {
  return { available: false, running: 0, usage: blankUsage() }
}

export function mergeSessionWindows(windows: SessionInfo[], session: SessionInfo): SessionInfo[] {
  const key = session.limitType ?? 'reported'
  return [...windows.filter((item) => (item.limitType ?? 'reported') !== key), session]
    .sort((left, right) => (left.limitType ?? '').localeCompare(right.limitType ?? ''))
}

export class OrchestrationEngine extends EventEmitter {
  private settings!: AppSettings
  private tasks: ProxyTask[] = []
  private readonly runtimes = new Map<string, ProviderRuntime>()
  private readonly controllers = new Map<string, AbortController>()
  private pumping = false

  constructor(private readonly store: JsonStore, private readonly mcpAuth?: McpAuthManager) { super() }

  async initialize(): Promise<void> {
    const state = await this.store.load()
    this.settings = state.settings
    this.tasks = state.tasks
    await this.mcpAuth?.initialize()
    await this.mcpAuth?.reconcile(this.settings.controlPlane)
    for (const provider of this.settings.providers) {
      const runtime = blankRuntime()
      const persisted = state.providerRuntime?.[provider.id]
      if (persisted?.usage?.date === today()) runtime.usage = persisted.usage
      runtime.sessions = persisted?.sessions ?? (persisted?.session ? [persisted.session] : undefined)
      this.runtimes.set(provider.id, runtime)
    }
    await this.checkProviders()
  }

  snapshot(): AppSnapshot {
    this.rollUsageDays()
    return structuredClone({
      tasks: this.tasks,
      providers: this.settings.providers.map((provider) => ({ ...provider, runtime: this.runtimes.get(provider.id) ?? blankRuntime() })),
      settings: this.settings,
      mcpAuth: this.mcpAuth?.statuses(this.settings.controlPlane) ?? []
    })
  }

  async createTask(input: CreateTaskInput): Promise<ProxyTask> {
    if (!input.prompt.trim() && !input.attachments?.length) throw new Error('A task prompt or image is required.')
    if (!input.cwd.trim()) throw new Error('A working directory is required.')
    try {
      const directory = await stat(input.cwd)
      if (!directory.isDirectory()) throw new Error('not a directory')
    } catch {
      throw new Error('The working directory does not exist or cannot be accessed.')
    }
    const attachments = await validateChatContext(input.cwd, input.attachments)
    const prompt = input.prompt.trim() || 'Please inspect the attached image.'
    const benchIds = [...new Set(input.benchProviderIds ?? [])].filter((id) => this.settings.providers.some((provider) => provider.id === id))
    if (input.benchProviderIds?.length && benchIds.length < 2) throw new Error('Choose at least two installed agents to compare.')
    const task: ProxyTask = {
      id: randomUUID(),
      prompt,
      cwd: input.cwd,
      mode: input.mode,
      type: classifyTask(prompt),
      preferredProviderId: input.preferredProviderId || undefined,
      modelOverride: input.model?.trim() || undefined,
      modelOverrideProviderId: input.model?.trim() ? input.modelProviderId || input.preferredProviderId || undefined : undefined,
      status: 'queued',
      createdAt: new Date().toISOString(),
      output: '',
      attempts: [],
      estimatedInputTokens: estimateTokens(prompt),
      estimatedOutputTokens: 0,
      activity: [],
      filesChanged: [],
      orchestrated: input.orchestrate && !benchIds.length ? true : undefined,
      bench: benchIds.length ? true : undefined,
      subtasks: benchIds.length
        ? benchIds.map((providerId) => ({
          id: randomUUID(),
          title: this.settings.providers.find((provider) => provider.id === providerId)?.name ?? providerId,
          prompt, type: classifyTask(prompt), status: 'queued' as const, output: '', providerId
        }))
        : input.orchestrate ? [] : undefined,
      turns: [{ id: randomUUID(), role: 'user', content: prompt, attachments: attachments.length ? attachments : undefined, at: new Date().toISOString() }]
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
      task.error = 'Task cancelled by user.'
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
      preferredProviderId: original.continuationProviderId ?? original.preferredProviderId,
      attachments: original.turns?.find((turn) => turn.role === 'user')?.attachments
    })
  }

  async changeTaskProvider(taskId: string, providerId: string): Promise<ProxyTask> {
    const task = this.findTask(taskId)
    if (task.status === 'running' || task.status === 'queued') throw new Error('Wait for the task to stop before changing its provider.')
    const provider = this.snapshot().providers.find((item) => item.id === providerId)
    if (!provider) throw new Error(`Unknown provider: ${providerId}`)
    // Ignore unrelated tasks currently occupying the provider: this selection
    // controls a future turn. Availability, capability, cooldown, and usage
    // limits still have to be valid at selection time.
    const selectable = rankProviders(
      { ...task, preferredProviderId: providerId, orchestrated: false },
      [{ ...provider, runtime: { ...provider.runtime, running: 0 } }]
    ).length > 0
    if (!selectable) throw new Error(`${provider.name} is not currently available for this task.`)

    task.continuationProviderId = providerId
    if (task.sessionProviderId !== providerId) {
      task.sessionId = undefined
      task.sessionProviderId = undefined
    }
    const event: ActivityEvent = {
      kind: 'notice',
      label: 'Provider selected',
      detail: `${provider.name} will receive the full conversation on the next turn.`,
      at: new Date().toISOString()
    }
    task.activity = [...(task.activity ?? []), event].slice(-100)
    await this.persistAndEmit()
    return structuredClone(task)
  }

  async readTaskFile(taskId: string, path: string): Promise<TaskFileContent> {
    const task = this.findTask(taskId)
    const workspace = await loadTaskWorkspace(task.cwd, task.filesChanged ?? [])
    return await loadTaskFile(task.cwd, workspace.changes, path)
  }

  async getTaskWorkspace(taskId: string): Promise<TaskWorkspaceSnapshot> {
    const task = this.findTask(taskId)
    return await loadTaskWorkspace(task.cwd, task.filesChanged ?? [])
  }

  async listWorkspaceEntries(cwd: string, query: string): Promise<WorkspaceEntry[]> {
    return await listWorkspaceEntries(cwd, query)
  }

  attachmentPath(taskId: string, attachmentId: string): string {
    const task = this.findTask(taskId)
    const attachment = (task.turns ?? []).flatMap((turn) => turn.attachments ?? [])
      .find((item) => item.id === attachmentId && item.kind === 'image')
    if (!attachment) throw new Error('Unknown image attachment.')
    return attachment.path
  }

  // Branches left behind by orchestrated tasks, grouped by the repo they belong
  // to, so subtask work can be reviewed and merged without leaving the app.
  async listBranchInbox(): Promise<BranchRepo[]> {
    return await listBranchInbox(this.tasks.map((task) => task.cwd))
  }

  async readBranchFile(cwd: string, branch: string, path: string): Promise<string> {
    return await branchFileDiff(cwd, branch, path)
  }

  async mergeBranch(cwd: string, branch: string): Promise<BranchRepo[]> {
    await mergeTaskBranch(cwd, branch)
    return await this.listBranchInbox()
  }

  async deleteBranch(cwd: string, branch: string): Promise<BranchRepo[]> {
    await deleteTaskBranch(cwd, branch)
    return await this.listBranchInbox()
  }

  async clearFinishedTasks(): Promise<void> {
    this.tasks = this.tasks.filter((task) => task.status === 'queued' || task.status === 'running')
    await this.persistAndEmit()
  }

  async checkProviders(): Promise<AppSnapshot> {
    // Re-derive PATH first: a CLI may have been installed or a version manager
    // initialized since launch, and health checks resolve executables against
    // this process's PATH. Without this, a provider missing at startup would
    // stay "Not detected" for the whole session even after the user fixes it.
    await hydrateExecutablePath()
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
    await this.mcpAuth?.reconcile(this.settings.controlPlane)
    await this.persistAndEmit()
    return this.snapshot()
  }

  async authenticateMcpServer(serverId: string): Promise<AppSnapshot> {
    if (!this.mcpAuth) throw new Error('Secure MCP authentication is not available in this build.')
    const server = this.settings.controlPlane.mcpServers.find((item) => item.id === serverId)
    if (!server) throw new Error(`Unknown MCP server: ${serverId}`)
    const authentication = this.mcpAuth.authenticate(server)
    this.emitSnapshot()
    try { await authentication } finally { this.emitSnapshot() }
    return this.snapshot()
  }

  async disconnectMcpServer(serverId: string): Promise<AppSnapshot> {
    if (!this.mcpAuth) throw new Error('Secure MCP authentication is not available in this build.')
    await this.mcpAuth.disconnect(serverId)
    this.emitSnapshot()
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
        // A bench run targets its chosen agents directly, so it does not compete
        // for the router's ranking — only for the lanes each provider allows.
        if (task.bench) { void this.runBench(task); await new Promise((resolve) => setTimeout(resolve, 0)); continue }
        const ranked = this.route(task)
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
      this.selectTaskProvider(task, providerId)
      runtime.running += 1
      const attempt: TaskAttempt = { providerId, startedAt: new Date().toISOString(), status: 'running' }
      task.attempts.push(attempt)
      const started = Date.now()
      this.emitSnapshot()

      const attachments = task.turns?.find((turn) => turn.role === 'user')?.attachments ?? []
      const runPrompt = this.promptWithMemory(this.messageWithContext(task.prompt, task.cwd, attachments))
      let contextReported = false
      const runConfig = this.withModel(provider, task)
      this.noteModelFallback(task, provider, runConfig)
      const result = await runProvider(runConfig, {
        prompt: runPrompt,
        cwd: task.cwd,
        signal: controller.signal,
        controlPlane: await this.activeControlPlane(),
        imagePaths: this.imagePaths(attachments),
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
        onContext: (context) => { contextReported = true; this.applyContext(task, provider, context) },
        onSession: (session) => { this.applySession(runtime, session) },
        onSessionId: (sessionId) => { task.sessionId = sessionId; task.sessionProviderId = provider.id }
      })
      if (!task.model) task.model = result.model ?? provider.model

      runtime.running = Math.max(0, runtime.running - 1)
      runtime.usage.tasks += 1
      runtime.usage.elapsedMs += Date.now() - started
      runtime.usage.estimatedInputTokens += task.estimatedInputTokens
      runtime.usage.estimatedOutputTokens += estimateTokens(result.output)
      this.applyConfiguredContext(provider, estimateTokens(runPrompt), task, contextReported)
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
      if (controller.signal.aborted || result.failureKind === 'cancelled') {
        task.status = 'cancelled'
        task.error = 'Task cancelled by user.'
        task.finishedAt = new Date().toISOString()
        break
      }
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
      task.status = 'failed'
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
  async continueTask(taskId: string, message: string, contextItems: ChatContextItem[] = []): Promise<ProxyTask> {
    const text = message.trim()
    const task = this.findTask(taskId)
    const attachments = await validateChatContext(task.cwd, contextItems)
    if (!text && !attachments.length) throw new Error('A follow-up message or image is required.')
    const userMessage = text || 'Please inspect the attached image.'
    if (task.status === 'running' || task.status === 'queued') throw new Error('Wait for the current turn to finish before continuing.')

    // Keep a stopped conversation on the provider the user last selected. This
    // is especially important after an intentional cancellation: a subsequent
    // message must not silently move to another platform. Users can explicitly
    // choose a replacement with changeTaskProvider.
    const requestedProviderId = task.continuationProviderId ?? task.selectedProviderId
    const routed = routeTask(
      { ...task, preferredProviderId: requestedProviderId, orchestrated: false },
      this.snapshot().providers
    )
    const ranked = routed.ranked
    task.routing = routed.decision
    if (requestedProviderId && !ranked.some((item) => item.id === requestedProviderId)) {
      const requested = this.settings.providers.find((item) => item.id === requestedProviderId)
      throw new Error(`${requested?.name ?? 'The selected provider'} is not currently available. Choose another provider before continuing.`)
    }
    const primaryProviderId = requestedProviderId ?? ranked[0]?.id
    if (!primaryProviderId) throw new Error('No eligible provider is available to continue.')

    task.turns = [...(task.turns ?? []), { id: randomUUID(), role: 'user', content: userMessage, attachments: attachments.length ? attachments : undefined, at: new Date().toISOString() }]
    task.status = 'running'
    task.error = undefined
    task.finishedAt = undefined
    task.output = ''
    task.orchestrated = false
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    this.startAssistantTurn(task)
    await this.persistAndEmit()

    // Prefer the provider that owns the resumable session, but only while it is
    // still routable. Quota/unavailable failures continue on the next platform
    // with a transcript replay so follow-up turns get the same failover safety
    // as first-turn tasks.
    const sessionProviderId = task.sessionId && task.sessionProviderId === primaryProviderId ? task.sessionProviderId : undefined
    const candidateIds = [...new Set([
      primaryProviderId,
      ...ranked.map((item) => item.id)
    ])]

    let completed = false
    let finalError: string | undefined
    for (const providerId of candidateIds) {
      const provider = this.settings.providers.find((item) => item.id === providerId)
      const runtime = this.runtimes.get(providerId)
      if (!provider || !runtime || controller.signal.aborted) break
      const resumable = providerId === sessionProviderId && Boolean(task.sessionId)
      const prompt = resumable ? this.messageWithContext(userMessage, task.cwd, attachments) : `[Full conversation history transferred by Frontier]\n${this.transcript(task)}\n\n[Instruction]\nContinue the conversation from the latest user message. Use the complete history above, including work and partial results from previous providers.`
      if (!resumable) { task.sessionId = undefined; task.sessionProviderId = undefined }
      this.selectTaskProvider(task, provider.id)
      runtime.running += 1
      const attempt: TaskAttempt = { providerId, startedAt: new Date().toISOString(), status: 'running' }
      task.attempts.push(attempt)
      const started = Date.now()
      this.emitSnapshot()

      let contextReported = false
      const runConfig = this.withModel(provider, task)
      this.noteModelFallback(task, provider, runConfig)
      const result = await runProvider(runConfig, {
        prompt, cwd: task.cwd, signal: controller.signal, controlPlane: await this.activeControlPlane(),
        resumeSessionId: resumable ? task.sessionId : undefined,
        imagePaths: this.imagePaths(attachments),
        onOutput: (chunk) => { task.output += chunk; task.estimatedOutputTokens = estimateTokens(task.output); this.emit('stream', { taskId: task.id, kind: 'output', data: chunk } satisfies StreamEvent); this.emitSnapshot() },
        onModel: (model) => { task.model = model; this.emitSnapshot() },
        onActivity: (event) => { task.activity = [...(task.activity ?? []), event].slice(-100); recordFileChange(task, event); this.emitSnapshot() },
        onUsage: (usage) => { this.applyUsage(runtime, usage, task) },
        onContext: (context) => { contextReported = true; this.applyContext(task, provider, context) },
        onSession: (session) => { this.applySession(runtime, session) },
        onSessionId: (sessionId) => { task.sessionId = sessionId; task.sessionProviderId = provider.id }
      })
      runtime.running = Math.max(0, runtime.running - 1)
      runtime.usage.tasks += 1
      runtime.usage.elapsedMs += Date.now() - started
      runtime.usage.estimatedInputTokens += estimateTokens(prompt)
      runtime.usage.estimatedOutputTokens += estimateTokens(result.output)
      this.applyConfiguredContext(provider, estimateTokens(prompt), task, contextReported)
      attempt.finishedAt = new Date().toISOString()
      attempt.status = result.ok ? 'completed' : result.failureKind === 'cancelled' ? 'cancelled' : 'failed'
      attempt.error = result.error

      if (controller.signal.aborted || result.failureKind === 'cancelled') { finalError = 'Task cancelled by user.'; break }
      if (result.ok) { task.continuationProviderId = provider.id; completed = true; finalError = undefined; break }
      finalError = result.error
      if (result.failureKind === 'quota') {
        runtime.cooldownUntil = new Date(Date.now() + this.settings.quotaCooldownMinutes * 60_000).toISOString()
        runtime.cooldownReason = result.error
        task.output += `\n\n[${provider.name} reached a usage limit; continuing with another platform.]\n\n`
        continue
      }
      if (result.failureKind === 'unavailable') {
        runtime.available = false
        task.output += `\n\n[${provider.name} became unavailable; continuing with another platform.]\n\n`
        continue
      }
      break
    }
    this.finishTask(task, controller.signal.aborted ? 'cancelled' : completed ? 'completed' : 'failed', completed ? undefined : controller.signal.aborted ? 'Task cancelled.' : finalError ?? 'No eligible provider could complete this turn.')
    this.finalizeAssistantTurn(task)
    this.controllers.delete(task.id)
    await this.persistAndEmit()
    void this.pump()
    return structuredClone(task)
  }

  private transcript(task: ProxyTask): string {
    return (task.turns ?? []).filter((turn) => turn.content.trim())
      .map((turn) => {
        if (turn.role === 'user') return `User: ${this.messageWithContext(turn.content, task.cwd, turn.attachments ?? [])}`
        const provider = this.settings.providers.find((item) => item.id === turn.providerId)?.name ?? 'Assistant'
        const details = [turn.model, turn.status && turn.status !== 'completed' ? turn.status : undefined].filter(Boolean).join(', ')
        return `${provider}${details ? ` (${details})` : ''}: ${turn.content}`
      }).join('\n\n')
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
      this.selectTaskProvider(task, planner.id)
      const attachments = task.turns?.find((turn) => turn.role === 'user')?.attachments ?? []
      const imagePaths = this.imagePaths(attachments)
      const planResult = await this.runOne(planner, buildPlannerPrompt(this.promptWithMemory(this.messageWithContext(task.prompt, task.cwd, attachments))), task, controller, undefined, undefined, undefined, imagePaths)
      if (controller.signal.aborted) { this.finishTask(task, 'cancelled', 'Task cancelled.'); return }
      if (!planResult.ok) throw new Error(planResult.error ?? 'No provider could plan this task.')

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
      const synthesizer = this.pickProvider(task)
      if (!synthesizer) throw new Error('No eligible provider is available to synthesize the task results.')
      this.selectTaskProvider(task, synthesizer.id)
      const synthesisResult = await this.runOne(synthesizer, buildSynthesisPrompt(task.prompt, task.subtasks), task, controller, (text) => {
        task.output += text
        task.estimatedOutputTokens = estimateTokens(task.output)
        this.emitSnapshot()
      }, undefined, undefined, imagePaths)
      if (!synthesisResult.ok) throw new Error(synthesisResult.error ?? 'No provider could synthesize the task results.')

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

  // Head-to-head: the identical prompt goes to every chosen agent at once, each
  // in its own worktree so their edits cannot collide. Deliberately no failover
  // — a lane that fails is a result about that agent, not something to reroute.
  private async runBench(task: ProxyTask): Promise<void> {
    task.status = 'running'
    task.startedAt = new Date().toISOString()
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    this.startAssistantTurn(task)
    await this.persistAndEmit()

    const attachments = task.turns?.find((turn) => turn.role === 'user')?.attachments ?? []
    const prompt = this.promptWithMemory(this.messageWithContext(task.prompt, task.cwd, attachments))
    const imagePaths = this.imagePaths(attachments)
    const git = await isGitRepo(task.cwd)

    await Promise.all((task.subtasks ?? []).map(async (lane) => {
      const provider = this.settings.providers.find((item) => item.id === lane.providerId)
      const runtime = provider ? this.runtimes.get(provider.id) : undefined
      if (!provider || !runtime) { lane.status = 'failed'; lane.error = 'This agent is no longer configured.'; this.emitSnapshot(); return }

      let workdir = task.cwd
      if (git) {
        const branch = `frontier/${task.id.slice(0, 8)}/bench-${branchSlug(provider.name)}`
        try { workdir = await createWorktree(task.cwd, branch); lane.branch = branch } catch { /* share the cwd */ }
      }
      lane.status = 'running'
      runtime.running += 1
      const started = Date.now()
      this.emitSnapshot()
      try {
        const runConfig = this.withModel(provider, task)
        if (task.modelOverride && runConfig.model !== task.modelOverride) lane.output += `[${provider.name} cannot run ${task.modelOverride}; using ${runConfig.model ?? 'its default model'}.]\n\n`
        const result = await runProvider(runConfig, {
          prompt, cwd: workdir, signal: controller.signal, controlPlane: await this.activeControlPlane(), imagePaths,
          onOutput: (text) => { lane.output += text; this.emitSnapshot() },
          onModel: (model) => { lane.model = model; this.emitSnapshot() },
          // Lanes run concurrently, so every event is attributed to its agent.
          onActivity: (event) => {
            task.activity = [...(task.activity ?? []), { ...event, label: `${provider.name}: ${event.label}` }].slice(-100)
            this.emitSnapshot()
          },
          onUsage: (usage) => { this.applyUsage(runtime, usage, task) },
          onSession: (session) => { this.applySession(runtime, session) }
        })
        if (!lane.output.trim()) lane.output = result.output
        if (!lane.model) lane.model = result.model ?? provider.model
        lane.status = controller.signal.aborted || result.failureKind === 'cancelled' ? 'cancelled' : result.ok ? 'completed' : 'failed'
        if (!result.ok && lane.status !== 'cancelled') lane.error = result.error
        if (lane.branch && result.ok) lane.committed = await commitWorktree(workdir, `Frontier bench (${provider.name}): ${task.prompt.slice(0, 60)}`)
      } catch (error) {
        lane.status = 'failed'
        lane.error = error instanceof Error ? error.message : String(error)
      } finally {
        runtime.running = Math.max(0, runtime.running - 1)
        runtime.usage.tasks += 1
        runtime.usage.elapsedMs += Date.now() - started
        runtime.usage.estimatedInputTokens += estimateTokens(prompt)
        runtime.usage.estimatedOutputTokens += estimateTokens(lane.output)
        if (workdir !== task.cwd) await removeWorktree(task.cwd, workdir)
        this.emitSnapshot()
      }
    }))

    const lanes = task.subtasks ?? []
    task.output = this.benchSummary(lanes)
    task.estimatedOutputTokens = estimateTokens(task.output)
    const finished = lanes.filter((lane) => lane.status === 'completed')
    this.finishTask(
      task,
      controller.signal.aborted ? 'cancelled' : finished.length ? 'completed' : 'failed',
      controller.signal.aborted ? 'Task cancelled.' : finished.length ? undefined : 'No agent completed this comparison.'
    )
    this.finalizeAssistantTurn(task)
    this.controllers.delete(task.id)
    await this.persistAndEmit()
    void this.pump()
  }

  // A factual scoreboard built from what actually happened — no extra model call.
  private benchSummary(lanes: SubTask[]): string {
    const rows = lanes.map((lane) => {
      const parts = [lane.model, lane.status]
      if (lane.branch) parts.push(lane.committed ? `committed to \`${lane.branch}\`` : 'no file changes')
      if (lane.error) parts.push(lane.error)
      return `- **${lane.title}** — ${parts.filter(Boolean).join(' · ')}`
    })
    return [`### Head-to-head results`, '', ...rows].join('\n')
  }

  private async runSubtasks(task: ProxyTask, controller: AbortController): Promise<void> {
    const subtasks = task.subtasks ?? []
    const imagePaths = this.imagePaths(task.turns?.find((turn) => turn.role === 'user')?.attachments ?? [])
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
      const provider = await this.awaitSubtaskProvider(task, subtask, controller)
      if (!provider) {
        if (controller.signal.aborted) return
        subtask.status = 'failed'; subtask.error = 'No eligible provider.'; this.emitSnapshot(); return runNext()
      }
      subtask.status = 'running'; subtask.providerId = provider.id; this.emitSnapshot()
      const workdir = worktrees.get(subtask.id) ?? task.cwd
      try {
        const result = await this.runOne(provider, subtask.prompt, task, controller, (text) => { subtask.output += text; this.emitSnapshot() }, workdir, subtask.type, imagePaths)
        if (!subtask.output.trim()) subtask.output = result.output
        subtask.providerId = result.providerId
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

  // A subtask lane must wait for a provider slot rather than give up. With a
  // single installed CLI at maxConcurrent 1 — the shipped default — the second
  // lane would otherwise find every provider busy the instant the first lane
  // started, and abandon its subtask before it ever ran. Only a subtask that no
  // provider could take even when idle (no capability, cooldown, usage limit,
  // offline) is a genuine failure.
  private async awaitSubtaskProvider(task: ProxyTask, subtask: SubTask, controller: AbortController): Promise<ProviderConfig | undefined> {
    const routing = { ...task, type: subtask.type, preferredProviderId: undefined, orchestrated: false }
    for (;;) {
      if (controller.signal.aborted) return undefined
      const providers = this.snapshot().providers
      const ranked = rankProviders(routing, providers)
      if (ranked.length) return this.settings.providers.find((item) => item.id === ranked[0].id)
      const idle = providers.map((provider) => ({ ...provider, runtime: { ...provider.runtime, running: 0 } }))
      if (!rankProviders(routing, idle).length) return undefined
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  private async runOne(
    initialProvider: ProviderConfig,
    prompt: string,
    task: ProxyTask,
    controller: AbortController,
    onText?: (text: string) => void,
    cwd?: string,
    routingType?: TaskType,
    imagePaths: string[] = []
  ): Promise<{ output: string; model?: string; ok: boolean; error?: string; providerId: string }> {
    const routingTask = { ...task, type: routingType ?? task.type, preferredProviderId: undefined, orchestrated: false }
    const ranked = rankProviders(routingTask, this.snapshot().providers)
    const candidateIds = [...new Set([initialProvider.id, ...ranked.map((item) => item.id)])]
    let final: { output: string; model?: string; ok: boolean; error?: string; providerId: string } = {
      output: '', ok: false, error: 'No eligible provider could complete this run.', providerId: initialProvider.id
    }

    for (const providerId of candidateIds) {
      const provider = this.settings.providers.find((item) => item.id === providerId)
      const runtime = this.runtimes.get(providerId)
      if (!provider || !runtime || controller.signal.aborted) break
      if (providerId !== initialProvider.id && !rankProviders(routingTask, [{ ...provider, runtime }]).length) continue
      runtime.running += 1
      this.selectTaskProvider(task, provider.id)
      const started = Date.now()
      let output = ''
      let contextReported = false
      const result = await runProvider(this.withModel(provider, task), {
        prompt, cwd: cwd ?? task.cwd, signal: controller.signal, controlPlane: await this.activeControlPlane(), imagePaths,
        onOutput: (text) => { output += text; onText?.(text) },
        onModel: (model) => { task.model = model; this.emitSnapshot() },
        onActivity: (event) => { task.activity = [...(task.activity ?? []), event].slice(-100); recordFileChange(task, event); this.emitSnapshot() },
        onUsage: (usage) => { this.applyUsage(runtime, usage, task) },
        onContext: (context) => { contextReported = true; this.applyContext(task, provider, context) },
        onSession: (session) => { this.applySession(runtime, session) },
        onSessionId: (sessionId) => { task.sessionId = sessionId; task.sessionProviderId = provider.id }
      })
      runtime.running = Math.max(0, runtime.running - 1)
      runtime.usage.tasks += 1
      runtime.usage.elapsedMs += Date.now() - started
      runtime.usage.estimatedInputTokens += estimateTokens(prompt)
      runtime.usage.estimatedOutputTokens += estimateTokens(result.output)
      this.applyConfiguredContext(provider, estimateTokens(prompt), task, contextReported)
      final = { output: result.output || output, model: result.model, ok: result.ok, error: result.error, providerId: provider.id }
      if (result.ok || controller.signal.aborted || result.failureKind === 'cancelled') return final

      const notice: ActivityEvent = { kind: 'notice', label: 'Automatic fallback', at: new Date().toISOString() }
      if (result.failureKind === 'quota') {
        runtime.cooldownUntil = new Date(Date.now() + this.settings.quotaCooldownMinutes * 60_000).toISOString()
        runtime.cooldownReason = result.error
        notice.detail = `${provider.name} reached its usage limit; trying another platform.`
      } else if (result.failureKind === 'unavailable') {
        runtime.available = false
        notice.detail = `${provider.name} became unavailable; trying another platform.`
      } else return final
      task.activity = [...(task.activity ?? []), notice].slice(-100)
      this.emitSnapshot()
    }
    return final
  }

  // Rank providers for a task and keep the explanation on the task, so the UI
  // can show why this agent won and what disqualified the others.
  private route(task: ProxyTask): ReturnType<typeof routeTask>['ranked'] {
    const { ranked, decision } = routeTask(task, this.snapshot().providers)
    task.routing = decision
    return ranked
  }

  private pickProvider(task: ProxyTask): ProviderConfig | undefined {
    const ranked = rankProviders({ ...task, orchestrated: false }, this.snapshot().providers)
    return this.settings.providers.find((item) => item.id === ranked[0]?.id)
  }

  private modelOwner(provider: ProviderConfig): ModelOwner {
    return { id: provider.id, kind: provider.kind, model: provider.model, models: this.runtimes.get(provider.id)?.models }
  }

  // Never hand a provider a model id belonging to another CLI: Codex fails the
  // whole run on `claude-opus-5` rather than ignoring it.
  private withModel(provider: ProviderConfig, task: ProxyTask): ProviderConfig {
    const model = resolveTaskModel(this.modelOwner(provider), task.modelOverride, task.modelOverrideProviderId, this.settings.providers.map((item) => this.modelOwner(item)))
    return model === provider.model ? provider : { ...provider, model }
  }

  // Say so in the transcript when the picked model could not travel with the task.
  private noteModelFallback(task: ProxyTask, provider: ProviderConfig, effective: ProviderConfig): void {
    if (!task.modelOverride || effective.model === task.modelOverride) return
    task.output += `\n\n[${provider.name} cannot run ${task.modelOverride}; using ${effective.model ?? 'its default model'}.]\n\n`
  }

  private async activeControlPlane(): Promise<ControlPlaneProfile> {
    return this.mcpAuth ? await this.mcpAuth.profileWithAuth(this.settings.controlPlane) : this.settings.controlPlane
  }

  private applyUsage(runtime: ProviderRuntime, usage: UsageSample, task?: ProxyTask): void {
    runtime.usage.inputTokens += usage.inputTokens
    runtime.usage.outputTokens += usage.outputTokens
    runtime.usage.costUsd += usage.costUsd
    // Record the CLI's real reported tokens on the task too, so per-task views
    // show actual usage instead of the crude character-count estimate.
    if (task) {
      task.usageInputTokens = (task.usageInputTokens ?? 0) + usage.inputTokens
      task.usageOutputTokens = (task.usageOutputTokens ?? 0) + usage.outputTokens
      task.usageCostUsd = (task.usageCostUsd ?? 0) + usage.costUsd
    }
    this.emitSnapshot()
  }

  private applyContext(task: ProxyTask, provider: ProviderConfig, context: ContextSample): void {
    task.contextTokens = Math.max(0, context.tokens)
    const window = context.window ?? provider.contextWindow
    if (window) task.contextWindow = window
    // The occupancy is real, but when the CLI does not report its own window we
    // fall back to the configured/known one — mark that pairing as an estimate.
    task.contextSource = context.window ? 'reported' : 'estimated'
    this.emitSnapshot()
  }

  private applySession(runtime: ProviderRuntime, session: SessionInfo): void {
    const windows = runtime.sessions ?? (runtime.session ? [runtime.session] : [])
    runtime.sessions = mergeSessionWindows(windows, session)
    runtime.session = undefined
    this.emitSnapshot()
  }

  private selectTaskProvider(task: ProxyTask, providerId: string): void {
    // Failover can land on a provider other than the router's first choice.
    if (task.routing) task.routing.chosenProviderId = providerId
    if (task.selectedProviderId && task.selectedProviderId !== providerId) {
      task.contextTokens = undefined
      task.contextWindow = undefined
      task.contextSource = undefined
    }
    task.selectedProviderId = providerId
  }

  private applyConfiguredContext(provider: ProviderConfig, usedTokens: number, task: ProxyTask | undefined, contextReported: boolean): void {
    if (task && provider.contextWindow && !contextReported) {
      task.contextTokens = usedTokens
      task.contextWindow = provider.contextWindow
      task.contextSource = 'estimated'
    }
  }

  // Prepend Frontier's persistent memory as context for a fresh task.
  private promptWithMemory(prompt: string): string {
    const memory = this.settings.memory?.trim()
    return memory ? `[Frontier memory — persistent context you should use]\n${memory}\n\n[Task]\n${prompt}` : prompt
  }

  private messageWithContext(message: string, cwd: string, items: ChatContextItem[]): string {
    const context = contextPrompt(cwd, items)
    return context ? `${message}\n\n${context}` : message
  }

  private imagePaths(items: ChatContextItem[]): string[] {
    return items.filter((item) => item.kind === 'image').map((item) => item.path)
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
    const providerRuntime = Object.fromEntries([...this.runtimes].map(([providerId, runtime]) => [providerId, {
      usage: runtime.usage,
      sessions: runtime.sessions ?? (runtime.session ? [runtime.session] : undefined)
    }]))
    await this.store.save({ settings: this.settings, tasks: this.tasks.slice(0, 200), providerRuntime })
    this.emitSnapshot()
  }

  private emitSnapshot(): void {
    this.emit('snapshot', this.snapshot())
  }
}
