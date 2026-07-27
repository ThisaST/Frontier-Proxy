import { describe, expect, it } from 'vitest'
import { controlPlaneInjection, mcpServersDocument } from '../src/main/controlplane'
import type { ControlPlaneProfile, ProviderConfig } from '../src/shared/types'

function provider(kind: ProviderConfig['kind'], extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: kind, name: kind, kind, enabled: true, executable: kind, priority: 1, maxConcurrent: 1, capabilities: ['coding'], ...extra }
}

const profile: ControlPlaneProfile = {
  systemPrompt: 'Prefer pnpm.',
  addDirs: ['C:/docs'],
  allowedTools: ['Edit', 'Read'],
  disallowedTools: ['Bash(rm *)'],
  strictMcp: true,
  mcpServers: [
    { id: '1', name: 'files', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', 'mcp-files'] },
    { id: '2', name: 'remote', enabled: true, transport: 'http', url: 'https://mcp.example/api' },
    { id: '3', name: 'off', enabled: false, transport: 'stdio', command: 'nope' }
  ]
}

describe('control plane translation', () => {
  it('builds an MCP document from enabled servers only', () => {
    const doc = mcpServersDocument(profile) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(doc.mcpServers)).toEqual(['files', 'remote'])
    expect(doc.mcpServers.files).toEqual({ command: 'npx', args: ['-y', 'mcp-files'] })
    expect(doc.mcpServers.remote).toEqual({ type: 'http', url: 'https://mcp.example/api' })
  })

  it('builds Copilot MCP entries with its required transport and tool fields', () => {
    const doc = mcpServersDocument(profile, 'copilot') as { mcpServers: Record<string, unknown> }
    expect(doc.mcpServers.files).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'mcp-files'], env: {}, tools: ['*'] })
    expect(doc.mcpServers.remote).toEqual({ type: 'http', url: 'https://mcp.example/api', headers: {}, tools: ['*'] })
  })

  it('translates the profile into Claude Code flags', () => {
    const { args } = controlPlaneInjection(provider('claude'), profile)
    expect(args).toContain('--mcp-config')
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--allowedTools')
    expect(args).toContain('Edit')
    expect(args).toContain('mcp__files__*')
    expect(args).toContain('mcp__remote__*')
    expect(args).toContain('--disallowedTools')
    expect(args).toContain('--add-dir')
    expect(args).toContain('--append-system-prompt')
    const promptContext = args[args.indexOf('--append-system-prompt') + 1]
    expect(promptContext).toContain('Prefer pnpm.')
    expect(promptContext).toContain('Frontier attached these MCP servers')
    expect(promptContext).toContain('"files" (stdio)')
    expect(promptContext).toContain('"remote" (http)')
    expect(promptContext).toContain('Do not install or re-register these servers')
    // The MCP config is passed as inline JSON.
    const mcpArg = args[args.indexOf('--mcp-config') + 1]
    expect(JSON.parse(mcpArg).mcpServers.files.command).toBe('npx')
  })

  it('translates the profile into Copilot flags and folds context into the prompt', () => {
    const injection = controlPlaneInjection(provider('copilot'), profile)
    expect(injection.args).toContain('--additional-mcp-config')
    expect(injection.args.some((a) => a === '--allow-tool=Edit, Read, files, remote')).toBe(true)
    expect(injection.args.some((a) => a.startsWith('--deny-tool='))).toBe(true)
    expect(injection.args).toContain('--add-dir')
    expect(injection.promptPrefix).toContain('Prefer pnpm.')
    expect(injection.promptPrefix).toContain('Frontier attached these MCP servers')
    expect(injection.promptPrefix).toContain('"files" (stdio)')
    expect(injection.promptPrefix).toContain('`copilot mcp list`')
  })

  it.each(['codex', 'codex-oss'] as const)('translates MCP servers into %s config overrides', (kind) => {
    const injection = controlPlaneInjection(provider(kind), {
      ...profile,
      mcpServers: [
        { id: '1', name: 'local.tools', enabled: true, transport: 'stdio', command: ' npx ', args: ['-y', 'mcp-files'], env: { API_KEY: 'secret' } },
        { id: '2', name: 'remote', enabled: true, transport: 'http', url: ' https://mcp.example/api ', headers: { Authorization: 'Bearer token' } },
        { id: '3', name: 'legacy', enabled: true, transport: 'sse', url: 'https://mcp.example/sse' },
        { id: '4', name: 'incomplete', enabled: true, transport: 'stdio', command: ' ' },
        { id: '5', name: 'off', enabled: false, transport: 'stdio', command: 'nope' }
      ]
    })

    const headerEnvironment = Object.entries(injection.env ?? {}).find(([, value]) => value === 'Bearer token')
    expect(headerEnvironment).toBeDefined()
    const [headerVariable] = headerEnvironment!
    expect(injection.args).toEqual([
      '-c', 'mcp_servers.frontier_local_tools_600ecdd={ command = "npx", args = ["-y", "mcp-files"], env = { "API_KEY" = "secret" }, env_vars = [], cwd = ".", default_tools_approval_mode = "approve", enabled = true }',
      '-c', `mcp_servers.remote={ url = "https://mcp.example/api", http_headers = { }, env_http_headers = { "Authorization" = "${headerVariable}" }, default_tools_approval_mode = "approve", enabled = true }`
    ])
    expect(injection.args.join(' ')).not.toContain('Bearer token')
    expect(injection.promptPrefix).toContain('Prefer pnpm.')
    expect(injection.promptPrefix).toContain('"local.tools" (stdio; session tool namespace: "frontier_local_tools_600ecdd")')
    expect(injection.promptPrefix).toContain('"remote" (http)')
    expect(injection.promptPrefix).not.toContain('"legacy"')
    expect(injection.promptPrefix).toContain('`codex mcp list`')
  })

  it.each(['claude', 'copilot'] as const)('passes remote %s headers through per-process environment placeholders', (kind) => {
    const injection = controlPlaneInjection(provider(kind), {
      ...profile,
      mcpServers: [{ id: 'secure', name: 'secure', enabled: true, transport: 'http', url: 'https://mcp.example/api', headers: { Authorization: 'Bearer secret' } }]
    })

    const headerEnvironment = Object.entries(injection.env ?? {}).find(([, value]) => value === 'Bearer secret')
    expect(headerEnvironment).toBeDefined()
    const [headerVariable] = headerEnvironment!
    const flag = kind === 'claude' ? '--mcp-config' : '--additional-mcp-config'
    const config = injection.args[injection.args.indexOf(flag) + 1]
    expect(config).toContain(`\${${headerVariable}}`)
    expect(config).not.toContain('Bearer secret')
  })

  it.each(['claude', 'copilot', 'codex', 'codex-oss'] as const)('adds MCP task context for %s even without a custom system prompt', (kind) => {
    const injection = controlPlaneInjection(provider(kind), {
      systemPrompt: '',
      addDirs: [],
      allowedTools: [],
      disallowedTools: [],
      strictMcp: false,
      mcpServers: [{ id: 'supabase', name: 'supabase', enabled: true, transport: 'http', url: 'https://mcp.supabase.com/mcp?project_ref=example' }]
    })

    const promptContext = kind === 'claude'
      ? injection.args[injection.args.indexOf('--append-system-prompt') + 1]
      : injection.promptPrefix
    expect(promptContext).toContain('"supabase" (http)')
    expect(promptContext).toContain('Use their MCP tools directly')
    expect(promptContext).toContain('persistent configuration')
  })

  it('returns nothing for a provider opted out of the control plane', () => {
    expect(controlPlaneInjection(provider('claude', { useControlPlane: false }), profile).args).toEqual([])
  })

  it('emits no flags for an empty profile', () => {
    const empty: ControlPlaneProfile = { systemPrompt: '', addDirs: [], allowedTools: [], disallowedTools: [], strictMcp: false, mcpServers: [] }
    expect(controlPlaneInjection(provider('claude'), empty).args).toEqual([])
    expect(mcpServersDocument(empty)).toBeUndefined()
  })
})
