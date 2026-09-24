import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { promisify } from 'node:util'
import { classifyTask } from '../shared/classify'
import type { JevQuestion, JevRequestBody, RoutingAdvice, RoutingAdvisorSettings, TaskType } from '../shared/types'

const execFileAsync = promisify(execFile)

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

const TASK_TYPES: TaskType[] = ['coding', 'debugging', 'review', 'planning', 'documentation', 'general']

const TASK_TYPE_CRITERIA: Record<TaskType, string> = {
  coding: 'Writing new code, implementing a feature, or building something that does not yet exist.',
  debugging: 'Fixing a bug, error, exception, crash, or regression in existing code.',
  review: 'Reviewing, auditing, or assessing existing code, a diff, or a pull request for quality or security.',
  planning: 'Architecture, design, proposals, or planning work that happens before code is written.',
  documentation: 'Writing or updating docs, READMEs, comments, changelogs, or guides.',
  general: 'General conversation or work that does not clearly fit the other categories.'
}

// Jev bills per input token, and both the state and the longest question share
// a combined budget. classifyTask/estimateTokens's own 4-chars-per-token rule
// of thumb puts this well under the 32k-token field limit while keeping the
// parts of a long prompt most likely to matter: the ask up front, the detail
// at the end.
const MAX_STATE_CHARS = 96_000

export function trimForJev(prompt: string): string {
  if (prompt.length <= MAX_STATE_CHARS) return prompt
  const half = Math.floor((MAX_STATE_CHARS - 20) / 2)
  return `${prompt.slice(0, half)}\n…[trimmed for length]…\n${prompt.slice(-half)}`
}

export interface AdviceCandidate {
  providerId: string
  model: string
  // From model-profiles.ts's describeCandidate — built by the caller so this
  // module stays decoupled from ProviderConfig/ProviderRuntime shapes.
  description: string
}

export interface RepoFacts {
  languages: string[]
  fileCount: number
  manifests: string[]
  topLevelFolders: string[]
}

// Jev's `choice` type accepts at most 255 options.
const MAX_TARGET_OPTIONS = 255

// The exact request body Frontier would send — pure, so the UI's "what is
// sent" disclosure can never drift from what actually goes out.
export function buildJevRequest(
  input: { prompt: string; attachments?: string[] },
  candidates: AdviceCandidate[],
  settings: Pick<RoutingAdvisorSettings, 'model'>,
  repoFacts?: RepoFacts
): JevRequestBody {
  const state: Record<string, unknown> = { task: trimForJev(input.prompt) }
  if (input.attachments?.length) state.attachments = input.attachments
  if (repoFacts) state.repo = repoFacts

  const questions: Record<string, JevQuestion> = {
    task_type: {
      type: 'choice',
      instructions: 'Classify the kind of software work this task is.',
      criteria: Object.fromEntries(TASK_TYPES.map((type) => [type, TASK_TYPE_CRITERIA[type]]))
    },
    complexity: {
      type: 'score',
      instructions: 'How complex is this task to implement correctly, from trivial to architectural?',
      criteria: [
        'Trivial: a one-line edit, config change, or typo fix.',
        'Single-file change: a small, self-contained change to one file.',
        'Multi-file feature or bugfix: touches several files or components.',
        'Architectural / cross-cutting: affects the system design or many subsystems.'
      ]
    },
    edits_files: {
      type: 'noul',
      instructions: 'Will completing this task require editing files in the repository?',
      criteria: { true: 'Yes, files will be created or modified.', false: 'No, this is read-only (a question, review, or explanation).' }
    },
    long_context: {
      type: 'noul',
      instructions: 'Does this task require a large amount of repository context to complete well?',
      criteria: { true: 'Yes, it needs broad context across the codebase.', false: 'No, it is narrowly scoped.' }
    },
    split_worthy: {
      type: 'noul',
      instructions: 'Does this task contain multiple independent parts that could be worked on in parallel?',
      criteria: { true: 'Yes, it has independent sub-parts.', false: 'No, it is one continuous piece of work.' }
    }
  }

  // Below two candidates there is nothing to choose between, so the question
  // is omitted rather than asked with one trivial option.
  const capped = candidates.slice(0, MAX_TARGET_OPTIONS)
  if (capped.length >= 2) {
    questions.target = {
      type: 'choice',
      instructions: 'Which of these installed coding agent and model combinations is the best fit for this task?',
      criteria: Object.fromEntries(capped.map((candidate) => [`${candidate.providerId}::${candidate.model}`, candidate.description]))
    }
  }

  return { state, model: settings.model?.trim() || 'jev-latest', questions }
}

