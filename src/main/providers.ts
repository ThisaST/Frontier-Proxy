import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import spawn from 'cross-spawn'
import type { ActivityEvent, ContextSample, ControlPlaneProfile, ProviderConfig, SessionInfo, UsageSample } from '../shared/types'
import { controlPlaneInjection } from './controlplane'

export type RunFailureKind = 'quota' | 'unavailable' | 'failed' | 'cancelled'

export interface ProviderRunResult {
  ok: boolean
  output: string
  error?: string
  failureKind?: RunFailureKind
  model?: string
  usage?: UsageSample
  session?: SessionInfo
  sessionId?: string
}

interface RunOptions {
  prompt: string
  cwd: string
  signal: AbortSignal
  onOutput: (text: string) => void
  onModel?: (model: string) => void
  onActivity?: (event: ActivityEvent) => void
  onUsage?: (usage: UsageSample) => void
  onContext?: (context: ContextSample) => void
  onSession?: (session: SessionInfo) => void
  onSessionId?: (sessionId: string) => void
  controlPlane?: ControlPlaneProfile
  // Resume a prior CLI session (Claude --resume) to continue in-context.
  resumeSessionId?: string
  imagePaths?: string[]
}

export interface StreamHandlers {
  onText: (text: string) => void
  onModel: (model: string) => void
  onActivity: (event: ActivityEvent) => void
  onUsage?: (usage: UsageSample) => void
  onContext?: (context: ContextSample) => void
  onSession?: (session: SessionInfo) => void
  onSessionId?: (sessionId: string) => void
}

const QUOTA_PATTERN = /(rate.?limit|usage.?limit|request.?limit|premium requests?|monthly limit|quota|overloaded|capacity|too many requests|credits? exhausted)/i

const COPILOT_SAFE_TOOLS = 'write, shell(git:*), shell(npm:*), shell(npx:*), shell(pnpm:*), shell(yarn:*), shell(bun:*), shell(cargo:*), shell(go:*), shell(pytest:*)'

function copilotGithubMcpArgs(provider: ProviderConfig): string[] {
  if (provider.copilotEnableAllGithubMcpTools) return ['--enable-all-github-mcp-tools']
  const toolsets = [...new Set((provider.copilotGithubMcpToolsets ?? []).map((value) => value.trim()).filter(Boolean))]
  const tools = [...new Set((provider.copilotGithubMcpTools ?? []).map((value) => value.trim()).filter(Boolean))]
  return [
    ...toolsets.map((toolset) => `--add-github-mcp-toolset=${toolset}`),
    ...tools.map((tool) => `--add-github-mcp-tool=${tool}`)
  ]
}

export interface ProviderCommand {
  executable: string
  args: string[]
  env?: Record<string, string>
  promptInArgs?: boolean
  // Context folded into stdin only for CLIs that lack a native
  // system/developer-instruction channel.
  promptPrefix?: string
}

export function buildProviderCommand(provider: ProviderConfig, cwd: string, prompt: string, profile?: ControlPlaneProfile, resumeSessionId?: string, imagePaths: string[] = []): ProviderCommand {
  const extra = provider.args ?? []
  const cp = profile ? controlPlaneInjection(provider, profile) : { args: [] as string[], promptPrefix: undefined as string | undefined }
  const resume = resumeSessionId && provider.kind === 'claude' ? ['--resume', resumeSessionId] : []
  switch (provider.kind) {
    case 'codex':
      return {
        executable: provider.executable,
        args: ['exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', cwd,
          ...(provider.model ? ['--model', provider.model] : []), ...imagePaths.flatMap((path) => ['--image', path]), ...cp.args, ...extra, '-'],
        promptPrefix: cp.promptPrefix,
        env: cp.env
      }
    case 'codex-oss':
      return {
        executable: provider.executable,
        args: ['exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', cwd,
          '--oss', '--local-provider', 'ollama', ...(provider.model ? ['--model', provider.model] : []), ...imagePaths.flatMap((path) => ['--image', path]), ...cp.args, ...extra, '-'],
        promptPrefix: cp.promptPrefix,
        env: cp.env
      }
    case 'claude':
      return {
        executable: provider.executable,
        args: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'acceptEdits',
          ...resume, ...(provider.model ? ['--model', provider.model] : []), ...cp.args, ...extra],
        promptPrefix: cp.promptPrefix,
        env: cp.env
      }
    case 'copilot':
      return {
        executable: provider.executable,
        args: ['-s', '--no-ask-user', `--allow-tool=${COPILOT_SAFE_TOOLS}`,
          ...(provider.model ? ['--model', provider.model] : []), ...copilotGithubMcpArgs(provider), ...cp.args, ...extra],
        promptPrefix: cp.promptPrefix,
        env: cp.env
      }
    case 'ollama':
      return { executable: provider.executable, args: ['run', provider.model || 'qwen3-coder', ...extra] }
    case 'custom':
      const promptInArgs = extra.some((argument) => argument.includes('{prompt}'))
      return {
        executable: provider.executable,
        args: extra.map((argument) => argument.replaceAll('{cwd}', cwd).replaceAll('{model}', provider.model ?? '').replaceAll('{prompt}', prompt)),
        promptInArgs
      }
  }
}

