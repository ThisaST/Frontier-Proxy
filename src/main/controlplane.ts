import type { ControlPlaneProfile, McpServerConfig, ProviderConfig } from '../shared/types'

export interface ControlPlaneInjection {
  // Extra CLI flags to splice into the provider command.
  args: string[]
  // Text to prepend to the stdin prompt for CLIs without a system-prompt flag.
  promptPrefix?: string
}

const EMPTY: ControlPlaneInjection = { args: [] }

type McpJsonTarget = 'claude' | 'copilot'

function configuredMcpServers(profile: ControlPlaneProfile): McpServerConfig[] {
  return profile.mcpServers.filter((server) => {
    if (!server.enabled || !server.name.trim()) return false
    return server.transport === 'stdio' ? Boolean(server.command?.trim()) : Boolean(server.url?.trim())
  })
}

// Claude and Copilot both accept an `mcpServers` JSON document, but Copilot's
// schema additionally expects an explicit transport, args, env, and tool set.
function serverEntry(server: McpServerConfig, target: McpJsonTarget): Record<string, unknown> {
  if (server.transport === 'stdio') {
    if (target === 'copilot') {
      return {
        type: 'stdio',
        command: server.command?.trim() ?? '',
        args: server.args ?? [],
        env: server.env ?? {},
        tools: ['*']
      }
    }
    return {
      command: server.command?.trim() ?? '',
      ...(server.args?.length ? { args: server.args } : {}),
      ...(server.env && Object.keys(server.env).length ? { env: server.env } : {})
    }
  }
  if (target === 'copilot') {
    return {
      type: server.transport,
      url: server.url?.trim() ?? '',
      headers: server.headers ?? {},
      tools: ['*']
    }
  }
  return {
    type: server.transport,
    url: server.url?.trim() ?? '',
    ...(server.headers && Object.keys(server.headers).length ? { headers: server.headers } : {})
  }
}

export function mcpServersDocument(profile: ControlPlaneProfile, target: McpJsonTarget = 'claude'): Record<string, unknown> | undefined {
  const enabled = configuredMcpServers(profile)
  if (!enabled.length) return undefined
  const servers: Record<string, unknown> = {}
  for (const server of enabled) servers[server.name.trim()] = serverEntry(server, target)
  return { mcpServers: servers }
}

function mcpJson(profile: ControlPlaneProfile, target: McpJsonTarget): string | undefined {
  const doc = mcpServersDocument(profile, target)
  return doc ? JSON.stringify(doc) : undefined
}

function enabledMcpNames(profile: ControlPlaneProfile): string[] {
  return [...new Set(configuredMcpServers(profile).map((server) => server.name.trim()))]
}

type McpCapableProvider = Extract<ProviderConfig['kind'], 'claude' | 'copilot' | 'codex' | 'codex-oss'>

function attachedMcpServers(kind: McpCapableProvider, profile: ControlPlaneProfile): McpServerConfig[] {
  const configured = configuredMcpServers(profile)
  // Codex supports stdio and Streamable HTTP, but not legacy SSE servers.
  return kind === 'codex' || kind === 'codex-oss'
    ? configured.filter((server) => server.transport !== 'sse')
    : configured
}

// JSON string literals are also valid TOML basic strings, including the
// escaping needed for dotted key segments and inline-table values.
function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`
}

function tomlStringMap(values: Record<string, string>): string {
  const entries = Object.entries(values)
  return entries.length ? `{ ${entries.map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`).join(', ')} }` : '{ }'
}

function codexServerName(name: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(name)) return name

  // The CLI's dotted `-c` path parser does not support quoted key segments.
  // Keep portable names unchanged and give other names a stable, collision-
  // resistant alias rather than passing an override that breaks Codex startup.
  let hash = 2_166_136_261
  for (let index = 0; index < name.length; index += 1) hash = Math.imul(hash ^ name.charCodeAt(index), 16_777_619)
  const stem = name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'server'
  return `frontier_${stem}_${(hash >>> 0).toString(16)}`
}

function mcpSessionContext(kind: McpCapableProvider, profile: ControlPlaneProfile): string | undefined {
  const servers = attachedMcpServers(kind, profile)
  if (!servers.length) return undefined

  const serverList = servers.map((server) => {
    const name = server.name.trim()
    const alias = kind === 'codex' || kind === 'codex-oss' ? codexServerName(name) : name
    const aliasText = alias === name ? '' : `; session tool namespace: ${JSON.stringify(alias)}`
    return `- ${JSON.stringify(name)} (${server.transport}${aliasText})`
  })

  return [
    'Frontier MCP session context:',
    'Frontier attached these MCP servers to this provider process for the current task:',
    ...serverList,
    'Use their MCP tools directly when they are relevant to the request.',
    'These servers are injected for this task only. Do not use `codex mcp list`, `claude mcp list`, `copilot mcp list`, or another newly launched CLI process to decide whether they are available; those commands inspect persistent configuration and may not show Frontier\'s per-run injection.',
    'Do not install or re-register these servers. If a requested MCP tool cannot be called, report the actual tool-discovery, connection, authentication, or invocation error from this provider session.'
  ].join('\n')
}

