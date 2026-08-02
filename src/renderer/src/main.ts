import './styles.css'
import { renderMarkdown } from './markdown'
import { highlightSourceLine, parseUnifiedDiff } from './syntax'
import type { AppSnapshot, BranchRepo, ChatContextItem, ControlPlaneProfile, ConversationTurn, McpServerConfig, McpTransport, ProxyTask, RoutingCandidate, SelectedImage, SessionInfo, SubTask, TaskBranch, TaskFileContent, TaskWorkspaceSnapshot, WorkspaceEntry } from '../../shared/types'
import { activeSessions, sessionBlocked, sessionResetAt, sessionStatusNote, sessionWindowElapsedPercent, sessionWindowLabel, sessionWindowPercent } from '../../shared/sessions'

let snapshot: AppSnapshot
let selectedTaskId: string | undefined
let toastTimer: number | undefined
let controlPlaneDraft: ControlPlaneProfile | undefined
let taskQuery = ''
let currentView = 'home'
let agentsTab: 'registry' | 'usage' = 'registry'

// One task surface, three tabs — the task list and the workspace are the same
// screen, so there is no second place a task can be inspected.
let surfaceTab: 'conversation' | 'files' | 'route' = 'conversation'
let focusMode = false
let detailFilePath: string | undefined
let detailFileMode: 'diff' | 'source' = 'diff'
let detailFileState: { taskId: string; path: string; version: string; file: TaskFileContent } | undefined
let detailFileRequest = 0
let detailFileLoadingKey: string | undefined
let detailWorkspaceState: { taskId: string; version: string; workspace: TaskWorkspaceSnapshot } | undefined
let detailWorkspaceLoadingKey: string | undefined
// A project tree is thousands of rows, so folders start collapsed and only the
// branches holding this task's changes (and the open file) are revealed.
let detailTreeTaskId: string | undefined
let detailTreeRevealed: string | undefined
let detailOpenFolders = new Set<string>()
// Avoids re-parsing markdown for a finished task on every unrelated snapshot.
let lastBodyRender = { id: '', status: '', length: -1 }

// Queue/surface split. Widths are clamped against the live grid width, so a
// value saved on a small window can never collapse the layout later.
// SURFACE_MIN_WIDTH and GUTTER_WIDTH mirror the stylesheet's own track sizes for
// `.content-grid`; a queue width clamped against smaller numbers would overflow.
const QUEUE_MIN_WIDTH = 260
const SURFACE_MIN_WIDTH = 430
const GUTTER_WIDTH = 7
let queueWidth: number | undefined
let applyQueueWidth: () => void = () => undefined

// Review inbox
let reviewRepos: BranchRepo[] = []
let reviewLoaded = false
let reviewSelection: { cwd: string; branch: string } | undefined
let reviewFilePath: string | undefined
let reviewDiffRequest = 0

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const taskDialog = byId<HTMLDialogElement>('task-dialog')
const commandPalette = byId<HTMLDialogElement>('command-palette')
const confirmDialog = byId<HTMLDialogElement>('confirm-dialog')
let commandPaletteIndex = 0

interface ComposerDraft {
  items: ChatContextItem[]
  previews: Map<string, string>
  mentionEntries: WorkspaceEntry[]
  mentionIndex: number
  mentionRange?: { start: number; end: number }
  requestVersion: number
}

const composerDrafts = new Map<string, ComposerDraft>()
const attachmentPreviewCache = new Map<string, string>()

function composerDraft(inputId: string): ComposerDraft {
  let draft = composerDrafts.get(inputId)
  if (!draft) {
    draft = { items: [], previews: new Map(), mentionEntries: [], mentionIndex: 0, requestVersion: 0 }
    composerDrafts.set(inputId, draft)
  }
  return draft
}

function composerCwd(inputId: string): string | undefined {
  if (inputId === 'prompt') return byId<HTMLInputElement>('cwd').value.trim() || undefined
  return snapshot?.tasks.find((task) => task.id === selectedTaskId)?.cwd
}

