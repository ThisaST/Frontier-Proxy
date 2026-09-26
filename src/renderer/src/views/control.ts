// Context & Tools — the shared control-plane profile (MCP servers, tool
// allow/deny lists, system prompt, extra context dirs) applied across CLIs.
import type { ControlPlaneProfile, McpServerConfig, McpTransport } from '../../../shared/types'
import { byId, element, field, textArea, textInput } from '../ui/dom'
import { errorMessage, reportError, showToast } from '../ui/feedback'
import { linesToRecord, recordToLines, splitArguments, textLines } from '../ui/format'
import { snapshot, setSnapshot } from '../state'
import { SKILL_CAPABLE_KINDS } from './skills'

let controlPlaneDraft: ControlPlaneProfile | undefined

function cloneProfile(profile: ControlPlaneProfile): ControlPlaneProfile {
  return {
    systemPrompt: profile.systemPrompt ?? '',
    addDirs: [...(profile.addDirs ?? [])],
    allowedTools: [...(profile.allowedTools ?? [])],
    disallowedTools: [...(profile.disallowedTools ?? [])],
    strictMcp: Boolean(profile.strictMcp),
    mcpServers: (profile.mcpServers ?? []).map((server) => ({
      ...server,
      args: server.args ? [...server.args] : undefined,
      env: server.env ? { ...server.env } : undefined,
      headers: server.headers ? { ...server.headers } : undefined
    }))
  }
}

function ensureDraft(): ControlPlaneProfile {
  if (!controlPlaneDraft) controlPlaneDraft = cloneProfile(snapshot.settings.controlPlane)
  return controlPlaneDraft
}

// Task execution happens in the main process and reads the persisted profile.
// Flush the renderer draft before any action that launches an agent.
export async function persistControlPlaneDraft(showConfirmation = false): Promise<void> {
  if (!controlPlaneDraft) return
  const saved = await window.frontier.updateControlPlane(syncDraftFromInputs())
  setSnapshot(saved)
  controlPlaneDraft = cloneProfile(saved.settings.controlPlane)
  if (showConfirmation) showToast('Context & Tools configuration saved')
}

