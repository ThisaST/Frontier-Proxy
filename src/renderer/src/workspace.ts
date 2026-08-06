// Collaborative workspaces (ADR 0001) — a second conversation shape alongside the task
// view. Kept in its own module so `main.ts`'s diff stays a handful of lines: an import,
// a nav entry, one switchView case, one line in the snapshot re-render path, and the
// stream subscription (see the module's exports at the bottom).
//
// Hard rule (ADR D2): the renderer only ever sees `ParticipantView`. No `ProviderKind`,
// no `provider.kind` branching, no per-agent icons — adding a sixth provider kind must
// never touch this file.
import { renderMarkdown } from './markdown'
import { openBranchInReview } from './main'
import { handleFromName, isValidHandle, normalizeHandle, parseMentions } from '../../shared/mentions'
import type {
  ActivityEvent, AppSnapshot, ParticipantCapability, ParticipantKind, ParticipantView,
  WorkspaceMessage, WorkspaceStreamEvent, WorkspaceTurn, WorkspaceView
} from '../../shared/types'

type SnapshotProvider = AppSnapshot['providers'][number]

// ---- Small helpers duplicated from main.ts ----
// main.ts's diff must stay tiny (see CLAUDE.md / the phase brief), so nothing is
// exported from there for this module to import — these few generic helpers are
// copied rather than shared, matching main.ts's own terse style.
const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

function element(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function emptyState(title: string, detail: string): HTMLElement {
  const empty = element('div', 'empty-state')
  empty.append(element('strong', undefined, title), detail)
  return empty
}

function timeAgo(date?: string): string {
  if (!date) return '—'
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+':\s*/, '')
  return String(error)
}

let toastTimer: number | undefined
function showToast(message: string): void {
  const toast = byId('toast')
  toast.textContent = message
  toast.classList.remove('show')
  window.clearTimeout(toastTimer)
  requestAnimationFrame(() => toast.classList.add('show'))
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2_800)
}

function reportError(action: string, error: unknown): void {
  const message = `${action}: ${errorMessage(error)}`
  console.error(message, error)
  showToast(message)
}

// A real confirmation step for anything that removes a workspace or a participant —
// mirrors main.ts's own confirmAction over the same shared `#confirm-dialog` markup.
// Only one modal can be open at a time, so the two independent implementations never race.
const confirmDialog = byId<HTMLDialogElement>('confirm-dialog')
function confirmAction(title: string, body: string, acceptLabel: string): Promise<boolean> {
  byId('confirm-title').textContent = title
  byId('confirm-body').textContent = body
  const accept = byId<HTMLButtonElement>('confirm-accept')
  accept.textContent = acceptLabel
  confirmDialog.showModal()
  return new Promise((resolve) => {
    const finish = (value: boolean): void => {
      accept.removeEventListener('click', onAccept)
      confirmDialog.removeEventListener('close', onClose)
      confirmDialog.close()
      resolve(value)
    }
    const onAccept = (): void => finish(true)
    const onClose = (): void => resolve(false)
    accept.addEventListener('click', onAccept)
    confirmDialog.addEventListener('close', onClose, { once: true })
  })
}

const ACTIVITY_ICON: Record<string, string> = { tool: '⚙', thinking: '✳', notice: '•' }
const CAPABILITY_META: Record<ParticipantCapability, { icon: string; label: string }> = {
  'read-repo': { icon: '⌁', label: 'read' },
  'edit-files': { icon: '⎇', label: 'branch' },
  'run-commands': { icon: '⚙', label: 'run' }
}
// Reused from the existing palette (hljs-keyword / hljs-type) rather than inventing new
// hex values — participant accents are the one place new *colours* are allowed, and even
// there we stay inside tokens the stylesheet already defines.
const ACCENT_SWATCHES = ['var(--green)', 'var(--blue)', 'var(--yellow)', 'var(--red)', '#e4a9eb', '#7ed9c4']

// ---- Module state ----
let latestSnapshot: AppSnapshot | undefined
let selectedWorkspaceId: string | undefined
let lastThreadRender = { id: '', length: -1 }
let repoContextCache: { cwd: string; skillCount: number } | undefined
let activeRosterMenuCleanup: (() => void) | undefined
let participantEditTarget: { workspaceId: string; participantId?: string } | undefined
let participantKind: ParticipantKind = 'agent'
let participantAccent: string = ACCENT_SWATCHES[0]
let workspaceFormMode: 'create' | 'rename' = 'create'
let workspaceFormTargetId: string | undefined
const mentionState: { entries: ParticipantView[]; index: number; range?: { start: number; end: number } } = { entries: [], index: 0 }

function currentWorkspace(): WorkspaceView | undefined {
  return latestSnapshot?.workspaces.find((workspace) => workspace.id === selectedWorkspaceId)
}

function providerLabel(id?: string): string | undefined {
  return latestSnapshot?.providers.find((provider) => provider.id === id)?.name
}

// Clicking an existing nav item is the plain cross-view navigation this module needs
// for Context & Tools — reusing the generic listener main.ts already attaches to every
// `.nav-item` (`switchView(item.dataset.view)`). Opening a branch in Review also needs
// to preselect it, so that case goes through `openBranchInReview` instead (below).
function goToNav(view: string): void {
  (document.querySelector<HTMLElement>(`.nav-item[data-view="${view}"]`))?.click()
}

