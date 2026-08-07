import { describe, expect, it } from 'vitest'
import { buildProviderCommand, codexErrorMessage, discoverModels, modelRejectionError, parseCodexModels, resolveTaskModel, runProvider, type ModelOwner } from '../src/main/providers'
import type { ControlPlaneProfile, ProviderConfig } from '../src/shared/types'

function custom(args: string[]): ProviderConfig {
  return {
    id: 'test', name: 'Test process', kind: 'custom', enabled: true,
    executable: process.execPath, args, priority: 1, maxConcurrent: 1, capabilities: ['general']
  }
}

function codexDeveloperInstructions(args: string[]): string | undefined {
  const prefix = 'developer_instructions='
  const argument = args.find((value) => value.startsWith(prefix))
  return argument ? JSON.parse(argument.slice(prefix.length)) as string : undefined
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

  it('adds selected GitHub MCP toolsets and tools to Copilot sessions', () => {
    const provider: ProviderConfig = {
      id: 'copilot', name: 'GitHub Copilot', kind: 'copilot', enabled: true,
      executable: 'copilot', priority: 1, maxConcurrent: 1, capabilities: ['coding'],
      copilotGithubMcpToolsets: ['actions', ' code_security ', 'actions'],
      copilotGithubMcpTools: ['get_job_logs', ' get_job_logs ']
    }
    const command = buildProviderCommand(provider, '/workspace', 'inspect CI')
    expect(command.args.filter((argument) => argument === '--add-github-mcp-toolset=actions')).toHaveLength(1)
    expect(command.args).toContain('--add-github-mcp-toolset=code_security')
    expect(command.args).toContain('--add-github-mcp-tool=get_job_logs')
    expect(command.args).not.toContain('--enable-all-github-mcp-tools')
  })

  it('lets the all-tools Copilot setting override individual GitHub MCP selections', () => {
    const provider: ProviderConfig = {
      id: 'copilot', name: 'GitHub Copilot', kind: 'copilot', enabled: true,
      executable: 'copilot', priority: 1, maxConcurrent: 1, capabilities: ['coding'],
      copilotGithubMcpToolsets: ['actions'], copilotGithubMcpTools: ['get_job_logs'],
      copilotEnableAllGithubMcpTools: true
    }
    const command = buildProviderCommand(provider, '/workspace', 'inspect CI')
    expect(command.args).toContain('--enable-all-github-mcp-tools')
    expect(command.args.some((argument) => argument.startsWith('--add-github-mcp-'))).toBe(false)
  })

  it('includes a shared Supabase MCP server in the launched Codex command', () => {
    const codex: ProviderConfig = {
      id: 'codex', name: 'Codex', kind: 'codex', enabled: true, executable: 'codex',
      priority: 1, maxConcurrent: 1, capabilities: ['coding']
    }
    const controlPlane: ControlPlaneProfile = {
      systemPrompt: '', addDirs: [], allowedTools: [], disallowedTools: [], strictMcp: false,
      mcpServers: [{
        id: 'supabase', name: 'supabase', enabled: true, transport: 'http',
        url: 'https://mcp.supabase.com/mcp?project_ref=example&read_only=true&features=database'
      }]
    }

    const command = buildProviderCommand(codex, '/workspace', 'inspect the database', controlPlane)
    expect(command.args).toContain('-c')
    expect(command.args).toContain('mcp_servers.supabase={ url = "https://mcp.supabase.com/mcp?project_ref=example&read_only=true&features=database", http_headers = { }, env_http_headers = { }, default_tools_approval_mode = "approve", enabled = true }')
    expect(command.args.at(-1)).toBe('-')
    expect(command.promptPrefix).toBeUndefined()
    const developerInstructions = codexDeveloperInstructions(command.args)
    expect(developerInstructions).toContain('"supabase" (http)')
    expect(developerInstructions).toContain('Do not install or re-register these servers')
  })

  it('passes attached images to Codex as native vision inputs', () => {
    const codex: ProviderConfig = {
      id: 'codex', name: 'Codex', kind: 'codex', enabled: true, executable: 'codex',
      priority: 1, maxConcurrent: 1, capabilities: ['coding']
    }
    const command = buildProviderCommand(codex, '/workspace', 'inspect these', undefined, undefined, ['/tmp/one.png', '/tmp/two.jpg'])
    expect(command.args).toContain('--image')
    expect(command.args).toContain('/tmp/one.png')
    expect(command.args).toContain('/tmp/two.jpg')
    expect(command.args.at(-1)).toBe('-')
  })

  it.each(['claude', 'copilot'] as const)('includes and permits a shared Supabase MCP server in the launched %s command', (kind) => {
    const agent: ProviderConfig = {
      id: kind, name: kind, kind, enabled: true, executable: kind,
      priority: 1, maxConcurrent: 1, capabilities: ['coding']
    }
    const controlPlane: ControlPlaneProfile = {
      systemPrompt: '', addDirs: [], allowedTools: [], disallowedTools: [], strictMcp: false,
      mcpServers: [{ id: 'supabase', name: 'supabase', enabled: true, transport: 'http', url: 'https://mcp.supabase.com/mcp?project_ref=example&read_only=true&features=database' }]
    }

    const command = buildProviderCommand(agent, '/workspace', 'inspect the database', controlPlane)
    const configFlag = kind === 'claude' ? '--mcp-config' : '--additional-mcp-config'
    const config = JSON.parse(command.args[command.args.indexOf(configFlag) + 1]) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(config.mcpServers.supabase.url).toBe('https://mcp.supabase.com/mcp?project_ref=example&read_only=true&features=database')
    if (kind === 'claude') {
      expect(command.args).toContain('mcp__supabase__*')
      const promptContext = command.args[command.args.indexOf('--append-system-prompt') + 1]
      expect(promptContext).toContain('"supabase" (http)')
      expect(promptContext).toContain('Do not install or re-register these servers')
    }
    else {
      expect(config.mcpServers.supabase.tools).toEqual(['*'])
      expect(command.args).toContain('--allow-tool=supabase')
      expect(command.promptPrefix).toContain('"supabase" (http)')
      expect(command.promptPrefix).toContain('Do not install or re-register these servers')
    }
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

  it('treats an intentional abort as cancellation even when output mentions a limit', async () => {
    const controller = new AbortController()
    const resultPromise = runProvider(custom(['-e', "process.stderr.write('usage limit reached');setInterval(()=>{},1000)"]), {
      prompt: 'work', cwd: process.cwd(), signal: controller.signal, onOutput: () => undefined
    })
    setTimeout(() => controller.abort(), 25)
    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(result.failureKind).toBe('cancelled')
  })

  it('offers a curated known-model set for subscription CLIs', async () => {
    const claude: ProviderConfig = {
      id: 'claude', name: 'Claude Code', kind: 'claude', enabled: true, executable: 'claude',
      priority: 1, maxConcurrent: 1, capabilities: ['coding']
    }
    const models = await discoverModels(claude)
    expect(models).toContain('claude-opus-4-8')
    expect(models).toContain('claude-sonnet-4-5')
  })

  it('always includes the provider\'s configured model, de-duplicated', async () => {
    const claude: ProviderConfig = {
      id: 'claude', name: 'Claude Code', kind: 'claude', enabled: true, executable: 'claude',
      model: 'claude-opus-4-8', priority: 1, maxConcurrent: 1, capabilities: ['coding']
    }
    const models = await discoverModels(claude)
    expect(models.filter((m) => m === 'claude-opus-4-8')).toHaveLength(1)
    // A custom provider with no known set falls back to just its configured model.
    expect(await discoverModels({ ...custom([]), model: 'my-local-model' })).toEqual(['my-local-model'])
  })
})

describe('Codex model catalog', () => {
  // Shape of `codex debug models` (trimmed; the real entries also carry the
  // model's full base instructions).
  const catalog = JSON.stringify({
    models: [
      { slug: 'gpt-5.6-terra', visibility: 'list', supported_in_api: true, priority: 2 },
      { slug: 'gpt-5.6-sol', visibility: 'list', supported_in_api: true, priority: 1 },
      { slug: 'gpt-5.6-sol-wm', visibility: 'hide', supported_in_api: false, priority: 1 },
      { slug: 'codex-auto-review', visibility: 'hide', supported_in_api: true, priority: 43 },
      { slug: 'gpt-5.5', visibility: 'list', supported_in_api: true, priority: 7 }
    ]
  })

  it('offers only the listed models, most current first', () => {
    expect(parseCodexModels(catalog)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5'])
  })

  it('ignores output it cannot read rather than inventing models', () => {
    expect(parseCodexModels('')).toEqual([])
    expect(parseCodexModels('error: unrecognized subcommand \'debug\'')).toEqual([])
    expect(parseCodexModels('{"models":[{"visibility":"list"}]}')).toEqual([])
    // Warnings printed ahead of the JSON must not defeat the parse.
    expect(parseCodexModels(`warning: update available\n${catalog}`)).toContain('gpt-5.6-sol')
  })
})

describe('rejected model reporting', () => {
  const envelope = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5-codex\' model is not supported when using Codex with a ChatGPT account."}}'

  it('unwraps a JSON error envelope into its sentence', () => {
    expect(codexErrorMessage(envelope)).toBe("The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.")
    expect(codexErrorMessage('plain failure text')).toBe('plain failure text')
    expect(codexErrorMessage('{not json')).toBe('{not json')
  })

  it('turns a rejected model into an actionable error naming the model', () => {
    const message = modelRejectionError(envelope, 'gpt-5-codex')
    expect(message).toContain('not supported when using Codex with a ChatGPT account')
    expect(message).toContain('cannot run "gpt-5-codex"')
    expect(message).not.toContain('invalid_request_error')
  })

  it('leaves unrelated failures alone', () => {
    expect(modelRejectionError('error: file not found', 'gpt-5.6-sol')).toBeUndefined()
  })
})

describe('per-task model override scoping', () => {
  const claude: ModelOwner = { id: 'claude', kind: 'claude', models: ['claude-opus-5', 'claude-sonnet-5'] }
  const codex: ModelOwner = { id: 'codex', kind: 'codex', model: 'gpt-5-codex' }
  const all = [claude, codex]

  it('keeps the override on the agent it was picked for', () => {
    expect(resolveTaskModel(claude, 'claude-opus-5', 'claude', all)).toBe('claude-opus-5')
  })

  it('never hands another CLI\'s model id to a failover target', () => {
    expect(resolveTaskModel(codex, 'claude-opus-5', 'claude', all)).toBe('gpt-5-codex')
    // Same protection without a recorded owner (tasks created before the fix).
    expect(resolveTaskModel(codex, 'claude-opus-5', undefined, all)).toBe('gpt-5-codex')
    expect(resolveTaskModel(claude, 'claude-opus-5', undefined, all)).toBe('claude-opus-5')
  })

  it('passes through a custom id no agent claims', () => {
    expect(resolveTaskModel(codex, 'gpt-6-preview', undefined, all)).toBe('gpt-6-preview')
    expect(resolveTaskModel(codex, 'gpt-6-preview', 'codex', all)).toBe('gpt-6-preview')
    expect(resolveTaskModel(claude, 'gpt-6-preview', 'codex', all)).toBeUndefined()
  })

  it('falls back to the provider default when there is no override', () => {
    expect(resolveTaskModel(codex, undefined, undefined, all)).toBe('gpt-5-codex')
    expect(resolveTaskModel(codex, '  ', undefined, all)).toBe('gpt-5-codex')
  })
})
