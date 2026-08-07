import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildProviderCommand, parseAntigravityLine, runProvider, type AntigravityStreamState, type StreamHandlers } from '../src/main/providers'
import { controlPlaneInjection } from '../src/main/controlplane'
import type { ActivityEvent, ContextSample, ControlPlaneProfile, ProviderConfig, ResolvedSkill, UsageSample } from '../src/shared/types'

function provider(extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: 'antigravity', name: 'Antigravity', kind: 'antigravity', enabled: true, executable: 'agy', priority: 1, maxConcurrent: 1, capabilities: ['coding'], ...extra }
}

// Real event shapes captured from `agy 1.1.10 --output-format=stream-json`.
function collect(lines: object[]): { text: string; model?: string; activity: ActivityEvent[]; usage?: UsageSample; context?: ContextSample; sessionId?: string; state: AntigravityStreamState } {
  let text = ''
  let model: string | undefined
  let usage: UsageSample | undefined
  let context: ContextSample | undefined
  let sessionId: string | undefined
  const activity: ActivityEvent[] = []
  const handlers: StreamHandlers = {
    onText: (value) => { text += value },
    onModel: (value) => { model = value },
    onActivity: (event) => { activity.push(event) },
    onUsage: (value) => { usage = value },
    onContext: (value) => { context = value },
    onSessionId: (value) => { sessionId = value }
  }
  const state: AntigravityStreamState = { streamedText: false }
  for (const line of lines) parseAntigravityLine(line as Record<string, unknown>, handlers, state)
  return { text, model, activity, usage, context, sessionId, state }
}

const step = (body: object): object => ({ event: 'step_update', step_update: body })

describe('antigravity command', () => {
  // agy parses flags with Go's `flag` package: parsing stops at the first
  // non-flag argument and `-p` consumes the token after it. Anything placed
  // after the prompt is silently ignored by the CLI.
  it('puts every flag before -p and the prompt last', () => {
    const { args, promptInArgs } = buildProviderCommand(provider({ args: ['--effort=high'] }), '/repo', 'do it')
    expect(promptInArgs).toBe(true)
    expect(args.at(-2)).toBe('-p')
    expect(args.at(-1)).toBe('do it')
    expect(args.indexOf('--effort=high')).toBeLessThan(args.indexOf('-p'))
  })

  // Without --add-dir the agent writes into ~/.gemini/antigravity-cli/scratch/
  // even though the process cwd is correct, and only
  // --dangerously-skip-permissions actually executes tools (--mode=accept-edits
  // leaves every write soft-denied). Both are load-bearing, not cosmetic.
  it('scopes the workspace to the task cwd and enables tool execution', () => {
    const { args } = buildProviderCommand(provider(), '/repo/app', 'do it')
    expect(args).toContain('--add-dir=/repo/app')
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).toContain('--output-format=stream-json')
  })

  it('resumes a prior conversation by id', () => {
    const { args } = buildProviderCommand(provider(), '/repo', 'again', undefined, 'conv-1')
    expect(args).toContain('--conversation=conv-1')
  })

  it('never resumes another CLI session id', () => {
    const { args } = buildProviderCommand({ ...provider(), kind: 'copilot' }, '/repo', 'again', undefined, 'conv-1')
    expect(args.join(' ')).not.toContain('conv-1')
  })

  // promptInArgs skips the stdin write, so shared context has to be folded into
  // the argv prompt or it would be dropped on the floor.
  it('folds the shared control-plane context into the prompt argument', () => {
    const profile: ControlPlaneProfile = { systemPrompt: 'Prefer pnpm.', addDirs: [], allowedTools: [], disallowedTools: [], mcpServers: [], strictMcp: false }
    const command = buildProviderCommand(provider(), '/repo', 'do it', profile)
    expect(command.promptPrefix).toBeUndefined()
    expect(command.args.at(-1)).toBe('Prefer pnpm.\n\ndo it')
  })
})

