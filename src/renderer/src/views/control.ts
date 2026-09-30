// Settings → Context & Tools: the shared control-plane profile (MCP servers, tool allow/deny lists,
// system prompt, extra context dirs) applied across CLIs.
//
// It is one draft, rendered on tab entry only (never from a snapshot), and flushed by
// `persistControlPlaneDraft()` before every run, which reads the `#cp-*` inputs from the DOM, so the
// panel stays mounted while hidden. Save model: Strict MCP applies the moment it changes; every
// other field, MCP server rows included (a row is one object, its switch one of its fields), waits
// for the tab's save bar. The dirty guard keeps a typed-but-unsaved field across tab changes, and a
// clean draft re-reads the saved profile on entry so it never goes stale.
import type { ControlPlaneProfile, McpAuthStatus, McpServerConfig, McpTransport } from '../../../shared/types'
import { byId, element, textArea, textInput } from '../ui/dom'
import { status, type StatusTone } from '../ui/components'
import { errorMessage, reportError, showToast } from '../ui/feedback'
import { linesToRecord, recordToLines, splitArguments, textLines } from '../ui/format'
import { bindSaveBar, createDirtyGuard, type DirtyGuard } from '../ui/dirty'
import { snapshot, setSnapshot } from '../state'
import { SKILL_CAPABLE_KINDS } from './skills'
import { kitButton, switchControl } from './settings-parts'

const TEXT_FIELDS = ['cp-system-prompt', 'cp-add-dirs', 'cp-allowed', 'cp-disallowed'] as const
const SERVERS = 'mcp-servers' // the guard's key for any edit to the server list

let controlPlaneDraft: ControlPlaneProfile | undefined
let controlForm: DirtyGuard | undefined
let strictSwitch: DirtyGuard

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
  controlForm?.clear()
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

// A server-row edit: the draft already holds it; mark the tab dirty and refresh the flags preview.
function serverEdited(preview = true): void {
  controlForm?.mark(SERVERS)
  if (preview) void refreshPreview()
}

function labelled(text: string, control: HTMLElement, wide = false): HTMLLabelElement {
  const label = document.createElement('label'); label.className = `settings-field${wide ? ' cp-wide' : ''}`
  label.append(element('span', 'field-label', text), control)
  return label
}

const AUTH_STATUS: Record<McpAuthStatus['state'], [StatusTone, string]> = {
  authenticated: ['ok', 'Authenticated securely'],
  authenticating: ['running', 'Waiting for browser authentication…'],
  manual: ['ok', 'Authorization header configured manually'],
  error: ['danger', 'Authentication needs attention'],
  'not-authenticated': ['neutral', 'OAuth not connected']
}

function serverAuth(server: McpServerConfig): HTMLElement {
  const persisted = snapshot.settings.controlPlane.mcpServers.find((item) => item.id === server.id)
  const changed = persisted?.url?.trim() !== server.url?.trim()
  const authState = changed ? undefined : snapshot.mcpAuth.find((item) => item.serverId === server.id)
  const [tone, label] = AUTH_STATUS[authState?.state ?? 'not-authenticated']
  const auth = element('div', 'cp-server-auth')
  const message = element('div', 'cp-auth-status')
  message.append(status(tone, label), element('span', 'settings-row-help', changed
    ? 'Save this server before authenticating.'
    : authState?.error ?? (authState?.expiresAt ? `Token refresh is managed automatically · current token expires ${new Date(authState.expiresAt).toLocaleString()}` : 'Use browser login for OAuth-protected servers; public servers can be used without it.')))

  const actions = element('div', 'cp-auth-actions')
  if (authState?.state !== 'manual') {
    const authenticate = kitButton('secondary', authState?.state === 'authenticated' ? 'Re-authenticate' : 'Authenticate', undefined, true)
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
    const disconnect = kitButton('ghost', 'Disconnect', undefined, true)
    disconnect.addEventListener('click', async () => {
      disconnect.disabled = true
      try { setSnapshot(await window.frontier.disconnectMcpServer(server.id)); showToast(`${server.name || 'MCP server'} disconnected`) }
      catch (error) { reportError('Could not disconnect MCP server', error) }
      finally { renderMcpServers(); void refreshPreview() }
    })
    actions.append(disconnect)
  }
  auth.append(message, actions)
  return auth
}

