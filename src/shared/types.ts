export type ProviderKind = 'codex' | 'claude' | 'copilot' | 'codex-oss' | 'ollama' | 'custom'
export type RoutingMode = 'balanced' | 'quality' | 'saver'
export type TaskType = 'coding' | 'debugging' | 'review' | 'planning' | 'documentation' | 'general'
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

// ---- Jev routing advisor (auxiliary service, ADR 0002) ----
// Off by default. Shadow records what Jev would have chosen next to the real
// route without changing it; Active lets its answers become bounded routing
// factors and, when confident, the advised model. Never a model-execution key:
// Jev classifies the task, it never runs an agent.
export type AdvisorMode = 'off' | 'shadow' | 'active'
export type ModelTier = 'local' | 'fast' | 'standard' | 'frontier'

export interface RoutingAdvisorSettings {
  mode: AdvisorMode
  // 'jev-latest' or a pinned version string.
  model: string
  // Below this, a Jev answer is ignored in favour of the heuristic/no signal.
  minConfidence: number
  // Repo language mix, file count, manifests, and top-level folder names — never
  // file contents. On by default; the Routing screen can turn it off.
  shareRepoFacts: boolean
  // Off by default: without this, every keystroke in the composer would send a
  // draft prompt to TypeSafe. On submit, Jev is always called at most once.
  previewWhileTyping: boolean
}

// One Jev question, in the exact shape TypeSafe's API expects.
export interface JevQuestion {
  type: 'choice' | 'score' | 'noul'
  instructions: string | Record<string, unknown>
  // choice: option -> description (or null). score: ordered level descriptions
  // (2-10 levels). noul: optional true/false descriptions.
  criteria?: Record<string, string | null> | string[] | { true: string; false: string }
}

// The exact JSON body Frontier would send to `POST /v1/systemone` — never
// containing the API key. Exposed to the UI so the advisor's "what is sent"
// disclosure can never drift from the real request.
export interface JevRequestBody {
  state: Record<string, unknown>
  model: string
  questions: Record<string, JevQuestion>
}

export interface RoutingAdviceTarget {
  choice: string
  probabilities: Record<string, number>
  confidence: number
}

// Jev's answers, folded into one record. `source: 'heuristic'` means either the
// advisor is off/unreachable or its task_type answer was below minConfidence —
// `heuristicTaskType` is always the regex classifier's own answer so the UI can
// show what Jev's pick was measured against.
export interface RoutingAdvice {
  source: 'jev' | 'heuristic'
  // Jev's own model id (e.g. "jev-1.13.0"), not the routed provider's model.
  model?: string
  at: string
  latencyMs?: number
  inputTokens?: number
  taskType: TaskType
  heuristicTaskType: TaskType
  taskTypeProbs?: Record<string, number>
  taskTypeConfidence?: number
  // 0-3 float: trivial -> single-file -> multi-file -> architectural.
  complexity?: number
  complexityConfidence?: number
  // noul answers: probability (0..1) the statement is true.
  editsFiles?: number
  longContext?: number
  splitWorthy?: number
  target?: RoutingAdviceTarget
  // Set when Jev could not be reached/parsed; routing still proceeds on the
  // heuristic fields above.
  error?: string
}

// Input/output for the Routing screen's live preview and the Home composer's
// route-preview line. Never touches task state.
export interface AdvisorPreviewInput {
  prompt: string
  cwd: string
  attachments?: string[]
  mode?: AdvisorMode
  // The routing policy the preview's pseudo task runs under; defaults to
  // 'balanced' (mirrors the New Task dialog's own default) when omitted.
  policy?: RoutingMode
  preferredProviderId?: string
  model?: string
  modelProviderId?: string
}

export interface AdvisorPreviewResult {
  request: JevRequestBody
  heuristic: RoutingAdvice
  decision: RoutingDecision
  model?: string
}

export interface AdvisorTestResult {
  ok: boolean
  model?: string
  latencyMs?: number
  error?: string
}

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

// One day's accumulated usage for a provider. The current day lives on
// `ProviderRuntime.usage`; finished days are appended to `ProviderRuntime.history`
// at the local-date rollover instead of being discarded.
export interface UsageDay {
  date: string
  tasks: number
  estimatedInputTokens: number
  estimatedOutputTokens: number
  // Actual tokens/cost reported by the provider (0 when the CLI reports none).
  inputTokens: number
  outputTokens: number
  costUsd: number
  elapsedMs: number
  // Real usage attributed to the model that produced it, so a day's tokens can
  // be broken down per model rather than only per CLI.
  models?: Record<string, ModelUsage>
  // Whether any cost figure was actually reported during this day. Only Claude
  // reports cost today, so a 0 must never be shown as "this cost nothing".
  costReported?: boolean
}