// ---- Repo context card (Column 2) ----

function renderRepoContext(): void {
  const workspace = currentWorkspace()
  const container = byId('workspace-repo-context')
  if (!workspace) { container.replaceChildren(); return }
  const mcpCount = latestSnapshot?.settings.controlPlane.mcpServers.filter((server) => server.enabled).length ?? 0
  const skillCount = repoContextCache?.cwd === workspace.cwd ? repoContextCache.skillCount : undefined
  const path = element('p', undefined, workspace.cwd); path.title = workspace.cwd
  const link = element('button', 'text-button', 'Context & Tools →')
  link.addEventListener('click', () => goToNav('control'))
  container.replaceChildren(
    element('p', 'eyebrow', 'REPO CONTEXT'),
    path,
    element('p', undefined, `Skills ${skillCount ?? '…'} · MCP ${mcpCount}`),
    link
  )
  if (repoContextCache?.cwd !== workspace.cwd) void loadRepoContextSkills(workspace.cwd)
}

async function loadRepoContextSkills(cwd: string): Promise<void> {
  try { repoContextCache = { cwd, skillCount: (await window.frontier.listSkills(cwd)).skills.length } }
  catch { repoContextCache = { cwd, skillCount: 0 } }
  if (currentWorkspace()?.cwd === cwd) renderRepoContext()
}

// ---- Workspace list (Column 2) ----

function renderWorkspaceList(workspaces: WorkspaceView[]): void {
  const list = byId('workspace-list')
  list.replaceChildren(...workspaces.map((workspace) => {
    const row = element('button', `workspace-item${workspace.id === selectedWorkspaceId ? ' selected' : ''}`)
    const agents = workspace.participants.filter((participant) => participant.kind === 'agent')
    const available = agents.filter((participant) => participant.available).length
    row.append(element('strong', undefined, workspace.name))
    const meta = element('div', 'workspace-item-meta')
    meta.append(element('span', undefined, `${agents.length} agent${agents.length === 1 ? '' : 's'}`))
    if (agents.length) meta.append(element('span', 'workspace-item-online', `● ${available}`))
    row.append(meta)
    row.addEventListener('click', () => {
      if (selectedWorkspaceId === workspace.id) return
      selectedWorkspaceId = workspace.id
      closeRosterMenu()
      lastThreadRender = { id: '', length: -1 }
      if (latestSnapshot) renderWorkspaceView(latestSnapshot)
    })
    return row
  }))
}

// ---- Conversation (Column 3) ----

function renderConversation(): void {
  const workspace = currentWorkspace()
  const title = byId('workspace-conv-title')
  const subtitle = byId('workspace-conv-subtitle')
  const rename = byId<HTMLButtonElement>('workspace-rename-button')
  const remove = byId<HTMLButtonElement>('workspace-delete-button')
  const composer = byId('workspace-composer')
  rename.disabled = !workspace
  remove.disabled = !workspace
  if (!workspace) {
    title.textContent = 'Select a workspace'
    subtitle.textContent = ''
    composer.hidden = true
    byId('workspace-thread').replaceChildren(emptyState('Nothing selected', 'Choose a workspace from the list to see its conversation and participants.'))
    byId('workspace-addressing-hint').textContent = ''
    lastThreadRender = { id: '', length: -1 }
    return
  }
  title.textContent = workspace.name
  subtitle.textContent = workspace.cwd
  subtitle.title = workspace.cwd
  composer.hidden = false
  renderThread(workspace)
  renderAddressingHint(workspace)
}

function participantFor(workspace: WorkspaceView, id?: string): ParticipantView | undefined {
  return id ? workspace.participants.find((participant) => participant.id === id) : undefined
}

function avatarDot(participant?: ParticipantView): HTMLElement {
  const dot = element('span', 'ws-avatar-dot')
  if (participant?.accent) dot.style.background = participant.accent
  return dot
}

function messageBubble(message: WorkspaceMessage, participant?: ParticipantView): HTMLElement {
  const block = element('article', `ws-message ${message.author}`)
  const head = element('div', 'ws-message-head')
  if (message.author === 'system') head.append(element('strong', undefined, 'system'))
  else head.append(avatarDot(participant), element('strong', undefined, participant?.name ?? 'Unknown'))
  head.append(element('span', undefined, timeAgo(message.createdAt)))
  block.append(head)
  const body = element('div', 'ws-message-body')
  body.textContent = message.author === 'system' ? (message.systemReason ?? message.text) : message.text
  block.append(body)
  return block
}

function queuedLabel(turn: WorkspaceTurn, participant?: ParticipantView): string {
  const provider = latestSnapshot?.providers.find((item) => item.id === turn.providerId)
  const running = provider?.runtime.running ?? 0
  return `⏳ waiting for ${provider?.name ?? participant?.name ?? 'agent'}${running ? ` (${running} running)` : ''}`
}

function activityRow(event: ActivityEvent): HTMLElement {
  const row = element('div', `detail-activity-row ${event.kind}`)
  const body = element('div')
  body.append(element('strong', undefined, event.label))
  if (event.detail) body.append(element('small', undefined, event.detail))
  row.append(element('span', undefined, ACTIVITY_ICON[event.kind] ?? '•'), body)
  return row
}