type Dict = Record<string, unknown>

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function utilizationPercent(info: Dict): number | undefined {
  const raw = finiteNumber(info.utilization ?? info.utilizationPercent ?? info.utilization_percent ?? info.usedPercent ?? info.used_percent)
  if (raw === undefined || raw < 0) return undefined
  return Math.min(100, raw <= 1 ? raw * 100 : raw)
}

function timestampIso(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const time = Date.parse(value)
    return Number.isFinite(time) ? new Date(time).toISOString() : undefined
  }
  const numeric = finiteNumber(value)
  if (numeric === undefined) return undefined
  return new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric).toISOString()
}

function inputTokens(usage: Dict | undefined): number | undefined {
  if (!usage) return undefined
  const values = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens]
  if (!values.some((value) => finiteNumber(value) !== undefined)) return undefined
  return values.reduce<number>((total, value) => total + (finiteNumber(value) ?? 0), 0)
}

interface ClaudeStreamState {
  streamedText: boolean
  thinking: string
  model?: string
  contextInputTokens?: number
  contextOutputTokens: number
  contextWindow?: number
}

function emitClaudeContext(handlers: StreamHandlers, state: ClaudeStreamState): void {
  if (state.contextInputTokens === undefined) return
  handlers.onContext?.({ tokens: state.contextInputTokens + state.contextOutputTokens, window: state.contextWindow })
}

function updateClaudeMessageContext(message: Dict | undefined, handlers: StreamHandlers, state: ClaudeStreamState): void {
  const usage = message?.usage as Dict | undefined
  const input = inputTokens(usage)
  if (input === undefined) return
  state.contextInputTokens = input
  state.contextOutputTokens = finiteNumber(usage?.output_tokens) ?? 0
  emitClaudeContext(handlers, state)
}

function modelContextWindow(modelUsage: Dict | undefined, model?: string): number | undefined {
  if (!modelUsage) return undefined
  const matching = model ? Object.entries(modelUsage).find(([name]) => canonicalModel(name) === model)?.[1] as Dict | undefined : undefined
  const matchedWindow = finiteNumber(matching?.contextWindow ?? matching?.context_window)
  if (matchedWindow && matchedWindow > 0) return matchedWindow
  let largest: number | undefined
  for (const entry of Object.values(modelUsage)) {
    const window = finiteNumber((entry as Dict)?.contextWindow ?? (entry as Dict)?.context_window)
    if (window && window > (largest ?? 0)) largest = window
  }
  return largest
}

// Model tags can carry suffixes like "[1m]" (1M-context). Show the canonical id.
function canonicalModel(model: string): string {
  return model.replace(/\[[^\]]*\]\s*$/, '').trim()
}

function condense(text: string, limit = 140): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > limit ? `${single.slice(0, limit)}…` : single
}

// The most meaningful string in a tool's input, for a one-line activity detail.
function summarizeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const dict = input as Dict
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'notebook_path', 'prompt', 'description']) {
    const value = dict[key]
    if (typeof value === 'string' && value.trim()) return condense(value, 120)
  }
  return undefined
}