// ---- Response parsing ----

interface JevAnswerChoice { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
interface JevAnswerScore { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number }
interface JevAnswerNoul { type: 'noul'; noul: number }

export interface JevResponseBody {
  model: string
  answers: Record<string, unknown>
  usage?: { input_tokens?: number; output_tokens?: number }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error(`Jev response is missing a "${field}" answer.`)
  return value as Record<string, unknown>
}

function asChoice(value: unknown, field: string): JevAnswerChoice {
  const answer = record(value, field)
  if (answer.type !== 'choice' || typeof answer.choice !== 'string' || typeof answer.confidence !== 'number' || !answer.probabilities || typeof answer.probabilities !== 'object') {
    throw new Error(`Jev response has a malformed "${field}" choice answer.`)
  }
  return { type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities as Record<string, number> }
}

function asScore(value: unknown, field: string): JevAnswerScore {
  const answer = record(value, field)
  if (answer.type !== 'score' || typeof answer.score !== 'number' || typeof answer.confidence !== 'number') {
    throw new Error(`Jev response has a malformed "${field}" score answer.`)
  }
  return { type: 'score', score: answer.score, confidence: answer.confidence, probabilities: (answer.probabilities as Record<string, number>) ?? {} }
}

function asNoul(value: unknown, field: string): JevAnswerNoul {
  const answer = record(value, field)
  if (answer.type !== 'noul' || typeof answer.noul !== 'number') {
    throw new Error(`Jev response has a malformed "${field}" noul answer.`)
  }
  return { type: 'noul', noul: answer.noul }
}

// Defensive by design: a malformed or unexpected shape throws, so the caller
// falls back to the heuristic rather than routing on garbage.
export function adviceFromResponse(json: unknown, heuristicType: TaskType, minConfidence: number, extra: { latencyMs?: number; at?: string } = {}): RoutingAdvice {
  if (!json || typeof json !== 'object') throw new Error('Jev returned an invalid response.')
  const body = json as Record<string, unknown>
  const answers = record(body.answers, 'answers')

  const taskTypeAnswer = asChoice(answers.task_type, 'task_type')
  if (!TASK_TYPES.includes(taskTypeAnswer.choice as TaskType)) throw new Error(`Jev returned an unknown task_type choice: "${taskTypeAnswer.choice}".`)
  const confident = taskTypeAnswer.confidence >= minConfidence
  const taskType = confident ? (taskTypeAnswer.choice as TaskType) : heuristicType

  const complexityAnswer = asScore(answers.complexity, 'complexity')
  const editsFiles = asNoul(answers.edits_files, 'edits_files')
  const longContext = asNoul(answers.long_context, 'long_context')
  const splitWorthy = asNoul(answers.split_worthy, 'split_worthy')
  const targetAnswer = answers.target !== undefined ? asChoice(answers.target, 'target') : undefined

  const usage = body.usage as Record<string, unknown> | undefined
  const inputTokens = usage && typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined

  return {
    source: 'jev',
    model: typeof body.model === 'string' ? body.model : undefined,
    at: extra.at ?? new Date().toISOString(),
    latencyMs: extra.latencyMs,
    inputTokens,
    taskType,
    heuristicTaskType: heuristicType,
    taskTypeProbs: taskTypeAnswer.probabilities,
    taskTypeConfidence: taskTypeAnswer.confidence,
    complexity: complexityAnswer.score,
    complexityConfidence: complexityAnswer.confidence,
    editsFiles: editsFiles.noul,
    longContext: longContext.noul,
    splitWorthy: splitWorthy.noul,
    target: targetAnswer ? { choice: targetAnswer.choice, probabilities: targetAnswer.probabilities, confidence: targetAnswer.confidence } : undefined
  }
}

// The always-available fallback: today's regex classifier, wrapped in the same
// shape a Jev answer would take so callers never have to branch on source.
export function heuristicAdvice(prompt: string): RoutingAdvice {
  const type = classifyTask(prompt)
  return { source: 'heuristic', at: new Date().toISOString(), taskType: type, heuristicTaskType: type }
}

// ---- HTTP client ----

function redactKey(message: string, key: string | undefined): string {
  return key ? message.split(key).join('[redacted]') : message
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

async function jevErrorMessage(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  let detail = body.trim()
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const found = parsed.detail ?? parsed.error ?? parsed.message
    if (typeof found === 'string') detail = found
  } catch { /* keep the raw body as the detail */ }
  if (response.status === 401) return 'Jev rejected the API key.'
  if (response.status === 422) return `Jev rejected the request${detail ? `: ${detail}` : '.'}`
  if (response.status === 429) return `Jev is rate limiting requests${detail ? `: ${detail}` : '.'}`
  if (response.status === 529) return 'Jev is currently overloaded.'
  return `Jev request failed (${response.status})${detail ? `: ${detail}` : '.'}`
}

function networkErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'Jev did not respond in time.'
  return `Could not reach Jev: ${error instanceof Error ? error.message : String(error)}`
}