function turnBubble(workspace: WorkspaceView, turn: WorkspaceTurn): HTMLElement {
  const participant = participantFor(workspace, turn.participantId)
  const block = element('article', `ws-message agent ${turn.status}`)
  const head = element('div', 'ws-message-head')
  head.append(avatarDot(participant), element('strong', undefined, participant ? `${participant.name} · ${participant.role}` : 'Unknown participant'))
  if (turn.status === 'queued') head.append(element('span', 'ws-message-status', queuedLabel(turn, participant)))
  else if (turn.status === 'running') head.append(element('span', 'ws-message-status', '▌ working…'))
  else if (turn.status === 'failed') head.append(element('span', 'ws-message-status', `⚠ ${turn.error ?? 'Failed'}`))
  else if (turn.status === 'cancelled') head.append(element('span', undefined, 'Cancelled'))
  else head.append(element('span', undefined, timeAgo(turn.finishedAt ?? turn.startedAt)))
  block.append(head)

  const body = element('div', 'ws-message-body markdown')
  if (turn.output.trim()) body.appendChild(renderMarkdown(turn.output))
  else if (turn.status === 'failed') body.textContent = turn.error ?? 'Failed.'
  else if (turn.status === 'running') body.textContent = 'Working…'
  else if (turn.status === 'queued') body.textContent = 'Waiting for a slot…'
  else body.textContent = '—'
  block.append(body)

  // The live activity feed reuses the exact rendering the task view uses for
  // `task.activity` (tool label + one-line detail), just scoped to this turn.
  if (turn.status === 'running' && turn.activity?.length) {
    const activity = element('div', 'ws-message-activity')
    for (const event of turn.activity.slice(-6)) activity.append(activityRow(event))
    block.append(activity)
  }

  const foot = element('div', 'ws-turn-foot')
  if (turn.branch) {
    const branch = element('button', 'lane-branch') as HTMLButtonElement
    const fileNote = turn.filesChanged?.length ? ` · ${turn.filesChanged.length} file${turn.filesChanged.length === 1 ? '' : 's'}` : ''
    branch.textContent = turn.committed ? `⎇ ${turn.branch}${fileNote}` : `⎇ ${turn.branch} · no changes`
    branch.title = turn.committed ? 'Open this branch in Review' : 'Isolated branch; nothing was changed'
    branch.disabled = !turn.committed
    if (turn.committed) branch.addEventListener('click', () => openBranchInReview(workspace.cwd, turn.branch!))
    foot.append(branch)
  }
  if (turn.status === 'failed') {
    const retry = element('button', 'secondary-button', 'Retry this reply') as HTMLButtonElement
    retry.addEventListener('click', async () => {
      retry.disabled = true
      try { await window.frontier.retryWorkspaceTurn(workspace.id, turn.id) }
      catch (error) { reportError('Could not retry this reply', error); retry.disabled = false }
    })
    foot.append(retry)
  }
  if (turn.status === 'running' || turn.status === 'queued') {
    const cancel = element('button', 'secondary-button', 'Cancel') as HTMLButtonElement
    cancel.addEventListener('click', async () => {
      cancel.disabled = true
      try { await window.frontier.cancelWorkspaceTurn(workspace.id, turn.id) }
      catch (error) { reportError('Could not cancel this reply', error); cancel.disabled = false }
    })
    foot.append(cancel)
  }
  if (foot.childElementCount) block.append(foot)
  return block
}

// Mirrors the task view's own `renderThread`: a signature guard so a snapshot tick with
// nothing new to show is a no-op, and a full repaint (not incremental append) otherwise,
// preserving scroll position only when the reader was already at the bottom.
function renderThread(workspace: WorkspaceView): void {
  const thread = byId('workspace-thread')
  const turnLength = workspace.turns.reduce((total, turn) => total + turn.output.length + turn.status.length + (turn.activity?.length ?? 0), 0)
  const messageLength = workspace.messages.reduce((total, message) => total + message.text.length, 0)
  const signature = { id: workspace.id, length: turnLength + messageLength + workspace.turns.length * 7 + workspace.messages.length * 3 }
  if (lastThreadRender.id === signature.id && lastThreadRender.length === signature.length) return
  lastThreadRender = signature
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60

  const turnsByMessage = new Map<string, WorkspaceTurn[]>()
  for (const turn of workspace.turns) turnsByMessage.set(turn.messageId, [...(turnsByMessage.get(turn.messageId) ?? []), turn])

  const fragment = document.createDocumentFragment()
  const sorted = [...workspace.messages].sort((left, right) => left.seq - right.seq)
  for (const message of sorted) {
    // An 'agent' message is only ever the plain-text record of a turn that already
    // completed (`WorkspaceRuntime.appendAgentMessage`); the richer turn bubble below
    // (model, activity, branch) is rendered instead, right after its trigger, so the
    // reply never appears twice.
    if (message.author === 'agent') continue
    fragment.append(messageBubble(message, participantFor(workspace, message.participantId)))
    for (const turn of turnsByMessage.get(message.id) ?? []) fragment.append(turnBubble(workspace, turn))
  }
  if (!sorted.length) fragment.append(emptyState('Nothing yet', 'Say something, and @mention a participant to bring them in.'))
  thread.replaceChildren(fragment)
  const anyBusy = workspace.turns.some((turn) => turn.status === 'running' || turn.status === 'queued')
  if (anyBusy || atBottom) thread.scrollTop = thread.scrollHeight
}