describe('antigravity control plane', () => {
  const profile: ControlPlaneProfile = {
    systemPrompt: 'Prefer pnpm.',
    addDirs: ['/docs'],
    allowedTools: ['Edit'],
    disallowedTools: ['Bash'],
    mcpServers: [{ id: 'm1', name: 'files', enabled: true, transport: 'stdio', command: 'mcp-files' }],
    strictMcp: true
  }

  // agy has no per-run MCP flag and no tool allow/deny flags — they live in
  // settings.json, which Frontier must not write. Claiming otherwise in the
  // flag preview would tell the user their profile applied when it did not.
  it('injects only --add-dir, never MCP or tool allow/deny flags', () => {
    const { args } = controlPlaneInjection(provider(), profile)
    expect(args).toEqual(['--add-dir=/docs'])
    expect(args.join(' ')).not.toContain('mcp')
    expect(args.join(' ')).not.toContain('Edit')
    expect(args.join(' ')).not.toContain('Bash')
  })

  it('describes skills through the prompt and add-dirs their roots', () => {
    const skills: ResolvedSkill[] = [
      { id: 'a', name: 'deploy', description: 'ship it', enabled: true, sources: [{ root: '/skills/deploy', path: '/skills/deploy/SKILL.md', scope: 'personal', nativeFor: ['claude'] }] },
      { id: 'b', name: 'legacy', description: 'old', enabled: false, sources: [{ root: '/skills/legacy', path: '/skills/legacy/SKILL.md', scope: 'personal', nativeFor: ['claude'] }] }
    ]
    const { args, promptPrefix } = controlPlaneInjection(provider(), profile, skills)
    // No root is native to antigravity, so every enabled skill is ambient.
    expect(args).toContain('--add-dir=/skills/deploy')
    expect(promptPrefix).toContain('/skills/deploy/SKILL.md')
    expect(promptPrefix).toContain('Do not use these skills: "legacy"')
    // Skill(...) is a Claude-only flag; emitting it here would be invented.
    expect(args.join(' ')).not.toContain('Skill(')
  })

  it('opts out entirely when the provider disables the shared profile', () => {
    expect(controlPlaneInjection(provider({ useControlPlane: false }), profile).args).toEqual([])
  })
})