function renderDraftImages(inputId: string): void {
  const draft = composerDraft(inputId)
  const container = byId(`${inputId}-attachments`)
  const images = draft.items.filter((item) => item.kind === 'image')
  container.replaceChildren(...images.map((item) => {
    const chip = document.createElement('div'); chip.className = 'composer-image-chip'; chip.title = item.name
    const image = document.createElement('img'); image.alt = item.name; image.src = draft.previews.get(item.id) ?? ''
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${item.name}`)
    remove.addEventListener('click', () => {
      draft.items = draft.items.filter((candidate) => candidate.id !== item.id)
      draft.previews.delete(item.id)
      renderDraftImages(inputId)
    })
    chip.append(image, remove); return chip
  }))
}

function addImages(inputId: string, selected: SelectedImage[]): void {
  const draft = composerDraft(inputId)
  for (const item of selected) {
    if (draft.items.length >= 12) { showToast('A message can include up to 12 context items'); break }
    if (draft.items.some((candidate) => candidate.id === item.attachment.id)) continue
    draft.items.push(item.attachment)
    draft.previews.set(item.attachment.id, item.previewUrl)
  }
  renderDraftImages(inputId)
}

function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image.'))
    reader.readAsDataURL(file)
  })
}

async function saveDroppedImages(inputId: string, files: File[]): Promise<void> {
  const images = files.filter((file) => file.type.startsWith('image/'))
  if (!images.length) return
  try {
    const selected: SelectedImage[] = []
    for (const file of images.slice(0, 12)) selected.push(await window.frontier.savePastedImage({ dataUrl: await fileDataUrl(file), name: file.name }))
    addImages(inputId, selected)
  } catch (error) { reportError('Could not attach image', error) }
}

function closeMentions(inputId: string): void {
  const draft = composerDraft(inputId)
  draft.mentionEntries = []; draft.mentionRange = undefined; draft.mentionIndex = 0; draft.requestVersion += 1
  byId(`${inputId}-mentions`).hidden = true
}

function selectMention(inputId: string, entry: WorkspaceEntry): void {
  const input = byId<HTMLTextAreaElement>(inputId)
  const draft = composerDraft(inputId)
  if (!draft.mentionRange) return
  const suffix = entry.kind === 'folder' ? '/' : ''
  const insertion = `@${entry.path}${suffix} `
  input.value = `${input.value.slice(0, draft.mentionRange.start)}${insertion}${input.value.slice(draft.mentionRange.end)}`
  const caret = draft.mentionRange.start + insertion.length
  input.setSelectionRange(caret, caret)
  if (!draft.items.some((item) => item.kind === entry.kind && item.path === entry.path) && draft.items.length < 12) {
    draft.items.push({ id: crypto.randomUUID(), kind: entry.kind, name: entry.name, path: entry.path })
  }
  closeMentions(inputId)
  input.focus()
}

function renderMentions(inputId: string): void {
  const draft = composerDraft(inputId)
  const menu = byId(`${inputId}-mentions`)
  const nodes = draft.mentionEntries.map((entry, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = `composer-mention ${index === draft.mentionIndex ? 'selected' : ''}`
    button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === draft.mentionIndex))
    const icon = document.createElement('span'); icon.className = 'composer-mention-icon'; icon.textContent = entry.kind === 'folder' ? '▱' : '◇'
    const copy = document.createElement('span'); copy.className = 'composer-mention-copy'
    const name = document.createElement('strong'); name.textContent = entry.name
    const path = document.createElement('small'); path.textContent = entry.path
    copy.append(name, path); button.append(icon, copy)
    button.addEventListener('mousedown', (event) => { event.preventDefault(); selectMention(inputId, entry) })
    return button
  })
  if (!nodes.length) { const empty = document.createElement('div'); empty.className = 'composer-mention-empty'; empty.textContent = 'No matching files or folders'; menu.replaceChildren(empty) }
  else menu.replaceChildren(...nodes)
  menu.hidden = false
}

async function refreshMentions(inputId: string): Promise<void> {
  const input = byId<HTMLTextAreaElement>(inputId)
  const caret = input.selectionStart ?? input.value.length
  const before = input.value.slice(0, caret)
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (!match) { closeMentions(inputId); return }
  const cwd = composerCwd(inputId)
  const menu = byId(`${inputId}-mentions`)
  if (!cwd) {
    const empty = document.createElement('div'); empty.className = 'composer-mention-empty'; empty.textContent = 'Choose a working folder first'
    menu.replaceChildren(empty); menu.hidden = false; return
  }
  const draft = composerDraft(inputId)
  const version = ++draft.requestVersion
  draft.mentionRange = { start: caret - match[1].length - 1, end: caret }
  try {
    const entries = await window.frontier.listWorkspaceEntries(cwd, match[1].trim())
    if (draft.requestVersion !== version) return
    draft.mentionEntries = entries; draft.mentionIndex = 0; renderMentions(inputId)
  } catch (error) {
    closeMentions(inputId)
    reportError('Could not list project files', error)
  }
}

function handleMentionKeydown(inputId: string, event: KeyboardEvent): boolean {
  const draft = composerDraft(inputId)
  const menu = byId(`${inputId}-mentions`)
  if (menu.hidden || !draft.mentionEntries.length) return false
  if (event.key === 'ArrowDown') { event.preventDefault(); draft.mentionIndex = Math.min(draft.mentionEntries.length - 1, draft.mentionIndex + 1); renderMentions(inputId); return true }
  if (event.key === 'ArrowUp') { event.preventDefault(); draft.mentionIndex = Math.max(0, draft.mentionIndex - 1); renderMentions(inputId); return true }
  if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); selectMention(inputId, draft.mentionEntries[draft.mentionIndex]); return true }
  if (event.key === 'Escape') { event.preventDefault(); closeMentions(inputId); return true }
  return false
}

function messageContext(inputId: string, message: string): ChatContextItem[] {
  return composerDraft(inputId).items.filter((item) => item.kind === 'image' || message.includes(`@${item.path}`))
}

function clearComposerDraft(inputId: string): void {
  const draft = composerDraft(inputId)
  draft.items = []; draft.previews.clear(); closeMentions(inputId); renderDraftImages(inputId)
}

interface CommandPaletteEntry {
  icon: string
  label: string
  detail: string
  shortcut?: string
  keywords: string
  run(): void
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value > 9_999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

function timeAgo(date?: string): string {
  if (!date) return '—'
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function showToast(message: string): void {
  const toast = byId('toast')
  toast.textContent = message
  toast.classList.remove('show')
  window.clearTimeout(toastTimer)
  requestAnimationFrame(() => toast.classList.add('show'))
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2_800)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+':\s*/, '')
  return String(error)
}

function reportError(action: string, error: unknown): void {
  const message = `${action}: ${errorMessage(error)}`
  console.error(message, error)
  showToast(message)
}

// A real confirmation step for anything that rewrites the user's repository.
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

function providerName(id?: string): string {
  return snapshot.providers.find((provider) => provider.id === id)?.name ?? 'Routing…'
}

type SnapshotProvider = AppSnapshot['providers'][number]

function activeCooldown(provider: SnapshotProvider): boolean {
  return Boolean(provider.runtime.cooldownUntil && Date.parse(provider.runtime.cooldownUntil) > Date.now())
}

function trackedTokens(provider: SnapshotProvider): number {
  const usage = provider.runtime.usage
  const actual = usage.inputTokens + usage.outputTokens
  return actual || usage.estimatedInputTokens + usage.estimatedOutputTokens
}

function providerSessions(provider: SnapshotProvider): SessionInfo[] {
  return activeSessions(provider.runtime)
}

function trackedBudgetPercent(provider: SnapshotProvider): number | undefined {
  return provider.dailyTokenBudget ? Math.min(100, (trackedTokens(provider) / provider.dailyTokenBudget) * 100) : undefined
}

function providerLimitReached(provider: SnapshotProvider): boolean {
  if (activeCooldown(provider) || (trackedBudgetPercent(provider) ?? 0) >= 100) return true
  return providerSessions(provider).some((session) => sessionBlocked(session))
}

// What the app actually knows about a provider's plan window, in the order the
// CLIs report it: a real percentage if given, otherwise the named window and how
// long it has left, otherwise nothing — never a percentage we made up.
function providerQuota(provider: SnapshotProvider): { text: string; reset?: string; percent?: number; timePercent?: number } {
  const sessions = providerSessions(provider)
  // The headline number and the window it names have to be the same window.
  const worst = sessions.filter((session) => sessionWindowPercent(session) !== undefined)
    .sort((left, right) => sessionWindowPercent(right)! - sessionWindowPercent(left)!)[0]
  const worstPercent = worst ? sessionWindowPercent(worst)! : undefined
  const tracked = trackedBudgetPercent(provider)
  if (worstPercent !== undefined && (tracked === undefined || worstPercent >= tracked)) {
    return { text: `${Math.round(worstPercent)}% of ${sessionWindowLabel(worst)} window used`, reset: sessionResetAt(worst), percent: worstPercent }
  }
  if (tracked !== undefined) return { text: `${Math.round(tracked)}% of tracked daily budget used`, percent: tracked }
  const window = sessions.find((session) => sessionResetAt(session)) ?? sessions[0]
  if (!window) return { text: 'No plan limit reported' }
  const note = sessionStatusNote(window)
  return { text: `${sessionWindowLabel(window)} window${note ? ` · ${note}` : ''}`, reset: sessionResetAt(window), timePercent: sessionWindowElapsedPercent(window) }
}

function providerCapacity(provider: SnapshotProvider): { label: string; tone: string } {
  if (!provider.enabled) return { label: 'Disabled', tone: 'muted' }
  if (activeCooldown(provider)) return { label: `Limit reached · ${countdown(provider.runtime.cooldownUntil)}`, tone: 'limited' }
  if (providerLimitReached(provider)) return { label: 'Usage limit reached', tone: 'limited' }
  if (!provider.runtime.available) return { label: 'Not installed', tone: 'offline' }
  if (provider.runtime.running) return { label: 'Working', tone: 'busy' }
  return { label: 'Available', tone: 'ready' }
}

function providerSelectableForTask(provider: SnapshotProvider, task: ProxyTask): boolean {
  return provider.enabled && provider.runtime.available && !providerLimitReached(provider) && provider.capabilities.includes(task.type)
}

function taskIsBusy(task: ProxyTask): boolean {
  return task.status === 'running' || task.status === 'queued'
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds % 60)}s`
}

function taskElapsed(task: ProxyTask): string {
  if (!task.startedAt) return '—'
  const end = task.finishedAt ? Date.parse(task.finishedAt) : Date.now()
  return formatDuration(Math.max(0, end - Date.parse(task.startedAt)))
}

function formatCost(usd: number): string {
  if (usd >= 0.005) return `$${usd.toFixed(2)}`
  return usd > 0 ? '<$0.01' : '$0.00'
}

function countdown(iso?: string): string {
  if (!iso) return '—'
  const ms = Date.parse(iso) - Date.now()
  if (ms <= 0) return 'resetting…'
  const days = Math.floor(ms / 86_400_000)
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (days > 0) return `${days}d ${hours % 24}h`
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function ancestorFolders(path = ''): string[] {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
}

// Prefer the CLI's real reported tokens; fall back to character-count estimates
// (labelled as such) when the provider reports none.
function taskTokens(task: ProxyTask): { input: number; output: number; estimated: boolean } {
  if (task.usageInputTokens !== undefined || task.usageOutputTokens !== undefined) {
    return { input: task.usageInputTokens ?? 0, output: task.usageOutputTokens ?? 0, estimated: false }
  }
  return { input: task.estimatedInputTokens, output: task.estimatedOutputTokens, estimated: true }
}

function taskKindLabel(task: ProxyTask): string {
  return task.bench ? 'Comparison' : task.orchestrated ? 'Split & delegate' : 'Single agent'
}

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

// --- Sidebar rail ---

function renderMiniProviders(): void {
  const container = byId('provider-mini-list')
  container.replaceChildren(...snapshot.providers.filter((provider) => provider.enabled).map((provider) => {
    const row = element('div', 'mini-provider')
    const capacity = providerCapacity(provider)
    row.title = `${provider.name} · ${capacity.label}`
    row.setAttribute('aria-label', `${provider.name}: ${capacity.label}`)
    const dot = element('span', `provider-dot ${capacity.tone === 'limited' ? 'limited' : provider.runtime.running ? 'busy' : provider.runtime.available ? 'online' : ''}`)
    dot.setAttribute('aria-hidden', 'true')
    row.append(dot, element('span', undefined, provider.name), element('small', undefined, capacity.label.toLowerCase()))
    return row
  }))
}

// --- Mission Control ---

function gauge(percent: number | undefined, tone = ''): HTMLElement {
  const bar = element('div', `home-bar ${tone}`.trim())
  const fill = element('div')
  fill.style.width = `${Math.min(100, Math.max(0, percent ?? 0))}%`
  bar.append(fill)
  return bar
}

function renderHome(): void {
  const agents = byId('home-agents')
  const enabled = snapshot.providers.filter((provider) => provider.enabled)
  if (!enabled.length) {
    agents.replaceChildren(emptyState('No agents enabled', 'Turn on an agent under Agents to start routing work.'))
  } else {
    agents.replaceChildren(...enabled.map((provider) => {
      const capacity = providerCapacity(provider)
      const card = element('article', `home-agent ${capacity.tone}`)
      const head = element('div', 'home-agent-head')
      const identity = element('div', 'home-agent-identity')
      identity.append(element('span', `provider-dot ${capacity.tone === 'limited' ? 'limited' : provider.runtime.running ? 'busy' : provider.runtime.available ? 'online' : ''}`), element('strong', undefined, provider.name))
      head.append(identity, element('span', `capacity-badge ${capacity.tone}`, capacity.label))

      const plan = providerQuota(provider)
      const quota = element('div', 'home-agent-quota')
      const quotaHead = element('div', 'home-agent-quota-head')
      quotaHead.append(
        element('span', undefined, plan.text),
        element('small', undefined, plan.reset ? `resets in ${countdown(plan.reset)}` : '')
      )
      // Without a reported percentage the bar tracks the window's clock, not
      // usage — a muted tone so it never reads as "how much you have left".
      quota.append(quotaHead, gauge(plan.percent ?? plan.timePercent, plan.percent === undefined ? 'time' : plan.percent >= 90 ? 'high' : ''))

      const running = snapshot.tasks.find((task) => task.status === 'running' && task.selectedProviderId === provider.id)
      const foot = element('div', 'home-agent-foot')
      foot.append(
        element('span', undefined, running ? `Working: ${running.prompt.slice(0, 44)}${running.prompt.length > 44 ? '…' : ''}` : `${formatNumber(trackedTokens(provider))} tokens today`),
        element('small', undefined, formatCost(provider.runtime.usage.costUsd))
      )
      if (running) {
        card.classList.add('active')
        card.addEventListener('click', () => openTask(running.id))
      }
      card.append(head, quota, foot)
      return card
    }))
  }

  const activeTasks = snapshot.tasks.filter((task) => task.status === 'running' || task.status === 'queued')
  const active = byId('home-active')
  if (!activeTasks.length) {
    active.replaceChildren(emptyState('Nothing running', 'Start a task and it will appear here while it works.'))
  } else {
    active.replaceChildren(...activeTasks.map((task) => {
      const row = element('button', 'home-task')
      const latest = task.activity?.at(-1)
      row.append(
        element('span', `task-state-dot ${task.status}`),
        (() => {
          const body = element('div', 'home-task-body')
          body.append(element('strong', undefined, task.prompt), element('small', undefined, latest ? `${latest.label}${latest.detail ? ` · ${latest.detail}` : ''}` : `${taskKindLabel(task)} · ${providerName(task.selectedProviderId)}`))
          return body
        })(),
        element('span', 'home-task-time', taskElapsed(task))
      )
      row.addEventListener('click', () => openTask(task.id))
      return row
    }))
  }

  const waiting = reviewRepos.flatMap((repo) => repo.branches.filter((branch) => !branch.merged).map((branch) => ({ repo, branch })))
  const review = byId('home-review')
  if (!reviewLoaded) review.replaceChildren(element('p', 'detail-empty', 'Checking for branches…'))
  else if (!waiting.length) review.replaceChildren(emptyState('Nothing to review', 'Branches from split & compare runs will collect here.'))
  else {
    review.replaceChildren(...waiting.slice(0, 6).map(({ repo, branch }) => {
      const row = element('button', 'home-branch')
      const body = element('div', 'home-task-body')
      body.append(element('strong', undefined, branch.subject), element('small', undefined, `${repo.name} · ${branch.files.length} file${branch.files.length === 1 ? '' : 's'}`))
      row.append(element('span', 'branch-glyph', '⑃'), body, element('span', 'home-task-time', timeAgo(branch.committedAt)))
      row.addEventListener('click', () => { reviewSelection = { cwd: branch.cwd, branch: branch.branch }; reviewFilePath = undefined; switchView('review') })
      return row
    }))
  }

  const count = waiting.length
  const badge = byId('nav-review-count')
  badge.hidden = count === 0
  badge.textContent = String(count)
}

// --- Task queue ---

function taskMatchesQuery(task: ProxyTask): boolean {
  if (!taskQuery) return true
  const haystack = `${task.prompt} ${task.type} ${task.mode} ${task.status} ${providerName(task.selectedProviderId)}`.toLowerCase()
  return haystack.includes(taskQuery)
}

function renderTasks(): void {
  const container = byId('task-list')
  if (!snapshot.tasks.length) {
    container.replaceChildren(emptyState('The queue is clear', 'Create a task and Frontier will pick the best available agent.'))
    renderSurface()
    return
  }
  const visible = snapshot.tasks.filter(taskMatchesQuery)
  if (!selectedTaskId || !snapshot.tasks.some((task) => task.id === selectedTaskId)) selectedTaskId = visible[0]?.id ?? snapshot.tasks[0].id
  if (!visible.length) {
    container.replaceChildren(emptyState('No matching tasks', `Nothing matches “${taskQuery}”.`))
    renderSurface()
    return
  }
  container.replaceChildren(...visible.map((task) => {
    const row = element('div', `task-row ${task.id === selectedTaskId ? 'selected' : ''}`)
    row.dataset.taskId = task.id
    const body = element('div')
    body.append(element('div', 'task-title', task.prompt))
    const meta = element('div', 'task-meta')
    meta.append(element('span', 'task-provider', providerName(task.selectedProviderId)))
    if (task.bench) meta.append(element('span', 'tag-orchestrated', 'compare'))
    else if (task.orchestrated) meta.append(element('span', 'tag-orchestrated', 'split'))
    if (task.filesChanged?.length) meta.append(element('span', undefined, `${task.filesChanged.length} file${task.filesChanged.length === 1 ? '' : 's'}`))
    if (task.contextWindow && task.contextTokens !== undefined) {
      const percent = Math.min(100, Math.max(0, (task.contextTokens / task.contextWindow) * 100))
      meta.append(element('span', 'tag-context', `${Math.round(percent)}% ctx`))
    }
    body.append(meta)
    row.append(element('span', `task-state-dot ${task.status}`), body, element('span', 'task-time', timeAgo(task.createdAt)))
    row.addEventListener('click', () => { selectedTaskId = task.id; surfaceTab = 'conversation'; renderTasks() })
    return row
  }))
  renderSurface()
}

// --- Unified task surface ---

function metaChip(label: string, value: string, className = ''): HTMLElement {
  const chip = element('div', `meta-chip ${className}`.trim())
  chip.append(element('span', 'meta-label', label), element('strong', undefined, value))
  return chip
}

function renderSurfaceMeta(task: ProxyTask): void {
  const meta = byId('surface-meta')
  const tokens = taskTokens(task)
  const chips = [
    metaChip('Agent', providerName(task.selectedProviderId)),
    metaChip('Model', task.model ?? '—', 'model'),
    metaChip(tokens.estimated ? 'Tokens (est.)' : 'Tokens', `${formatNumber(tokens.input)} in · ${formatNumber(tokens.output)} out`),
    metaChip('Elapsed', taskElapsed(task))
  ]
  if (task.usageCostUsd) chips.push(metaChip('Cost', formatCost(task.usageCostUsd)))

  if (task.contextWindow && task.contextTokens !== undefined) {
    const percent = Math.min(100, Math.max(0, (task.contextTokens / task.contextWindow) * 100))
    const chip = element('div', 'meta-chip context-meter')
    chip.append(element('span', 'meta-label', task.contextSource === 'estimated' ? 'Context (estimate)' : 'Context'))
    const row = element('div', 'context-row')
    row.append(gauge(percent, percent >= 80 ? 'high' : ''), element('strong', undefined, `${Math.round(percent)}%`))
    chip.title = `${formatNumber(task.contextTokens)} of ${formatNumber(task.contextWindow)} tokens`
    chip.append(row)
    chips.push(chip)
  }
  meta.replaceChildren(...chips)
}

const ORCH_STAGES = ['planning', 'delegating', 'synthesizing', 'done'] as const

function renderSurfaceStages(task: ProxyTask): void {
  const container = byId('surface-stages')
  if (!task.orchestrated) { container.replaceChildren(); return }
  const stage = task.orchestrationStage ?? 'planning'
  const stageIndex = ORCH_STAGES.indexOf(stage)
  const bar = element('div', 'stage-bar')
  ORCH_STAGES.forEach((name, index) => {
    if (index > 0) bar.append(element('span', 'stage-sep', '→'))
    bar.append(element('span', `stage-step${index === stageIndex ? ' active' : ''}${index < stageIndex ? ' past' : ''}`, name))
  })
  container.replaceChildren(bar)
}

function laneCard(task: ProxyTask, lane: SubTask, columns: boolean): HTMLElement {
  const card = element('article', `lane ${lane.status}${columns ? ' lane-column' : ''}`)
  const head = element('div', 'lane-head')
  const identity = element('div', 'lane-identity')
  identity.append(element('span', `task-state-dot ${lane.status}`), element('strong', undefined, lane.title))
  head.append(identity, element('span', 'lane-meta', [lane.model, lane.status].filter(Boolean).join(' · ')))
  card.append(head)

  if (lane.branch) {
    const branch = element('button', 'lane-branch') as HTMLButtonElement
    branch.textContent = lane.committed ? `⑃ ${lane.branch}` : `⑃ ${lane.branch} · no changes`
    branch.title = lane.committed ? 'Open this branch in Review' : 'Isolated branch; nothing was changed'
    branch.disabled = !lane.committed
    branch.addEventListener('click', () => { reviewSelection = { cwd: task.cwd, branch: lane.branch! }; reviewFilePath = undefined; switchView('review') })
    card.append(branch)
  }

  const body = element('div', 'lane-body markdown')
  if (lane.output.trim()) body.appendChild(renderMarkdown(lane.output))
  else if (lane.error) { body.textContent = lane.error; body.classList.add('lane-error') }
  else body.textContent = lane.status === 'running' ? 'Working…' : 'Queued…'
  card.append(body)
  return card
}

function renderThread(task: ProxyTask): void {
  const thread = byId('surface-thread')
  const streaming = taskIsBusy(task)
  const lanes = task.subtasks ?? []
  const historyLength = (task.turns ?? []).reduce((total, turn) => total + turn.content.length, 0)
  const laneLength = lanes.reduce((total, lane) => total + lane.output.length + lane.status.length, 0)
  const signature = { id: task.id, status: task.status, length: historyLength + laneLength + (task.output?.length ?? 0) + (task.activity?.length ?? 0) }
  if (lastBodyRender.id === signature.id && lastBodyRender.status === signature.status && lastBodyRender.length === signature.length) return
  lastBodyRender = signature
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60

  const fragment = document.createDocumentFragment()

  // A comparison is read side by side, not as a transcript.
  if (task.bench) {
    fragment.append(element('p', 'lane-note', 'The same prompt ran on each agent in its own isolated branch.'))
    const columns = element('div', 'lane-columns')
    for (const lane of lanes) columns.append(laneCard(task, lane, true))
    fragment.append(columns)
    if (task.output.trim() && !streaming) fragment.append(renderMarkdown(task.output))
    if (task.error) fragment.append(element('div', 'output-error', task.error))
    thread.replaceChildren(fragment)
    if (streaming || atBottom) thread.scrollTop = thread.scrollHeight
    return
  }

  const turns: ConversationTurn[] = task.turns?.length ? task.turns : [
    { id: 'legacy-user', role: 'user', content: task.prompt, at: task.createdAt },
    ...(task.output || task.error ? [{ id: 'legacy-assistant', role: 'assistant' as const, content: task.output, providerId: task.selectedProviderId, model: task.model, status: task.status, at: task.finishedAt ?? task.createdAt }] : [])
  ]
  turns.forEach((turn, index) => {
    const live = streaming && turn.role === 'assistant' && index === turns.length - 1
    const block = element('article', `detail-turn ${turn.role}`)
    const head = element('div', 'detail-turn-head')
    head.append(
      element('strong', undefined, turn.role === 'user' ? 'You' : providerName(turn.providerId)),
      element('span', undefined, [turn.model, turn.status, timeAgo(turn.at)].filter(Boolean).join(' · '))
    )
    const body = element('div', 'detail-turn-body markdown')
    const content = live ? task.output : turn.content
    if (turn.role === 'user' || live) body.textContent = content || (live ? 'Working…' : '')
    else if (content.trim()) body.appendChild(renderMarkdown(content))
    else body.textContent = turn.status === 'failed' ? (task.error ?? 'Failed.') : '—'
    if (turn.role === 'user') appendTurnAttachments(task.id, body, turn.attachments)
    block.append(head, body)
    fragment.append(block)

    // Subtasks belong with the assistant turn that produced them.
    if (task.orchestrated && lanes.length && index === turns.length - 1) {
      const group = element('div', 'lane-stack')
      group.append(element('p', 'lane-note', `${lanes.length} subtask${lanes.length === 1 ? '' : 's'}, each in its own isolated branch.`))
      for (const lane of lanes) group.append(laneCard(task, lane, false))
      fragment.append(group)
    }
  })
  if (task.error && !streaming) fragment.append(element('div', 'output-error', task.error))
  thread.replaceChildren(fragment)
  if (streaming || atBottom) thread.scrollTop = thread.scrollHeight
}

function appendTurnAttachments(taskId: string, body: HTMLElement, attachments: ChatContextItem[] = []): void {
  if (!attachments.length) return
  const container = element('div', 'turn-attachments')
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      const image = document.createElement('img'); image.className = 'turn-image'; image.alt = attachment.name; image.title = attachment.name
      container.append(image)
      const key = `${taskId}:${attachment.id}`
      const cached = attachmentPreviewCache.get(key)
      if (cached) image.src = cached
      else void window.frontier.getAttachmentPreview(taskId, attachment.id)
        .then((preview) => { attachmentPreviewCache.set(key, preview); if (image.isConnected) image.src = preview })
        .catch(() => { image.alt = `${attachment.name} (preview unavailable)` })
    } else {
      const reference = element('span', 'turn-reference'); reference.title = attachment.path
      reference.append(element('span', undefined, attachment.kind === 'folder' ? '▱' : '◇'), element('span', undefined, `@${attachment.path}${attachment.kind === 'folder' ? '/' : ''}`))
      container.append(reference)
    }
  }
  body.append(container)
}

// --- Routing receipt ---

function candidateRow(candidate: RoutingCandidate, chosen: boolean): HTMLElement {
  const row = element('div', `receipt-row ${candidate.eligible ? 'eligible' : 'skipped'}${chosen ? ' chosen' : ''}`)
  const head = element('div', 'receipt-head')
  const name = element('strong', undefined, candidate.providerName)
  head.append(name)
  if (chosen) head.append(element('span', 'receipt-chip', 'chosen'))
  head.append(element('span', 'receipt-score', candidate.eligible ? String(Math.round(candidate.score ?? 0)) : '—'))
  row.append(head)

  if (candidate.eligible && candidate.factors?.length) {
    const factors = element('div', 'receipt-factors')
    for (const factor of candidate.factors) {
      const item = element('div', `receipt-factor ${factor.points < 0 ? 'negative' : 'positive'}`)
      item.append(element('span', undefined, factor.label), element('span', 'receipt-points', `${factor.points > 0 ? '+' : ''}${Math.round(factor.points)}`))
      factors.append(item)
    }
    row.append(factors)
  } else if (candidate.skippedReason) {
    row.append(element('p', 'receipt-reason', candidate.skippedReason))
  }
  return row
}

function renderReceipt(task: ProxyTask): void {
  const container = byId('surface-receipt')
  const routing = task.routing
  if (!routing) {
    container.replaceChildren(element('p', 'detail-empty', task.bench
      ? 'Comparisons target the agents you chose, so no routing decision was made.'
      : 'No routing decision has been recorded for this task yet.'))
    return
  }
  const summary = element('p', 'receipt-summary')
  const chosenName = snapshot.providers.find((provider) => provider.id === routing.chosenProviderId)?.name ?? 'No agent'
  summary.textContent = `${chosenName} scored highest for this ${routing.taskType} task under the ${routing.mode} policy.`
  const rows = routing.candidates.map((candidate) => candidateRow(candidate, candidate.providerId === routing.chosenProviderId))
  container.replaceChildren(summary, ...rows)
}

const ACTIVITY_ICON: Record<string, string> = { tool: '⚙', thinking: '✳', notice: '•' }

function renderRouteTab(task: ProxyTask): void {
  renderReceipt(task)
  const attempts = byId('surface-attempts')
  if (!task.attempts.length) attempts.replaceChildren(element('p', 'detail-empty', 'No agent has been launched yet.'))
  else attempts.replaceChildren(...task.attempts.map((attempt) => {
    const row = element('div', `detail-route-row ${attempt.status}`)
    const body = element('div')
    body.append(element('strong', undefined, providerName(attempt.providerId)), element('small', undefined, `${attempt.status} · ${timeAgo(attempt.startedAt)}`))
    row.append(element('span', 'timeline-dot'), body)
    if (attempt.error) row.title = attempt.error
    return row
  }))

  const activity = byId('surface-activity')
  const events = task.activity ?? []
  if (!events.length) activity.replaceChildren(element('p', 'detail-empty', 'No activity recorded.'))
  else activity.replaceChildren(...events.map((event) => {
    const row = element('div', `detail-activity-row ${event.kind}`)
    const body = element('div')
    body.append(element('strong', undefined, event.label))
    if (event.detail) body.append(element('small', undefined, event.detail))
    row.append(element('span', undefined, ACTIVITY_ICON[event.kind] ?? '•'), body)
    return row
  }))
}

// --- Files tab ---

function codeLine(oldNumber: number | undefined, newNumber: number | undefined, marker: string, source: string, kind: string, language: string): HTMLElement {
  const row = element('div', `task-code-line ${kind}`)
  const old = element('span', 'task-code-number', oldNumber ? String(oldNumber) : '')
  const next = element('span', 'task-code-number', newNumber ? String(newNumber) : '')
  const mark = element('span', 'task-code-marker', marker)
  const code = document.createElement('code')
  // highlight.js escapes source text and emits only span markup for token classes.
  code.innerHTML = highlightSourceLine(source, language)
  row.append(old, next, mark, code); return row
}

function renderDiffInto(container: HTMLElement, diff: string, language: string): void {
  container.replaceChildren(...parseUnifiedDiff(diff).map((line) => {
    if (line.kind === 'header' || line.kind === 'hunk') {
      const row = element('div', `task-code-line ${line.kind}`)
      const text = document.createElement('code'); text.textContent = line.source; row.append(text); return row
    }
    return codeLine(line.oldNumber, line.newNumber, line.marker, line.source, line.kind, language)
  }))
}

function renderTaskFileViewer(file?: TaskFileContent): void {
  const title = byId('task-file-title')
  const language = byId('task-file-language')
  const notice = byId('task-file-notice')
  const code = byId('task-file-code')
  const modes = byId('task-file-mode')
  modes.hidden = !file
  modes.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    const isDiff = button.dataset.fileMode === 'diff'
    button.disabled = isDiff && !file?.diff.trim()
    button.classList.toggle('active', button.dataset.fileMode === detailFileMode)
  })
  if (!file) {
    title.textContent = 'Select a file'; language.textContent = 'SOURCE'
    notice.hidden = false; notice.textContent = 'Choose any project file. Changed files are marked in the tree.'
    code.replaceChildren(); return
  }
  title.textContent = file.relativePath; language.textContent = file.language.toUpperCase()
  if (file.binary) { notice.hidden = false; notice.textContent = 'Binary files cannot be displayed.'; code.replaceChildren(); return }
  if (!file.exists && detailFileMode === 'source') { notice.hidden = false; notice.textContent = 'This file no longer exists in the task workspace.'; code.replaceChildren(); return }
  if (file.truncated && detailFileMode === 'source') { notice.hidden = false; notice.textContent = 'Large file: showing the first 1 MB.' } else notice.hidden = true

  if (detailFileMode === 'diff') {
    if (!file.diff.trim()) { notice.hidden = false; notice.textContent = 'No working-tree diff is available. The change may already be committed.'; code.replaceChildren(); return }
    renderDiffInto(code, file.diff, file.language)
  } else {
    code.replaceChildren(...file.content.replace(/\r\n/g, '\n').split('\n').map((line, index) => codeLine(undefined, index + 1, '', line, 'source', file.language)))
  }
}