// Parse one Claude Code stream-json line. Text is streamed incrementally via
// content_block_delta; tool calls and thinking become activity events.
export function parseClaudeLine(event: Dict, handlers: StreamHandlers, state: ClaudeStreamState): void {
  const type = event.type
  if (type === 'system' && event.subtype === 'init') {
    if (typeof event.model === 'string') { state.model = canonicalModel(event.model); handlers.onModel(state.model) }
    if (typeof event.session_id === 'string') handlers.onSessionId?.(event.session_id)
    return
  }
  if (type === 'rate_limit_event') {
    const info = (event.rate_limit_info ?? event.rateLimitInfo) as Dict | undefined
    if (info) handlers.onSession?.({
      resetsAt: timestampIso(info.resetsAt ?? info.resets_at),
      overageResetsAt: timestampIso(info.overageResetsAt ?? info.overage_resets_at),
      usingOverage: typeof (info.isUsingOverage ?? info.is_using_overage) === 'boolean' ? Boolean(info.isUsingOverage ?? info.is_using_overage) : undefined,
      status: typeof info.status === 'string' ? info.status : typeof (info.overageStatus ?? info.overage_status) === 'string' ? String(info.overageStatus ?? info.overage_status) : undefined,
      utilizationPercent: utilizationPercent(info),
      limitType: typeof (info.rateLimitType ?? info.rate_limit_type) === 'string' ? String(info.rateLimitType ?? info.rate_limit_type).replaceAll('_', ' ') : 'reported',
      updatedAt: new Date().toISOString()
    })
    return
  }
  if (type === 'stream_event') {
    const inner = event.event as Dict | undefined
    const innerType = inner?.type
    if (innerType === 'message_start') {
      const message = inner?.message as Dict | undefined
      if (typeof message?.model === 'string') { state.model = canonicalModel(message.model); handlers.onModel(state.model) }
      updateClaudeMessageContext(message, handlers, state)
    } else if (innerType === 'message_delta') {
      const usage = inner?.usage as Dict | undefined
      const output = finiteNumber(usage?.output_tokens)
      if (output !== undefined) { state.contextOutputTokens = output; emitClaudeContext(handlers, state) }
    } else if (innerType === 'content_block_delta') {
      const delta = inner?.delta as Dict | undefined
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') { state.streamedText = true; handlers.onText(delta.text) }
      else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') state.thinking += delta.thinking
    } else if (innerType === 'content_block_stop' && state.thinking.trim()) {
      handlers.onActivity({ kind: 'thinking', label: 'Thinking', detail: condense(state.thinking), at: new Date().toISOString() })
      state.thinking = ''
    }
    return
  }
  if (type === 'assistant') {
    const message = event.message as Dict | undefined
    updateClaudeMessageContext(message, handlers, state)
    const content = message?.content as Dict[] | undefined
    for (const block of content ?? []) {
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        handlers.onActivity({ kind: 'tool', label: String(block.name), detail: summarizeToolInput(block.input), at: new Date().toISOString() })
      }
    }
    return
  }
  if (type === 'result') {
    const usage = event.usage as Dict | undefined
    if (usage) {
      handlers.onUsage?.({ inputTokens: inputTokens(usage) ?? 0, outputTokens: finiteNumber(usage.output_tokens) ?? 0, costUsd: finiteNumber(event.total_cost_usd) ?? 0 })
    }
    state.contextWindow = modelContextWindow(event.modelUsage as Dict | undefined, state.model)
    emitClaudeContext(handlers, state)
    if (typeof event.result === 'string' && !state.streamedText) handlers.onText(event.result)
  }
}

