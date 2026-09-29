// Collaborative workspaces (ADR 0001) — a second conversation shape alongside the task
// view. Kept in its own module so `main.ts`'s diff stays a handful of lines: an import,
// a nav entry, one switchView case, one line in the snapshot re-render path, and the
// stream subscription (see the module's exports at the bottom).
//
// Hard rule (ADR D2): the renderer only ever sees `ParticipantView`. No `ProviderKind`,
// no `provider.kind` branching, no per-agent icons — adding a sixth provider kind must
// never touch this file.
import { renderMarkdown } from './markdown'
import { openBranchInReview, switchView } from './main'
import { onProjectChange, projectMatches } from './project'
import { avatar, fieldLabel, restoreFocusOnClose, sectionTitle, status } from './ui/components'
import { byId, element } from './ui/dom'
import { icon, type IconName } from './ui/icons'
import { initRadioGroup, syncRadioGroupTabIndex } from './ui/segmented'
import { handleFromName, isValidHandle, normalizeHandle, parseMentions } from '../../shared/mentions'
import type {
  ActivityEvent, AppSnapshot, ParticipantCapability, ParticipantKind, ParticipantView,
  WorkspaceMessage, WorkspaceStreamEvent, WorkspaceTurn, WorkspaceView
} from '../../shared/types'

type SnapshotProvider = AppSnapshot['providers'][number]

// ---- Small helpers local to this module ----
function emptyState(title: string, detail: string): HTMLElement {
  const empty = element('div', 'empty')
  empty.append(element('strong', 'ws-empty-title', title), element('p', undefined, detail))
  return empty
}

// Two-letter initials for an avatar: "GitHub Copilot" -> GC, "nova" -> NO.
function initialsOf(name: string): string {
  const words = name.trim().split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (!words.length) return '?'
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase()
}

function readStorage(key: string): string | undefined { try { return localStorage.getItem(key) ?? undefined } catch { return undefined } }
function writeStorage(key: string, value: string): void { try { localStorage.setItem(key, value) } catch { /* private mode / disabled storage */ } }
function removeStorage(key: string): void { try { localStorage.removeItem(key) } catch { /* private mode / disabled storage */ } }

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
restoreFocusOnClose(confirmDialog)
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

const ACTIVITY_ICON: Record<string, IconName> = { tool: 'tool', thinking: 'thinking', notice: 'notice' }
// `edit-files` governs isolation, not enforcement (CLAUDE.md, D6): it is worded as what it does,
// never as a permission.
const CAPABILITY_LABEL: Record<ParticipantCapability, string> = {
  'read-repo': 'Reads the repo',
  'edit-files': 'Works on an isolated branch',
  'run-commands': 'Runs commands'
}

// ---- Module state ----
let latestSnapshot: AppSnapshot | undefined
let selectedWorkspaceId: string | undefined
let lastThreadRender = { id: '', length: -1 }
let repoContextCache: { cwd: string; skillCount: number } | undefined
let activeRosterMenuCleanup: (() => void) | undefined
let participantEditTarget: { workspaceId: string; participantId?: string } | undefined
let participantKind: ParticipantKind = 'agent'
// The participant's `accent` stays in state (a stored field) but is no longer rendered or edited:
// avatars are neutral initials. It is carried through an edit so nothing is dropped.
let participantAccent: string | undefined
let workspaceFormMode: 'create' | 'rename' = 'create'
let workspaceFormTargetId: string | undefined
const mentionState: { entries: ParticipantView[]; index: number; range?: { start: number; end: number } } = { entries: [], index: 0 }

function currentWorkspace(): WorkspaceView | undefined {
  return latestSnapshot?.workspaces.find((workspace) => workspace.id === selectedWorkspaceId)
}

function providerLabel(id?: string): string | undefined {
  return latestSnapshot?.providers.find((provider) => provider.id === id)?.name
}

// Plain cross-view navigation (Context & Tools, now a Settings tab), through `switchView`, which
// resolves every old id via nav.ts. Opening a branch in Review also needs to preselect it, so
// that case goes through `openBranchInReview` instead (below).
function goToNav(view: string): void {
  switchView(view)
}

// ---- Repo context card (list column) ----