function renderAddressingHint(workspace: WorkspaceView): void {
  const input = byId<HTMLTextAreaElement>('ws-composer-input')
  const hint = byId('workspace-addressing-hint')
  const { addressed } = parseMentions(input.value, workspace.participants)
  if (!addressed.length) {
    hint.textContent = 'No one addressed — this will be posted to the log only.'
    hint.classList.remove('addressed')
    return
  }
  const handles = addressed.map((id) => `@${workspace.participants.find((participant) => participant.id === id)?.handle ?? id}`)
  hint.textContent = `Addressing ${handles.join(', ')}`
  hint.classList.add('addressed')
}

function renderAddressingHintFromInput(): void {
  const workspace = currentWorkspace()
  if (workspace) renderAddressingHint(workspace)
}

// ---- Mention autocomplete (same keyboard contract as the file-mention menu) ----

function closeWsMentions(): void {
  mentionState.entries = []; mentionState.index = 0; mentionState.range = undefined
  byId('ws-composer-mentions').hidden = true
}

function selectWsMention(entry: ParticipantView): void {
  const input = byId<HTMLTextAreaElement>('ws-composer-input')
  if (!mentionState.range) return
  const insertion = `@${entry.handle} `
  input.value = `${input.value.slice(0, mentionState.range.start)}${insertion}${input.value.slice(mentionState.range.end)}`
  const caret = mentionState.range.start + insertion.length
  input.setSelectionRange(caret, caret)
  closeWsMentions()
  input.focus()
  renderAddressingHintFromInput()
}

function renderWsMentions(): void {
  const menu = byId('ws-composer-mentions')
  if (!mentionState.entries.length) {
    menu.replaceChildren(element('div', 'composer-mention-empty', 'No matching participants'))
    menu.hidden = false
    return
  }
  menu.replaceChildren(...mentionState.entries.map((entry, index) => {
    const button = element('button', `composer-mention ${index === mentionState.index ? 'selected' : ''}`)
    button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === mentionState.index))
    const copy = element('span', 'composer-mention-copy')
    const detail = [entry.role, entry.kind === 'agent' ? providerLabel(entry.providerId) : undefined, entry.available ? undefined : (entry.unavailableReason ?? 'unavailable')]
      .filter(Boolean).join(' · ')
    copy.append(element('strong', undefined, entry.name), element('small', undefined, detail))
    button.append(element('span', `provider-dot ${entry.available ? 'online' : ''}`), copy)
    button.addEventListener('mousedown', (event) => { event.preventDefault(); selectWsMention(entry) })
    return button
  }))
  menu.hidden = false
}

// Unavailable participants stay listed and selectable (wireframe §2) — you find out why
// a mention can't be reached at send time, via a system message, not by it vanishing here.
function refreshWsMentions(): void {
  const input = byId<HTMLTextAreaElement>('ws-composer-input')
  const caret = input.selectionStart ?? input.value.length
  const before = input.value.slice(0, caret)
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before)
  const workspace = currentWorkspace()
  if (!match || !workspace) { closeWsMentions(); return }
  mentionState.range = { start: caret - match[1].length - 1, end: caret }
  const query = match[1].trim().toLowerCase()
  mentionState.entries = workspace.participants.filter((participant) => !query || participant.handle.includes(query) || participant.name.toLowerCase().includes(query))
  mentionState.index = 0
  renderWsMentions()
}

function handleWsMentionKeydown(event: KeyboardEvent): boolean {
  const menu = byId('ws-composer-mentions')
  if (menu.hidden || !mentionState.entries.length) return false
  if (event.key === 'ArrowDown') { event.preventDefault(); mentionState.index = Math.min(mentionState.entries.length - 1, mentionState.index + 1); renderWsMentions(); return true }
  if (event.key === 'ArrowUp') { event.preventDefault(); mentionState.index = Math.max(0, mentionState.index - 1); renderWsMentions(); return true }
  if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); selectWsMention(mentionState.entries[mentionState.index]); return true }
  if (event.key === 'Escape') { event.preventDefault(); closeWsMentions(); return true }
  return false
}

async function sendWsMessage(): Promise<void> {
  const workspace = currentWorkspace()
  if (!workspace) return
  const input = byId<HTMLTextAreaElement>('ws-composer-input')
  const button = byId<HTMLButtonElement>('ws-composer-send')
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  closeWsMentions()
  renderAddressingHint(workspace)
  input.disabled = true; button.disabled = true
  try { await window.frontier.postWorkspaceMessage(workspace.id, text) }
  catch (error) { input.value = text; reportError('Could not send message', error) }
  finally { input.disabled = false; button.disabled = false; input.focus() }
}

// ---- Roster (Column 4) ----

function closeRosterMenu(): void { activeRosterMenuCleanup?.(); activeRosterMenuCleanup = undefined }

