import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import spawn from 'cross-spawn'
import type { ProviderConfig } from '../shared/types'

export type RunFailureKind = 'quota' | 'unavailable' | 'failed' | 'cancelled'

export interface ProviderRunResult {
  ok: boolean
  output: string
  error?: string
  failureKind?: RunFailureKind
}

interface RunOptions {
  prompt: string
  cwd: string
  signal: AbortSignal
  onOutput: (text: string) => void
}

const QUOTA_PATTERN = /(rate.?limit|usage.?limit|request.?limit|premium requests?|monthly limit|quota|overloaded|capacity|too many requests|credits? exhausted)/i

const COPILOT_SAFE_TOOLS = 'write, shell(git:*), shell(npm:*), shell(npx:*), shell(pnpm:*), shell(yarn:*), shell(bun:*), shell(cargo:*), shell(go:*), shell(pytest:*)'

export function buildProviderCommand(provider: ProviderConfig, cwd: string, prompt: string): { executable: string; args: string[]; promptInArgs?: boolean } {
  const extra = provider.args ?? []
  switch (provider.kind) {
    case 'codex':
      return {
        executable: provider.executable,
        args: ['exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', cwd,
          ...(provider.model ? ['--model', provider.model] : []), ...extra, '-']
      }
    case 'codex-oss':
      return {
        executable: provider.executable,
        args: ['exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', cwd,
          '--oss', '--local-provider', 'ollama', ...(provider.model ? ['--model', provider.model] : []), ...extra, '-']
      }
    case 'claude':
      return {
        executable: provider.executable,
        args: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'acceptEdits',
          ...(provider.model ? ['--model', provider.model] : []), ...extra]
      }
    case 'copilot':
      return {
        executable: provider.executable,
        args: ['-s', '--no-ask-user', `--allow-tool=${COPILOT_SAFE_TOOLS}`,
          ...(provider.model ? ['--model', provider.model] : []), ...extra]
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

function extractCodexEvent(value: Record<string, unknown>): string {
  if (value.type === 'item.completed' || value.type === 'item.updated') {
    const item = value.item as Record<string, unknown> | undefined
    if (item?.type === 'agent_message' && typeof item.text === 'string') return item.text
  }
  if (value.type === 'error' && typeof value.message === 'string') return `\n${value.message}\n`
  return ''
}

function extractClaudeEvent(value: Record<string, unknown>): string {
  if (value.type === 'content_block_delta') {
    const delta = value.delta as Record<string, unknown> | undefined
    return typeof delta?.text === 'string' ? delta.text : ''
  }
  if (value.type === 'result' && typeof value.result === 'string') return value.result
  return ''
}

function consumeJsonLines(
  process: ChildProcessWithoutNullStreams,
  provider: ProviderConfig,
  onText: (text: string) => void
): { getOutput: () => string; getRawError: () => string } {
  let pending = ''
  let output = ''
  let rawError = ''
  let streamedClaudeText = false

  process.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    if (provider.kind === 'ollama' || provider.kind === 'copilot' || provider.kind === 'custom') {
      output += text
      onText(text)
      return
    }
    pending += text
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as Record<string, unknown>
        let extracted = provider.kind === 'claude' ? extractClaudeEvent(event) : extractCodexEvent(event)
        if (provider.kind === 'claude' && event.type === 'content_block_delta' && extracted) streamedClaudeText = true
        if (provider.kind === 'claude' && event.type === 'result' && streamedClaudeText) extracted = ''
        if (extracted) {
          output += extracted
          onText(extracted)
        }
      } catch {
        rawError += `${line}\n`
      }
    }
  })
  process.stderr.on('data', (chunk: Buffer) => { rawError += chunk.toString('utf8') })

  return {
    getOutput: () => output || pending.trim(),
    getRawError: () => rawError.trim()
  }
}

export async function runProvider(provider: ProviderConfig, options: RunOptions): Promise<ProviderRunResult> {
  const command = buildProviderCommand(provider, options.cwd, options.prompt)
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

    const collected = consumeJsonLines(child, provider, options.onOutput)
    const abort = (): void => { child.kill() }
    options.signal.addEventListener('abort', abort, { once: true })

    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      options.signal.removeEventListener('abort', abort)
      resolve({ ok: false, output: collected.getOutput(), error: error.message, failureKind: error.code === 'ENOENT' ? 'unavailable' : 'failed' })
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      options.signal.removeEventListener('abort', abort)
      const output = collected.getOutput()
      const error = collected.getRawError()
      if (options.signal.aborted || signal) resolve({ ok: false, output, error: 'Task cancelled.', failureKind: 'cancelled' })
      else if (code === 0) resolve({ ok: true, output })
      else resolve({ ok: false, output, error: error || `Provider exited with code ${code}.`, failureKind: QUOTA_PATTERN.test(`${error}\n${output}`) ? 'quota' : 'failed' })
    })

    child.stdin.end(command.promptInArgs ? undefined : options.prompt)
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