async function loadDetailFile(task: ProxyTask, path: string, version: string): Promise<void> {
  const key = `${task.id}:${path}:${version}`
  if (detailFileState?.taskId === task.id && detailFileState.path === path && detailFileState.version === version) {
    renderTaskFileViewer(detailFileState.file); return
  }
  if (detailFileLoadingKey === key) return
  detailFileLoadingKey = key
  const request = ++detailFileRequest
  const notice = byId('task-file-notice'); notice.hidden = false; notice.textContent = 'Loading file…'
  byId('task-file-code').replaceChildren()
  try {
    const file = await window.frontier.readTaskFile(task.id, path)
    if (request !== detailFileRequest || selectedTaskId !== task.id || detailFilePath !== path) return
    detailFileState = { taskId: task.id, path, version, file }
    renderTaskFileViewer(file)
  } catch (error) {
    if (request !== detailFileRequest) return
    notice.hidden = false; notice.textContent = errorMessage(error)
  } finally { if (detailFileLoadingKey === key) detailFileLoadingKey = undefined }
}

function taskWorkspaceVersion(task: ProxyTask): string {
  return (task.filesChanged ?? []).map((change) => `${change.path}:${change.action}:${change.at}`).join('|')
}

async function loadDetailWorkspace(task: ProxyTask, version: string): Promise<void> {
  const key = `${task.id}:${version}`
  if (detailWorkspaceLoadingKey === key) return
  detailWorkspaceLoadingKey = key
  try {
    const workspace = await window.frontier.getTaskWorkspace(task.id)
    if (selectedTaskId !== task.id || taskWorkspaceVersion(task) !== version) return
    detailWorkspaceState = { taskId: task.id, version, workspace }
    if (surfaceTab === 'files') renderFilesTab(task)
  } catch (error) {
    if (selectedTaskId === task.id) byId('surface-file-list').replaceChildren(element('div', 'detail-empty', errorMessage(error)))
  } finally { if (detailWorkspaceLoadingKey === key) detailWorkspaceLoadingKey = undefined }
}

