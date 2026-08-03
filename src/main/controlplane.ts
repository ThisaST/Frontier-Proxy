import type { ControlPlaneProfile, McpServerConfig, ProviderConfig, ProviderKind, ResolvedSkill } from '../shared/types'

export interface ControlPlaneInjection {
  // Extra CLI flags to splice into the provider command.
  args: string[]
  // Text to prepend to the stdin prompt only for CLIs without a native
  // system/developer-instruction channel.
  promptPrefix?: string
  // Per-run secrets referenced by MCP config placeholders. These are passed
  // only to the provider process and never written to provider config files.
  env?: Record<string, string>
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
function stableHash(value: string): string {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619)
  return (hash >>> 0).toString(16)
}

function environmentBackedHeaders(server: McpServerConfig, environment?: Record<string, string>): Record<string, string> {
  if (!environment) return server.headers ?? {}
  return Object.fromEntries(Object.entries(server.headers ?? {}).map(([header, value]) => {
    const variable = `FRONTIER_MCP_HEADER_${stableHash(`${server.id}:${header.toLowerCase()}`)}`.toUpperCase()
    environment[variable] = value
    return [header, `\${${variable}}`]
  }))
}

function serverEntry(server: McpServerConfig, target: McpJsonTarget, environment?: Record<string, string>): Record<string, unknown> {
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
      headers: environmentBackedHeaders(server, environment),
      tools: ['*']
    }
  }
  return {
    type: server.transport,
    url: server.url?.trim() ?? '',
    ...(server.headers && Object.keys(server.headers).length ? { headers: environmentBackedHeaders(server, environment) } : {})
  }
}

export function mcpServersDocument(profile: ControlPlaneProfile, target: McpJsonTarget = 'claude', environment?: Record<string, string>): Record<string, unknown> | undefined {
  const enabled = configuredMcpServers(profile)
  if (!enabled.length) return undefined
  const servers: Record<string, unknown> = {}
  for (const server of enabled) servers[server.name.trim()] = serverEntry(server, target, environment)
  return { mcpServers: servers }
}