export interface JevClientOptions {
  fetch?: typeof fetch
  // Per-attempt hard timeout.
  timeoutMs?: number
  // Retry-After is honoured up to this cap so one slow retry cannot itself
  // block the queue.
  retryDelayCapMs?: number
}

// Wraps the one Jev endpoint Frontier calls: a hard per-attempt timeout, one
// retry on 429/529 honouring Retry-After (capped), and every error message
// redacted of the key before it can reach a transcript or log.
export class JevClient {
  private readonly fetcher: typeof fetch
  private readonly timeoutMs: number
  private readonly retryDelayCapMs: number

  constructor(options: JevClientOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 2_000
    this.retryDelayCapMs = options.retryDelayCapMs ?? 1_000
  }

  private async attempt(key: string, body: JevRequestBody): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await this.fetcher(JEV_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
    } finally {
      clearTimeout(timer)
    }
  }

  async request(key: string, body: JevRequestBody): Promise<{ json: JevResponseBody; latencyMs: number }> {
    const started = Date.now()
    let response: Response
    try {
      response = await this.attempt(key, body)
    } catch (error) {
      throw new Error(redactKey(networkErrorMessage(error), key))
    }

    if (response.status === 429 || response.status === 529) {
      const requested = parseRetryAfterMs(response.headers.get('retry-after'))
      const delay = Math.min(this.retryDelayCapMs, requested ?? this.retryDelayCapMs)
      await new Promise((resolve) => setTimeout(resolve, delay))
      try {
        response = await this.attempt(key, body)
      } catch (error) {
        throw new Error(redactKey(networkErrorMessage(error), key))
      }
    }

    if (!response.ok) throw new Error(redactKey(await jevErrorMessage(response), key))
    let json: unknown
    try {
      json = await response.json()
    } catch {
      throw new Error('Jev returned a response that was not valid JSON.')
    }
    return { json: json as JevResponseBody, latencyMs: Date.now() - started }
  }

  // A tiny request used by "Test connection" in the Routing screen.
  async test(key: string): Promise<{ ok: boolean; model?: string; latencyMs?: number; error?: string }> {
    const body: JevRequestBody = {
      state: { task: 'Connectivity check from Frontier Proxy.' },
      model: 'jev-latest',
      questions: { ping: { type: 'noul', instructions: 'Is this state a connectivity check rather than a real coding task?' } }
    }
    try {
      const { json, latencyMs } = await this.request(key, body)
      return { ok: true, model: json.model, latencyMs }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

// Ties the pieces together for a real advisory call: build the request, call
// Jev, and fall back to the heuristic (with the error attached) on any
// failure. Never throws — this is the one function the engine calls.
export async function advise(
  client: JevClient,
  key: string,
  input: { prompt: string; attachments?: string[] },
  candidates: AdviceCandidate[],
  settings: RoutingAdvisorSettings,
  facts?: RepoFacts
): Promise<RoutingAdvice> {
  const heuristicType = classifyTask(input.prompt)
  const request = buildJevRequest(input, candidates, settings, facts)
  try {
    const { json, latencyMs } = await client.request(key, request)
    return adviceFromResponse(json, heuristicType, settings.minConfidence, { latencyMs })
  } catch (error) {
    return { ...heuristicAdvice(input.prompt), error: error instanceof Error ? error.message : String(error) }
  }
}

// ---- Repo facts ----
// Lightweight metadata only — language mix, file count, manifests, top-level
// folder names. File contents never leave the machine.

const MANIFEST_NAMES = new Set([
  'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'setup.py', 'requirements.txt',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'mix.exs',
  'pubspec.yaml', 'CMakeLists.txt', 'Package.swift'
])

const EXTENSION_LANGUAGE: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin',
  '.rb': 'Ruby', '.php': 'PHP', '.cs': 'C#', '.cpp': 'C++', '.cc': 'C++', '.c': 'C', '.h': 'C', '.hpp': 'C++',
  '.swift': 'Swift', '.m': 'Objective-C', '.scala': 'Scala', '.ex': 'Elixir', '.exs': 'Elixir',
  '.dart': 'Dart', '.vue': 'Vue', '.svelte': 'Svelte', '.sh': 'Shell', '.sql': 'SQL'
}

const REPO_FACTS_TTL_MS = 5 * 60_000
const repoFactsCache = new Map<string, { at: number; facts: RepoFacts | undefined }>()

async function computeRepoFacts(cwd: string): Promise<RepoFacts | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8', maxBuffer: 16_000_000
    })
    const paths = stdout.split('\0').filter(Boolean)
    if (!paths.length) return undefined
    const languageCounts = new Map<string, number>()
    const manifests = new Set<string>()
    const topLevelFolders = new Set<string>()
    for (const path of paths) {
      const language = EXTENSION_LANGUAGE[extname(path).toLowerCase()]
      if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1)
      const base = path.split('/').pop() ?? ''
      if (MANIFEST_NAMES.has(base)) manifests.add(base)
      const top = path.split('/')[0]
      if (top && top !== path) topLevelFolders.add(top)
    }
    const languages = [...languageCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 6).map(([name]) => name)
    return { languages, fileCount: paths.length, manifests: [...manifests], topLevelFolders: [...topLevelFolders].slice(0, 15) }
  } catch {
    return undefined
  }
}

