import { describe, expect, it } from 'vitest'
import { parseClaudeLine, type StreamHandlers } from '../src/main/providers'
import type { ActivityEvent } from '../src/shared/types'

// Real event shapes captured from `claude -p --output-format stream-json`.
function collect(lines: object[]): { text: string; model?: string; activity: ActivityEvent[] } {
  let text = ''
  let model: string | undefined
  const activity: ActivityEvent[] = []
  const handlers: StreamHandlers = {
    onText: (value) => { text += value },
    onModel: (value) => { model = value },
    onActivity: (event) => { activity.push(event) }
  }
  const state = { streamedText: false, thinking: '' }
  for (const line of lines) parseClaudeLine(line as Record<string, unknown>, handlers, state)
  return { text, model, activity }
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
})