export interface ModelUsage {
  // Usage reports received, not runs: a single run can report several times.
  samples: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export type AuthState = 'logged-in' | 'logged-out' | 'unknown'

// Whether the CLI is actually signed in, which `<exe> --version` cannot answer.
// Only positive evidence is reported: a CLI whose login state cannot be read
// stays `unknown` rather than being accused of being logged out.
export interface AuthStatus {
  state: AuthState
  detail?: string
  checkedAt: string
}

// How a provider's finished runs actually turned out, per task type. Fed back
// into routing as one bounded, labelled factor — the merge/discard counts come
// from the Review inbox, so the user's own verdict on an agent's branch is the
// strongest signal here.
export interface OutcomeStats {
  runs: number
  completed: number
  merged: number
  discarded: number
  verified: number
  verifyFailed: number
}

export interface ProviderRuntime {
  available: boolean
  version?: string
  lastCheckedAt?: string
  // Real login state of the CLI, probed read-only from its own on-disk session.
  auth?: AuthStatus
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
  usage: UsageDay
  // Completed days, oldest first, so the Usage view can chart a trend instead of
  // showing only today.
  history?: UsageDay[]
  // Per task type, how this provider's runs have actually turned out.
  outcomes?: Partial<Record<TaskType, OutcomeStats>>
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
  // Present whenever the advisor is not off. In shadow mode this records what
  // the route WOULD be with Jev's advice applied, without changing chosenProviderId.
  advisor?: {
    mode: AdvisorMode
    // True only in active mode with jev-sourced advice actually scored above.
    applied: boolean
    wouldChooseProviderId?: string
    wouldChooseModel?: string
    note?: string
  }
}

// One command run against a finished agent's worktree — the repo's own tests,
// linter, or type checker. Frontier never invents a command: they are detected
// from the project's manifests or configured explicitly.
export interface VerificationCheck {
  name: string
  command: string
  args: string[]
}

export interface VerificationResult {
  name: string
  // The command as it was actually run, for display.
  command: string
  ok: boolean
  exitCode?: number
  durationMs: number
  // Tail of the combined output, capped — enough to see the failure.
  output: string
  timedOut?: boolean
}

// The verdict for one isolated run: every detected check, and whether they all
// passed. `checks: []` with `ran: false` means nothing was detected to run,
// which is not the same as passing.
export interface VerificationReport {
  ran: boolean
  ok: boolean
  checks: VerificationResult[]
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
  // Head-to-head measurements, filled in as the lane runs so the bench
  // scoreboard reports what happened instead of only who finished.
  startedAt?: string
  finishedAt?: string
  usageInputTokens?: number
  usageOutputTokens?: number
  additions?: number
  deletions?: number
  filesTouched?: number
  // The repo's own checks, run in this lane's worktree before it was torn down.
  verification?: VerificationReport
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
  // Jev's (or the heuristic's) read on this task, computed once at creation.
  // Continuations, bench lanes, and workspace turns never get one.
  advice?: RoutingAdvice
  // The model the advisor picked for the provider that actually ran, and why —
  // only ever set in active mode, and only for the agent it was computed for.
  routedModel?: { providerId: string; model: string; reason: string }
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
  // Checks that ran in the worktree this branch came from, joined on the branch
  // name. Absent for a branch whose run predates verification.
  verification?: VerificationReport
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

// Verification runs the project's own commands — never anything Frontier made
// up — against an isolated worktree once its agent has finished.
export interface VerificationSettings {
  enabled: boolean
  // Empty means "detect from the repo" (package.json scripts, Makefile, Cargo,
  // Go). A non-empty list replaces detection entirely.
  commands: string[]
  timeoutSeconds: number
}

export interface NotificationSettings {
  enabled: boolean
  // Long runs are the point of notifying; a task that finishes while you are
  // watching does not need one.
  onlyWhenUnfocused: boolean
}

export interface AppSettings {
  providers: ProviderConfig[]
  maxParallelTasks: number
  quotaCooldownMinutes: number
  controlPlane: ControlPlaneProfile
  // Frontier's own persistent memory, injected as context into every new task.
  memory: string
  skills: SkillSettings
  verification: VerificationSettings
  notifications: NotificationSettings
  // Let a provider's recent outcomes influence routing. Off means the router
  // scores exactly as it did before outcome tracking existed.
  learnFromOutcomes: boolean
  advisor: RoutingAdvisorSettings
}

export interface AppSnapshot {
  tasks: ProxyTask[]
  providers: Array<ProviderConfig & { runtime: ProviderRuntime }>
  settings: AppSettings
  mcpAuth: McpAuthStatus[]
  workspaces: WorkspaceView[]
  // The API key itself never appears here, in state.json, or in logs — only
  // whether one is stored and the outcome of the last call.
  advisor: { hasKey: boolean; lastError?: string; lastCheckedAt?: string }
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
  // The repo's own checks, run in this turn's worktree (edit-files turns only).
  verification?: VerificationReport
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
  updateSettings(changes: Partial<Pick<AppSettings, 'maxParallelTasks' | 'quotaCooldownMinutes' | 'memory' | 'skills' | 'verification' | 'notifications' | 'learnFromOutcomes' | 'advisor'>>): Promise<AppSnapshot>
  updateControlPlane(profile: ControlPlaneProfile): Promise<AppSnapshot>
  previewControlPlane(providerId: string, profile?: ControlPlaneProfile, options?: { cwd?: string; skillIds?: string[] }): Promise<string[]>
  listSkills(cwd: string, refresh?: boolean): Promise<SkillCatalog>
  authenticateMcpServer(serverId: string): Promise<AppSnapshot>
  disconnectMcpServer(serverId: string): Promise<AppSnapshot>
  setAdvisorKey(key: string): Promise<AppSnapshot>
  clearAdvisorKey(): Promise<AppSnapshot>
  testAdvisor(): Promise<AdvisorTestResult>
  previewAdvisor(input: AdvisorPreviewInput): Promise<AdvisorPreviewResult>
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