function capabilityChips(participant: ParticipantView): HTMLElement | undefined {
  if (!participant.capabilities.length) return undefined
  const row = element('div', 'ws-capability-chips')
  for (const capability of participant.capabilities) {
    const meta = CAPABILITY_META[capability]
    row.append(element('span', 'ws-capability-chip', `${meta.icon} ${meta.label}`))
  }
  return row
}

function toggleRosterMenu(workspace: WorkspaceView, participant: ParticipantView, anchor: HTMLElement): void {
  if (activeRosterMenuCleanup) { closeRosterMenu(); return }
  const menu = element('div', 'ws-roster-menu')
  const edit = element('button', undefined, 'Edit participant')
  edit.addEventListener('click', () => { closeRosterMenu(); openParticipantEditor(workspace.id, participant.id) })
  const remove = element('button', undefined, 'Remove participant')
  remove.addEventListener('click', async () => {
    closeRosterMenu()
    const confirmed = await confirmAction('Remove this participant?', `${participant.name} (@${participant.handle}) will be removed from this workspace. Past messages stay in the log.`, 'Remove')
    if (!confirmed) return
    try { await window.frontier.removeParticipant(workspace.id, participant.id) }
    catch (error) { reportError('Could not remove participant', error) }
  })
  menu.append(edit, remove)
  anchor.append(menu)
  activeRosterMenuCleanup = () => menu.remove()
  window.setTimeout(() => document.addEventListener('click', closeRosterMenu, { once: true }), 0)
}

function rosterRow(workspace: WorkspaceView, participant: ParticipantView): HTMLElement {
  const row = element('div', 'workspace-roster-row')
  row.append(element('span', `provider-dot ${participant.available ? 'online' : ''}`))
  const body = element('div', 'workspace-roster-row-body')
  body.append(element('strong', undefined, participant.name))
  if (participant.kind === 'agent') {
    const provider = latestSnapshot?.providers.find((item) => item.id === participant.providerId)
    body.append(element('small', undefined, [participant.role, provider?.name, participant.model].filter(Boolean).join(' · ')))
  } else if (participant.role) body.append(element('small', undefined, participant.role))
  if (!participant.available && participant.unavailableReason) body.append(element('small', 'ws-unavailable-reason', participant.unavailableReason))
  const chips = capabilityChips(participant)
  if (chips) body.append(chips)
  row.append(body)

  const menuButton = element('button', 'ws-roster-menu-button', '⋯')
  menuButton.setAttribute('aria-label', `Actions for ${participant.name}`)
  menuButton.addEventListener('click', (event) => { event.stopPropagation(); toggleRosterMenu(workspace, participant, row) })
  row.append(menuButton)
  return row
}

// Creating a workspace seeds only the human participant; every other enabled agent is
// shown here as a not-yet-added suggestion until the user actually adds it.
function suggestedRow(workspace: WorkspaceView, provider: SnapshotProvider): HTMLElement {
  const row = element('div', 'workspace-roster-row suggested')
  row.append(element('span', 'provider-dot'))
  const body = element('div', 'workspace-roster-row-body')
  body.append(element('strong', undefined, provider.name), element('small', undefined, 'Not yet added'))
  row.append(body)
  const add = element('button', 'text-button ws-add-button', '+ Add')
  add.addEventListener('click', () => openParticipantEditor(workspace.id, undefined, provider.id))
  row.append(add)
  return row
}

function rosterGroup(label: string, rows: HTMLElement[]): HTMLElement {
  const group = element('div', 'workspace-roster-group')
  group.append(element('p', 'eyebrow', label))
  const list = element('div', 'workspace-roster-list')
  list.append(...rows)
  group.append(list)
  return group
}

function renderRoster(): void {
  const workspace = currentWorkspace()
  const container = byId('workspace-roster')
  closeRosterMenu()
  if (!workspace) { container.replaceChildren(); return }
  const humans = workspace.participants.filter((participant) => participant.kind === 'human')
  const agents = workspace.participants.filter((participant) => participant.kind === 'agent')
  const suggested = (latestSnapshot?.providers ?? []).filter((provider) => provider.enabled && !agents.some((agent) => agent.providerId === provider.id))

  const agentRows = [...agents.map((agent) => rosterRow(workspace, agent)), ...suggested.map((provider) => suggestedRow(workspace, provider))]
  container.replaceChildren(
    rosterGroup('HUMANS', humans.map((human) => rosterRow(workspace, human))),
    rosterGroup('AGENTS', agentRows),
    element('p', 'workspace-roster-footer', 'Only participants you @mention will reply.')
  )
}

// ---- Resizable columns (draggable gutters, persisted like `fp-wq-width`) ----

const workspaceGutterAppliers: Array<() => void> = []
function applyWorkspaceGutters(): void { for (const apply of workspaceGutterAppliers) apply() }

