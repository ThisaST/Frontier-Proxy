import { describe, expect, it } from 'vitest'
import { parseCodexLine } from '../src/main/providers'
import type { ActivityEvent, ContextSample, UsageSample } from '../src/shared/types'

// Real event shapes captured from codex-cli 0.146 `exec --json` (a task that
// created a file). These lock in the parsing the UI depends on for the file-
// changes panel, the usage totals, and the context meter.
const AGENT_MESSAGE = { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Creating the file.' } }
const FILE_CHANGE = { type: 'item.completed', item: { id: 'item_1', type: 'file_change', changes: [{ path: '/repo/hello.txt', kind: 'add' }], status: 'completed' } }
const SHELL = { type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: 'ls -la', exit_code: 0, status: 'completed' } }
const TURN_COMPLETED = { type: 'turn.completed', usage: { input_tokens: 46023, cached_input_tokens: 37120, output_tokens: 343, reasoning_output_tokens: 128 } }

function collect(events: object[]): { text: string; activity: ActivityEvent[]; usage?: UsageSample; context?: ContextSample } {
  const state = { text: '', activity: [] as ActivityEvent[], usage: undefined as UsageSample | undefined, context: undefined as ContextSample | undefined }
  const handlers = {
    onText: (t: string) => { state.text += t },
    onModel: () => {},
    onActivity: (e: ActivityEvent) => { state.activity.push(e) },
    onUsage: (u: UsageSample) => { state.usage = u },
    onContext: (c: ContextSample) => { state.context = c }
  }
  for (const event of events) parseCodexLine(event as Record<string, unknown>, handlers)
  return state
}

describe('codex stream parsing (real 0.146 events)', () => {
  it('records a file change with its path so the files panel can populate', () => {
    const { activity } = collect([FILE_CHANGE])
    const change = activity.find((event) => event.detail === '/repo/hello.txt')
    expect(change).toBeDefined()
    // kind "add" maps to the Write action recordFileChange treats as a create.
    expect(change?.label).toBe('Write')
  })

  it('streams agent text and surfaces shell commands as activity', () => {
    const { text, activity } = collect([AGENT_MESSAGE, SHELL])
    expect(text).toContain('Creating the file.')
    expect(activity.some((event) => event.label === 'Shell' && event.detail === 'ls -la')).toBe(true)
  })

  it('reports real usage tokens from turn.completed', () => {
    const { usage } = collect([TURN_COMPLETED])
    expect(usage).toEqual({ inputTokens: 46023, outputTokens: 343, costUsd: 0 })
  })

  it('derives context occupancy from input+output tokens (Codex reports no context field)', () => {
    const { context } = collect([TURN_COMPLETED])
    // Codex exposes no context_tokens/context_window, so the parser uses the
    // per-turn token totals as the occupancy; the engine supplies the window.
    expect(context).toEqual({ tokens: 46023 + 343, window: undefined })
  })
})