function renderRepoContext(): void {
  const workspace = currentWorkspace()
  const container = byId('workspace-repo-context')
  if (!workspace) { container.replaceChildren(); return }
  const mcpCount = latestSnapshot?.settings.controlPlane.mcpServers.filter((server) => server.enabled).length ?? 0
  const skillCount = repoContextCache?.cwd === workspace.cwd ? repoContextCache.skillCount : undefined
  const path = element('span', 'mono ws-context-path', workspace.cwd); path.title = workspace.cwd
  const link = element('button', 'btn btn-ghost btn-sm') as HTMLButtonElement
  link.type = 'button'
  link.append(document.createTextNode('Context & Tools'), icon('chevron-right', 14))
  link.addEventListener('click', () => goToNav('control'))
  container.replaceChildren(
    sectionTitle('Repo context', 'div'),
    path,
    element('span', undefined, `Skills ${skillCount ?? '…'} · MCP ${mcpCount}`),
    link
  )
  if (repoContextCache?.cwd !== workspace.cwd) void loadRepoContextSkills(workspace.cwd)
}

async function loadRepoContextSkills(cwd: string): Promise<void> {
  try { repoContextCache = { cwd, skillCount: (await window.frontier.listSkills(cwd)).skills.length } }
  catch { repoContextCache = { cwd, skillCount: 0 } }
  if (currentWorkspace()?.cwd === cwd) renderRepoContext()
}

// ---- Workspace list (list column) ----