function renderFilesTab(task: ProxyTask): void {
  const version = taskWorkspaceVersion(task)
  const loaded = detailWorkspaceState?.taskId === task.id && detailWorkspaceState.version === version ? detailWorkspaceState.workspace : undefined
  if (!loaded) {
    byId('surface-file-list').replaceChildren(element('div', 'detail-empty', 'Loading project files…'))
    renderTaskFileViewer()
    void loadDetailWorkspace(task, version)
    return
  }
  const changes = loaded.changes
  byId('surface-file-count').textContent = String(changes.length)
  const list = byId('surface-file-list')
  byId('task-file-sidebar-summary').textContent = `${loaded.entries.filter((entry) => entry.kind === 'file').length} files · ${changes.length} changed`

  const entries = new Map(loaded.entries.map((entry) => [entry.path, entry]))
  for (const change of changes) {
    const parts = change.path.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      const folderPath = parts.slice(0, index).join('/')
      if (!entries.has(folderPath)) entries.set(folderPath, { kind: 'folder', name: parts[index - 1], path: folderPath })
    }
    if (!entries.has(change.path)) entries.set(change.path, { kind: 'file', name: baseName(change.path), path: change.path })
  }
  const allEntries = [...entries.values()]
  const files = allEntries.filter((entry) => entry.kind === 'file')
  if (!files.length) {
    list.replaceChildren(element('div', 'detail-empty', 'This project folder has no files to display.'))
    detailFilePath = undefined; renderTaskFileViewer(); return
  }
  const changeByPath = new Map(changes.map((change) => [change.path, change]))
  if (!detailFilePath || !entries.has(detailFilePath) || entries.get(detailFilePath)?.kind !== 'file') {
    detailFilePath = changes[0]?.path ?? files[0].path
  }
  // Folders a changed file lives in are worth counting even when collapsed.
  const changedInFolder = new Map<string, number>()
  for (const change of changes) for (const folder of ancestorFolders(change.path)) changedInFolder.set(folder, (changedInFolder.get(folder) ?? 0) + 1)
  if (detailTreeTaskId !== task.id) {
    detailTreeTaskId = task.id
    detailTreeRevealed = undefined
    detailOpenFolders = new Set(changes.flatMap((change) => ancestorFolders(change.path)))
  }
  // Reveal a newly selected file once; re-revealing every render would make the
  // folder holding the open file impossible to collapse.
  if (detailTreeRevealed !== detailFilePath) {
    detailTreeRevealed = detailFilePath
    for (const folder of ancestorFolders(detailFilePath)) detailOpenFolders.add(folder)
  }
  const children = new Map<string, WorkspaceEntry[]>()
  for (const entry of allEntries) {
    const separator = entry.path.lastIndexOf('/')
    const parent = separator === -1 ? '' : entry.path.slice(0, separator)
    const siblings = children.get(parent) ?? []
    siblings.push(entry); children.set(parent, siblings)
  }
  for (const siblings of children.values()) siblings.sort((left, right) => Number(right.kind === 'folder') - Number(left.kind === 'folder') || left.name.localeCompare(right.name))
  const rows: HTMLElement[] = []
  const appendRows = (parent: string, depth: number): void => {
    for (const entry of children.get(parent) ?? []) {
      if (entry.kind === 'folder') {
        const open = detailOpenFolders.has(entry.path)
        const folder = element('button', `task-detail-folder ${open ? 'open' : ''}`)
        folder.style.setProperty('--tree-depth', String(depth))
        folder.setAttribute('aria-expanded', String(open))
        folder.append(element('span', 'tree-caret', open ? '▾' : '▸'), element('strong', undefined, entry.name))
        const changed = changedInFolder.get(entry.path)
        if (changed) folder.append(element('small', 'tree-changed-count', String(changed)))
        folder.addEventListener('click', () => {
          if (open) detailOpenFolders.delete(entry.path); else detailOpenFolders.add(entry.path)
          renderFilesTab(task)
        })
        rows.push(folder)
        if (open) appendRows(entry.path, depth + 1)
        continue
      }
      const change = changeByPath.get(entry.path)
      const button = element('button', `task-detail-file ${change ? 'changed' : ''} ${entry.path === detailFilePath ? 'active' : ''}`)
      button.style.setProperty('--tree-depth', String(depth))
      const badge = change
        ? element('span', `file-badge ${change.action}`, change.action === 'create' ? 'NEW' : change.action === 'delete' ? 'DEL' : 'EDIT')
        : element('span', 'file-tree-icon', '·')
      const body = element('span')
      body.append(element('strong', undefined, entry.name))
      button.append(badge, body)
      button.title = entry.path
      button.addEventListener('click', () => {
        detailFilePath = entry.path; detailFileMode = change ? 'diff' : 'source'; detailFileState = undefined; renderFilesTab(task)
      })
      rows.push(button)
    }
  }
  appendRows('', 0)
  list.replaceChildren(...rows)
  const selectedChange = changes.find((change) => change.path === detailFilePath)
  if (!selectedChange && detailFileMode === 'diff') detailFileMode = 'source'
  if (detailFilePath) void loadDetailFile(task, detailFilePath, selectedChange?.at ?? (version || 'workspace'))
}

// --- Surface shell ---

function renderComposerState(task: ProxyTask, input: HTMLTextAreaElement, button: HTMLButtonElement): void {
  const busy = taskIsBusy(task)
  input.disabled = busy
  input.placeholder = busy ? 'Working…' : 'Continue the conversation…  @ to add files'
  input.closest('.composer-draft')?.querySelectorAll<HTMLButtonElement>('.composer-attach').forEach((control) => { control.disabled = busy })
  button.disabled = false
  button.textContent = busy ? 'Stop' : 'Send'
  button.classList.toggle('cancel-button', busy)
  button.setAttribute('aria-label', busy ? 'Stop this task' : 'Send message')
}

function renderSurfaceActions(task: ProxyTask): void {
  const target = byId('surface-actions')
  if (taskIsBusy(task)) { target.replaceChildren(); return }
  const controls = element('div', 'output-actions-inner')

  if (!task.bench) {
    const select = document.createElement('select'); select.className = 'detail-provider-select'; select.title = 'Agent for the next message'
    const current = task.continuationProviderId ?? task.selectedProviderId ?? ''
    for (const provider of snapshot.providers) {
      const option = document.createElement('option'); option.value = provider.id
      const selectable = providerSelectableForTask(provider, task)
      option.textContent = `${provider.name}${selectable ? '' : ' · unavailable'}`; option.disabled = !selectable
      select.append(option)
    }
    select.value = current
    select.addEventListener('change', async () => {
      const next = select.value
      if (!next || next === current) return
      select.disabled = true
      try { await window.frontier.changeTaskProvider(task.id, next); showToast(`${providerName(next)} will take the next message`) }
      catch (error) { select.value = current; reportError('Could not change agent', error) }
      finally { select.disabled = false }
    })
    controls.append(select)
  }

  const retry = element('button', 'secondary-button', 'Run again')
  retry.addEventListener('click', async () => {
    try {
      await persistControlPlaneDraft()
      const created = await window.frontier.retryTask(task.id)
      selectedTaskId = created.id
    } catch (error) { reportError('Could not re-run this task', error) }
  })
  controls.append(retry)
  target.replaceChildren(controls)
}