function renderMcpServers(): void {
  const draft = ensureDraft()
  const list = byId('cp-server-list')
  if (!draft.mcpServers.length) {
    list.replaceChildren(element('p', 'settings-empty', 'No MCP servers yet. Add one, or import a .mcp.json, to share it across every agent.'))
    return
  }
  list.replaceChildren(...draft.mcpServers.map((server) => {
    const row = element('div', 'cp-server')
    const top = element('div', 'cp-server-top')
    const toggle = switchControl(undefined, server.enabled, `Enable ${server.name || 'this MCP server'}`)
    toggle.input.addEventListener('change', () => { server.enabled = toggle.input.checked; serverEdited() })

    const name = textInput(server.name); name.className = 'input mono-text'; name.placeholder = 'server-name'; name.setAttribute('aria-label', 'Server name')
    name.addEventListener('input', () => { server.name = name.value; toggle.input.setAttribute('aria-label', `Enable ${server.name || 'this MCP server'}`); serverEdited() })

    const transport = document.createElement('select'); transport.className = 'select'; transport.setAttribute('aria-label', 'Transport')
    for (const option of ['stdio', 'http', 'sse']) transport.append(new Option(option, option))
    transport.value = server.transport
    transport.addEventListener('change', () => { server.transport = transport.value as McpTransport; serverEdited(); renderMcpServers() })

    const remove = kitButton('danger', 'Remove', undefined, true)
    remove.setAttribute('aria-label', `Remove ${server.name || 'this MCP server'}`)
    remove.addEventListener('click', () => {
      draft.mcpServers = draft.mcpServers.filter((item) => item.id !== server.id)
      serverEdited(); renderMcpServers()
    })
    top.append(toggle.wrap, name, transport, remove)

    const detail = element('div', 'cp-server-detail')
    if (server.transport === 'stdio') {
      const command = textInput(server.command ?? ''); command.className = 'input mono-text'; command.placeholder = 'npx'
      command.addEventListener('input', () => { server.command = command.value; serverEdited() })
      const args = textInput((server.args ?? []).join(' ')); args.className = 'input mono-text'; args.placeholder = 'space-separated'
      args.addEventListener('input', () => { server.args = splitArguments(args.value); serverEdited() })
      const env = textArea(recordToLines(server.env, '='), 2); env.className = 'textarea mono-text cp-short'; env.placeholder = 'KEY=value (one per line)'
      env.addEventListener('input', () => { server.env = linesToRecord(env.value, '='); serverEdited() })
      detail.append(labelled('Command', command), labelled('Arguments', args), labelled('Environment variables', env, true))
    } else {
      const url = textInput(server.url ?? ''); url.className = 'input mono-text'; url.placeholder = 'https://host/mcp'
      url.addEventListener('input', () => { server.url = url.value; serverEdited() })
      const headers = textArea(recordToLines(server.headers, ': '), 2); headers.className = 'textarea mono-text cp-short'; headers.placeholder = 'Header-Name: value (one per line)'
      headers.addEventListener('input', () => { server.headers = linesToRecord(headers.value, ':'); serverEdited() })
      detail.append(labelled('Server URL', url, true), labelled('Headers', headers, true))
    }
    row.append(top, detail)
    if (server.transport !== 'stdio') row.append(serverAuth(server))
    return row
  }))
}

function renderPreviewProviderOptions(): void {
  const select = byId<HTMLSelectElement>('cp-preview-provider')
  const current = select.value
  const capable = snapshot.providers.filter((provider) => (SKILL_CAPABLE_KINDS as readonly string[]).includes(provider.kind))
  select.replaceChildren(new Option('Select agent…', ''), ...capable.map((provider) => new Option(provider.name, provider.id)))
  if (capable.some((provider) => provider.id === current)) select.value = current
  else if (!current && capable[0]) select.value = capable[0].id
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

// Tab entry only. A clean tab re-reads the saved profile; a dirty one keeps the draft and every
// field the user has typed into.
export function renderControlPlane(): void {
  if (!controlForm?.isDirty()) controlPlaneDraft = undefined
  const draft = ensureDraft()
  const form = controlForm!
  form.reflect('cp-system-prompt', draft.systemPrompt ?? '')
  form.reflect('cp-add-dirs', (draft.addDirs ?? []).join('\n'))
  form.reflect('cp-allowed', (draft.allowedTools ?? []).join('\n'))
  form.reflect('cp-disallowed', (draft.disallowedTools ?? []).join('\n'))
  strictSwitch.reflect('cp-strict-mcp', Boolean(snapshot.settings.controlPlane.strictMcp))
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
  const form = createDirtyGuard(TEXT_FIELDS)
  controlForm = form
  strictSwitch = createDirtyGuard(['cp-strict-mcp'])
  for (const id of TEXT_FIELDS) byId(id).addEventListener('input', () => void refreshPreview())

  bindSaveBar(byId('control-save-bar'), form, {
    save: async () => {
      try { await persistControlPlaneDraft(true); void refreshPreview() }
      catch (error) { reportError('Could not save configuration', error) }
    },
    discard: () => { controlPlaneDraft = undefined; renderControlPlane() }
  })

  // Strict MCP applies on its own: the saved profile with just this flag changed, so pending edits
  // elsewhere in the tab are neither committed nor lost. The draft takes the same value.
  byId<HTMLInputElement>('cp-strict-mcp').addEventListener('change', async (event) => {
    const input = event.target as HTMLInputElement
    input.disabled = true
    try {
      setSnapshot(await window.frontier.updateControlPlane({ ...cloneProfile(snapshot.settings.controlPlane), strictMcp: input.checked }))
      ensureDraft().strictMcp = input.checked
      showToast(input.checked ? 'Strict MCP on' : 'Strict MCP off')
    } catch (error) { reportError('Could not change Strict MCP', error) }
    finally { input.disabled = false; strictSwitch.clear(); strictSwitch.reflect('cp-strict-mcp', Boolean(snapshot.settings.controlPlane.strictMcp)); void refreshPreview() }
  })

  byId('cp-add-server').addEventListener('click', () => {
    const draft = syncDraftFromInputs()
    const server: McpServerConfig = { id: newId(), name: '', enabled: true, transport: 'stdio', command: '', args: [] }
    draft.mcpServers.push(server)
    serverEdited(false)
    renderMcpServers()
    byId('cp-server-list').querySelector<HTMLInputElement>('.cp-server:last-child .cp-server-top input.input')?.focus()
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
}