function setupResizableColumn(grid: HTMLElement, gutter: HTMLElement, cssVar: string, storageKey: string, min: number, max: number, anchor: 'left' | 'right'): void {
  const clamp = (value: number): number | undefined => (Number.isFinite(value) && value > 0 ? Math.round(Math.min(max, Math.max(min, value))) : undefined)
  const stored = Number(localStorage.getItem(storageKey))
  let width: number | undefined = Number.isFinite(stored) && stored > 0 ? clamp(stored) : undefined
  const apply = (): void => { if (width === undefined) grid.style.removeProperty(cssVar); else grid.style.setProperty(cssVar, `${width}px`) }
  let dragging = false
  gutter.addEventListener('mousedown', (event) => { dragging = true; gutter.classList.add('dragging'); document.body.style.userSelect = 'none'; event.preventDefault() })
  window.addEventListener('mousemove', (event) => {
    if (!dragging) return
    const rect = grid.getBoundingClientRect()
    const clamped = clamp(anchor === 'left' ? event.clientX - rect.left : rect.right - event.clientX)
    if (clamped === undefined) return
    width = clamped
    apply()
  })
  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false; gutter.classList.remove('dragging'); document.body.style.userSelect = ''
    if (width === undefined) localStorage.removeItem(storageKey); else localStorage.setItem(storageKey, String(width))
  })
  workspaceGutterAppliers.push(apply)
}

setupResizableColumn(byId('workspace-grid'), byId('workspace-gutter-list'), '--ws-list-col', 'fp-ws-list-width', 220, 460, 'left')
setupResizableColumn(byId('workspace-grid'), byId('workspace-gutter-roster'), '--ws-roster-col', 'fp-ws-roster-width', 200, 380, 'right')

// ---- Workspace create / rename dialog ----

const workspaceFormDialog = byId<HTMLDialogElement>('workspace-form-dialog')

function openWorkspaceForm(mode: 'create' | 'rename', workspace?: WorkspaceView): void {
  workspaceFormMode = mode
  workspaceFormTargetId = workspace?.id
  byId('workspace-form-title').textContent = mode === 'create' ? 'New workspace' : 'Rename workspace'
  byId<HTMLButtonElement>('ws-workspace-submit').textContent = mode === 'create' ? 'Create' : 'Save'
  byId<HTMLInputElement>('ws-workspace-name').value = workspace?.name ?? ''
  byId('ws-workspace-cwd-field').hidden = mode === 'rename'
  byId<HTMLInputElement>('ws-workspace-cwd').value = workspace?.cwd ?? ''
  byId('ws-workspace-error').textContent = ''
  workspaceFormDialog.showModal()
  requestAnimationFrame(() => byId<HTMLInputElement>('ws-workspace-name').focus())
}

byId('workspace-form-close').addEventListener('click', () => workspaceFormDialog.close())
byId('ws-workspace-cancel').addEventListener('click', () => workspaceFormDialog.close())
byId('ws-workspace-choose-directory').addEventListener('click', async () => {
  const button = byId<HTMLButtonElement>('ws-workspace-choose-directory')
  button.disabled = true; button.textContent = 'Choosing…'
  try {
    const input = byId<HTMLInputElement>('ws-workspace-cwd')
    const directory = await window.frontier.chooseDirectory(input.value)
    if (directory) input.value = directory
  } catch (error) { reportError('Folder picker failed', error) }
  finally { button.disabled = false; button.textContent = 'Choose folder…' }
})
byId<HTMLFormElement>('workspace-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const errorNode = byId('ws-workspace-error'); errorNode.textContent = ''
  const name = byId<HTMLInputElement>('ws-workspace-name').value.trim()
  const cwd = byId<HTMLInputElement>('ws-workspace-cwd').value.trim()
  if (!name) { errorNode.textContent = 'Name is required.'; return }
  const button = byId<HTMLButtonElement>('ws-workspace-submit')
  button.disabled = true
  try {
    if (workspaceFormMode === 'create') {
      if (!cwd) { errorNode.textContent = 'Choose a repository folder.'; return }
      const before = new Set((latestSnapshot?.workspaces ?? []).map((workspace) => workspace.id))
      const next = await window.frontier.createWorkspace(name, cwd)
      const created = next.workspaces.find((workspace) => !before.has(workspace.id))
      if (created) selectedWorkspaceId = created.id
      renderWorkspaceView(next)
    } else if (workspaceFormTargetId) {
      renderWorkspaceView(await window.frontier.updateWorkspace(workspaceFormTargetId, name))
    }
    workspaceFormDialog.close()
  } catch (error) { errorNode.textContent = errorMessage(error) } finally { button.disabled = false }
})

async function deleteCurrentWorkspace(): Promise<void> {
  const workspace = currentWorkspace()
  if (!workspace) return
  const confirmed = await confirmAction('Delete this workspace?', `“${workspace.name}” and its conversation will be deleted. This cannot be undone.`, 'Delete')
  if (!confirmed) return
  try {
    selectedWorkspaceId = undefined
    renderWorkspaceView(await window.frontier.deleteWorkspace(workspace.id))
  } catch (error) { reportError('Could not delete workspace', error) }
}

byId('workspace-new-button').addEventListener('click', () => openWorkspaceForm('create'))
byId('workspace-empty-create').addEventListener('click', () => openWorkspaceForm('create'))
byId('workspace-rename-button').addEventListener('click', () => { const workspace = currentWorkspace(); if (workspace) openWorkspaceForm('rename', workspace) })
byId('workspace-delete-button').addEventListener('click', () => void deleteCurrentWorkspace())

// ---- Participant editor dialog ----

const participantDialog = byId<HTMLDialogElement>('participant-dialog')

