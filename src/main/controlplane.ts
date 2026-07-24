import type { ControlPlaneProfile, McpServerConfig, ProviderConfig } from '../shared/types'

export interface ControlPlaneInjection {
  // Extra CLI flags to splice into the provider command.
  args: string[]
  // Text to prepend to the stdin prompt for CLIs without a system-prompt flag.
  promptPrefix?: string
}

const EMPTY: ControlPlaneInjection = { args: [] }

// Shape a server entry the way both Claude Code and Copilot expect inside a
// `{ "mcpServers": { <name>: <entry> } }` document.
function serverEntry(server: McpServerConfig): Record<string, unknown> {
  if (server.transport === 'stdio') {
    return {
      command: server.command ?? '',
      ...(server.args?.length ? { args: server.args } : {}),
      ...(server.env && Object.keys(server.env).length ? { env: server.env } : {})
    }
  }
  return {
    type: server.transport,
    url: server.url ?? '',
    ...(server.headers && Object.keys(server.headers).length ? { headers: server.headers } : {})
  }
}

export function mcpServersDocument(profile: ControlPlaneProfile): Record<string, unknown> | undefined {
  const enabled = profile.mcpServers.filter((server) => server.enabled && server.name.trim())
  if (!enabled.length) return undefined
  const servers: Record<string, unknown> = {}
  for (const server of enabled) servers[server.name.trim()] = serverEntry(server)
  return { mcpServers: servers }
}

function mcpJson(profile: ControlPlaneProfile): string | undefined {
  const doc = mcpServersDocument(profile)
  return doc ? JSON.stringify(doc) : undefined
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
  const mcp = mcpJson(profile)

  switch (provider.kind) {
    case 'claude': {
      const args: string[] = []
      if (mcp) {
        args.push('--mcp-config', mcp)
        if (profile.strictMcp) args.push('--strict-mcp-config')
      }
      if (allowed.length) args.push('--allowedTools', ...allowed)
      if (disallowed.length) args.push('--disallowedTools', ...disallowed)
      if (addDirs.length) args.push('--add-dir', ...addDirs)
      if (systemPrompt) args.push('--append-system-prompt', systemPrompt)
      return { args }
    }
    case 'copilot': {
      const args: string[] = []
      if (mcp) args.push('--additional-mcp-config', mcp)
      if (allowed.length) args.push(`--allow-tool=${allowed.join(', ')}`)
      if (disallowed.length) args.push(`--deny-tool=${disallowed.join(', ')}`)
      for (const dir of addDirs) args.push('--add-dir', dir)
      // Copilot has no system-prompt flag; fold context into the prompt text.
      return { args, promptPrefix: systemPrompt || undefined }
    }
    case 'codex':
    case 'codex-oss': {
      // Codex reads MCP servers from config.toml; per-invocation overrides use
      // `-c` keys. Tool scope is governed by its sandbox mode. For now only the
      // system prompt is portable, prepended to the task text.
      return { args: [], promptPrefix: systemPrompt || undefined }
    }
    default:
      // ollama / custom: no agent tool surface to configure centrally.
      return EMPTY
  }
}
