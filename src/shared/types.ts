export type ProviderKind = 'codex' | 'claude' | 'copilot' | 'antigravity' | 'codex-oss' | 'ollama' | 'custom'
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
  workspaces: WorkspaceView[]
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

// ---- Collaborative workspaces (ADR 0001) ----
// A workspace is a second conversation shape alongside ProxyTask: one long-lived thread
// per repo with several named AI participants addressed by @handle. It deliberately has
// no router, no failover, and no orchestration stages — see the ADR for why this is a
// new model rather than a reshaped ProxyTask.

export type ParticipantKind = 'human' | 'agent'
export type ParticipantCapability = 'read-repo' | 'edit-files' | 'run-commands'
export type WorkspaceTurnStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type WorkspaceMessageAuthor = 'human' | 'agent' | 'system'

// Mirrors providers.ts's RunFailureKind. Duplicated rather than imported: src/shared/
// may not depend on src/main/. Keep the two unions in sync by hand.
export type RunFailureKind = 'quota' | 'unavailable' | 'failed' | 'cancelled'

export interface WorkspaceParticipant {
  id: string
  handle: string          // '@handle', unique per workspace, lowercased on write
  name: string             // display name
  kind: ParticipantKind
  role: string              // free text — 'Backend reviewer', 'Docs'
  providerId?: string      // agent only; references ProviderConfig.id
  model?: string           // agent only; CLI-specific id, valid only for providerId
  capabilities: ParticipantCapability[]
  accent?: string          // avatar colour token
  enabled: boolean
}

// One message in a workspace's flat thread. `addressed` is resolved once, at post
// time, via parseMentions — it is not recomputed if the roster changes later.
export interface WorkspaceMessage {
  id: string
  seq: number              // monotonic per workspace (Workspace.nextSeq)
  author: WorkspaceMessageAuthor
  participantId?: string
  text: string
  createdAt: string
  addressed: string[]
  // Set when author is 'system' — e.g. a mention of a disabled/unavailable participant.
  systemReason?: string
}

// A dispatched run of one participant against one triggering message. Turns live on
// the workspace, not inside the message, so a retry adds a turn without mutating history.
export interface WorkspaceTurn {
  id: string
  workspaceId: string
  messageId: string        // the human message that triggered this turn
  participantId: string
  providerId: string
  status: WorkspaceTurnStatus
  output: string
  activity?: ActivityEvent[]
  model?: string
  error?: string
  failureKind?: RunFailureKind
  // Isolation for edit-files participants: the git branch this turn's changes were
  // committed to, and whether the commit happened.
  branch?: string
  committed?: boolean
  filesChanged?: FileChange[]
  startedAt?: string
  finishedAt?: string
}

export interface Workspace {
  id: string
  name: string
  cwd: string
  participants: WorkspaceParticipant[]
  messages: WorkspaceMessage[]
  turns: WorkspaceTurn[]
  createdAt: string
  nextSeq: number
}

// The renderer-facing participant shape. Availability is computed in the main process
// from ProviderRuntime (cooldowns, session limits, disabled state) — never here, so the
// renderer never has to reason about ProviderConfig.kind (ADR D2).
export type ParticipantView = WorkspaceParticipant & { available: boolean; unavailableReason?: string }

// Snapshot-facing shape: same as Workspace, but with participants swapped for the
// computed ParticipantView, mirroring how AppSnapshot already exposes
// `ProviderConfig & { runtime: ProviderRuntime }` instead of raw stored ProviderConfig.
export interface WorkspaceView extends Omit<Workspace, 'participants'> {
  participants: ParticipantView[]
}

// A separate stream channel from task output (`StreamEvent`/`frontier:stream`), so
// nothing in the task view can regress when workspace streaming ships (ADR D9).
export interface WorkspaceStreamEvent {
  workspaceId: string
  turnId: string
  kind: 'output' | 'status' | 'error'
  data: string
}

// The contract Phase 2 (workspace runtime) and Phase 3 (participant adapter) both
// build against, so they can be developed in parallel.
export interface ParticipantRunInput {
  workspace: Workspace
  participant: WorkspaceParticipant
  trigger: WorkspaceMessage
  history: WorkspaceMessage[]   // messages with seq <= trigger.seq, oldest first
  cwd: string                   // worktree dir for edit-files participants, workspace cwd otherwise
  signal: AbortSignal
  onOutput(chunk: string): void
  onActivity(event: ActivityEvent): void
  onModel(model: string): void
}

export interface ParticipantRunResult {
  ok: boolean
  output: string
  error?: string
  failureKind?: RunFailureKind
  model?: string
}

export interface ParticipantRunner {
  run(input: ParticipantRunInput): Promise<ParticipantRunResult>
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
  createWorkspace(name: string, cwd: string): Promise<AppSnapshot>
  updateWorkspace(workspaceId: string, name: string): Promise<AppSnapshot>
  deleteWorkspace(workspaceId: string): Promise<AppSnapshot>
  upsertParticipant(workspaceId: string, participant: Omit<WorkspaceParticipant, 'id'> & { id?: string }): Promise<AppSnapshot>
  removeParticipant(workspaceId: string, participantId: string): Promise<AppSnapshot>
  postWorkspaceMessage(workspaceId: string, text: string): Promise<AppSnapshot>
  retryWorkspaceTurn(workspaceId: string, turnId: string): Promise<AppSnapshot>
  cancelWorkspaceTurn(workspaceId: string, turnId: string): Promise<void>
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void
  onStream(callback: (event: StreamEvent) => void): () => void
  onWorkspaceStream(callback: (event: WorkspaceStreamEvent) => void): () => void
}