function joinPromptContext(...parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((part): part is string => Boolean(part))
  return present.length ? present.join('\n\n') : undefined
}

// Codex accepts per-invocation config overrides via repeated `-c key=value`
// arguments. Inline tables keep each server override self-contained.
function codexMcpArgs(profile: ControlPlaneProfile): string[] {
  const args: string[] = []
  for (const server of profile.mcpServers) {
    const name = server.name.trim()
    if (!server.enabled || !name) continue

    const fields: string[] = []
    if (server.transport === 'stdio') {
      const command = server.command?.trim()
      if (!command) continue
      fields.push(`command = ${tomlString(command)}`)
      fields.push(`args = ${tomlStringArray(server.args ?? [])}`)
      fields.push(`env = ${tomlStringMap(server.env ?? {})}`)
      fields.push('env_vars = []')
      fields.push('cwd = "."')
    } else if (server.transport === 'http') {
      const url = server.url?.trim()
      if (!url) continue
      fields.push(`url = ${tomlString(url)}`)
      fields.push(`http_headers = ${tomlStringMap(server.headers ?? {})}`)
      fields.push('env_http_headers = { }')
    } else {
      // Codex supports stdio and Streamable HTTP, but not the legacy SSE transport.
      continue
    }

    fields.push('default_tools_approval_mode = "approve"')
    fields.push('enabled = true')
    args.push('-c', `mcp_servers.${codexServerName(name)}={ ${fields.join(', ')} }`)
  }
  return args
}

function trimmedList(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean)
}

// True unless the provider explicitly opted out of the shared profile.
export function usesControlPlane(provider: ProviderConfig): boolean {
  return provider.useControlPlane !== false
}

// Translate the shared profile into flags for one provider's CLI. Pure and
// side-effect free so it can be unit-tested and previewed in the UI.
export function controlPlaneInjection(provider: ProviderConfig, profile: ControlPlaneProfile): ControlPlaneInjection {
  if (!usesControlPlane(provider)) return EMPTY
  const allowed = trimmedList(profile.allowedTools)
  const disallowed = trimmedList(profile.disallowedTools)
  const addDirs = trimmedList(profile.addDirs)
  const systemPrompt = profile.systemPrompt?.trim()

  switch (provider.kind) {
    case 'claude': {
      const args: string[] = []
      const mcp = mcpJson(profile, 'claude')
      if (mcp) {
        args.push('--mcp-config', mcp)
        if (profile.strictMcp) args.push('--strict-mcp-config')
      }
      const allowedWithMcp = [...new Set([...allowed, ...enabledMcpNames(profile).map((name) => `mcp__${name}__*`)])]
      if (allowedWithMcp.length) args.push('--allowedTools', ...allowedWithMcp)
      if (disallowed.length) args.push('--disallowedTools', ...disallowed)
      if (addDirs.length) args.push('--add-dir', ...addDirs)
      const promptContext = joinPromptContext(systemPrompt, mcpSessionContext('claude', profile))
      if (promptContext) args.push('--append-system-prompt', promptContext)
      return { args }
    }
    case 'copilot': {
      const args: string[] = []
      const mcp = mcpJson(profile, 'copilot')
      if (mcp) args.push('--additional-mcp-config', mcp)
      const allowedWithMcp = [...new Set([...allowed, ...enabledMcpNames(profile)])]
      if (allowedWithMcp.length) args.push(`--allow-tool=${allowedWithMcp.join(', ')}`)
      if (disallowed.length) args.push(`--deny-tool=${disallowed.join(', ')}`)
      for (const dir of addDirs) args.push('--add-dir', dir)
      // Copilot has no system-prompt flag; fold context into the prompt text.
      return { args, promptPrefix: joinPromptContext(systemPrompt, mcpSessionContext('copilot', profile)) }
    }
    case 'codex':
    case 'codex-oss': {
      // Tool scope is governed by Codex's sandbox mode. Shared MCP servers are
      // layered over config.toml for this invocation only.
      return { args: codexMcpArgs(profile), promptPrefix: joinPromptContext(systemPrompt, mcpSessionContext(provider.kind, profile)) }
    }
    default:
      // ollama / custom: no agent tool surface to configure centrally.
      return EMPTY
  }
}