describe('antigravity stream parsing', () => {
  it('reads the model and conversation id from the init event', () => {
    const { model, sessionId } = collect([
      { event: 'init', conversation_id: 'conv-9', init: { model: 'gemini-3.6-flash-low', cwd: '/repo', permission_mode: 'request-review' } }
    ])
    expect(model).toBe('gemini-3.6-flash-low')
    expect(sessionId).toBe('conv-9')
  })

  it('streams agent_response deltas and suppresses the duplicate final response', () => {
    const { text } = collect([
      step({ step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'O' }),
      step({ step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'K' }),
      { event: 'result', result: { status: 'SUCCESS', response: 'OK' } }
    ])
    expect(text).toBe('OK')
  })

  it('falls back to the final response when nothing streamed', () => {
    const { text } = collect([{ event: 'result', result: { status: 'SUCCESS', response: 'done' } }])
    expect(text).toBe('done')
  })

  // ACTIVE and DONE repeat identical tool_info; reporting both would double
  // every entry in the activity feed.
  it('reports a tool call once, with a label recordFileChange understands', () => {
    const info = { name: 'write_to_file', parameters: { TargetFile: '/repo/app.ts' } }
    const { activity } = collect([
      step({ state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: info }),
      step({ state: 'DONE', step_type: 'tool', tool_name: 'write_to_file', tool_info: info })
    ])
    expect(activity).toHaveLength(1)
    expect(activity[0]).toMatchObject({ kind: 'tool', label: 'Write', detail: '/repo/app.ts' })
  })

  it('summarizes a PascalCase command parameter', () => {
    const { activity } = collect([
      step({ state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'pnpm test' } } })
    ])
    expect(activity[0]).toMatchObject({ label: 'run_command', detail: 'pnpm test' })
  })

  // The whole reason this provider needs special handling: a denied tool call
  // is reported inside a run that still exits 0 with status SUCCESS. Losing the
  // denial would mark a task complete that changed nothing.
  it('records a soft-denied tool call so the run can be failed', () => {
    const { state, activity } = collect([
      step({ state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { TargetFile: '/repo/app.ts' } } }),
      step({
        state: 'ERROR',
        step_type: 'tool',
        tool_name: 'write_to_file',
        tool_info: { name: 'write_to_file', error: { type: 'TOOL_ERROR', message: 'User denied permission for write_file(/repo/app.ts).' } }
      }),
      { event: 'result', result: { status: 'SUCCESS', response: '' } }
    ])
    expect(state.blocked).toContain('User denied permission')
    expect(activity.at(-1)).toMatchObject({ kind: 'tool', label: 'write_to_file' })
  })

  it('leaves an ordinary tool failure to the CLI exit code', () => {
    const { state } = collect([
      step({ state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', error: { message: 'exit status 1' } } })
    ])
    expect(state.blocked).toBeUndefined()
  })

  it('reports usage and pairs context occupancy with no reported window', () => {
    const { usage, context } = collect([
      { event: 'result', result: { status: 'SUCCESS', response: 'ok', usage: { input_tokens: 28_921, output_tokens: 6, total_tokens: 28_927 } } }
    ])
    expect(usage).toEqual({ inputTokens: 28_921, outputTokens: 6, costUsd: 0 })
    // agy never reports its model's window, so the engine marks this estimated.
    expect(context).toEqual({ tokens: 28_927, window: undefined })
  })
})

// A stand-in `agy` that reproduces the exact shape of a soft-denied run: the
// denial is reported on the stream and the process still exits 0. Needs a
// shebang because the real command line is not node-parseable.
async function fakeAgy(lines: object[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'frontier-agy-'))
  const path = join(dir, 'agy')
  const body = lines.map((line) => JSON.stringify(JSON.stringify(line))).join(' + "\\n" + ')
  await writeFile(path, `#!/usr/bin/env node\nprocess.stdout.write(${body} + "\\n");process.exit(0)\n`)
  await chmod(path, 0o755)
  return path
}

async function run(executable: string): Promise<{ ok: boolean; error?: string }> {
  const result = await runProvider(provider({ executable }), {
    prompt: 'edit the file', cwd: tmpdir(), signal: new AbortController().signal, onOutput: () => {}
  })
  return { ok: result.ok, error: result.error }
}

describe.skipIf(process.platform === 'win32')('antigravity soft-deny handling', () => {
  // Verified against agy 1.1.10: a denied write exits 0 with status SUCCESS.
  // Trusting the exit code marks a task complete that changed nothing.
  it('fails a run whose tool call was denied, despite exit 0', async () => {
    const executable = await fakeAgy([
      { event: 'init', conversation_id: 'c1', init: { model: 'gemini-3.6-flash-low' } },
      step({ state: 'ERROR', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', error: { message: 'User denied permission for write_file(/repo/app.ts).' } } }),
      { event: 'result', result: { status: 'SUCCESS', response: '' } }
    ])
    const { ok, error } = await run(executable)
    expect(ok).toBe(false)
    expect(error).toContain('denied a tool call')
  })

  it('still succeeds when no tool call was denied', async () => {
    const executable = await fakeAgy([
      { event: 'init', conversation_id: 'c1', init: { model: 'gemini-3.6-flash-low' } },
      step({ state: 'ACTIVE', step_type: 'agent_response', text_delta: 'done' }),
      { event: 'result', result: { status: 'SUCCESS', response: 'done' } }
    ])
    expect((await run(executable)).ok).toBe(true)
  })
})