// Best-effort parse for Codex `exec --json` events (agent text, shell/file/MCP activity).
export function parseCodexLine(event: Dict, handlers: StreamHandlers): void {
  if (typeof event.model === 'string') handlers.onModel(canonicalModel(event.model))
  if (event.type === 'turn.completed') {
    const usage = event.usage as Dict | undefined
    if (usage) {
      const input = Number(usage.input_tokens ?? 0)
      const contextWindow = finiteNumber(usage.context_window ?? event.context_window ?? event.model_context_window)
      handlers.onUsage?.({
        inputTokens: input,
        outputTokens: Number(usage.output_tokens ?? 0),
        costUsd: 0
      })
      const explicitContext = finiteNumber(usage.context_tokens ?? usage.current_context_tokens ?? event.context_tokens)
      if (explicitContext !== undefined) handlers.onContext?.({ tokens: explicitContext, window: contextWindow })
    }
  }
  if (event.type === 'item.completed' || event.type === 'item.updated') {
    const item = event.item as Dict | undefined
    const at = new Date().toISOString()
    if (item?.type === 'agent_message' && typeof item.text === 'string') handlers.onText(item.text)
    else if (item?.type === 'command_execution' && typeof item.command === 'string') handlers.onActivity({ kind: 'tool', label: 'Shell', detail: condense(item.command, 120), at })
    else if (item?.type === 'file_change') {
      const changes = Array.isArray(item.changes) ? item.changes as Dict[] : [item]
      for (const change of changes) {
        if (typeof change.path !== 'string') continue
        const kind = String(change.kind ?? change.action ?? '').toLowerCase()
        const label = kind.includes('add') || kind.includes('create') ? 'Write' : kind.includes('delete') || kind.includes('remove') ? 'Delete' : 'Edit'
        handlers.onActivity({ kind: 'tool', label, detail: change.path, at })
      }
    }
    else if (item?.type === 'mcp_tool_call') handlers.onActivity({ kind: 'tool', label: typeof item.tool === 'string' ? item.tool : 'MCP', detail: typeof item.server === 'string' ? item.server : undefined, at })
    else if (item?.type === 'reasoning' && typeof item.text === 'string') handlers.onActivity({ kind: 'thinking', label: 'Thinking', detail: condense(item.text), at })
  }
  if (event.type === 'error' && typeof event.message === 'string') handlers.onText(`\n${event.message}\n`)
}

function consumeJsonLines(
  process: ChildProcessWithoutNullStreams,
  provider: ProviderConfig,
  handlers: StreamHandlers
): { getOutput: () => string; getRawError: () => string; getModel: () => string | undefined; getUsage: () => UsageSample | undefined; getSession: () => SessionInfo | undefined; getSessionId: () => string | undefined } {
  let pending = ''
  let output = ''
  let rawError = ''
  let model: string | undefined
  let usage: UsageSample | undefined
  let session: SessionInfo | undefined
  let sessionId: string | undefined
  const state: ClaudeStreamState = { streamedText: false, thinking: '', contextOutputTokens: 0 }
  const textHandlers: StreamHandlers = {
    onText: (text) => { output += text; handlers.onText(text) },
    onModel: (value) => { model = value; handlers.onModel(value) },
    onActivity: handlers.onActivity,
    onUsage: (value) => { usage = value; handlers.onUsage?.(value) },
    onContext: (value) => { handlers.onContext?.(value) },
    onSession: (value) => { session = value; handlers.onSession?.(value) },
    onSessionId: (value) => { sessionId = value; handlers.onSessionId?.(value) }
  }

  process.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    if (provider.kind === 'ollama' || provider.kind === 'copilot' || provider.kind === 'custom') {
      output += text
      handlers.onText(text)
      return
    }
    pending += text
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as Dict
        if (provider.kind === 'claude') parseClaudeLine(event, textHandlers, state)
        else parseCodexLine(event, textHandlers)
      } catch {
        rawError += `${line}\n`
      }
    }
  })
  process.stderr.on('data', (chunk: Buffer) => { rawError += chunk.toString('utf8') })

  return {
    getOutput: () => output || pending.trim(),
    getRawError: () => rawError.trim(),
    getModel: () => model,
    getUsage: () => usage,
    getSession: () => session,
    getSessionId: () => sessionId
  }
}

