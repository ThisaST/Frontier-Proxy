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
  // Copilot's built-in GitHub MCP server exposes more tools than its default
  // CLI subset. These settings map to Copilot's per-session selection flags.
  copilotGithubMcpToolsets?: string[]
  copilotGithubMcpTools?: string[]
  copilotEnableAllGithubMcpTools?: boolean
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

export type McpAuthState = 'not-authenticated' | 'authenticating' | 'authenticated' | 'manual' | 'error'

// Sanitized runtime state exposed to the renderer. OAuth credentials never
// leave the main process or appear in the shared control-plane profile.
export interface McpAuthStatus {
  serverId: string
  state: McpAuthState
  expiresAt?: string
  error?: string
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
}

// Current conversation-window occupancy is intentionally separate from usage:
// cumulative billing tokens are not the same thing as the latest model request.
export interface ContextSample {
  tokens: number
  window?: number
}

// Subscription session status parsed from a CLI's stream (Claude's
// rate_limit_event, Codex's token_count rate limits).
export interface SessionInfo {
  resetsAt?: string
  overageResetsAt?: string
  usingOverage?: boolean
  // Status of the plan window itself ("allowed", "rejected", …).
  status?: string
  // Overage status is a separate verdict and must not be read as the plan's.
  overageStatus?: string
  // Plan-window utilization when the CLI exposes it (normalized to 0..100).
  // Claude reports none, so an active window often has no percentage.
  utilizationPercent?: number
  // Human-readable window identifier such as "5-hour" or "7-day".
  limitType?: string
  // Window length, so a reset time can be shown as progress through the window.
  windowMinutes?: number
  updatedAt: string
}

