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
  maxConcurrent: number
  capabilities: TaskType[]
}

export interface ProviderRuntime {
  available: boolean
  version?: string
  lastCheckedAt?: string
  running: number
  cooldownUntil?: string
  cooldownReason?: string
  usage: {
    date: string
    tasks: number
    estimatedInputTokens: number
    estimatedOutputTokens: number
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

export interface ProxyTask {
  id: string
  prompt: string
  cwd: string
  mode: RoutingMode
  type: TaskType
  preferredProviderId?: string
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
}

export interface AppSettings {
  providers: ProviderConfig[]
  maxParallelTasks: number
  quotaCooldownMinutes: number
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
  clearFinishedTasks(): Promise<void>
  checkProviders(): Promise<AppSnapshot>
  updateProvider(patch: ProviderPatch): Promise<AppSnapshot>
  addCustomProvider(): Promise<AppSnapshot>
  removeProvider(providerId: string): Promise<AppSnapshot>
  updateSettings(changes: Partial<Pick<AppSettings, 'maxParallelTasks' | 'quotaCooldownMinutes'>>): Promise<AppSnapshot>
  chooseDirectory(currentPath?: string): Promise<string | null>
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void
  onStream(callback: (event: StreamEvent) => void): () => void
}