function renderSurface(): void {
  const task = snapshot.tasks.find((item) => item.id === selectedTaskId)
  const title = byId('surface-title')
  const subtitle = byId('surface-subtitle')
  const status = byId('surface-status')
  const composer = byId('surface-composer')

  if (!task) {
    title.textContent = 'Select a task'
    subtitle.textContent = ''
    status.textContent = 'Idle'; status.className = 'status-pill muted'
    byId('surface-meta').replaceChildren()
    byId('surface-actions').replaceChildren()
    byId('surface-stages').replaceChildren()
    byId('surface-thread').replaceChildren(emptyState('Nothing selected', 'Choose a task from the queue to see its conversation, files, and routing.'))
    composer.hidden = true
    lastBodyRender = { id: '', status: '', length: -1 }
    return
  }

  title.textContent = task.prompt
  subtitle.textContent = `${taskKindLabel(task)} · ${task.type} · ${task.cwd}`
  subtitle.title = task.cwd
  status.textContent = task.status; status.className = `status-pill ${task.status}`

  renderSurfaceMeta(task)
  renderSurfaceActions(task)
  renderSurfaceStages(task)
  renderThread(task)
  byId('surface-file-count').textContent = String(task.filesChanged?.length ?? 0)
  if (surfaceTab === 'files') renderFilesTab(task)
  if (surfaceTab === 'route') renderRouteTab(task)

  document.querySelectorAll<HTMLElement>('.surface-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.surfaceTab === surfaceTab))
  byId('surface-conversation').classList.toggle('active', surfaceTab === 'conversation')
  byId('surface-files').classList.toggle('active', surfaceTab === 'files')
  byId('surface-route').classList.toggle('active', surfaceTab === 'route')

  // A comparison has no single conversation to continue.
  composer.hidden = Boolean(task.bench) && !taskIsBusy(task)
  if (!composer.hidden) renderComposerState(task, byId<HTMLTextAreaElement>('composer-input'), byId<HTMLButtonElement>('composer-send'))
}

function openTask(taskId: string): void {
  selectedTaskId = taskId
  surfaceTab = 'conversation'
  detailFilePath = undefined
  detailFileState = undefined
  detailWorkspaceState = undefined
  detailFileRequest += 1
  switchView('tasks')
  renderTasks()
}

// --- Review inbox ---

async function loadReview(showToastOnError = false): Promise<void> {
  try {
    reviewRepos = await window.frontier.listBranchInbox()
    reviewLoaded = true
    if (reviewSelection && !reviewRepos.some((repo) => repo.branches.some((branch) => branch.cwd === reviewSelection!.cwd && branch.branch === reviewSelection!.branch))) {
      reviewSelection = undefined
      reviewFilePath = undefined
    }
    renderReview()
    renderHome()
  } catch (error) {
    reviewLoaded = true
    if (showToastOnError) reportError('Could not read task branches', error)
  }
}

function selectedBranch(): TaskBranch | undefined {
  if (!reviewSelection) return undefined
  return reviewRepos.flatMap((repo) => repo.branches).find((branch) => branch.cwd === reviewSelection!.cwd && branch.branch === reviewSelection!.branch)
}

function repoFor(branch: TaskBranch): BranchRepo | undefined {
  return reviewRepos.find((repo) => repo.cwd === branch.cwd)
}

async function loadReviewDiff(branch: TaskBranch, path: string): Promise<void> {
  const request = ++reviewDiffRequest
  const target = byId('review-diff')
  target.replaceChildren(element('div', 'detail-empty', 'Loading diff…'))
  try {
    const diff = await window.frontier.readBranchFile(branch.cwd, branch.branch, path)
    if (request !== reviewDiffRequest) return
    if (!diff.trim()) { target.replaceChildren(element('div', 'detail-empty', 'No textual diff for this file.')); return }
    renderDiffInto(target, diff, languageFor(path))
  } catch (error) {
    if (request !== reviewDiffRequest) return
    target.replaceChildren(element('div', 'detail-empty', errorMessage(error)))
  }
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json', md: 'markdown',
  css: 'css', scss: 'scss', html: 'xml', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  sh: 'bash', yml: 'yaml', yaml: 'yaml', sql: 'sql', toml: 'ini'
}

function languageFor(path: string): string {
  return LANGUAGE_BY_EXTENSION[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'plaintext'
}

function renderReview(): void {
  const list = byId('review-list')
  if (!reviewLoaded) {
    list.replaceChildren(element('div', 'detail-empty', 'Looking for task branches…'))
  } else if (!reviewRepos.length) {
    list.replaceChildren(emptyState('No branches to review', 'Split & delegate and Compare runs commit their work to isolated branches. They will appear here.'))
  } else {
    const nodes: HTMLElement[] = []
    for (const repo of reviewRepos) {
      const head = element('div', 'review-repo')
      head.append(element('strong', undefined, repo.name), element('small', undefined, `on ${repo.currentBranch}${repo.dirty ? ' · uncommitted changes' : ''}`))
      head.title = repo.cwd
      nodes.push(head)
      for (const branch of repo.branches) {
        const row = element('button', `review-branch${branch.merged ? ' merged' : ''}${reviewSelection?.branch === branch.branch && reviewSelection.cwd === branch.cwd ? ' active' : ''}`)
        const body = element('div', 'review-branch-body')
        body.append(element('strong', undefined, branch.subject))
        const additions = branch.files.reduce((total, file) => total + file.additions, 0)
        const deletions = branch.files.reduce((total, file) => total + file.deletions, 0)
        body.append(element('small', undefined, `${branch.files.length} file${branch.files.length === 1 ? '' : 's'} · +${additions} −${deletions} · ${timeAgo(branch.committedAt)}`))
        row.append(body)
        if (branch.merged) row.append(element('span', 'review-merged-chip', 'merged'))
        row.addEventListener('click', () => { reviewSelection = { cwd: branch.cwd, branch: branch.branch }; reviewFilePath = undefined; renderReview() })
        nodes.push(row)
      }
    }
    list.replaceChildren(...nodes)
  }

  const branch = selectedBranch()
  const title = byId('review-branch-title')
  const subtitle = byId('review-branch-subtitle')
  const actions = byId('review-branch-actions')
  const files = byId('review-files')
  const diff = byId('review-diff')

  if (!branch) {
    title.textContent = 'Select a branch'
    subtitle.textContent = ''
    actions.replaceChildren(); files.replaceChildren(); diff.replaceChildren()
    return
  }
  const repo = repoFor(branch)
  title.textContent = branch.subject
  subtitle.textContent = `${branch.branch} · ${repo?.name ?? ''}`
  subtitle.title = branch.cwd

  const controls = element('div', 'output-actions-inner')
  if (branch.merged) {
    controls.append(element('span', 'review-merged-chip', 'already merged'))
  } else {
    const merge = element('button', 'primary-button', `Merge into ${repo?.currentBranch ?? 'HEAD'}`) as HTMLButtonElement
    merge.disabled = Boolean(repo?.dirty)
    merge.title = repo?.dirty ? 'Commit or stash your changes first' : `Merge ${branch.branch}`
    merge.addEventListener('click', async () => {
      const confirmed = await confirmAction(
        'Merge this branch?',
        `${branch.branch} will be merged into ${repo?.currentBranch ?? 'HEAD'} in ${branch.cwd}. This changes files in your repository.`,
        'Merge'
      )
      if (!confirmed) return
      merge.disabled = true
      try { reviewRepos = await window.frontier.mergeBranch(branch.cwd, branch.branch); showToast(`Merged ${branch.branch}`); renderReview(); renderHome() }
      catch (error) { reportError('Merge failed', error); merge.disabled = false }
    })
    controls.append(merge)
  }
  const remove = element('button', 'text-button', 'Delete branch')
  remove.addEventListener('click', async () => {
    const confirmed = await confirmAction('Delete this branch?', `${branch.branch} and its commits will be deleted from ${branch.cwd}. This cannot be undone.`, 'Delete')
    if (!confirmed) return
    try {
      reviewRepos = await window.frontier.deleteBranch(branch.cwd, branch.branch)
      reviewSelection = undefined; reviewFilePath = undefined
      showToast('Branch deleted'); renderReview(); renderHome()
    } catch (error) { reportError('Could not delete branch', error) }
  })
  controls.append(remove)
  actions.replaceChildren(controls)

  if (!branch.files.length) {
    files.replaceChildren(element('div', 'detail-empty', 'This branch changes no files.'))
    diff.replaceChildren()
    return
  }
  if (!reviewFilePath || !branch.files.some((file) => file.path === reviewFilePath)) reviewFilePath = branch.files[0].path
  files.replaceChildren(...branch.files.map((file) => {
    const row = element('button', `review-file${file.path === reviewFilePath ? ' active' : ''}`)
    row.append(
      element('span', `file-badge ${file.action}`, file.action === 'create' ? 'NEW' : file.action === 'delete' ? 'DEL' : 'EDIT'),
      (() => { const body = element('span', 'review-file-body'); body.append(element('strong', undefined, baseName(file.path)), element('small', undefined, file.path)); return body })(),
      element('span', 'review-file-stat', `+${file.additions} −${file.deletions}`)
    )
    row.addEventListener('click', () => { reviewFilePath = file.path; renderReview() })
    return row
  }))
  void loadReviewDiff(branch, reviewFilePath)
}

// --- Agents (registry + usage) ---

function field(labelText: string, input: HTMLElement, wide = false): HTMLLabelElement {
  const label = document.createElement('label'); if (wide) label.className = 'wide'
  label.append(labelText, input); return label
}

function textInput(value: string, type = 'text'): HTMLInputElement {
  const input = document.createElement('input'); input.type = type; input.value = value; return input
}

function textArea(value: string, rows = 2): HTMLTextAreaElement {
  const area = document.createElement('textarea'); area.rows = rows; area.value = value; return area
}

function recordToLines(record: Record<string, string> | undefined, sep: string): string {
  return record ? Object.entries(record).map(([key, value]) => `${key}${sep}${value}`).join('\n') : ''
}

function linesToRecord(value: string, sep: string): Record<string, string> | undefined {
  const record: Record<string, string> = {}
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim(); if (!trimmed) continue
    const index = trimmed.indexOf(sep); if (index < 0) continue
    const key = trimmed.slice(0, index).trim()
    if (key) record[key] = trimmed.slice(index + sep.length).trim()
  }
  return Object.keys(record).length ? record : undefined
}

function splitArguments(value: string): string[] {
  const result: string[] = []
  let current = ''
  let quote = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (character === quote) quote = ''
      else if (character === '\\' && index + 1 < value.length) current += value[++index]
      else current += character
    } else if (character === '"' || character === "'") quote = character
    else if (/\s/.test(character)) { if (current) { result.push(current); current = '' } }
    else current += character
  }
  if (current) result.push(current)
  return result
}

function formatArguments(values: string[]): string {
  return values.map((value) => /\s/.test(value) ? JSON.stringify(value) : value).join(' ')
}

function listValues(value: string): string[] {
  return [...new Set(value.split(/[\r\n,]+/).map((item) => item.trim()).filter(Boolean))]
}

