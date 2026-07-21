import { describe, expect, it } from 'vitest'
import { buildProviderCommand, runProvider } from '../src/main/providers'
import type { ProviderConfig } from '../src/shared/types'

function custom(args: string[]): ProviderConfig {
  return {
    id: 'test', name: 'Test process', kind: 'custom', enabled: true,
    executable: process.execPath, args, priority: 1, maxConcurrent: 1, capabilities: ['general']
  }
}

describe('local provider process adapter', () => {
  it('builds a non-interactive Copilot command with scoped permissions', () => {
    const provider: ProviderConfig = {
      id: 'copilot', name: 'GitHub Copilot', kind: 'copilot', enabled: true,
      executable: 'copilot', model: 'gpt-5.3-codex', args: ['--allow-url=github.com'],
      priority: 1, maxConcurrent: 1, capabilities: ['coding']
    }
    const command = buildProviderCommand(provider, '/workspace', 'fix the bug')
    expect(command.executable).toBe('copilot')
    expect(command.args).toContain('-s')
    expect(command.args).toContain('--no-ask-user')
    expect(command.args).toContain('--model')
    expect(command.args).toContain('gpt-5.3-codex')
    expect(command.args.some((argument) => argument.startsWith('--allow-tool=write'))).toBe(true)
    expect(command.args).not.toContain('--allow-all')
    expect(command.promptInArgs).toBeUndefined()
  })

  it('sends prompts through stdin without a shell and streams stdout', async () => {
    let streamed = ''
    const result = await runProvider(custom(['-e', "process.stdin.on('data',d=>process.stdout.write(d.toString().toUpperCase()))"]), {
      prompt: 'safe; $(not-a-command)', cwd: process.cwd(), signal: new AbortController().signal,
      onOutput: (text) => { streamed += text }
    })
    expect(result.ok).toBe(true)
    expect(result.output).toBe('SAFE; $(NOT-A-COMMAND)')
    expect(streamed).toBe(result.output)
  })

  it('classifies usage-limit failures for failover', async () => {
    const result = await runProvider(custom(['-e', "process.stderr.write('usage limit reached');process.exit(2)"]), {
      prompt: 'work', cwd: process.cwd(), signal: new AbortController().signal, onOutput: () => undefined
    })
    expect(result.ok).toBe(false)
    expect(result.failureKind).toBe('quota')
  })
})
