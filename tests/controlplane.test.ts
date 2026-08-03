import { describe, expect, it } from 'vitest'
import { controlPlaneInjection, mcpServersDocument } from '../src/main/controlplane'
import type { ControlPlaneProfile, ProviderConfig, ProviderKind, ResolvedSkill } from '../src/shared/types'

function provider(kind: ProviderConfig['kind'], extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: kind, name: kind, kind, enabled: true, executable: kind, priority: 1, maxConcurrent: 1, capabilities: ['coding'], ...extra }
}

function skill(name: string, extra: Partial<ResolvedSkill> & { nativeFor?: ProviderKind[]; path?: string } = {}): ResolvedSkill {
  const { nativeFor = [], path = `/skills/${name}/SKILL.md`, sources, ...rest } = extra
  return {
    id: name,
    name,
    description: `${name} description`,
    enabled: true,
    sources: sources ?? [{ root: `/skills/${name}`, path, scope: 'personal', nativeFor }],
    ...rest
  }
}

function codexDeveloperInstructions(args: string[]): string | undefined {
  const prefix = 'developer_instructions='
  const argument = args.find((value) => value.startsWith(prefix))
  return argument ? JSON.parse(argument.slice(prefix.length)) as string : undefined
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
    expect(injection.args.slice(0, 4)).toEqual([
      '-c', 'mcp_servers.frontier_local_tools_600ecdd={ command = "npx", args = ["-y", "mcp-files"], env = { "API_KEY" = "secret" }, env_vars = [], cwd = ".", default_tools_approval_mode = "approve", enabled = true }',
      '-c', `mcp_servers.remote={ url = "https://mcp.example/api", http_headers = { }, env_http_headers = { "Authorization" = "${headerVariable}" }, default_tools_approval_mode = "approve", enabled = true }`
    ])
    expect(injection.args.join(' ')).not.toContain('Bearer token')
    expect(injection.promptPrefix).toBeUndefined()
    expect(injection.args[4]).toBe('-c')
    const developerInstructions = codexDeveloperInstructions(injection.args)
    expect(developerInstructions).toContain('Prefer pnpm.')
    expect(developerInstructions).toContain('"local.tools" (stdio; session tool namespace: "frontier_local_tools_600ecdd")')
    expect(developerInstructions).toContain('"remote" (http)')
    expect(developerInstructions).not.toContain('"legacy"')
    expect(developerInstructions).toContain('`codex mcp list`')
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
      : kind === 'codex' || kind === 'codex-oss'
        ? codexDeveloperInstructions(injection.args)
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

describe('skills injection', () => {
  const nativeSkill = skill('docker-deployment', { nativeFor: ['claude'] })
  const ambientSkill = skill('web-design-guidelines', { nativeFor: ['copilot', 'codex', 'codex-oss'] })
  const disabledSkill = skill('legacy-skill', { nativeFor: ['claude'], enabled: false })

  it('emits Skill() into --allowedTools for enabled native skills and --disallowedTools for disabled native skills, for Claude only', () => {
    const { args } = controlPlaneInjection(provider('claude'), profile, [nativeSkill, disabledSkill])
    const allowedIndex = args.indexOf('--allowedTools')
    const disallowedIndex = args.indexOf('--disallowedTools')
    const addDirIndex = args.indexOf('--add-dir')
    const allowedSlice = args.slice(allowedIndex + 1, disallowedIndex)
    const disallowedSlice = args.slice(disallowedIndex + 1, addDirIndex)
    expect(allowedSlice).toContain('Skill(docker-deployment)')
    expect(allowedSlice).not.toContain('Skill(legacy-skill)')
    expect(disallowedSlice).toContain('Skill(legacy-skill)')
    expect(disallowedSlice).not.toContain('Skill(docker-deployment)')
  })

  it('keeps ambient-enabled skills out of --allowedTools, adds their root via --add-dir, and lists them in --append-system-prompt', () => {
    const { args } = controlPlaneInjection(provider('claude'), profile, [ambientSkill])
    const allowedIndex = args.indexOf('--allowedTools')
    const disallowedIndex = args.indexOf('--disallowedTools')
    expect(args.slice(allowedIndex + 1, disallowedIndex)).not.toContain('Skill(web-design-guidelines)')
    const addDirIndex = args.indexOf('--add-dir')
    const promptIndex = args.indexOf('--append-system-prompt')
    expect(args.slice(addDirIndex + 1, promptIndex)).toContain('/skills/web-design-guidelines')
    const promptContext = args[promptIndex + 1]
    expect(promptContext).toContain('"web-design-guidelines"')
    expect(promptContext).toContain('/skills/web-design-guidelines/SKILL.md')
  })

  it.each(['copilot', 'codex', 'codex-oss'] as const)('lists enabled skills and a disabled-skill notice through the prompt channel for %s, never a Skill() token in args', (kind) => {
    const injection = controlPlaneInjection(provider(kind), profile, [nativeSkill, ambientSkill, disabledSkill])
    const promptContext = kind === 'copilot' ? injection.promptPrefix : codexDeveloperInstructions(injection.args)
    expect(promptContext).toContain('"docker-deployment"')
    expect(promptContext).toContain('/skills/docker-deployment/SKILL.md')
    expect(promptContext).toContain('"web-design-guidelines"')
    expect(promptContext).toContain('/skills/web-design-guidelines/SKILL.md')
    expect(promptContext).toContain('Do not use these skills')
    expect(promptContext).toContain('"legacy-skill"')
    expect(injection.args.some((value) => value.includes('Skill('))).toBe(false)
  })

  // Real case on this machine: docker-deployment exists in both ~/.claude/skills
  // and ~/.agents/skills. Copilot reaches it natively only through the latter and
  // gets no --add-dir for the former, so citing the first-scanned path would send
  // it to a file it cannot open.
  it('cites the copy under a root the target CLI can actually reach', () => {
    const shared = skill('docker-deployment', {
      sources: [
        { root: '/home/.claude/skills', path: '/home/.claude/skills/docker-deployment/SKILL.md', scope: 'personal', nativeFor: ['claude'] },
        { root: '/home/.agents/skills', path: '/home/.agents/skills/docker-deployment/SKILL.md', scope: 'personal', nativeFor: ['copilot', 'codex', 'codex-oss'] }
      ]
    })
    const copilot = controlPlaneInjection(provider('copilot'), profile, [shared])
    expect(copilot.promptPrefix).toContain('/home/.agents/skills/docker-deployment/SKILL.md')
    expect(copilot.promptPrefix).not.toContain('/home/.claude/skills/docker-deployment/SKILL.md')

    // Claude reaches the same skill natively through the other root, so it is
    // handled by Skill() flags and never listed in the prompt at all.
    const claude = controlPlaneInjection(provider('claude'), profile, [shared])
    expect(claude.args).toContain('Skill(docker-deployment)')
  })

  it('returns [] for a provider opted out of the control plane even with skills present', () => {
    expect(controlPlaneInjection(provider('claude', { useControlPlane: false }), profile, [nativeSkill]).args).toEqual([])
  })

  it('is byte-identical to today for an empty profile with no skills (regression lock)', () => {
    const empty: ControlPlaneProfile = { systemPrompt: '', addDirs: [], allowedTools: [], disallowedTools: [], strictMcp: false, mcpServers: [] }
    expect(controlPlaneInjection(provider('claude'), empty, []).args).toEqual([])
  })
})