function renderProviders(): void {
  const grid = byId('provider-grid')
  // Rebuilding the cards replaces their inputs. Snapshots arrive on every
  // streamed output chunk, so without this guard a task running in the
  // background would wipe out whatever the user is typing into a field.
  if (grid.childElementCount && grid.contains(document.activeElement)) return
  grid.replaceChildren(...snapshot.providers.map((provider) => {
    const card = element('article', 'provider-card')
    const header = element('div', 'provider-card-header')
    const identity = element('div', 'provider-name')
    const identityText = element('div')
    identityText.append(element('h3', undefined, provider.name), element('small', undefined, provider.kind.toUpperCase()))
    identity.append(element('span', `provider-dot ${provider.runtime.available ? 'online' : ''}`), identityText)
    const toggleLabel = document.createElement('label'); toggleLabel.className = 'switch'
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = provider.enabled
    toggleLabel.append(toggle, element('span', 'slider'))
    header.append(identity, toggleLabel)

    const form = element('div', 'provider-form')
    const displayName = textInput(provider.name)
    const executable = textInput(provider.executable)
    const model = textInput(provider.model ?? '')
    const priority = textInput(String(provider.priority), 'number'); priority.min = '0'; priority.max = '100'
    const budget = textInput(provider.dailyTokenBudget ? String(provider.dailyTokenBudget) : '', 'number'); budget.min = '0'; budget.placeholder = 'Unlimited'
    const contextWindow = textInput(provider.contextWindow ? String(provider.contextWindow) : '', 'number'); contextWindow.min = '0'; contextWindow.placeholder = 'Auto-detect'
    const args = textInput(formatArguments(provider.args ?? []))
    const concurrency = textInput(String(provider.maxConcurrent), 'number'); concurrency.min = '1'; concurrency.max = '8'
    form.append(
      field('Display name', displayName), field('Executable', executable), field('Model (optional)', model),
      field('Routing priority', priority), field('Parallel tasks', concurrency), field('Tracked usage limit', budget),
      field('Context window (tokens)', contextWindow), field('Extra arguments (quotes supported)', args, true)
    )

    let copilotToolsets: HTMLTextAreaElement | undefined
    let copilotTools: HTMLTextAreaElement | undefined
    let copilotAllTools: HTMLInputElement | undefined
    if (provider.kind === 'copilot') {
      copilotToolsets = textArea((provider.copilotGithubMcpToolsets ?? []).join('\n'), 2)
      copilotToolsets.placeholder = 'actions, code_security, discussions…'
      copilotTools = textArea((provider.copilotGithubMcpTools ?? []).join('\n'), 2)
      copilotTools.placeholder = 'Individual GitHub MCP tool names (optional)'
      copilotAllTools = document.createElement('input')
      copilotAllTools.type = 'checkbox'
      copilotAllTools.checked = Boolean(provider.copilotEnableAllGithubMcpTools)
      const allToolsRow = document.createElement('label'); allToolsRow.className = 'checkbox-row wide'
      allToolsRow.append(copilotAllTools, ' Enable every built-in GitHub MCP tool')
      const help = element('p', 'field-help wide', 'Optional. Toolsets and tools extend Copilot’s default GitHub subset for each Frontier task. “Every tool” overrides both lists.')
      const syncCopilotFields = (): void => {
        copilotToolsets!.disabled = copilotAllTools!.checked
        copilotTools!.disabled = copilotAllTools!.checked
      }
      copilotAllTools.addEventListener('change', syncCopilotFields)
      syncCopilotFields()
      form.append(field('GitHub MCP toolsets', copilotToolsets, true), field('Individual GitHub MCP tools', copilotTools, true), allToolsRow, help)
    }

    const cpCapable = ['claude', 'copilot', 'codex', 'codex-oss'].includes(provider.kind)
    let cpToggle: HTMLInputElement | undefined
    if (cpCapable) {
      cpToggle = document.createElement('input'); cpToggle.type = 'checkbox'; cpToggle.checked = provider.useControlPlane !== false
      const row = document.createElement('label'); row.className = 'checkbox-row wide'
      row.append(cpToggle, ' Apply shared Context & Tools profile')
      form.append(row)
    }

    const footer = element('div', 'provider-card-footer')
    const health = element('span', 'health-label', provider.runtime.available ? `● Ready · ${provider.runtime.version ?? 'detected'}` : provider.enabled ? '● Not detected' : '○ Disabled')
    const save = element('button', 'secondary-button', 'Save agent') as HTMLButtonElement
    save.addEventListener('click', async () => {
      save.setAttribute('disabled', '')
      try {
        await window.frontier.updateProvider({ id: provider.id, changes: {
          enabled: toggle.checked,
          name: displayName.value.trim() || provider.name,
          executable: executable.value.trim(),
          model: model.value.trim() || undefined,
          priority: Number(priority.value) || 0,
          maxConcurrent: Math.max(1, Math.min(8, Number(concurrency.value) || 1)),
          dailyTokenBudget: Number(budget.value) > 0 ? Number(budget.value) : undefined,
          contextWindow: Number(contextWindow.value) > 0 ? Number(contextWindow.value) : undefined,
          args: args.value.trim() ? splitArguments(args.value) : undefined,
          ...(cpToggle ? { useControlPlane: cpToggle.checked } : {}),
          ...(provider.kind === 'copilot' ? {
            copilotGithubMcpToolsets: listValues(copilotToolsets?.value ?? ''),
            copilotGithubMcpTools: listValues(copilotTools?.value ?? ''),
            copilotEnableAllGithubMcpTools: Boolean(copilotAllTools?.checked)
          } : {})
        } })
        showToast(`${provider.name} updated`)
      } catch (error) { reportError(`Could not update ${provider.name}`, error) } finally { save.removeAttribute('disabled') }
    })
    toggle.addEventListener('change', () => save.click())
    const buttons = element('div', 'header-actions')
    if (provider.kind === 'custom') {
      const remove = element('button', 'text-button', 'Remove')
      remove.addEventListener('click', async () => {
        try { await window.frontier.removeProvider(provider.id); showToast('Custom agent removed') }
        catch (error) { reportError('Could not remove agent', error) }
      })
      buttons.append(remove)
    }
    buttons.append(save)
    footer.append(health, buttons)
    card.append(header, form, footer)
    return card
  }))
}

function usageStat(label: string, value: string): HTMLElement {
  const stat = element('div', 'usage-stat')
  stat.append(element('span', 'usage-stat-label', label), element('strong', undefined, value))
  return stat
}

function usageGauge(label: string, percent: number | undefined, detail: string, tone = ''): HTMLElement {
  const node = element('div', `usage-gauge ${tone}`.trim())
  const head = element('div', 'usage-gauge-head')
  head.append(element('span', undefined, label), element('strong', undefined, percent === undefined ? '—' : `${Math.round(percent)}%`))
  const bar = element('div', 'usage-bar')
  const fill = element('div', 'usage-bar-fill'); fill.style.width = `${Math.min(100, Math.max(0, percent ?? 0))}%`
  bar.append(fill)
  node.append(head, bar, element('div', 'usage-budget-label', detail))
  return node
}

function renderUsage(): void {
  const grid = byId('usage-grid')
  grid.replaceChildren(...snapshot.providers.map((provider) => {
    const usage = provider.runtime.usage
    const hasActual = usage.inputTokens + usage.outputTokens > 0

    const capacity = providerCapacity(provider)
    const card = element('article', `panel usage-card ${capacity.tone === 'limited' ? 'limited' : ''}`)
    const header = element('div', 'usage-card-header')
    const identity = element('div', 'usage-card-identity')
    identity.append(element('span', `provider-dot ${capacity.tone === 'limited' ? 'limited' : provider.runtime.running ? 'busy' : provider.runtime.available ? 'online' : ''}`), element('h3', undefined, provider.name))
    header.append(identity, element('span', `capacity-badge ${capacity.tone}`, capacity.label))

    const stats = element('div', 'usage-stats')
    stats.append(
      usageStat('Cost today', formatCost(usage.costUsd)),
      usageStat(hasActual ? 'Input tokens' : 'Input (est.)', formatNumber(hasActual ? usage.inputTokens : usage.estimatedInputTokens)),
      usageStat(hasActual ? 'Output tokens' : 'Output (est.)', formatNumber(hasActual ? usage.outputTokens : usage.estimatedOutputTokens)),
      usageStat('Tasks', String(usage.tasks))
    )

    const sessions = providerSessions(provider)
    const gauges = element('div', 'usage-gauges')
    for (const session of sessions) {
      const percent = sessionWindowPercent(session)
      const resetAt = sessionResetAt(session)
      const note = sessionStatusNote(session)
      const detail = [
        resetAt ? `Resets in ${countdown(resetAt)}` : 'No reset time reported by the CLI',
        session.usingOverage ? 'overage in use' : undefined,
        note
      ].filter(Boolean).join(' · ')
      // This CLI may report the window without reporting how much of it is
      // spent; then the gauge shows elapsed time and says so, rather than
      // pretending zero usage.
      const elapsed = percent === undefined ? sessionWindowElapsedPercent(session) : undefined
      gauges.append(usageGauge(
        percent === undefined ? `${sessionWindowLabel(session)} window elapsed` : `${sessionWindowLabel(session)} limit used`,
        percent ?? elapsed,
        percent === undefined ? `${detail} · this CLI reports no usage percentage` : detail,
        percent === undefined ? 'time' : percent >= 90 ? 'high' : ''
      ))
    }
    if (provider.dailyTokenBudget) {
      const trackedPct = Math.min(100, (trackedTokens(provider) / provider.dailyTokenBudget) * 100)
      gauges.append(usageGauge('Tracked daily budget', trackedPct, `${formatNumber(trackedTokens(provider))} / ${formatNumber(provider.dailyTokenBudget)} tracked tokens`, trackedPct >= 90 ? 'high' : ''))
    } else if (!sessions.length) {
      const cooldown = activeCooldown(provider)
      gauges.append(usageGauge('Session usage', cooldown ? 100 : undefined,
        cooldown ? `Automatic fallback active · retries in ${countdown(provider.runtime.cooldownUntil)}` : `${formatNumber(trackedTokens(provider))} tracked tokens · no plan limit reported`,
        cooldown ? 'high' : ''))
    }

    const footer = element('div', 'usage-card-footer')
    const attention = sessions.map(sessionStatusNote).find(Boolean)
    const overage = sessions.find((session) => session.overageStatus && session.overageStatus !== 'allowed')
    footer.append(element('span', 'usage-session', providerLimitReached(provider)
      ? `Frontier will skip ${provider.name} while this limit is active and route work elsewhere.`
      : attention
        ? `Plan status: ${attention}`
        : sessions.length
          ? `${sessions.length} usage window${sessions.length === 1 ? '' : 's'} in force${overage ? ` · overage ${overage.overageStatus?.replaceAll('_', ' ')}` : ''}.`
          : 'No plan window has been reported in this app session.'))

    card.append(header, gauges, stats, footer)
    return card
  }))
}

function renderAgentsTab(): void {
  document.querySelectorAll<HTMLElement>('#agents-segmented button').forEach((button) => button.classList.toggle('active', button.dataset.agentsTab === agentsTab))
  byId('agents-registry').classList.toggle('active', agentsTab === 'registry')
  byId('agents-usage').classList.toggle('active', agentsTab === 'usage')
  if (agentsTab === 'registry') renderProviders()
  else renderUsage()
}

// --- New task dialog ---

type RunMode = 'single' | 'orchestrate' | 'bench'
let runMode: RunMode = 'single'

function setRunMode(mode: RunMode): void {
  runMode = mode
  document.querySelectorAll<HTMLElement>('.run-mode').forEach((button) => {
    const active = button.dataset.runMode === mode
    button.classList.toggle('active', active)
    button.setAttribute('aria-checked', String(active))
  })
  byId('single-options').hidden = mode === 'bench'
  byId('bench-options').hidden = mode !== 'bench'
  byId('model-field').hidden = mode === 'bench'
  if (mode === 'bench') renderBenchProviders()
}

function renderBenchProviders(): void {
  const container = byId('bench-providers')
  const eligible = snapshot.providers.filter((provider) => provider.enabled && provider.runtime.available)
  if (eligible.length < 2) {
    container.replaceChildren(element('p', 'field-help', 'At least two installed, signed-in agents are needed for a comparison.'))
    return
  }
  container.replaceChildren(...eligible.map((provider) => {
    const label = document.createElement('label'); label.className = 'bench-provider'
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = provider.id
    const body = element('span', 'bench-provider-body')
    body.append(element('strong', undefined, provider.name), element('small', undefined, provider.model ?? provider.kind))
    label.append(input, body)
    return label
  }))
}

function selectedBenchProviders(): string[] {
  return [...byId('bench-providers').querySelectorAll<HTMLInputElement>('input:checked')].map((input) => input.value)
}

function renderTaskProviderOptions(): void {
  const select = byId<HTMLSelectElement>('provider-override')
  const current = select.value
  select.replaceChildren(new Option('Automatic', ''), ...snapshot.providers.filter((provider) => provider.enabled).map((provider) => new Option(provider.name, provider.id)))
  select.value = current
  renderTaskModelOptions()
}

// Populate the model dropdown from discovered/known models, scoped to the chosen
// agent (or grouped by agent under Automatic).
function renderTaskModelOptions(): void {
  const select = byId<HTMLSelectElement>('task-model-select')
  const custom = byId<HTMLInputElement>('task-model')
  const current = select.value
  const overrideId = byId<HTMLSelectElement>('provider-override').value
  const providers = snapshot.providers.filter((provider) => provider.enabled && (!overrideId || provider.id === overrideId))
  const groups = providers
    .map((provider) => ({ id: provider.id, name: provider.name, models: provider.runtime.models ?? [] }))
    .filter((group) => group.models.length)
    .map((group) => {
      const node = document.createElement('optgroup'); node.label = group.name
      // The owning agent travels with the id: model ids are CLI-specific, so the
      // main process must not hand this one to a different agent on failover.
      for (const model of group.models) {
        const option = new Option(model, model)
        option.dataset.providerId = group.id
        node.append(option)
      }
      return node
    })
  select.replaceChildren(new Option('Provider default', ''), ...groups, new Option('Custom model…', '__custom__'))
  const values = new Set(['', '__custom__', ...groups.flatMap((group) => [...group.children].map((option) => (option as HTMLOptionElement).value))])
  select.value = values.has(current) ? current : ''
  custom.hidden = select.value !== '__custom__'
}

function renderSettings(): void {
  byId<HTMLInputElement>('max-parallel').value = String(snapshot.settings.maxParallelTasks)
  byId<HTMLInputElement>('cooldown-minutes').value = String(snapshot.settings.quotaCooldownMinutes)
  const memory = byId<HTMLTextAreaElement>('memory-input')
  if (document.activeElement !== memory) memory.value = snapshot.settings.memory ?? ''
}

// --- Control plane (Context & Tools) ---

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
async function persistControlPlaneDraft(showConfirmation = false): Promise<void> {
  if (!controlPlaneDraft) return
  const saved = await window.frontier.updateControlPlane(syncDraftFromInputs())
  snapshot = saved
  controlPlaneDraft = cloneProfile(saved.settings.controlPlane)
  if (showConfirmation) showToast('Context & Tools configuration saved')
}

function textLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
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
            snapshot = await window.frontier.authenticateMcpServer(server.id)
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
          try { snapshot = await window.frontier.disconnectMcpServer(server.id); showToast(`${server.name || 'MCP server'} disconnected`) }
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
  const capable = snapshot.providers.filter((provider) => ['claude', 'copilot', 'codex', 'codex-oss'].includes(provider.kind))
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

function renderControlPlane(): void {
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

// --- Shell ---

function render(): void {
  // Every renderer below reads the snapshot. It arrives asynchronously, and the
  // user can click a nav item before it does.
  if (typeof snapshot === 'undefined') return
  renderMiniProviders(); renderTasks(); renderTaskProviderOptions(); renderSettings()
  if (currentView === 'home') renderHome()
  if (currentView === 'agents') renderAgentsTab()
  if (currentView === 'review') renderReview()
}

const VIEW_META: Record<string, { title: string; eyebrow: string }> = {
  home: { title: 'Home', eyebrow: 'MISSION CONTROL' },
  tasks: { title: 'Tasks', eyebrow: 'ORCHESTRATION CONSOLE' },
  review: { title: 'Review', eyebrow: 'BRANCH INBOX' },
  agents: { title: 'Agents', eyebrow: 'LOCAL EXECUTABLES' },
  control: { title: 'Context & Tools', eyebrow: 'CONTROL PLANE' },
  settings: { title: 'Settings', eyebrow: 'PREFERENCES' }
}

function switchView(view: string): void {
  currentView = view
  document.querySelectorAll('.nav-item').forEach((item) => {
    const active = (item as HTMLElement).dataset.view === view
    item.classList.toggle('active', active)
    if (active) item.setAttribute('aria-current', 'page')
    else item.removeAttribute('aria-current')
  })
  document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item.id === `${view}-view`))
  const meta = VIEW_META[view] ?? { title: view, eyebrow: '' }
  byId('view-title').textContent = meta.title
  byId('view-eyebrow').textContent = meta.eyebrow
  byId('new-task-button').style.display = view === 'review' || view === 'control' ? 'none' : ''
  // The first snapshot may still be in flight — clicking a nav item before it
  // lands used to throw here and leave the view empty. render() repaints the
  // active view as soon as the snapshot arrives.
  if (typeof snapshot === 'undefined') return
  // Render the control plane from the draft only on entry so streaming snapshots
  // never clobber in-progress edits.
  if (view === 'control') renderControlPlane()
  if (view === 'agents') renderAgentsTab()
  if (view === 'home') renderHome()
  if (view === 'tasks') { renderTasks(); applyQueueWidth() }
  if (view === 'review') { renderReview(); void loadReview(true) }
}

function commandPaletteEntries(query: string): CommandPaletteEntry[] {
  const commands: CommandPaletteEntry[] = [
    { icon: '＋', label: 'New task', detail: 'Send work to an agent', shortcut: '⌘N', keywords: 'create route agent run', run: () => openTaskDialog() },
    { icon: '⚖', label: 'Compare agents', detail: 'Run one prompt on several agents at once', keywords: 'bench head to head compare', run: () => openTaskDialog('bench') },
    { icon: '◇', label: 'Go to Home', detail: 'Agent capacity and what is running', keywords: 'navigate mission control', run: () => switchView('home') },
    { icon: '⌁', label: 'Go to Tasks', detail: 'The work queue', keywords: 'navigate queue', run: () => switchView('tasks') },
    { icon: '⑃', label: 'Go to Review', detail: 'Branches waiting to be merged', keywords: 'navigate merge branches', run: () => switchView('review') },
    { icon: '◫', label: 'Go to Agents', detail: 'Installed CLIs and their usage', keywords: 'navigate providers models usage', run: () => switchView('agents') },
    { icon: '⊹', label: 'Go to Context & Tools', detail: 'MCP, permissions, and shared context', keywords: 'navigate mcp control plane', run: () => switchView('control') },
    { icon: '⌘', label: 'Go to Settings', detail: 'Scheduling and memory', keywords: 'navigate preferences', run: () => switchView('settings') },
    { icon: '↻', label: 'Check agents', detail: 'Refresh CLI availability and models', keywords: 'health refresh status', run: () => byId<HTMLButtonElement>('health-check').click() },
    { icon: '×', label: 'Clear finished tasks', detail: 'Remove completed, failed, and cancelled tasks', keywords: 'clean history', run: () => byId<HTMLButtonElement>('clear-finished').click() }
  ]
  const normalized = query.trim().toLowerCase()
  const matchingCommands = commands.filter((entry) => !normalized || `${entry.label} ${entry.detail} ${entry.keywords}`.toLowerCase().includes(normalized))
  const matchingTasks = (snapshot?.tasks ?? [])
    .filter((task) => !normalized || `${task.prompt} ${task.type} ${task.status} ${providerName(task.selectedProviderId)}`.toLowerCase().includes(normalized))
    .slice(0, normalized ? 10 : 5)
    .map((task): CommandPaletteEntry => ({
      icon: task.status === 'running' ? '◌' : task.status === 'completed' ? '✓' : '·',
      label: task.prompt,
      detail: `${taskKindLabel(task)} · ${task.status} · ${providerName(task.selectedProviderId)}`,
      keywords: 'task conversation workspace',
      run: () => openTask(task.id)
    }))
  return [...matchingCommands, ...matchingTasks]
}

function renderCommandPalette(): void {
  const input = byId<HTMLInputElement>('command-palette-input')
  const entries = commandPaletteEntries(input.value)
  commandPaletteIndex = Math.max(0, Math.min(commandPaletteIndex, Math.max(0, entries.length - 1)))
  const results = byId('command-palette-results')
  if (!entries.length) {
    results.replaceChildren(element('div', 'command-palette-empty', 'No matching commands or tasks.'))
    return
  }
  results.replaceChildren(...entries.map((entry, index) => {
    const button = element('button', `command-palette-item${index === commandPaletteIndex ? ' selected' : ''}`) as HTMLButtonElement
    button.type = 'button'; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === commandPaletteIndex))
    const copy = element('span', 'command-palette-item-copy')
    copy.append(element('strong', undefined, entry.label), element('small', undefined, entry.detail))
    button.append(element('span', 'command-palette-item-icon', entry.icon), copy, element('span', 'command-palette-item-key', entry.shortcut ?? ''))
    button.addEventListener('click', () => { commandPalette.close(); entry.run() })
    return button
  }))
}

function openCommandPalette(): void {
  const input = byId<HTMLInputElement>('command-palette-input')
  input.value = ''
  commandPaletteIndex = 0
  renderCommandPalette()
  commandPalette.showModal()
  requestAnimationFrame(() => input.focus())
}

function openTaskDialog(mode: RunMode = 'single'): void {
  setRunMode(mode)
  if (!taskDialog.open) taskDialog.showModal()
}

const SIDEBAR_STATE_KEY = 'fp-sidebar-collapsed'

function setSidebarCollapsed(collapsed: boolean, persist = true): void {
  const shell = document.querySelector<HTMLElement>('.shell')
  const toggle = byId<HTMLButtonElement>('sidebar-toggle')
  shell?.classList.toggle('sidebar-collapsed', collapsed)
  toggle.setAttribute('aria-expanded', String(!collapsed))
  toggle.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation')
  toggle.title = collapsed ? 'Expand navigation' : 'Collapse navigation'
  toggle.querySelector('span')!.textContent = collapsed ? '›' : '‹'
  if (persist) localStorage.setItem(SIDEBAR_STATE_KEY, String(collapsed))
}

setSidebarCollapsed(localStorage.getItem(SIDEBAR_STATE_KEY) === 'true', false)
byId('sidebar-toggle').addEventListener('click', () => {
  setSidebarCollapsed(!document.querySelector('.shell')?.classList.contains('sidebar-collapsed'))
})
document.querySelectorAll<HTMLElement>('.nav-item').forEach((item) => item.addEventListener('click', () => switchView(item.dataset.view ?? 'home')))
byId('home-view-tasks').addEventListener('click', () => switchView('tasks'))
byId('home-view-review').addEventListener('click', () => switchView('review'))
byId('review-refresh').addEventListener('click', () => void loadReview(true))

document.querySelectorAll<HTMLElement>('.surface-tab').forEach((tab) => tab.addEventListener('click', () => {
  surfaceTab = (tab.dataset.surfaceTab as typeof surfaceTab) ?? 'conversation'
  renderSurface()
}))
document.querySelectorAll<HTMLElement>('#agents-segmented button').forEach((button) => button.addEventListener('click', () => {
  agentsTab = button.dataset.agentsTab === 'usage' ? 'usage' : 'registry'
  renderAgentsTab()
}))
byId('surface-focus').addEventListener('click', () => {
  focusMode = !focusMode
  byId('content-grid').classList.toggle('focus-mode', focusMode)
  const button = byId<HTMLButtonElement>('surface-focus')
  button.setAttribute('aria-pressed', String(focusMode))
  button.textContent = focusMode ? '⤡' : '⤢'
  button.title = focusMode ? 'Show the queue' : 'Focus this task'
})
byId('task-file-mode').querySelectorAll<HTMLElement>('button').forEach((button) => button.addEventListener('click', () => {
  detailFileMode = button.dataset.fileMode === 'source' ? 'source' : 'diff'
  renderTaskFileViewer(detailFileState?.file)
}))
byId('new-task-button').addEventListener('click', () => openTaskDialog())
byId('close-dialog').addEventListener('click', () => taskDialog.close())
byId('cancel-dialog').addEventListener('click', () => taskDialog.close())
byId('confirm-cancel').addEventListener('click', () => confirmDialog.close())
document.querySelectorAll<HTMLElement>('.run-mode').forEach((button) => button.addEventListener('click', () => setRunMode((button.dataset.runMode as RunMode) ?? 'single')))
byId('choose-directory').addEventListener('click', async () => {
  const button = byId<HTMLButtonElement>('choose-directory')
  button.disabled = true
  button.textContent = 'Choosing…'
  try {
    const input = byId<HTMLInputElement>('cwd')
    const directory = await window.frontier.chooseDirectory(input.value)
    if (directory) input.value = directory
  } catch (error) {
    byId('form-error').textContent = `Folder picker failed: ${errorMessage(error)}. You can paste the path manually.`
    reportError('Folder picker failed', error)
  } finally {
    button.disabled = false
    button.textContent = 'Choose folder…'
  }
})
byId('health-check').addEventListener('click', async () => {
  const button = byId<HTMLButtonElement>('health-check'); button.disabled = true; button.textContent = 'Checking…'
  try { await window.frontier.checkProviders(); showToast('Agent health refreshed') }
  catch (error) { reportError('Agent check failed', error) }
  finally { button.disabled = false; button.textContent = '↻ Check agents' }
})
byId<HTMLInputElement>('task-search').addEventListener('input', (event) => {
  taskQuery = (event.target as HTMLInputElement).value.trim().toLowerCase()
  renderTasks()
})
byId<HTMLInputElement>('command-palette-input').addEventListener('input', () => { commandPaletteIndex = 0; renderCommandPalette() })
byId<HTMLInputElement>('command-palette-input').addEventListener('keydown', (event) => {
  const entries = commandPaletteEntries((event.currentTarget as HTMLInputElement).value)
  if (event.key === 'ArrowDown') { event.preventDefault(); commandPaletteIndex = Math.min(entries.length - 1, commandPaletteIndex + 1); renderCommandPalette() }
  else if (event.key === 'ArrowUp') { event.preventDefault(); commandPaletteIndex = Math.max(0, commandPaletteIndex - 1); renderCommandPalette() }
  else if (event.key === 'Enter' && entries[commandPaletteIndex]) { event.preventDefault(); commandPalette.close(); entries[commandPaletteIndex].run() }
})
commandPalette.addEventListener('click', (event) => { if (event.target === commandPalette) commandPalette.close() })