function renderAccentPicker(selected: string): void {
  const container = byId('ws-participant-accent')
  container.replaceChildren(...ACCENT_SWATCHES.map((swatch) => {
    const button = element('button', `ws-accent-swatch${swatch === selected ? ' selected' : ''}`) as HTMLButtonElement
    button.style.setProperty('--swatch', swatch)
    button.setAttribute('aria-label', `Accent ${swatch}`)
    button.addEventListener('click', () => { participantAccent = swatch; renderAccentPicker(swatch) })
    return button
  }))
}

function setParticipantKind(kind: ParticipantKind): void {
  participantKind = kind
  document.querySelectorAll<HTMLElement>('#ws-participant-kind .run-mode').forEach((button) => {
    const active = button.dataset.kind === kind
    button.classList.toggle('active', active); button.setAttribute('aria-checked', String(active))
  })
  byId('ws-participant-agent-fields').hidden = kind !== 'agent'
  byId('ws-participant-capabilities').hidden = kind !== 'agent'
}
document.querySelectorAll<HTMLElement>('#ws-participant-kind .run-mode').forEach((button) =>
  button.addEventListener('click', () => setParticipantKind(button.dataset.kind === 'human' ? 'human' : 'agent')))

let handleEdited = false
byId<HTMLInputElement>('ws-participant-handle').addEventListener('input', () => { handleEdited = true })
byId<HTMLInputElement>('ws-participant-name').addEventListener('input', (event) => {
  if (handleEdited) return
  byId<HTMLInputElement>('ws-participant-handle').value = handleFromName((event.target as HTMLInputElement).value)
})

// Model options are scoped to the chosen agent — the same rule `renderTaskModelOptions`
// applies for tasks (model ids are CLI-specific and never travel between agents).
function renderParticipantModelOptions(): void {
  const select = byId<HTMLSelectElement>('ws-participant-model')
  const custom = byId<HTMLInputElement>('ws-participant-model-custom')
  const current = select.value
  const provider = latestSnapshot?.providers.find((item) => item.id === byId<HTMLSelectElement>('ws-participant-provider').value)
  const models = provider?.runtime.models ?? []
  select.replaceChildren(new Option('Provider default', ''), ...models.map((model) => new Option(model, model)), new Option('Custom model…', '__custom__'))
  const values = new Set(['', '__custom__', ...models])
  select.value = values.has(current) ? current : ''
  custom.hidden = select.value !== '__custom__'
}
byId<HTMLSelectElement>('ws-participant-provider').addEventListener('change', renderParticipantModelOptions)
byId<HTMLSelectElement>('ws-participant-model').addEventListener('change', () => {
  const custom = byId<HTMLInputElement>('ws-participant-model-custom')
  custom.hidden = byId<HTMLSelectElement>('ws-participant-model').value !== '__custom__'
  if (!custom.hidden) custom.focus()
})

function openParticipantEditor(workspaceId: string, participantId?: string, suggestedProviderId?: string): void {
  const workspace = latestSnapshot?.workspaces.find((item) => item.id === workspaceId)
  const participant = participantId ? workspace?.participants.find((item) => item.id === participantId) : undefined
  const suggestedProvider = suggestedProviderId ? latestSnapshot?.providers.find((item) => item.id === suggestedProviderId) : undefined
  participantEditTarget = { workspaceId, participantId }

  byId('participant-dialog-title').textContent = participant ? 'Edit participant' : 'Add participant'
  byId<HTMLButtonElement>('ws-participant-submit').textContent = participant ? 'Save' : 'Add'
  byId<HTMLInputElement>('ws-participant-name').value = participant?.name ?? suggestedProvider?.name ?? ''
  byId<HTMLInputElement>('ws-participant-handle').value = participant?.handle ?? (suggestedProvider ? handleFromName(suggestedProvider.name) : '')
  // The handle tracks the name until the user edits it themselves — renaming a suggested
  // participant otherwise left a handle nobody meant to keep.
  handleEdited = Boolean(participant?.handle)
  byId<HTMLInputElement>('ws-participant-role').value = participant?.role ?? (suggestedProvider ? 'Agent' : '')
  // Anything that isn't explicitly 'human' is an agent. A participant persisted without a
  // `kind` used to leave both type buttons unselected and hide the agent fields entirely.
  setParticipantKind(participant?.kind === 'human' ? 'human' : 'agent')

  const providerSelect = byId<HTMLSelectElement>('ws-participant-provider')
  providerSelect.replaceChildren(...(latestSnapshot?.providers ?? []).map((provider) => new Option(provider.name, provider.id)))
  providerSelect.value = participant?.providerId ?? suggestedProviderId ?? providerSelect.options[0]?.value ?? ''
  renderParticipantModelOptions()
  if (participant?.model) {
    const modelSelect = byId<HTMLSelectElement>('ws-participant-model')
    const hasModel = [...modelSelect.options].some((option) => option.value === participant.model)
    modelSelect.value = hasModel ? participant.model : '__custom__'
    byId<HTMLInputElement>('ws-participant-model-custom').hidden = hasModel
    byId<HTMLInputElement>('ws-participant-model-custom').value = hasModel ? '' : participant.model
  }

  participantAccent = participant?.accent ?? ACCENT_SWATCHES[(workspace?.participants.length ?? 0) % ACCENT_SWATCHES.length]
  renderAccentPicker(participantAccent)

  byId<HTMLInputElement>('ws-cap-read').checked = participant ? participant.capabilities.includes('read-repo') : true
  byId<HTMLInputElement>('ws-cap-edit').checked = participant?.capabilities.includes('edit-files') ?? false
  byId<HTMLInputElement>('ws-cap-run').checked = participant?.capabilities.includes('run-commands') ?? false

  byId('ws-participant-error').textContent = ''
  participantDialog.showModal()
  requestAnimationFrame(() => byId<HTMLInputElement>('ws-participant-name').focus())
}