function newId(): string {
  return typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function syncDraftFromInputs(): ControlPlaneProfile {
  const draft = ensureDraft()
  draft.systemPrompt = byId<HTMLTextAreaElement>('cp-system-prompt').value
  draft.addDirs = textLines(byId<HTMLTextAreaElement>('cp-add-dirs').value)
  draft.allowedTools = textLines(byId<HTMLTextAreaElement>('cp-allowed').value)
  draft.disallowedTools = textLines(byId<HTMLTextAreaElement>('cp-disallowed').value)
  draft.strictMcp = byId<HTMLInputElement>('cp-strict-mcp').checked
  return draft
}

function renderMcpServers(): void {
  const draft = ensureDraft()
  const list = byId('cp-server-list')
  if (!draft.mcpServers.length) {
    list.replaceChildren(element('p', 'cp-empty', 'No MCP servers yet. Add one to share it across every agent.'))
    return
  }
  list.replaceChildren(...draft.mcpServers.map((server) => {
    const row = element('div', 'cp-server')

    const top = element('div', 'cp-server-top')
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = server.enabled
    toggle.setAttribute('aria-label', `Enable ${server.name || 'this MCP server'}`)
    toggle.addEventListener('change', () => { server.enabled = toggle.checked })
    const toggleWrap = document.createElement('label'); toggleWrap.className = 'switch small'
    toggleWrap.append(toggle, element('span', 'slider'))

    const name = textInput(server.name); name.placeholder = 'server-name'
    name.addEventListener('input', () => { server.name = name.value; void refreshPreview() })

    const transport = document.createElement('select')
    for (const option of ['stdio', 'http', 'sse']) transport.append(new Option(option, option))
    transport.value = server.transport
    transport.addEventListener('change', () => { server.transport = transport.value as McpTransport; renderMcpServers(); void refreshPreview() })

    const remove = element('button', 'text-button', 'Remove')
    remove.addEventListener('click', () => {
      draft.mcpServers = draft.mcpServers.filter((item) => item.id !== server.id)
      renderMcpServers(); void refreshPreview()
    })
    top.append(toggleWrap, name, transport, remove)

    const detail = element('div', 'cp-server-detail')
    if (server.transport === 'stdio') {
      const command = textInput(server.command ?? ''); command.placeholder = 'command (e.g. npx)'
      command.addEventListener('input', () => { server.command = command.value; void refreshPreview() })
      const args = textInput((server.args ?? []).join(' ')); args.placeholder = 'arguments (space-separated)'
      args.addEventListener('input', () => { server.args = splitArguments(args.value); void refreshPreview() })
      const env = textArea(recordToLines(server.env, '='), 2); env.placeholder = 'KEY=value (one per line)'
      env.addEventListener('input', () => { server.env = linesToRecord(env.value, '='); void refreshPreview() })
      detail.append(field('Command', command), field('Arguments', args), field('Environment variables', env, true))
    } else {
      const url = textInput(server.url ?? ''); url.placeholder = 'https://host/mcp'
      url.addEventListener('input', () => { server.url = url.value; void refreshPreview() })
      const headers = textArea(recordToLines(server.headers, ': '), 2); headers.placeholder = 'Header-Name: value (one per line)'
      headers.addEventListener('input', () => { server.headers = linesToRecord(headers.value, ':'); void refreshPreview() })
      detail.append(field('Server URL', url, true), field('Headers', headers, true))
    }
    row.append(top, detail)
    if (server.transport !== 'stdio') {
      const persisted = snapshot.settings.controlPlane.mcpServers.find((item) => item.id === server.id)
      const changed = persisted?.url?.trim() !== server.url?.trim()
      const authState = changed ? undefined : snapshot.mcpAuth.find((item) => item.serverId === server.id)
      const auth = element('div', 'cp-server-auth')
      const message = element('div', `cp-auth-status ${authState?.state ?? 'not-authenticated'}`)
      const statusLabels = {
        authenticated: 'Authenticated securely',
        authenticating: 'Waiting for browser authentication…',
        manual: 'Authorization header configured manually',
        error: 'Authentication needs attention',
        'not-authenticated': 'OAuth not connected'
      } as const
      message.append(
        element('strong', undefined, statusLabels[authState?.state ?? 'not-authenticated']),
        element('span', undefined, changed
          ? 'Save this server before authenticating.'
          : authState?.error ?? (authState?.expiresAt ? `Token refresh is managed automatically · current token expires ${new Date(authState.expiresAt).toLocaleString()}` : 'Use browser login for OAuth-protected servers; public servers can be used without it.'))
      )

      const actions = element('div', 'cp-auth-actions')
      if (authState?.state !== 'manual') {
        const authenticate = element('button', 'secondary-button', authState?.state === 'authenticated' ? 'Re-authenticate' : 'Authenticate') as HTMLButtonElement
        authenticate.disabled = changed || authState?.state === 'authenticating'
        authenticate.addEventListener('click', async () => {
          authenticate.disabled = true; authenticate.textContent = 'Opening browser…'
          try {
            await persistControlPlaneDraft()
            setSnapshot(await window.frontier.authenticateMcpServer(server.id))
            showToast(`${server.name || 'MCP server'} authenticated`)
          } catch (error) { reportError('MCP authentication failed', error) }
          finally { renderMcpServers(); void refreshPreview() }
        })
        actions.append(authenticate)
      }
      if (authState?.state === 'authenticated' || authState?.state === 'error') {
        const disconnect = element('button', 'text-button', 'Disconnect') as HTMLButtonElement
        disconnect.addEventListener('click', async () => {
          disconnect.disabled = true
          try { setSnapshot(await window.frontier.disconnectMcpServer(server.id)); showToast(`${server.name || 'MCP server'} disconnected`) }
          catch (error) { reportError('Could not disconnect MCP server', error) }
          finally { renderMcpServers(); void refreshPreview() }
        })
        actions.append(disconnect)
      }
      auth.append(message, actions)
      row.append(auth)
    }
    return row
  }))
}

function renderPreviewProviderOptions(): void {
  const select = byId<HTMLSelectElement>('cp-preview-provider')
  const current = select.value
  const capable = snapshot.providers.filter((provider) => (SKILL_CAPABLE_KINDS as readonly string[]).includes(provider.kind))
  select.replaceChildren(new Option('Select agent…', ''), ...capable.map((provider) => new Option(provider.name, provider.id)))
  if (capable.some((provider) => provider.id === current)) select.value = current
}

async function refreshPreview(): Promise<void> {
  const select = byId<HTMLSelectElement>('cp-preview-provider')
  const preview = byId<HTMLPreElement>('cp-preview')
  if (!select.value) { preview.textContent = 'Select an agent to preview the exact flags Frontier will inject.'; return }
  try {
    const args = await window.frontier.previewControlPlane(select.value, syncDraftFromInputs())
    const provider = snapshot.providers.find((item) => item.id === select.value)
    preview.textContent = `${provider?.executable ?? ''} ${args.join(' ')}`.trim()
  } catch (error) { preview.textContent = errorMessage(error) }
}

export function renderControlPlane(): void {
  const draft = ensureDraft()
  byId<HTMLTextAreaElement>('cp-system-prompt').value = draft.systemPrompt ?? ''
  byId<HTMLTextAreaElement>('cp-add-dirs').value = (draft.addDirs ?? []).join('\n')
  byId<HTMLTextAreaElement>('cp-allowed').value = (draft.allowedTools ?? []).join('\n')
  byId<HTMLTextAreaElement>('cp-disallowed').value = (draft.disallowedTools ?? []).join('\n')
  byId<HTMLInputElement>('cp-strict-mcp').checked = Boolean(draft.strictMcp)
  renderMcpServers()
  renderPreviewProviderOptions()
  void refreshPreview()
}

// Merge servers from a standard `.mcp.json` ({ "mcpServers": { name: {...} } }).
function importMcpServers(json: string): number {
  const parsed = JSON.parse(json) as Record<string, unknown>
  const map = (parsed.mcpServers ?? parsed.servers ?? parsed) as Record<string, Record<string, unknown>>
  if (!map || typeof map !== 'object') throw new Error('No "mcpServers" object found in the file.')
  const draft = ensureDraft()
  let count = 0
  for (const [name, definition] of Object.entries(map)) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) continue
    const isStdio = typeof definition.command === 'string'
    draft.mcpServers.push({
      id: newId(), name, enabled: definition.enabled !== false,
      transport: isStdio ? 'stdio' : definition.type === 'sse' ? 'sse' : 'http',
      command: isStdio ? String(definition.command) : undefined,
      args: Array.isArray(definition.args) ? definition.args.map(String) : undefined,
      env: definition.env && typeof definition.env === 'object' ? definition.env as Record<string, string> : undefined,
      url: !isStdio && typeof definition.url === 'string' ? definition.url : undefined,
      headers: definition.headers && typeof definition.headers === 'object' ? definition.headers as Record<string, string> : undefined
    })
    count += 1
  }
  return count
}

