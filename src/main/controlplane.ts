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

type McpCapableProvider = Extract<ProviderConfig['kind'], 'claude' | 'copilot' | 'codex' | 'codex-oss' | 'opencode'>

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
    'These servers are injected for this task only. Do not use `codex mcp list`, `claude mcp list`, `copilot mcp list`, `opencode mcp list`, or another newly launched CLI process to decide whether they are available; those commands inspect persistent configuration and may not show Frontier\'s per-run injection.',
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

// OpenCode takes a whole config document through OPENCODE_CONFIG_CONTENT,
// merged over the user's own opencode.json for this process only. Local
// servers take one argv array; remote ones cover Streamable HTTP and SSE.
// Header secrets use OpenCode's own `{env:VAR}` interpolation.
function openCodeMcp(profile: ControlPlaneProfile, environment: Record<string, string>): Record<string, unknown> | undefined {
  const servers = configuredMcpServers(profile)
  if (!servers.length) return undefined
  const entries: Record<string, unknown> = {}
  for (const server of servers) {
    if (server.transport === 'stdio') {
      entries[server.name.trim()] = {
        type: 'local',
        command: [server.command?.trim() ?? '', ...(server.args ?? [])],
        ...(server.env && Object.keys(server.env).length ? { environment: server.env } : {}),
        enabled: true
      }
      continue
    }
    const headers = Object.fromEntries(Object.entries(environmentBackedHeaders(server, environment)).map(([header, value]) => [header, value.replace(/^\$\{(\w+)\}$/, '{env:$1}')]))
    entries[server.name.trim()] = { type: 'remote', url: server.url?.trim() ?? '', ...(Object.keys(headers).length ? { headers } : {}), enabled: true }
  }
  return entries
}

// OpenCode permission keys are lowercase tool names (`bash`, `edit`,
// `webfetch`…), and every file-writing tool shares `edit`. A Claude-style
// `Tool(pattern)` entry becomes that tool's pattern map (`Bash(git:*)` →
// `bash: { "git *": … }`) — a literal `Bash(rm *)` key is accepted by OpenCode
// but matches nothing, so the rule would silently not apply. Anything else
// (e.g. an MCP tool glob) is passed through as a flat rule.
const OPENCODE_TOOL_KEYS: Record<string, string> = { write: 'edit', multiedit: 'edit', notebookedit: 'edit', patch: 'edit' }
// Keys OpenCode accepts only a flat action for; a pattern map on one makes the
// whole config invalid and the CLI refuses to start (verified, 1.18.x).
const OPENCODE_FLAT_ONLY = new Set(['todowrite', 'question', 'webfetch', 'websearch', 'doom_loop'])

function openCodePermissions(allowed: string[], disallowed: string[]): Record<string, unknown> {
  const flat = new Map<string, 'allow' | 'deny'>()
  const patterns = new Map<string, Map<string, 'allow' | 'deny'>>()
  // Denies are applied after allows so a tool named in both ends up denied.
  const rules = [...allowed.map((tool) => [tool, 'allow'] as const), ...disallowed.map((tool) => [tool, 'deny'] as const)]
  for (const [tool, action] of rules) {
    // OpenCode names MCP tools `<server>_<tool>` (verified), so Claude's
    // `mcp__<server>__<tool>` / `mcp__<server>__*` would otherwise match nothing.
    const mcp = /^mcp__(.+?)(?:__(.+))?$/.exec(tool)
    if (mcp) { flat.set(`${mcp[1]}_${mcp[2] ?? '*'}`, action); continue }
    const match = /^([A-Za-z_]+)(?:\((.*)\))?$/.exec(tool)
    if (!match) { flat.set(tool, action); continue }
    const lower = match[1].toLowerCase()
    const key = OPENCODE_TOOL_KEYS[lower] ?? lower
    const pattern = match[2]?.trim().replace(/:\*$/, ' *')
    if (!pattern || pattern === '*') { flat.set(key, action); continue }
    if (OPENCODE_FLAT_ONLY.has(key)) continue // cannot be scoped; applying it tool-wide would over-block or over-allow
    const map = patterns.get(key) ?? new Map<string, 'allow' | 'deny'>()
    map.delete(pattern) // re-insert so the later (deny) rule also comes later in the map
    map.set(pattern, action)
    patterns.set(key, map)
  }
  const permission: Record<string, unknown> = Object.fromEntries(flat)
  for (const [key, map] of patterns) {
    // OpenCode applies the last matching rule, so the tool-wide action goes
    // first and the specific patterns — denies after allows — follow it.
    const ordered = [...map].sort((a, b) => Number(a[1] === 'deny') - Number(b[1] === 'deny'))
    permission[key] = Object.fromEntries([...(flat.has(key) ? [['*', flat.get(key)]] : []), ...ordered])
  }
  return permission
}

// The catalog's per-skill choice merged with any `Skill`/`Skill(name)` rules
// from the shared tool lists; the user's own rules are applied last so an
// explicit deny is never re-allowed by the catalog, and a blanket `Skill` deny
// suppresses the catalog's allows altogether.
function openCodeSkillPermission(user: unknown, enabled: ResolvedSkill[], disabled: ResolvedSkill[]): Record<string, string> | undefined {
  const userMap = user && typeof user === 'object' ? { ...(user as Record<string, string>) } : {}
  const userAll = typeof user === 'string' ? user : userMap['*']
  delete userMap['*']
  const catalog = [...(userAll === 'deny' ? [] : enabled.map((skill) => [skill.name, 'allow'])), ...disabled.map((skill) => [skill.name, 'deny'])]
  const merged = { ...(userAll ? { '*': userAll } : {}), ...Object.fromEntries(catalog), ...userMap }
  return Object.keys(merged).length ? merged : undefined
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
    case 'opencode': {
      // OpenCode discovers every skill root Frontier scans for it and has a
      // real per-skill permission, so like Claude the choice is enforced, not
      // advised: disabled skills are denied (the skill tool then reports them
      // as not found), enabled ones allowed so a `skill: ask` config cannot
      // stall a headless run. Ambient roots join through `skills.paths`.
      const { ambientEnabled, disabled } = skillsForKind('opencode', skills)
      const enabled = skills.filter((skill) => skill.enabled)
      const config: Record<string, unknown> = {}
      const mcp = openCodeMcp(profile, environment)
      if (mcp) config.mcp = mcp
      const skillRoots = skillRootDirs(ambientEnabled)
      if (skillRoots.length) config.skills = { paths: skillRoots }
      const permission = openCodePermissions(allowed, disallowed)
      // A skill root outside the project needs the same allow as an extra dir:
      // headless, OpenCode auto-rejects its default external-directory prompt,
      // so the agent could list the skill but not read its bundled files.
      const outside = [...new Set([...addDirs, ...skillRoots])]
      if (outside.length) permission.external_directory = Object.fromEntries(outside.flatMap((dir) => [[dir, 'allow'], [`${dir.replace(/[\\/]+$/, '')}/**`, 'allow']]))
      const skillPermission = openCodeSkillPermission(permission.skill, enabled, disabled)
      if (skillPermission) permission.skill = skillPermission
      if (Object.keys(permission).length) config.permission = permission
      if (Object.keys(config).length) environment.OPENCODE_CONFIG_CONTENT = JSON.stringify(config)
      // No per-run system-prompt flag; fold context into the prompt, like Copilot.
      return withEnvironment({ args: [], promptPrefix: joinPromptContext(systemPrompt, mcpSessionContext('opencode', profile)) })
    }
    default:
      // ollama / custom: no agent tool surface to configure centrally.
      return EMPTY
  }
}