export interface ProviderRuntime {
  available: boolean
  version?: string
  lastCheckedAt?: string
  running: number
  cooldownUntil?: string
  cooldownReason?: string
  // A provider can report several simultaneous plan windows (for example,
  // Claude's five-hour and seven-day limits). Keep each one independently.
  sessions?: SessionInfo[]
  // Legacy single-window snapshots are still accepted when loading older state.
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

export interface TaskWorkspaceSnapshot {
  entries: WorkspaceEntry[]
  changes: FileChange[]
}

// User-supplied context attached to a chat turn. Workspace references keep a
// path relative to the task root; images keep the absolute path selected by
// the user so provider CLIs can receive them as native vision inputs.
export interface ChatContextItem {
  id: string
  kind: 'image' | 'file' | 'folder'
  name: string
  path: string
  mimeType?: string
}

export interface WorkspaceEntry {
  kind: 'file' | 'folder'
  name: string
  path: string
}

export interface SelectedImage {
  attachment: ChatContextItem
  previewUrl: string
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
  attachments?: ChatContextItem[]
  at: string
}

// One labelled part of a provider's routing score. The parts sum to the score
// the router sorts on, so the UI can show exactly why an agent was picked.
export interface RoutingFactor {
  label: string
  points: number
}

export interface RoutingCandidate {
  providerId: string
  providerName: string
  eligible: boolean
  score?: number
  factors?: RoutingFactor[]
  // Plain-language reason an ineligible provider was passed over.
  skippedReason?: string
}

export interface RoutingDecision {
  at: string
  taskType: TaskType
  mode: RoutingMode
  chosenProviderId?: string
  candidates: RoutingCandidate[]
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
  // The agent the override was picked for; other agents keep their own model.
  modelOverrideProviderId?: string
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
  // Real tokens/cost reported by the CLI for this task (undefined when the CLI
  // reports none). Preferred over the character-count estimates for display.
  usageInputTokens?: number
  usageOutputTokens?: number
  usageCostUsd?: number
  // The underlying model the routed CLI actually ran (e.g. "claude-opus-4-8").
  model?: string
  // Live activity feed surfaced from the agent's stream.
  activity?: ActivityEvent[]
  // Files the agent created or edited during the task.
  filesChanged?: FileChange[]
  // Why the router picked this task's provider, recorded at selection time.
  routing?: RoutingDecision
  // Head-to-head run: the same prompt sent to several agents at once, each in
  // its own worktree, for side-by-side comparison. Lanes reuse `subtasks`.
  bench?: boolean
  // Multi-provider orchestration (planner delegates subtasks).
  orchestrated?: boolean
  orchestrationStage?: OrchestrationStage
  subtasks?: SubTask[]
  // Latest context-window occupancy for this task's session.
  contextTokens?: number
  contextWindow?: number
  contextSource?: 'reported' | 'estimated'
  // Ongoing conversation — the initial prompt/result plus any follow-up turns.
  turns?: ConversationTurn[]
  // Provider CLI session for in-context continuation (Claude --resume).
  sessionId?: string
  sessionProviderId?: string
  // User-selected provider for future turns. Unlike selectedProviderId, this
  // does not rewrite which provider produced the most recent response.
  continuationProviderId?: string
  // Absolute resolved skill selection for this task. undefined means "inherit
  // the global disabled-set default" rather than "no skills enabled".
  skillIds?: string[]
}

// A file a Frontier task branch would bring into the checkout, measured from
// the branch's merge base with HEAD.
export interface BranchFileChange {
  path: string
  action: 'create' | 'edit' | 'delete'
  additions: number
  deletions: number
}

// One `frontier/<task>/<n>-<slug>` branch left behind by an orchestrated task,
// waiting to be reviewed and merged.
export interface TaskBranch {
  cwd: string
  branch: string
  taskId: string
  subject: string
  committedAt: string
  ahead: number
  merged: boolean
  files: BranchFileChange[]
}

export interface BranchRepo {
  cwd: string
  name: string
  currentBranch: string
  // Merging is refused while the checkout has uncommitted changes.
  dirty: boolean
  branches: TaskBranch[]
}

export type SkillScope = 'personal' | 'project'

// One root a SKILL.md was found under, and which CLIs scan that root unaided
// (as opposed to needing Frontier to inject it into the prompt/flags).
export interface SkillSource {
  root: string
  path: string
  scope: SkillScope
  nativeFor: ProviderKind[]
}

export interface SkillDefinition {
  id: string
  name: string
  description: string
  sources: SkillSource[]
}

export interface SkillRootStatus {
  root: string
  scope: SkillScope
  nativeFor: ProviderKind[]
  exists: boolean
}

export interface SkillCatalog {
  cwd: string
  scannedAt: string
  roots: SkillRootStatus[]
  skills: SkillDefinition[]
}

// Disabled entries are carried too: Claude needs them for --disallowedTools
// and the prompt-injected CLIs need them for the "do not use" clause.
export interface ResolvedSkill extends SkillDefinition {
  enabled: boolean
}

export interface SkillSettings {
  disabledIds: string[]
}

export interface AppSettings {
  providers: ProviderConfig[]
  maxParallelTasks: number
  quotaCooldownMinutes: number
  controlPlane: ControlPlaneProfile
  // Frontier's own persistent memory, injected as context into every new task.
  memory: string
  skills: SkillSettings
}

export interface AppSnapshot {
  tasks: ProxyTask[]
  providers: Array<ProviderConfig & { runtime: ProviderRuntime }>
  settings: AppSettings
  mcpAuth: McpAuthStatus[]
}

export interface CreateTaskInput {
  prompt: string
  cwd: string
  mode: RoutingMode
  preferredProviderId?: string
  // Per-task model override, applied only to the agent it was picked for.
  model?: string
  modelProviderId?: string
  // Run as a multi-provider orchestration (planner decomposes → delegates → synthesizes).
  orchestrate?: boolean
  // Run the same prompt head-to-head on these providers instead of routing it.
  benchProviderIds?: string[]
  attachments?: ChatContextItem[]
  // Per-task skill selection; undefined means "inherit the global default".
  skillIds?: string[]
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
  continueTask(taskId: string, message: string, attachments?: ChatContextItem[]): Promise<ProxyTask>
  readTaskFile(taskId: string, path: string): Promise<TaskFileContent>
  getTaskWorkspace(taskId: string): Promise<TaskWorkspaceSnapshot>
  listWorkspaceEntries(cwd: string, query: string): Promise<WorkspaceEntry[]>
  chooseImages(): Promise<SelectedImage[]>
  savePastedImage(input: { dataUrl: string; name?: string }): Promise<SelectedImage>
  getAttachmentPreview(taskId: string, attachmentId: string): Promise<string>
  listBranchInbox(): Promise<BranchRepo[]>
  readBranchFile(cwd: string, branch: string, path: string): Promise<string>
  mergeBranch(cwd: string, branch: string): Promise<BranchRepo[]>
  deleteBranch(cwd: string, branch: string): Promise<BranchRepo[]>
  clearFinishedTasks(): Promise<void>
  checkProviders(): Promise<AppSnapshot>
  updateProvider(patch: ProviderPatch): Promise<AppSnapshot>
  addCustomProvider(): Promise<AppSnapshot>
  removeProvider(providerId: string): Promise<AppSnapshot>
  updateSettings(changes: Partial<Pick<AppSettings, 'maxParallelTasks' | 'quotaCooldownMinutes' | 'memory' | 'skills'>>): Promise<AppSnapshot>
  updateControlPlane(profile: ControlPlaneProfile): Promise<AppSnapshot>
  previewControlPlane(providerId: string, profile?: ControlPlaneProfile, options?: { cwd?: string; skillIds?: string[] }): Promise<string[]>
  listSkills(cwd: string, refresh?: boolean): Promise<SkillCatalog>
  authenticateMcpServer(serverId: string): Promise<AppSnapshot>
  disconnectMcpServer(serverId: string): Promise<AppSnapshot>
  chooseDirectory(currentPath?: string): Promise<string | null>
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void
  onStream(callback: (event: StreamEvent) => void): () => void
}