byId('participant-dialog-close').addEventListener('click', () => participantDialog.close())
byId('ws-participant-cancel').addEventListener('click', () => participantDialog.close())
byId('workspace-add-participant-button').addEventListener('click', () => { const workspace = currentWorkspace(); if (workspace) openParticipantEditor(workspace.id) })

byId<HTMLFormElement>('participant-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const errorNode = byId('ws-participant-error'); errorNode.textContent = ''
  if (!participantEditTarget) return
  const name = byId<HTMLInputElement>('ws-participant-name').value.trim()
  const handle = byId<HTMLInputElement>('ws-participant-handle').value.trim()
  const role = byId<HTMLInputElement>('ws-participant-role').value.trim()
  if (!name || !handle || !role) { errorNode.textContent = 'Name, handle, and role are required.'; return }
  if (!isValidHandle(handle)) { errorNode.textContent = 'Handle must start with a letter and contain only letters, numbers, - or _.'; return }
  // Uniqueness itself is validated in the main process (`WorkspaceRuntime.upsertParticipant`)
  // — its error is surfaced below rather than duplicated here.
  const providerId = participantKind === 'agent' ? byId<HTMLSelectElement>('ws-participant-provider').value || undefined : undefined
  if (participantKind === 'agent' && !providerId) { errorNode.textContent = 'Choose an agent.'; return }
  const modelSelect = byId<HTMLSelectElement>('ws-participant-model')
  const model = participantKind === 'agent'
    ? (modelSelect.value === '__custom__' ? byId<HTMLInputElement>('ws-participant-model-custom').value.trim() || undefined : modelSelect.value || undefined)
    : undefined
  const capabilities: ParticipantCapability[] = participantKind === 'agent' ? [
    ...(byId<HTMLInputElement>('ws-cap-read').checked ? (['read-repo'] as const) : []),
    ...(byId<HTMLInputElement>('ws-cap-edit').checked ? (['edit-files'] as const) : []),
    ...(byId<HTMLInputElement>('ws-cap-run').checked ? (['run-commands'] as const) : [])
  ] : []

  const button = byId<HTMLButtonElement>('ws-participant-submit')
  button.disabled = true
  try {
    const next = await window.frontier.upsertParticipant(participantEditTarget.workspaceId, {
      id: participantEditTarget.participantId, handle, name, kind: participantKind, role, providerId, model, capabilities, accent: participantAccent, enabled: true
    })
    renderWorkspaceView(next)
    participantDialog.close()
  } catch (error) { errorNode.textContent = errorMessage(error) } finally { button.disabled = false }
})

// ---- Composer wiring (Enter sends, Shift+Enter newlines — matches the task composer) ----

byId('ws-composer-send').addEventListener('click', () => void sendWsMessage())
const wsComposerInput = byId<HTMLTextAreaElement>('ws-composer-input')
wsComposerInput.addEventListener('input', () => { refreshWsMentions(); renderAddressingHintFromInput() })
wsComposerInput.addEventListener('click', () => refreshWsMentions())
wsComposerInput.addEventListener('keydown', (event) => {
  if (handleWsMentionKeydown(event)) { event.stopImmediatePropagation(); return }
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendWsMessage() }
})
wsComposerInput.addEventListener('blur', () => window.setTimeout(closeWsMentions, 120))

// ---- Public surface main.ts wires up ----

// Called from `switchView`'s workspace case and from `render()`'s snapshot re-render
// path — safe to call repeatedly; it no-ops wherever nothing changed.
export function renderWorkspaceView(snapshot: AppSnapshot): void {
  latestSnapshot = snapshot
  const workspaces = snapshot.workspaces
  const empty = byId('workspace-empty')
  const grid = byId('workspace-grid')
  if (!workspaces.length) {
    empty.hidden = false; grid.hidden = true
    selectedWorkspaceId = undefined
    return
  }
  empty.hidden = true; grid.hidden = false
  if (!selectedWorkspaceId || !workspaces.some((workspace) => workspace.id === selectedWorkspaceId)) selectedWorkspaceId = workspaces[0].id
  renderWorkspaceList(workspaces)
  renderRepoContext()
  renderConversation()
  renderRoster()
  applyWorkspaceGutters()
}

// The dedicated workspace stream channel (ADR D9) only needs to keep the transcript
// pinned to the bottom while a turn is streaming — the text itself always arrives via
// the next full snapshot, exactly like the task view's `onStream` handler.
export function handleWorkspaceStream(event: WorkspaceStreamEvent): void {
  if (event.workspaceId !== selectedWorkspaceId) return
  const thread = byId('workspace-thread')
  thread.scrollTop = thread.scrollHeight
}