// Cached per cwd for a few minutes — a task advises once at creation, but
// several tasks created back to back in the same repo should not each shell
// out to git. Failures (not a git repo, git missing) return undefined rather
// than throwing: repo facts are optional context, not a requirement.
export async function repoFacts(cwd: string): Promise<RepoFacts | undefined> {
  const cached = repoFactsCache.get(cwd)
  if (cached && Date.now() - cached.at < REPO_FACTS_TTL_MS) return cached.facts
  const facts = await computeRepoFacts(cwd)
  repoFactsCache.set(cwd, { at: Date.now(), facts })
  return facts
}

export function clearRepoFactsCache(): void {
  repoFactsCache.clear()
}

// ---- Credential storage (ADR 0002) ----
// The Jev API key is an auxiliary-service credential, not a model-execution
// key: encrypted with the same safeStorage codec/pattern as MCP OAuth tokens
// (mcp-auth.ts), stored in its own small file, and never sent to the renderer,
// which only ever learns `hasKey`.

export interface CredentialCipher {
  encrypt(value: string): string
  decrypt(value: string): string
}

interface StoredAdvisorKeyFile {
  version: 1
  encrypted?: string
}

export class AdvisorKeyManager {
  private encrypted: string | undefined

  constructor(private readonly filePath: string, private readonly cipher: CredentialCipher) {}

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<StoredAdvisorKeyFile>
      this.encrypted = typeof parsed.encrypted === 'string' ? parsed.encrypted : undefined
    } catch {
      // A missing file is the normal first-run state.
    }
  }

  hasKey(): boolean {
    return Boolean(this.encrypted)
  }

  // Decrypted lazily on every call rather than cached in memory in plaintext.
  getKey(): string | undefined {
    if (!this.encrypted) return undefined
    try {
      return this.cipher.decrypt(this.encrypted)
    } catch {
      return undefined
    }
  }

  async setKey(key: string): Promise<void> {
    const trimmed = key.trim()
    if (!trimmed) throw new Error('An API key is required.')
    this.encrypted = this.cipher.encrypt(trimmed)
    await this.save()
  }

  async clearKey(): Promise<void> {
    this.encrypted = undefined
    await this.save()
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    const file: StoredAdvisorKeyFile = { version: 1, encrypted: this.encrypted }
    await writeFile(temporary, JSON.stringify(file), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filePath)
  }
}
