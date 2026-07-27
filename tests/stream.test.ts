import { describe, expect, it } from 'vitest'
import { parseClaudeLine, parseCodexLine, type StreamHandlers } from '../src/main/providers'
import type { ActivityEvent, ContextSample, SessionInfo, UsageSample } from '../src/shared/types'

// Real event shapes captured from `claude -p --output-format stream-json`.
function collect(lines: object[]): { text: string; model?: string; activity: ActivityEvent[]; usage?: UsageSample; context?: ContextSample; sessions: SessionInfo[] } {
  let text = ''
  let model: string | undefined
  let usage: UsageSample | undefined
  let context: ContextSample | undefined
  const sessions: SessionInfo[] = []
  const activity: ActivityEvent[] = []
  const handlers: StreamHandlers = {
    onText: (value) => { text += value },
    onModel: (value) => { model = value },
    onActivity: (event) => { activity.push(event) },
    onUsage: (value) => { usage = value },
    onContext: (value) => { context = value },
    onSession: (value) => { sessions.push(value) }
  }
  const state = { streamedText: false, thinking: '', contextOutputTokens: 0 }
  for (const line of lines) parseClaudeLine(line as Record<string, unknown>, handlers, state)
  return { text, model, activity, usage, context, sessions }
}

describe('claude stream parsing', () => {
  it('detects the underlying model and strips context-window suffixes', () => {
    const { model } = collect([{ type: 'system', subtype: 'init', model: 'claude-opus-4-8[1m]' }])
    expect(model).toBe('claude-opus-4-8')
  })

  it('streams text deltas and suppresses the duplicate final result', () => {
    const { text } = collect([
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'O' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'K' } } },
      { type: 'result', result: 'OK' }
    ])
    expect(text).toBe('OK')
  })

  it('falls back to the result text when nothing streamed', () => {
    expect(collect([{ type: 'result', result: 'Final answer' }]).text).toBe('Final answer')
  })

  it('surfaces tool calls as activity with a meaningful detail', () => {
    const { activity } = collect([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/main.ts' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }] } }
    ])
    expect(activity).toHaveLength(2)
    expect(activity[0]).toMatchObject({ kind: 'tool', label: 'Read', detail: 'src/main.ts' })
    expect(activity[1]).toMatchObject({ kind: 'tool', label: 'Bash', detail: 'git status' })
  })

  it('collects thinking deltas into a single activity entry', () => {
    const { activity } = collect([
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Let me ' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'check the config.' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }
    ])
    expect(activity).toHaveLength(1)
    expect(activity[0]).toMatchObject({ kind: 'thinking', label: 'Thinking', detail: 'Let me check the config.' })
  })

  it('keeps cumulative usage separate from the latest request context', () => {
    const { usage, context, sessions } = collect([
      { type: 'rate_limit_event', rate_limit_info: { resetsAt: 2_000_000_000, rateLimitType: 'five_hour', utilization: 0.26, status: 'allowed' } },
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-opus-4-8', usage: { input_tokens: 700, cache_read_input_tokens: 300 } } } },
      { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 40 } } },
      { type: 'result', usage: { input_tokens: 7_000, cache_read_input_tokens: 30_000, output_tokens: 400 }, modelUsage: { 'claude-opus-4-8': { contextWindow: 200_000 } } }
    ])
    expect(usage).toEqual({ inputTokens: 37_000, outputTokens: 400, costUsd: 0 })
    expect(context).toEqual({ tokens: 1_040, window: 200_000 })
    expect(sessions[0]).toMatchObject({ limitType: 'five hour', utilizationPercent: 26, status: 'allowed' })
  })

  it('parses multiple plan-window events and snake-case fields independently', () => {
    const { sessions } = collect([
      { type: 'rate_limit_event', rate_limit_info: { resetsAt: 2_000_000_000, rateLimitType: 'five_hour', utilization: 0.26, status: 'allowed' } },
      { type: 'rate_limit_event', rate_limit_info: { resets_at: '2033-05-18T03:33:20.000Z', rate_limit_type: 'seven_day', utilization_percent: 61, overage_status: 'allowed' } }
    ])
    expect(sessions).toHaveLength(2)
    expect(sessions.map((session) => session.limitType)).toEqual(['five hour', 'seven day'])
    expect(sessions[1]).toMatchObject({ utilizationPercent: 61, status: 'allowed' })
  })
})

describe('codex stream parsing', () => {
  it('does not mislabel cumulative turn usage as context occupancy', () => {
    let usage: UsageSample | undefined
    let context: ContextSample | undefined
    parseCodexLine({ type: 'turn.completed', usage: { input_tokens: 1200, output_tokens: 80 } }, {
      onText: () => undefined,
      onModel: () => undefined,
      onActivity: () => undefined,
      onUsage: (value) => { usage = value },
      onContext: (value) => { context = value }
    })
    expect(usage).toEqual({ inputTokens: 1200, outputTokens: 80, costUsd: 0 })
    expect(context).toBeUndefined()
  })

  it('uses explicit Codex context fields when a future CLI exposes them', () => {
    let context: ContextSample | undefined
    parseCodexLine({ type: 'turn.completed', usage: { input_tokens: 1200, output_tokens: 80, context_tokens: 900, context_window: 200_000 } }, {
      onText: () => undefined, onModel: () => undefined, onActivity: () => undefined,
      onContext: (value) => { context = value }
    })
    expect(context).toEqual({ tokens: 900, window: 200_000 })
  })
})