function renderWorkspaceList(workspaces: WorkspaceView[]): void {
  const list = byId('workspace-list')
  list.replaceChildren(...workspaces.map((workspace) => {
    const selected = workspace.id === selectedWorkspaceId
    const row = element('button', `row workspace-item${selected ? ' is-selected' : ''}`) as HTMLButtonElement
    row.type = 'button'
    if (selected) row.setAttribute('aria-current', 'true')
    const agents = workspace.participants.filter((participant) => participant.kind === 'agent')
    const available = agents.filter((participant) => participant.available).length

    const main = element('span', 'row-main ws-item-main')
    const path = element('span', 'row-meta mono ws-item-path', workspace.cwd); path.title = workspace.cwd
    const foot = element('span', 'ws-item-foot')
    const group = element('span', 'avatar-group')
    group.setAttribute('aria-hidden', 'true')
    const shown = workspace.participants.slice(0, 4)
    for (const participant of shown) group.append(avatar(initialsOf(participant.name)))
    if (workspace.participants.length > shown.length) group.append(avatar(`+${workspace.participants.length - shown.length}`))
    foot.append(group, agents.length
      ? status(available === agents.length ? 'ok' : 'warn', `${available} of ${agents.length} available`, { title: `${available} of ${agents.length} agent${agents.length === 1 ? '' : 's'} available` })
      : status('neutral', 'No agents'))
    main.append(element('span', 'ws-item-name', workspace.name), path, foot)
    row.append(main)
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

// ---- Conversation ----

function renderConversation(): void {
  const workspace = currentWorkspace()
  const title = byId('workspace-conv-title')
  const subtitle = byId('workspace-conv-subtitle')
  const rename = byId<HTMLButtonElement>('workspace-rename-button')
  const remove = byId<HTMLButtonElement>('workspace-delete-button')
  const participantsButton = byId<HTMLButtonElement>('workspace-participants-button')
  const composer = byId('workspace-composer')
  rename.disabled = !workspace
  remove.disabled = !workspace
  participantsButton.disabled = !workspace
  byId('workspace-participants-count').textContent = String(workspace?.participants.length ?? 0)
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

// ---- Mentions in rendered text ----
// A `@handle` that names a participant renders as an inline pill. It is display only: the
// dispatcher (main process, `postMessage`) is the sole thing that starts a run, and an agent's
// reply never does (ADR D4), so a pill in a reply carries no behaviour at all.

const MENTION_AT = /(^|[\s([{])@([A-Za-z0-9_-]+)/g
const CODE_SPAN = /(```[\s\S]*?```|`[^`\n]*`)/
const REPLY_MENTION_NOTE = 'A mention in a reply does not start anything'

function handlesOf(workspace: WorkspaceView): Set<string> {
  return new Set(workspace.participants.map((participant) => normalizeHandle(participant.handle)))
}

function mentionNodes(text: string, handles: Set<string>, note?: string): Node[] {
  const nodes: Node[] = []
  let last = 0
  for (const match of text.matchAll(MENTION_AT)) {
    const handle = match[2]
    if (!handles.has(handle.toLowerCase())) continue
    const start = (match.index ?? 0) + match[1].length
    if (start > last) nodes.push(document.createTextNode(text.slice(last, start)))
    const pill = element('span', 'mention', `@${handle}`)
    if (note) pill.title = note
    nodes.push(pill)
    last = start + 1 + handle.length
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)))
  return nodes
}

// Plain message text (human and system messages): mention pills, and code spans left as code
// (a mention inside code is an example, not an address — the same rule `parseMentions` applies).
function richText(text: string, handles: Set<string>): Node[] {
  return text.split(CODE_SPAN).flatMap((part, index) => {
    if (index % 2 === 0) return mentionNodes(part, handles)
    const fenced = part.startsWith('```')
    const code = element(fenced ? 'pre' : 'code', fenced ? 'ws-code-block' : 'ws-code')
    code.textContent = fenced ? part.slice(3, -3).replace(/^[A-Za-z0-9_+-]*\n/, '') : part.slice(1, -1)
    return [code]
  })
}

// Rendered markdown (an agent's reply): wrap mentions in the text nodes, skipping code.
function chipMentions(root: HTMLElement, handles: Set<string>): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest('code, pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  })
  const texts: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text)
  for (const text of texts) {
    if (!text.data.includes('@')) continue
    const replacement = mentionNodes(text.data, handles, REPLY_MENTION_NOTE)
    if (replacement.some((node) => node instanceof HTMLElement)) text.replaceWith(...replacement)
  }
}

function messageBubble(workspace: WorkspaceView, message: WorkspaceMessage, participant?: ParticipantView): HTMLElement {
  const handles = handlesOf(workspace)
  // A system line is the thread naming why something did not happen (an unknown or unreachable
  // handle): centred, quiet, never a silent drop.
  if (message.author === 'system') {
    const line = element('div', 'ws-sys')
    line.title = timeAgo(message.createdAt)
    line.append(...richText(message.systemReason ?? message.text, handles))
    return line
  }
  const block = element('article', 'wmsg human')
  block.append(avatar(initialsOf(participant?.name ?? '?')))
  const main = element('div', 'wmsg-main')
  const head = element('div', 'wmsg-head')
  head.append(element('span', 'wmsg-name', participant?.name ?? 'Unknown'), element('span', 'wmsg-tail wmsg-time', timeAgo(message.createdAt)))
  const body = element('div', 'wmsg-body')
  body.append(...richText(message.text, handles))
  main.append(head, body)
  block.append(main)
  return block
}

function queuedLabel(turn: WorkspaceTurn, participant?: ParticipantView): string {
  const provider = latestSnapshot?.providers.find((item) => item.id === turn.providerId)
  const running = provider?.runtime.running ?? 0
  return `waiting for ${provider?.name ?? participant?.name ?? 'agent'}${running ? ` (${running} running)` : ''}`
}

function activityRow(event: ActivityEvent): HTMLElement {
  const row = element('div', `ws-activity-row ${event.kind}`)
  const body = element('span', 'ws-activity-body')
  body.append(element('span', 'ws-activity-label', event.label))
  if (event.detail) body.append(element('span', 'mono ws-activity-detail', event.detail))
  row.append(icon(ACTIVITY_ICON[event.kind] ?? 'notice', 14), body)
  return row
}

function turnBubble(workspace: WorkspaceView, turn: WorkspaceTurn): HTMLElement {
  const participant = participantFor(workspace, turn.participantId)
  const block = element('article', `wmsg agent ${turn.status}`)
  block.append(avatar(initialsOf(participant?.name ?? '?')))
  const main = element('div', 'wmsg-main')
  const head = element('div', 'wmsg-head')
  head.append(element('span', 'wmsg-name', participant?.name ?? 'Unknown participant'))
  if (participant?.role) head.append(element('span', 'wmsg-role', participant.role))
  const tail = element('span', 'wmsg-tail')
  if (turn.status === 'queued') tail.append(status('neutral', queuedLabel(turn, participant)))
  else if (turn.status === 'running') tail.append(status('running', 'working…'))
  else if (turn.status === 'failed') tail.append(status('danger', turn.error ?? 'Failed'))
  else if (turn.status === 'cancelled') tail.append(status('neutral', 'Cancelled'))
  else { tail.classList.add('wmsg-time'); tail.textContent = timeAgo(turn.finishedAt ?? turn.startedAt) }
  head.append(tail)
  main.append(head)

  const body = element('div', 'wmsg-body markdown')
  if (turn.output.trim()) { body.appendChild(renderMarkdown(turn.output)); chipMentions(body, handlesOf(workspace)) }
  else if (turn.status === 'failed') body.textContent = turn.error ?? 'Failed.'
  else if (turn.status === 'running') body.textContent = 'Working…'
  else if (turn.status === 'queued') body.textContent = 'Waiting for a slot…'
  else body.textContent = '—'
  main.append(body)

  // The live activity feed mirrors `task.activity` (tool label + one-line detail), scoped to this turn.
  if (turn.status === 'running' && turn.activity?.length) {
    const activity = element('div', 'ws-activity')
    for (const event of turn.activity.slice(-6)) activity.append(activityRow(event))
    main.append(activity)
  }

  const foot = element('div', 'ws-turn-foot')
  if (turn.branch) {
    const branch = element('button', 'btn btn-secondary btn-sm') as HTMLButtonElement
    branch.type = 'button'
    const fileNote = turn.filesChanged?.length ? ` · ${turn.filesChanged.length} file${turn.filesChanged.length === 1 ? '' : 's'}` : ''
    branch.append(icon('branch', 14), element('span', 'mono', turn.branch), document.createTextNode(turn.committed ? fileNote : ' · no changes'))
    branch.title = turn.committed ? 'Open this branch in Review' : 'Isolated branch; nothing was changed'
    branch.disabled = !turn.committed
    if (turn.committed) branch.addEventListener('click', () => openBranchInReview(workspace.cwd, turn.branch!))
    foot.append(branch)
  }
  if (turn.status === 'failed') {
    const retry = element('button', 'btn btn-secondary btn-sm', 'Retry this reply') as HTMLButtonElement
    retry.type = 'button'
    retry.addEventListener('click', async () => {
      retry.disabled = true
      try { await window.frontier.retryWorkspaceTurn(workspace.id, turn.id) }
      catch (error) { reportError('Could not retry this reply', error); retry.disabled = false }
    })
    foot.append(retry)
  }
  if (turn.status === 'running' || turn.status === 'queued') {
    const cancel = element('button', 'btn btn-ghost btn-sm', 'Cancel') as HTMLButtonElement
    cancel.type = 'button'
    cancel.addEventListener('click', async () => {
      cancel.disabled = true
      try { await window.frontier.cancelWorkspaceTurn(workspace.id, turn.id) }
      catch (error) { reportError('Could not cancel this reply', error); cancel.disabled = false }
    })
    foot.append(cancel)
  }
  if (foot.childElementCount) main.append(foot)
  block.append(main)
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
    fragment.append(messageBubble(workspace, message, participantFor(workspace, message.participantId)))
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
  const { addressed, unknown } = parseMentions(input.value, workspace.participants)
  if (!addressed.length && !unknown.length) {
    hint.textContent = 'No one addressed — this will be posted to the log only.'
    return
  }
  const nodes: Node[] = []
  if (addressed.length) {
    nodes.push(document.createTextNode('Addressing '))
    addressed.forEach((id, index) => {
      if (index) nodes.push(document.createTextNode(', '))
      nodes.push(element('span', 'mention', `@${workspace.participants.find((participant) => participant.id === id)?.handle ?? id}`))
    })
  }
  if (unknown.length) nodes.push(document.createTextNode(`${addressed.length ? ' · ' : ''}${unknown.map((handle) => `@${handle}`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not in this workspace`))
  hint.replaceChildren(...nodes)
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
    menu.replaceChildren(element('div', 'ws-menu-empty', 'No matching participants'))
    menu.hidden = false
    return
  }
  menu.replaceChildren(...mentionState.entries.map((entry, index) => {
    const selected = index === mentionState.index
    const item = element('button', 'row ws-menu-item') as HTMLButtonElement
    item.type = 'button'
    item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(selected))
    const main = element('span', 'row-main')
    const title = element('span', 'ws-menu-title')
    title.append(element('span', 'ws-menu-name', entry.name), element('span', 'mono ws-handle', `@${entry.handle}`))
    const detail = [entry.role, entry.kind === 'agent' ? providerLabel(entry.providerId) : undefined].filter(Boolean).join(' · ')
    main.append(title, element('span', 'row-meta', detail))
    item.append(avatar(initialsOf(entry.name)), main, availability(entry))
    item.addEventListener('mousedown', (event) => { event.preventDefault(); selectWsMention(entry) })
    return item
  }))
  menu.hidden = false
  menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
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

function autoGrowComposer(): void {
  const input = byId<HTMLTextAreaElement>('ws-composer-input')
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight + 2, 140)}px`
}

async function sendWsMessage(): Promise<void> {
  const workspace = currentWorkspace()
  if (!workspace) return
  const input = byId<HTMLTextAreaElement>('ws-composer-input')
  const button = byId<HTMLButtonElement>('ws-composer-send')
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  autoGrowComposer()
  closeWsMentions()
  renderAddressingHint(workspace)
  input.disabled = true; button.disabled = true
  try { await window.frontier.postWorkspaceMessage(workspace.id, text) }
  catch (error) { input.value = text; reportError('Could not send message', error) }
  finally { input.disabled = false; button.disabled = false; input.focus() }
}

// ---- Roster (Participants dialog) ----
// Moved out of a third grid column into a dialog opened from the conversation header
// (`workspace-participants-button`), so the conversation column keeps that width. The
// dialog is a sibling `<dialog>` of `participant-dialog`, not a nested ancestor of it —
// native `<dialog>` modals stack independently in the top layer, so opening the editor
// from inside this dialog (`openParticipantEditor`, wired further down) layers on top,
// and closing it (`.close()`) only dismisses that one, leaving this dialog open beneath.

const participantsDialog = byId<HTMLDialogElement>('participants-dialog')
restoreFocusOnClose(participantsDialog)
byId('workspace-participants-button').addEventListener('click', () => participantsDialog.showModal())
byId('participants-dialog-close').addEventListener('click', () => participantsDialog.close())

function closeRosterMenu(): void { activeRosterMenuCleanup?.(); activeRosterMenuCleanup = undefined }

// Availability is computed in the main process (`unavailableReason` names why); the renderer
// only prints it: a dot and a word.
function availability(participant: ParticipantView): HTMLElement {
  return participant.available ? status('ok', 'Available') : status('danger', participant.unavailableReason ?? 'Unavailable')
}

function toggleRosterMenu(workspace: WorkspaceView, participant: ParticipantView, anchor: HTMLElement): void {
  if (activeRosterMenuCleanup) { closeRosterMenu(); return }
  const menu = element('div', 'ws-roster-menu')
  const edit = element('button', undefined, 'Edit participant')
  edit.addEventListener('click', () => { closeRosterMenu(); openParticipantEditor(workspace.id, participant.id) })
  const remove = element('button', 'danger', 'Remove participant')
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
  const row = element('div', 'ws-roster-row')
  row.append(avatar(initialsOf(participant.name)))
  const body = element('div', 'ws-roster-body')
  const title = element('div', 'ws-menu-title')
  title.append(element('span', 'ws-menu-name', participant.name), element('span', 'mono ws-handle', `@${participant.handle}`))
  body.append(title)
  const detail = element('div', 'row-meta')
  const provider = participant.kind === 'agent' ? latestSnapshot?.providers.find((item) => item.id === participant.providerId) : undefined
  detail.append(document.createTextNode([participant.role, provider?.name].filter(Boolean).join(' · ')))
  if (participant.kind === 'agent' && participant.model) detail.append(document.createTextNode(' · '), element('span', 'mono', participant.model))
  if (detail.childNodes.length) body.append(detail)
  body.append(availability(participant))
  // What the participant is set up to do, as one quiet line. `edit-files` is worded as isolation
  // ("works on an isolated branch"), never as a permission (CLAUDE.md, D6).
  if (participant.kind === 'agent' && participant.capabilities.length) body.append(element('div', 'ws-cap-line', participant.capabilities.map((capability) => CAPABILITY_LABEL[capability]).join(' · ')))
  row.append(body)

  const menuButton = element('button', 'btn btn-ghost btn-icon btn-sm ws-roster-menu-button') as HTMLButtonElement
  menuButton.type = 'button'
  menuButton.append(icon('more', 16))
  menuButton.setAttribute('aria-label', `Actions for ${participant.name}`)
  menuButton.addEventListener('click', (event) => { event.stopPropagation(); toggleRosterMenu(workspace, participant, row) })
  row.append(menuButton)
  return row
}

// Creating a workspace seeds only the human participant; every other enabled agent is
// shown here as a not-yet-added suggestion until the user actually adds it.
function suggestedRow(workspace: WorkspaceView, provider: SnapshotProvider): HTMLElement {
  const row = element('div', 'ws-roster-row suggested')
  row.append(avatar(initialsOf(provider.name)))
  const body = element('div', 'ws-roster-body')
  body.append(element('div', 'ws-menu-name', provider.name), status('neutral', 'Not yet added'))
  row.append(body)
  const add = element('button', 'btn btn-secondary btn-sm ws-add-button') as HTMLButtonElement
  add.type = 'button'
  add.append(icon('plus', 14), document.createTextNode('Add'))
  add.addEventListener('click', () => openParticipantEditor(workspace.id, undefined, provider.id))
  row.append(add)
  return row
}

function rosterGroup(label: string, rows: HTMLElement[]): HTMLElement {
  const group = element('div', 'workspace-roster-group')
  group.append(fieldLabel(label))
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
    rosterGroup('Humans', humans.map((human) => rosterRow(workspace, human))),
    rosterGroup('Agents', agentRows),
    element('p', 'workspace-roster-footer', 'Only participants you @mention will reply. A mention in a reply never starts another participant.')
  )
}

// ---- Resizable columns (draggable gutters, persisted like `fp-wq-width`) ----

const workspaceGutterAppliers: Array<() => void> = []
function applyWorkspaceGutters(): void { for (const apply of workspaceGutterAppliers) apply() }

function setupResizableColumn(grid: HTMLElement, gutter: HTMLElement, cssVar: string, storageKey: string, min: number, max: number, anchor: 'left' | 'right'): void {
  const clamp = (value: number): number | undefined => (Number.isFinite(value) && value > 0 ? Math.round(Math.min(max, Math.max(min, value))) : undefined)
  const stored = Number(readStorage(storageKey))
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
    if (width === undefined) removeStorage(storageKey); else writeStorage(storageKey, String(width))
  })
  workspaceGutterAppliers.push(apply)
}

setupResizableColumn(byId('workspace-grid'), byId('workspace-gutter-list'), '--ws-list-col', 'fp-ws-list-width', 220, 460, 'left')

onProjectChange(() => { if (latestSnapshot) renderWorkspaceView(latestSnapshot) })

// ---- Workspace create / rename dialog ----

const workspaceFormDialog = byId<HTMLDialogElement>('workspace-form-dialog')
restoreFocusOnClose(workspaceFormDialog)

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
restoreFocusOnClose(participantDialog)

function setParticipantKind(kind: ParticipantKind): void {
  participantKind = kind
  document.querySelectorAll<HTMLElement>('#ws-participant-kind [role="radio"]').forEach((button) => button.setAttribute('aria-checked', String(button.dataset.kind === kind)))
  syncRadioGroupTabIndex(byId('ws-participant-kind'))
  byId('ws-participant-kind-help').textContent = kind === 'human' ? 'A named person in the conversation.' : 'Runs on one of your configured agents.'
  byId('ws-participant-agent-fields').hidden = kind !== 'agent'
  byId('ws-participant-capabilities').hidden = kind !== 'agent'
}
document.querySelectorAll<HTMLElement>('#ws-participant-kind [role="radio"]').forEach((button) =>
  button.addEventListener('click', () => setParticipantKind(button.dataset.kind === 'human' ? 'human' : 'agent')))
initRadioGroup(byId('ws-participant-kind'), (option) => setParticipantKind(option.dataset.kind === 'human' ? 'human' : 'agent'))

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

  participantAccent = participant?.accent

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
wsComposerInput.addEventListener('input', () => { autoGrowComposer(); refreshWsMentions(); renderAddressingHintFromInput() })
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
  const workspaces = snapshot.workspaces.filter((workspace) => projectMatches(workspace.cwd))
  const empty = byId('workspace-empty')
  const grid = byId('workspace-grid')
  if (!workspaces.length) {
    empty.hidden = false; grid.hidden = true
    selectedWorkspaceId = undefined
    byId<HTMLButtonElement>('workspace-participants-button').disabled = true
    byId('workspace-participants-count').textContent = '0'
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
