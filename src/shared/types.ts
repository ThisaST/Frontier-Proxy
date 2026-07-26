export type ProviderKind = 'codex' | 'claude' | 'copilot' | 'codex-oss' | 'ollama' | 'custom'
export type RoutingMode = 'balanced' | 'quality' | 'saver'
export type TaskType = 'coding' | 'debugging' | 'review' | 'planning' | 'documentation' | 'general'
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ProviderConfig {
  id: string
  name: string
  kind: ProviderKind
  enabled: boolean
  executable: string
  model?: string
  args?: string[]
  priority: number
  dailyTokenBudget?: number
  // Optional model context limit for CLIs that do not report it themselves.
  // A value reported by the CLI always takes precedence at runtime.
  contextWindow?: number
  maxConcurrent: number
  capabilities: TaskType[]
  // When false, this provider ignores the shared control-plane profile.
  useControlPlane?: boolean
}

export type McpTransport = 'stdio' | 'http' | 'sse'

export interface McpServerConfig {
  id: string
  // The key this server is registered under in each CLI's MCP config.
  name: string
  enabled: boolean
  transport: McpTransport
  // stdio transport
  command?: string
  args?: string[]
  env?: Record<string, string>
  // http/sse transport
  url?: string
  headers?: Record<string, string>
}

// A single, CLI-agnostic profile that Frontier translates into each agent's
// native flags at spawn time — so MCP servers, tool permissions, and context
// are configured once here instead of separately in every CLI.
export interface ControlPlaneProfile {
  systemPrompt?: string
  addDirs: string[]
  allowedTools: string[]
  disallowedTools: string[]
  mcpServers: McpServerConfig[]
  // Claude: pass --strict-mcp-config so only Frontier's servers are used.
  strictMcp: boolean
}

// Real token/cost usage reported by a CLI's stream (Claude's result event).
export interface UsageSample {
  inputTokens: number
  outputTokens: number
  costUsd: number
  // Current-request context size and the model's context window, for a % gauge.
  contextTokens?: number
  contextWindow?: number
}

// Subscription session status parsed from Claude's rate_limit_event.
export interface SessionInfo {
  resetsAt?: string
  overageResetsAt?: string
  usingOverage?: boolean
  status?: string
  // Plan-window utilization when the CLI exposes it (normalized to 0..100).
  utilizationPercent?: number
  // Human-readable window identifier such as "5-hour" or "weekly".
  limitType?: string
  updatedAt: string
}

export interface ProviderRuntime {
  available: boolean
  version?: string
  lastCheckedAt?: string
  running: number
  cooldownUntil?: string
  cooldownReason?: string
  session?: SessionInfo
  // Models this provider can run — discovered (`ollama list`) or a curated
  // known set for the subscription CLIs (no headless list command exists).
  models?: string[]
  usage: {
    date: string
    tasks: number
    estimatedInputTokens: number
    estimatedOutputTokens: number
    // Actual tokens/cost reported by the provider (0 when the CLI reports none).
    inputTokens: number
    outputTokens: number
    costUsd: number
    elapsedMs: number
  }
}

export interface TaskAttempt {
  providerId: string
  startedAt: string
  finishedAt?: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  error?: string
}

// A step surfaced from the agent's live stream — a tool call, a thinking burst,
// or a notice — so the UI can show how the model is working, like Claude Code.
export interface ActivityEvent {
  kind: 'tool' | 'thinking' | 'notice'
  label: string
  detail?: string
  at: string
}

// A file the agent created or modified while working the task.
export interface FileChange {
  path: string
  action: 'create' | 'edit' | 'delete'
  at: string
}

export interface TaskFileContent {
  path: string
  relativePath: string
  language: string
  content: string
  diff: string
  exists: boolean
  binary: boolean
  truncated: boolean
}

// One turn in a task's ongoing conversation. Tasks are multi-turn: after the
// first result you can send follow-up messages that continue in-context.
export interface ConversationTurn {
  id: string
  role: 'user' | 'assistant'
  content: string
  providerId?: string
  model?: string
  status?: TaskStatus
  at: string
}