export async function runProvider(provider: ProviderConfig, options: RunOptions): Promise<ProviderRunResult> {
  const command = buildProviderCommand(provider, options.cwd, options.prompt, options.controlPlane, options.resumeSessionId, options.imagePaths)
  return await new Promise((resolve) => {
    let settled = false
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command.executable, command.args, {
        cwd: options.cwd,
        env: { ...process.env, ...(command.env ?? {}) },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      }) as ChildProcessWithoutNullStreams
    } catch (error) {
      resolve({ ok: false, output: '', error: String(error), failureKind: 'unavailable' })
      return
    }

    const collected = consumeJsonLines(child, provider, {
      onText: options.onOutput,
      onModel: (model) => options.onModel?.(model),
      onActivity: (event) => options.onActivity?.(event),
      onUsage: (usage) => options.onUsage?.(usage),
      onContext: (context) => options.onContext?.(context),
      onSession: (session) => options.onSession?.(session),
      onSessionId: (sessionId) => options.onSessionId?.(sessionId)
    })
    const abort = (): void => { child.kill() }
    options.signal.addEventListener('abort', abort, { once: true })

    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      options.signal.removeEventListener('abort', abort)
      resolve({ ok: false, output: collected.getOutput(), error: error.message, failureKind: error.code === 'ENOENT' ? 'unavailable' : 'failed', model: collected.getModel() })
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      options.signal.removeEventListener('abort', abort)
      const output = collected.getOutput()
      const error = collected.getRawError()
      const model = collected.getModel()
      const usage = collected.getUsage()
      const session = collected.getSession()
      const sessionId = collected.getSessionId()
      if (options.signal.aborted || signal) resolve({ ok: false, output, error: 'Task cancelled.', failureKind: 'cancelled', model, usage, session, sessionId })
      else if (code === 0) resolve({ ok: true, output, model, usage, session, sessionId })
      else resolve({ ok: false, output, error: error || `Provider exited with code ${code}.`, failureKind: QUOTA_PATTERN.test(`${error}\n${output}`) ? 'quota' : 'failed', model, usage, session, sessionId })
    })

    const stdinPrompt = command.promptPrefix ? `${command.promptPrefix}\n\n${options.prompt}` : options.prompt
    child.stdin.end(command.promptInArgs ? undefined : stdinPrompt)
  })
}

async function checkCommand(executable: string, args: string[]): Promise<{ available: boolean; version?: string }> {
  return await new Promise((resolve) => {
    let output = ''
    let settled = false
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill()
        resolve({ available: false })
      }
    }, 5_000)
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.once('error', () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ available: false })
      }
    })
    child.once('close', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ available: code === 0, version: output.trim().split(/\r?\n/)[0] || undefined })
      }
    })
  })
}

export async function checkProvider(provider: ProviderConfig): Promise<{ available: boolean; version?: string }> {
  const primary = await checkCommand(provider.executable, provider.kind === 'ollama' ? ['list'] : ['--version'])
  if (!primary.available || provider.kind !== 'codex-oss') return primary
  const ollama = await checkCommand('ollama', ['list'])
  return { available: ollama.available, version: primary.version }
}

// Curated known models per subscription CLI. These CLIs have no headless
// "list models" command, so we ship a sensible default set; the user can still
// type any model id via the "Custom model" option in the New Task dialog.
const KNOWN_MODELS: Partial<Record<ProviderConfig['kind'], string[]>> = {
  claude: ['claude-opus-4-8', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
  codex: ['gpt-5-codex', 'gpt-5', 'o4-mini'],
  copilot: ['claude-sonnet-4.5', 'claude-sonnet-4', 'gpt-5', 'gpt-5-mini', 'o3']
}

// Run a command and capture its full stdout (unlike checkCommand's first line).
function captureCommand(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
    } catch { resolve(''); return }
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill(); resolve(output) } }, 5_000)
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.once('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve('') } })
    child.once('close', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(output) } })
  })
}

// Parse `ollama list` (whitespace-columned table) into model names.
function parseOllamaModels(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((line) => line.split(/\s+/)[0])
    .filter((name) => name && name.toUpperCase() !== 'NAME')
}

// Models this provider can run. Real discovery for Ollama-backed providers
// (`ollama list`); a curated known set for the subscription CLIs. The provider's
// own configured model is always included so it appears selectable.
export async function discoverModels(provider: ProviderConfig): Promise<string[]> {
  const set = new Set<string>()
  if (provider.model?.trim()) set.add(provider.model.trim())
  if (provider.kind === 'ollama') {
    for (const name of parseOllamaModels(await captureCommand(provider.executable, ['list']))) set.add(name)
  } else if (provider.kind === 'codex-oss') {
    for (const name of parseOllamaModels(await captureCommand('ollama', ['list']))) set.add(name)
  } else {
    for (const name of KNOWN_MODELS[provider.kind] ?? []) set.add(name)
  }
  return [...set]
}