function mcpJson(profile: ControlPlaneProfile, target: McpJsonTarget, environment: Record<string, string>): string | undefined {
  const doc = mcpServersDocument(profile, target, environment)
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
  const stem = name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'server'
  return `frontier_${stem}_${stableHash(name)}`
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

interface SkillGroups { nativeEnabled: ResolvedSkill[]; ambientEnabled: ResolvedSkill[]; nativeDisabled: ResolvedSkill[]; disabled: ResolvedSkill[] }

// A skill is native to `kind` when any of its sources is a root that CLI
// scans unaided; ambient otherwise, meaning Frontier must --add-dir it and
// tell the agent it exists through the prompt/developer-instruction channel.
function skillsForKind(kind: ProviderKind, skills: ResolvedSkill[]): SkillGroups {
  const isNative = (skill: ResolvedSkill) => skill.sources.some((source) => source.nativeFor.includes(kind))
  const enabled = skills.filter((skill) => skill.enabled)
  const disabled = skills.filter((skill) => !skill.enabled)
  return {
    nativeEnabled: enabled.filter(isNative),
    ambientEnabled: enabled.filter((skill) => !isNative(skill)),
    nativeDisabled: disabled.filter(isNative),
    disabled
  }
}

// De-duped source roots so a CLI without native discovery of a root can still
// find the skill there once it is on the workspace's --add-dir allow list.
function skillRootDirs(skills: ResolvedSkill[]): string[] {
  const roots = new Set<string>()
  for (const skill of skills) for (const source of skill.sources) roots.add(source.root)
  return [...roots]
}

// Mirrors mcpSessionContext: lists each skill's name, description, and
// absolute SKILL.md path so a prompt-injected CLI knows to read it when the
// request matches, plus an advisory (unenforceable outside Claude's flags)
// "do not use" clause for disabled skills. `undefined` when there is nothing
// to say, so a user with no skills gets byte-identical args to before skills
// existed.
function skillsSessionContext(kind: ProviderKind, listed: ResolvedSkill[], disabled: ResolvedSkill[]): string | undefined {
  if (!listed.length && !disabled.length) return undefined
  // Cite the copy under a root this CLI can actually reach. A skill present in
  // several roots is native through one of them but gets no --add-dir for the
  // others, so naming the first-scanned path can point the agent at a file it
  // is not allowed to open. Ambient skills have no native source; their roots
  // are all --add-dir'd, so any path works.
  const instructionsFor = (skill: ResolvedSkill): string =>
    (skill.sources.find((source) => source.nativeFor.includes(kind)) ?? skill.sources[0])?.path ?? ''
  const skillList = listed.map((skill) => `- ${JSON.stringify(skill.name)}: ${skill.description} (instructions: ${instructionsFor(skill)})`)

  return [
    'Frontier skills catalog for this task:',
    ...(skillList.length ? ['Read the referenced SKILL.md with your file tools before acting whenever the request matches its description:', ...skillList] : []),
    ...(disabled.length ? [`Do not use these skills: ${disabled.map((skill) => JSON.stringify(skill.name)).join(', ')}.`] : []),
    'This catalog is read-only. Frontier never installs, registers, or modifies a skill; report a discovery/read error rather than trying to install one.'
  ].join('\n')
}

// Codex accepts per-invocation config overrides via repeated `-c key=value`
// arguments. Inline tables keep each server override self-contained.
function codexMcpArgs(profile: ControlPlaneProfile, environment: Record<string, string>): string[] {
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
      fields.push('http_headers = { }')
      const envHeaders: Record<string, string> = {}
      for (const [header, value] of Object.entries(server.headers ?? {})) {
        const variable = `FRONTIER_MCP_HEADER_${stableHash(`${server.id}:${header.toLowerCase()}`)}`.toUpperCase()
        environment[variable] = value
        envHeaders[header] = variable
      }
      fields.push(`env_http_headers = ${tomlStringMap(envHeaders)}`)
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
export function controlPlaneInjection(provider: ProviderConfig, profile: ControlPlaneProfile, skills: ResolvedSkill[] = []): ControlPlaneInjection {
  if (!usesControlPlane(provider)) return EMPTY
  const allowed = trimmedList(profile.allowedTools)
  const disallowed = trimmedList(profile.disallowedTools)
  const addDirs = trimmedList(profile.addDirs)
  const systemPrompt = profile.systemPrompt?.trim()
  const environment: Record<string, string> = {}
  const withEnvironment = (injection: ControlPlaneInjection): ControlPlaneInjection =>
    Object.keys(environment).length ? { ...injection, env: environment } : injection

  switch (provider.kind) {
    case 'claude': {
      // Native skills are handled by flags, not by re-listing them in the
      // prompt. Both directions are needed and do different jobs (verified
      // against the real CLI): --allowedTools only *pre-approves* invocation
      // headlessly, exactly like mcp__<name>__*, and does not scope the skill
      // list; --disallowedTools is what actually *blocks* a skill. Dropping
      // the deny side as redundant would silently stop disabling from working.
      const { nativeEnabled, ambientEnabled, nativeDisabled } = skillsForKind('claude', skills)
      const args: string[] = []
      const mcp = mcpJson(profile, 'claude', environment)
      if (mcp) {
        args.push('--mcp-config', mcp)
        if (profile.strictMcp) args.push('--strict-mcp-config')
      }
      const allowedWithMcp = [...new Set([...allowed, ...enabledMcpNames(profile).map((name) => `mcp__${name}__*`), ...nativeEnabled.map((skill) => `Skill(${skill.name})`)])]
      if (allowedWithMcp.length) args.push('--allowedTools', ...allowedWithMcp)
      const disallowedWithSkills = [...new Set([...disallowed, ...nativeDisabled.map((skill) => `Skill(${skill.name})`)])]
      if (disallowedWithSkills.length) args.push('--disallowedTools', ...disallowedWithSkills)
      const addDirsWithSkills = [...new Set([...addDirs, ...skillRootDirs(ambientEnabled)])]
      if (addDirsWithSkills.length) args.push('--add-dir', ...addDirsWithSkills)
      const promptContext = joinPromptContext(systemPrompt, mcpSessionContext('claude', profile), skillsSessionContext('claude', ambientEnabled, []))
      if (promptContext) args.push('--append-system-prompt', promptContext)
      return withEnvironment({ args })
    }
    case 'copilot': {
      // Copilot has no verified per-run skill selection at all (native vs.
      // ambient only describes which root it happens to scan itself), so
      // every enabled skill — not just the ambient ones — is named in the
      // prompt; `Skill(...)` is never emitted into its args.
      const { ambientEnabled, nativeEnabled, disabled } = skillsForKind('copilot', skills)
      const args: string[] = []
      const mcp = mcpJson(profile, 'copilot', environment)
      if (mcp) args.push('--additional-mcp-config', mcp)
      const allowedWithMcp = [...new Set([...allowed, ...enabledMcpNames(profile)])]
      if (allowedWithMcp.length) args.push(`--allow-tool=${allowedWithMcp.join(', ')}`)
      if (disallowed.length) args.push(`--deny-tool=${disallowed.join(', ')}`)
      const addDirsWithSkills = [...new Set([...addDirs, ...skillRootDirs(ambientEnabled)])]
      for (const dir of addDirsWithSkills) args.push('--add-dir', dir)
      // Copilot has no system-prompt flag; fold context into the prompt text.
      return withEnvironment({ args, promptPrefix: joinPromptContext(systemPrompt, mcpSessionContext('copilot', profile), skillsSessionContext('copilot', [...nativeEnabled, ...ambientEnabled], disabled)) })
    }
    case 'codex':
    case 'codex-oss': {
      // Tool scope is governed by Codex's sandbox mode. Shared MCP servers are
      // layered over config.toml for this invocation only. Keep Frontier's
      // context out of the user prompt and put it in Codex's native developer
      // instruction channel so the model receives it with the correct role.
      // Like Copilot, Codex has no verified per-run skill selection, so it
      // gets the same prompt-only treatment, minus --add-dir (no such flag).
      const { nativeEnabled, ambientEnabled, disabled } = skillsForKind(provider.kind, skills)
      const args = codexMcpArgs(profile, environment)
      const developerInstructions = joinPromptContext(systemPrompt, mcpSessionContext(provider.kind, profile), skillsSessionContext(provider.kind, [...nativeEnabled, ...ambientEnabled], disabled))
      if (developerInstructions) args.push('-c', `developer_instructions=${tomlString(developerInstructions)}`)
      return withEnvironment({ args })
    }
    default:
      // ollama / custom: no agent tool surface to configure centrally.
      return EMPTY
  }
}