// Keyboard shortcuts: ⌘/Ctrl+K opens the command palette, ⌘/Ctrl+N a new task.
window.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey)) return
  if (event.key.toLowerCase() === 'k') {
    event.preventDefault()
    if (commandPalette.open) commandPalette.close()
    else if (!taskDialog.open) openCommandPalette()
  } else if (event.key.toLowerCase() === 'n') {
    event.preventDefault()
    if (commandPalette.open) commandPalette.close()
    openTaskDialog()
  }
})

// Draggable divider between the queue and the task surface.
;(function setupResizer(): void {
  const grid = byId('content-grid')
  const gutter = byId('grid-gutter')
  let dragging = false

  // Clamp the queue column so the task surface always keeps room. On a narrow
  // window the upper bound can fall below the lower one; that range is unusable,
  // and the previous `Math.min(Math.max(...))` silently returned a width under
  // the minimum — sometimes zero or negative. Because the result was persisted,
  // one drag in a small window collapsed the queue on every later launch.
  // An unusable range now falls back to the stylesheet's proportional columns.
  const clampQueueWidth = (width: number): number | undefined => {
    const available = grid.getBoundingClientRect().width
    const widest = available - GUTTER_WIDTH - SURFACE_MIN_WIDTH
    if (!Number.isFinite(width) || width <= 0 || widest < QUEUE_MIN_WIDTH) return undefined
    return Math.round(Math.min(Math.max(QUEUE_MIN_WIDTH, width), widest))
  }

  applyQueueWidth = (): void => {
    // Only the queue column is written, and as the `--wq-col` custom property the
    // stylesheet already reads. Setting the whole `grid-template-columns` inline
    // used to outrank `.focus-mode`'s own columns, so focusing a task hid the
    // queue and left the surface auto-placed in the queue's column.
    // The grid has no width while the Tasks view is hidden, so a stored width is
    // applied when the view is shown rather than at startup.
    const clamped = queueWidth === undefined ? undefined : clampQueueWidth(queueWidth)
    if (clamped === undefined) grid.style.removeProperty('--wq-col')
    else grid.style.setProperty('--wq-col', `${clamped}px`)
  }

  const stored = Number(localStorage.getItem('fp-wq-width'))
  queueWidth = Number.isFinite(stored) && stored > 0 ? stored : undefined

  gutter.addEventListener('mousedown', (event) => { dragging = true; gutter.classList.add('dragging'); document.body.style.userSelect = 'none'; event.preventDefault() })
  window.addEventListener('mousemove', (event) => {
    if (!dragging) return
    const clamped = clampQueueWidth(event.clientX - grid.getBoundingClientRect().left)
    if (clamped === undefined) return
    queueWidth = clamped
    applyQueueWidth()
  })
  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false; gutter.classList.remove('dragging'); document.body.style.userSelect = ''
    // Only a width that survives clamping is worth remembering.
    const clamped = queueWidth === undefined ? undefined : clampQueueWidth(queueWidth)
    if (clamped === undefined) localStorage.removeItem('fp-wq-width')
    else localStorage.setItem('fp-wq-width', String(clamped))
  })
  // Shrinking the window can invalidate a width that used to fit.
  window.addEventListener('resize', () => { if (currentView === 'tasks') applyQueueWidth() })
})()

for (const inputId of ['composer-input', 'prompt']) {
  const input = byId<HTMLTextAreaElement>(inputId)
  const attach = document.querySelector<HTMLButtonElement>(`.composer-attach[data-composer-input="${inputId}"]`)
  attach?.addEventListener('click', async () => {
    attach.disabled = true
    try { addImages(inputId, await window.frontier.chooseImages()) }
    catch (error) { reportError('Could not attach image', error) }
    finally { attach.disabled = false; input.focus() }
  })
  input.addEventListener('input', () => {
    const draft = composerDraft(inputId)
    draft.items = draft.items.filter((item) => item.kind === 'image' || input.value.includes(`@${item.path}`))
    void refreshMentions(inputId)
  })
  input.addEventListener('click', () => { void refreshMentions(inputId) })
  input.addEventListener('keydown', (event) => { if (handleMentionKeydown(inputId, event)) event.stopImmediatePropagation() })
  input.addEventListener('blur', () => window.setTimeout(() => closeMentions(inputId), 120))
  input.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files ?? [])]
    if (!files.some((file) => file.type.startsWith('image/'))) return
    event.preventDefault(); void saveDroppedImages(inputId, files)
  })
  const draft = input.closest<HTMLElement>('.composer-draft')
  draft?.addEventListener('dragover', (event) => { if ([...(event.dataTransfer?.items ?? [])].some((item) => item.type.startsWith('image/'))) { event.preventDefault(); draft.classList.add('dragging') } })
  draft?.addEventListener('dragleave', () => draft.classList.remove('dragging'))
  draft?.addEventListener('drop', (event) => {
    draft.classList.remove('dragging')
    const files = [...(event.dataTransfer?.files ?? [])]
    if (!files.some((file) => file.type.startsWith('image/'))) return
    event.preventDefault(); void saveDroppedImages(inputId, files)
  })
}

async function handleComposerAction(): Promise<void> {
  const taskId = selectedTaskId
  if (!taskId) return
  const task = snapshot.tasks.find((item) => item.id === taskId)
  if (!task) return
  const input = byId<HTMLTextAreaElement>('composer-input')
  const button = byId<HTMLButtonElement>('composer-send')

  if (taskIsBusy(task)) {
    button.disabled = true
    button.textContent = 'Stopping…'
    try { await window.frontier.cancelTask(taskId) }
    catch (error) {
      reportError('Could not stop the task', error)
      renderComposerState(task, input, button)
    }
    return
  }

  const text = input.value.trim()
  const attachments = messageContext('composer-input', text)
  if (!text && !attachments.length) return
  const draft = composerDraft('composer-input')
  const savedItems = [...draft.items]
  const savedPreviews = new Map(draft.previews)
  input.value = ''
  for (const attachment of attachments) {
    const preview = savedPreviews.get(attachment.id)
    if (preview) attachmentPreviewCache.set(`${taskId}:${attachment.id}`, preview)
  }
  clearComposerDraft('composer-input')
  input.disabled = true
  button.disabled = true
  try {
    await persistControlPlaneDraft()
    await window.frontier.continueTask(taskId, text, attachments)
  } catch (error) {
    if (!input.value) input.value = text
    if (!composerDraft('composer-input').items.length) {
      composerDraft('composer-input').items = savedItems
      composerDraft('composer-input').previews = savedPreviews
      renderDraftImages('composer-input')
    }
    reportError('Could not continue the conversation', error)
  } finally {
    const latest = snapshot.tasks.find((item) => item.id === taskId)
    if (latest) renderComposerState(latest, input, button)
    if (!latest || !taskIsBusy(latest)) input.focus()
  }
}

byId('composer-send').addEventListener('click', () => void handleComposerAction())
byId<HTMLTextAreaElement>('composer-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void handleComposerAction() }
})
byId('clear-finished').addEventListener('click', () => void window.frontier.clearFinishedTasks())
byId('add-provider').addEventListener('click', async () => {
  try {
    agentsTab = 'registry'
    await window.frontier.addCustomProvider()
    showToast('Custom agent added — configure it below')
    requestAnimationFrame(() => document.querySelector('.provider-card:last-child')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  } catch (error) { reportError('Could not add agent', error) }
})
byId('cp-add-server').addEventListener('click', () => {
  const draft = syncDraftFromInputs()
  const server: McpServerConfig = { id: newId(), name: '', enabled: true, transport: 'stdio', command: '', args: [] }
  draft.mcpServers.push(server)
  renderMcpServers()
})
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
byId('save-memory').addEventListener('click', async () => {
  const button = byId<HTMLButtonElement>('save-memory'); button.disabled = true
  try { await window.frontier.updateSettings({ memory: byId<HTMLTextAreaElement>('memory-input').value }); showToast('Memory saved') }
  catch (error) { reportError('Could not save memory', error) } finally { button.disabled = false }
})
byId('save-settings').addEventListener('click', async () => {
  try {
    await window.frontier.updateSettings({
      maxParallelTasks: Number(byId<HTMLInputElement>('max-parallel').value),
      quotaCooldownMinutes: Number(byId<HTMLInputElement>('cooldown-minutes').value)
    })
    showToast('Scheduler settings saved')
  } catch (error) { reportError('Could not save scheduler settings', error) }
})

byId<HTMLSelectElement>('provider-override').addEventListener('change', renderTaskModelOptions)
byId<HTMLSelectElement>('task-model-select').addEventListener('change', () => {
  const custom = byId<HTMLInputElement>('task-model')
  custom.hidden = byId<HTMLSelectElement>('task-model-select').value !== '__custom__'
  if (!custom.hidden) custom.focus()
})

function selectedModel(): string | undefined {
  const choice = byId<HTMLSelectElement>('task-model-select').value
  if (choice === '__custom__') return byId<HTMLInputElement>('task-model').value.trim() || undefined
  return choice || undefined
}

// The agent a listed model was picked from; a typed custom id belongs to the
// chosen agent, or to nobody in particular under Automatic.
function selectedModelProvider(): string | undefined {
  const select = byId<HTMLSelectElement>('task-model-select')
  if (select.value === '__custom__') return byId<HTMLSelectElement>('provider-override').value || undefined
  return select.selectedOptions[0]?.dataset.providerId || undefined
}

byId<HTMLFormElement>('task-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const errorNode = byId('form-error'); errorNode.textContent = ''
  try {
    const benchIds = runMode === 'bench' ? selectedBenchProviders() : undefined
    if (runMode === 'bench' && (benchIds?.length ?? 0) < 2) throw new Error('Choose at least two agents to compare.')
    await persistControlPlaneDraft()
    const prompt = byId<HTMLTextAreaElement>('prompt').value
    const task = await window.frontier.createTask({
      prompt,
      cwd: byId<HTMLInputElement>('cwd').value,
      mode: byId<HTMLSelectElement>('routing-mode').value as 'balanced' | 'quality' | 'saver',
      preferredProviderId: runMode === 'single' ? byId<HTMLSelectElement>('provider-override').value || undefined : undefined,
      model: runMode === 'bench' ? undefined : selectedModel(),
      modelProviderId: runMode === 'bench' ? undefined : selectedModelProvider(),
      orchestrate: runMode === 'orchestrate',
      benchProviderIds: benchIds,
      attachments: messageContext('prompt', prompt)
    })
    for (const item of composerDraft('prompt').items) {
      const preview = composerDraft('prompt').previews.get(item.id)
      if (preview) attachmentPreviewCache.set(`${task.id}:${item.id}`, preview)
    }
    selectedTaskId = task.id
    surfaceTab = 'conversation'
    byId<HTMLTextAreaElement>('prompt').value = ''
    byId<HTMLSelectElement>('task-model-select').value = ''
    byId<HTMLInputElement>('task-model').value = ''
    byId<HTMLInputElement>('task-model').hidden = true
    clearComposerDraft('prompt')
    setRunMode('single')
    taskDialog.close()
    switchView('tasks')
  } catch (error) { errorNode.textContent = errorMessage(error) }
})

window.addEventListener('unhandledrejection', (event) => reportError('Unexpected application error', event.reason))

window.frontier.onSnapshot((next) => {
  const finishedBefore = new Set(snapshot?.tasks.filter((task) => taskIsBusy(task)).map((task) => task.id) ?? [])
  snapshot = next
  render()
  // A task that just stopped may have left new branches behind.
  if ([...finishedBefore].some((id) => { const task = next.tasks.find((item) => item.id === id); return task && !taskIsBusy(task) })) void loadReview()
})
window.frontier.onStream((event) => {
  if (event.taskId === selectedTaskId && surfaceTab === 'conversation') {
    const thread = byId('surface-thread')
    thread.scrollTop = thread.scrollHeight
  }
})

void window.frontier.getSnapshot()
  .then((initial) => { snapshot = initial; switchView('home'); render(); void loadReview() })
  .catch((error) => reportError('Could not connect to the Frontier service', error))

// Reset countdowns and expired-window state should keep moving even when no
// provider emits a new snapshot.
window.setInterval(() => {
  if (typeof snapshot === 'undefined') return
  renderMiniProviders()
  if (currentView === 'home') renderHome()
  if (currentView === 'agents' && agentsTab === 'usage') renderUsage()
}, 30_000)