export function initControlView(): void {
  byId('cp-add-server').addEventListener('click', () => {
    const draft = syncDraftFromInputs()
    const server: McpServerConfig = { id: newId(), name: '', enabled: true, transport: 'stdio', command: '', args: [] }
    draft.mcpServers.push(server)
    renderMcpServers()
  })
  byId('cp-import-mcp').addEventListener('click', () => byId<HTMLInputElement>('cp-import-file').click())
  byId<HTMLInputElement>('cp-import-file').addEventListener('change', async (event) => {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    try {
      syncDraftFromInputs()
      const count = importMcpServers(await file.text())
      await persistControlPlaneDraft()
      renderMcpServers(); void refreshPreview()
      showToast(`Imported and saved ${count} MCP server${count === 1 ? '' : 's'}`)
    } catch (error) { reportError('Import failed', error) } finally { input.value = '' }
  })
  byId<HTMLSelectElement>('cp-preview-provider').addEventListener('change', () => void refreshPreview())
  byId('save-control-plane').addEventListener('click', async () => {
    const button = byId<HTMLButtonElement>('save-control-plane'); button.disabled = true
    try {
      await persistControlPlaneDraft(true)
      void refreshPreview()
    } catch (error) { reportError('Could not save configuration', error) } finally { button.disabled = false }
  })
}