export type OrchestrationStage = 'planning' | 'delegating' | 'synthesizing' | 'done'

// One unit of work in an orchestrated task, dispatched to a best-fit provider.
export interface SubTask {
  id: string
  title: string
  prompt: string
  type: TaskType
  status: TaskStatus
  providerId?: string
  model?: string
  output: string
  error?: string
  // Isolation: the git branch this subtask's changes were committed to.
  branch?: string
  committed?: boolean
}

export interface ProxyTask {
  id: string
  prompt: string
  cwd: string
  mode: RoutingMode
  type: TaskType
  preferredProviderId?: string
  modelOverride?: string
  status: TaskStatus
  selectedProviderId?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  output: string
  error?: string
  attempts: TaskAttempt[]
  estimatedInputTokens: number
  estimatedOutputTokens: number
  // The underlying model the routed CLI actually ran (e.g. "claude-opus-4-8").
  model?: string
  // Live activity feed surfaced from the agent's stream.
  activity?: ActivityEvent[]
  // Files the agent created or edited during the task.
  filesChanged?: FileChange[]
  // Multi-provider orchestration (planner delegates subtasks).
  orchestrated?: boolean
  orchestrationStage?: OrchestrationStage
  subtasks?: SubTask[]
  // Latest context-window occupancy for this task's session.
  contextTokens?: number
  contextWindow?: number
  // Ongoing conversation — the initial prompt/result plus any follow-up turns.
  turns?: ConversationTurn[]
  // Provider CLI session for in-context continuation (Claude --resume).
  sessionId?: string
  sessionProviderId?: string
  // User-selected provider for future turns. Unlike selectedProviderId, this
  // does not rewrite which provider produced the most recent response.
  continuationProviderId?: string
}

export interface AppSettings {
  providers: ProviderConfig[]
  maxParallelTasks: number
  quotaCooldownMinutes: number
  controlPlane: ControlPlaneProfile
  // Frontier's own persistent memory, injected as context into every new task.
  memory: string
}

export interface AppSnapshot {
  tasks: ProxyTask[]
  providers: Array<ProviderConfig & { runtime: ProviderRuntime }>
  settings: AppSettings
}

export interface CreateTaskInput {
  prompt: string
  cwd: string
  mode: RoutingMode
  preferredProviderId?: string
  // Per-task model override, applied to whichever provider runs it.
  model?: string
  // Run as a multi-provider orchestration (planner decomposes → delegates → synthesizes).
  orchestrate?: boolean
}

export interface ProviderPatch {
  id: string
  changes: Partial<Omit<ProviderConfig, 'id' | 'kind'>>
}

export interface StreamEvent {
  taskId: string
  kind: 'output' | 'status' | 'error'
  data: string
}

export interface FrontierApi {
  getSnapshot(): Promise<AppSnapshot>
  createTask(input: CreateTaskInput): Promise<ProxyTask>
  cancelTask(taskId: string): Promise<void>
  retryTask(taskId: string): Promise<ProxyTask>
  changeTaskProvider(taskId: string, providerId: string): Promise<ProxyTask>
  continueTask(taskId: string, message: string): Promise<ProxyTask>
  readTaskFile(taskId: string, path: string): Promise<TaskFileContent>
  clearFinishedTasks(): Promise<void>
  checkProviders(): Promise<AppSnapshot>
  updateProvider(patch: ProviderPatch): Promise<AppSnapshot>
  addCustomProvider(): Promise<AppSnapshot>
  removeProvider(providerId: string): Promise<AppSnapshot>
  updateSettings(changes: Partial<Pick<AppSettings, 'maxParallelTasks' | 'quotaCooldownMinutes' | 'memory'>>): Promise<AppSnapshot>
  updateControlPlane(profile: ControlPlaneProfile): Promise<AppSnapshot>
  previewControlPlane(providerId: string, profile?: ControlPlaneProfile): Promise<string[]>
  chooseDirectory(currentPath?: string): Promise<string | null>
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void
  onStream(callback: (event: StreamEvent) => void): () => void
}
