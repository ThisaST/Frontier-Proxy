import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import spawn from 'cross-spawn'
import type { ActivityEvent, ControlPlaneProfile, ProviderConfig, SessionInfo, UsageSample } from '../shared/types'
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
  onSession?: (session: SessionInfo) => void
  onSessionId?: (sessionId: string) => void
  controlPlane?: ControlPlaneProfile
  // Resume a prior CLI session (Claude --resume) to continue in-context.
  resumeSessionId?: string
}

export interface StreamHandlers {
  onText: (text: string) => void
  onModel: (model: string) => void
  onActivity: (event: ActivityEvent) => void
  onUsage?: (usage: UsageSample) => void
  onSession?: (session: SessionInfo) => void
  onSessionId?: (sessionId: string) => void
}

const QUOTA_PATTERN = /(rate.?limit|usage.?limit|request.?limit|premium requests?|monthly limit|quota|overloaded|capacity|too many requests|credits? exhausted)/i

const COPILOT_SAFE_TOOLS = 'write, shell(git:*), shell(npm:*), shell(npx:*), shell(pnpm:*), shell(yarn:*), shell(bun:*), shell(cargo:*), shell(go:*), shell(pytest:*)'

export interface ProviderCommand {
  executable: string
  args: string[]
  promptInArgs?: boolean
  // Context (e.g. system prompt) folded into the stdin prompt for CLIs that
  // lack a native system-prompt flag.
  promptPrefix?: string
}

export function buildProviderCommand(provider: ProviderConfig, cwd: string, prompt: string, profile?: ControlPlaneProfile, resumeSessionId?: string): ProviderCommand {
  const extra = provider.args ?? []
  const cp = profile ? controlPlaneInjection(provider, profile) : { args: [] as string[], promptPrefix: undefined as string | undefined }
  const resume = resumeSessionId && provider.kind === 'claude' ? ['--resume', resumeSessionId] : []
  switch (provider.kind) {
    case 'codex':
      return {
        executable: provider.executable,
        args: ['exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', cwd,
          ...(provider.model ? ['--model', provider.model] : []), ...cp.args, ...extra, '-'],
        promptPrefix: cp.promptPrefix
      }
    case 'codex-oss':
      return {
        executable: provider.executable,
        args: ['exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', cwd,
          '--oss', '--local-provider', 'ollama', ...(provider.model ? ['--model', provider.model] : []), ...cp.args, ...extra, '-'],
        promptPrefix: cp.promptPrefix
      }
    case 'claude':
      return {
        executable: provider.executable,
        args: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'acceptEdits',
          ...resume, ...(provider.model ? ['--model', provider.model] : []), ...cp.args, ...extra],
        promptPrefix: cp.promptPrefix
      }
    case 'copilot':
      return {
        executable: provider.executable,
        args: ['-s', '--no-ask-user', `--allow-tool=${COPILOT_SAFE_TOOLS}`,
          ...(provider.model ? ['--model', provider.model] : []), ...cp.args, ...extra],
        promptPrefix: cp.promptPrefix
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
export function parseClaudeLine(event: Dict, handlers: StreamHandlers, state: { streamedText: boolean; thinking: string }): void {
  const type = event.type
  if (type === 'system' && event.subtype === 'init') {
    if (typeof event.model === 'string') handlers.onModel(canonicalModel(event.model))
    if (typeof event.session_id === 'string') handlers.onSessionId?.(event.session_id)
    return
  }
  if (type === 'rate_limit_event') {
    const info = event.rate_limit_info as Dict | undefined
    if (info) handlers.onSession?.({
      resetsAt: typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toISOString() : undefined,
      overageResetsAt: typeof info.overageResetsAt === 'number' ? new Date(info.overageResetsAt * 1000).toISOString() : undefined,
      usingOverage: typeof info.isUsingOverage === 'boolean' ? info.isUsingOverage : undefined,
      status: typeof info.status === 'string' ? info.status : typeof info.overageStatus === 'string' ? info.overageStatus : undefined,
      updatedAt: new Date().toISOString()
    })
    return
  }
  if (type === 'stream_event') {
    const inner = event.event as Dict | undefined
    const innerType = inner?.type
    if (innerType === 'message_start') {
      const message = inner?.message as Dict | undefined
      if (typeof message?.model === 'string') handlers.onModel(canonicalModel(message.model))
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
      const input = Number(usage.input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0)
      // The active model's context window (largest wins over sub-agent models).
      let contextWindow: number | undefined
      const modelUsage = event.modelUsage as Dict | undefined
      if (modelUsage) for (const entry of Object.values(modelUsage)) {
        const window = Number((entry as Dict)?.contextWindow ?? 0)
        if (window > (contextWindow ?? 0)) contextWindow = window
      }
      handlers.onUsage?.({ inputTokens: input, outputTokens: Number(usage.output_tokens ?? 0), costUsd: Number(event.total_cost_usd ?? 0), contextTokens: input, contextWindow })
    }
    if (typeof event.result === 'string' && !state.streamedText) handlers.onText(event.result)
  }
}

// Best-effort parse for Codex `exec --json` events (agent text, shell/file/MCP activity).
function parseCodexLine(event: Dict, handlers: StreamHandlers): void {
  if (typeof event.model === 'string') handlers.onModel(canonicalModel(event.model))
  if (event.type === 'item.completed' || event.type === 'item.updated') {
    const item = event.item as Dict | undefined
    const at = new Date().toISOString()
    if (item?.type === 'agent_message' && typeof item.text === 'string') handlers.onText(item.text)
    else if (item?.type === 'command_execution' && typeof item.command === 'string') handlers.onActivity({ kind: 'tool', label: 'Shell', detail: condense(item.command, 120), at })
    else if (item?.type === 'file_change') handlers.onActivity({ kind: 'tool', label: 'Edit', detail: typeof item.path === 'string' ? item.path : undefined, at })
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
  const state = { streamedText: false, thinking: '' }
  const textHandlers: StreamHandlers = {
    onText: (text) => { output += text; handlers.onText(text) },
    onModel: (value) => { model = value; handlers.onModel(value) },
    onActivity: handlers.onActivity,
    onUsage: (value) => { usage = value; handlers.onUsage?.(value) },
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
  const command = buildProviderCommand(provider, options.cwd, options.prompt, options.controlPlane, options.resumeSessionId)
  return await new Promise((resolve) => {
    let settled = false
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command.executable, command.args, {
        cwd: options.cwd,
        env: process.env,
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
