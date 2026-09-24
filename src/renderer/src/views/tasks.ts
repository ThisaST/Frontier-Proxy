// Tasks — three panes: the work queue (grouped by status), the conversation
// (the primary surface), and a collapsible route/files/activity inspector.
// The Files tab lives on in the file-viewer overlay, opened from the
// inspector's "Files changed" section.
import type { ChatContextItem, ConversationTurn, ProxyTask, RoutingCandidate, SubTask, TaskFileContent, TaskWorkspaceSnapshot, WorkspaceEntry } from '../../../shared/types'
import { renderMarkdown } from '../markdown'
import { byId, codeLine, element, emptyState, metaChip, renderDiffInto } from '../ui/dom'
import { chip, dialogHandle, gaugeSeg, inspectorSection, lamp, probabilityBar, probabilityBars, type Tone } from '../ui/components'
import { icon, type IconName } from '../ui/icons'
import { errorMessage, reportError, showToast } from '../ui/feedback'
import { baseName, formatCost, formatDuration, formatNumber, timeAgo } from '../ui/format'
import { providerName, providerSelectableForTask } from '../providers-view-model'
import { taskElapsed, taskIsBusy, taskKindLabel, taskStatusIndicator, taskTokens, verificationChip } from '../task-helpers'
import { snapshot, selectedTaskId, setSelectedTaskId, currentView } from '../state'
import { attachmentPreviewCache, composerDraft, messageContext, clearComposerDraft, renderDraftImages } from '../composer'
import { persistControlPlaneDraft } from '../views/control'
import { currentProject, onProjectChange, projectMatches, renderProjectChipInto } from '../project'
import { openBranchInReview, switchView } from '../main'
import { desiredTier } from '../../../shared/model-profiles'

function readLS(key: string): string | undefined { try { return localStorage.getItem(key) ?? undefined } catch { return undefined } }
function writeLS(key: string, value: string): void { try { localStorage.setItem(key, value) } catch { /* private mode / disabled storage */ } }
function removeLS(key: string): void { try { localStorage.removeItem(key) } catch { /* private mode / disabled storage */ } }

let taskQuery = ''
let focusMode = false

// --- Task list grouping ---

type TaskGroupId = 'running' | 'needs-review' | 'done' | 'failed'
const GROUPS: Array<{ id: TaskGroupId; label: string }> = [
  { id: 'running', label: 'Running' },
  { id: 'needs-review', label: 'Needs review' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed / cancelled' }
]
const GROUP_COLLAPSE_KEY = 'fp-task-groups-collapsed'
function loadCollapsedGroups(): Set<TaskGroupId> {
  try { const raw = readLS(GROUP_COLLAPSE_KEY); return raw ? new Set(JSON.parse(raw) as TaskGroupId[]) : new Set() } catch { return new Set() }
}
let collapsedGroups = loadCollapsedGroups()

// "Needs review" is completed work that left something to look at: a
// committed isolated branch, or — when that is hard to tell for a plain
// single-agent run — any recorded file change.
function taskNeedsReview(task: ProxyTask): boolean {
  if (task.status !== 'completed') return false
  if (task.subtasks?.some((lane) => lane.branch && lane.committed)) return true
  return Boolean(task.filesChanged?.length)
}

function taskGroup(task: ProxyTask): TaskGroupId {
  if (task.status === 'running' || task.status === 'queued') return 'running'
  if (task.status === 'failed' || task.status === 'cancelled') return 'failed'
  return taskNeedsReview(task) ? 'needs-review' : 'done'
}

function taskMatchesQuery(task: ProxyTask): boolean {
  if (!taskQuery) return true
  const haystack = `${task.prompt} ${task.type} ${task.mode} ${task.status} ${providerName(task.selectedProviderId)}`.toLowerCase()
  return haystack.includes(taskQuery)
}

function orderedVisibleTasks(scoped: ProxyTask[]): ProxyTask[] {
  const visible = scoped.filter(taskMatchesQuery)
  const result: ProxyTask[] = []
  for (const group of GROUPS) {
    if (collapsedGroups.has(group.id)) continue
    for (const task of visible) if (taskGroup(task) === group.id) result.push(task)
  }
  return result
}

function taskRowId(taskId: string): string { return `task-row-${taskId}` }

function taskRow(task: ProxyTask): HTMLElement {
  const row = element('div', `task-row ${task.id === selectedTaskId ? 'selected' : ''}`)
  row.id = taskRowId(task.id)
  row.dataset.taskId = task.id
  row.setAttribute('role', 'option')
  row.setAttribute('aria-selected', String(task.id === selectedTaskId))
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
  row.append(taskStatusIndicator(task.status), body, element('span', 'task-time', timeAgo(task.createdAt)))
  row.addEventListener('click', () => { setSelectedTaskId(task.id); renderTasks() })
  row.addEventListener('dblclick', () => openTask(task.id))
  return row
}

export function renderTasks(): void {
  const container = byId('task-list')
  renderProjectChipInto('tasks-project-chip')
  const scoped = snapshot.tasks.filter((task) => projectMatches(task.cwd))
  if (!scoped.length) {
    container.replaceChildren(currentProject
      ? emptyState('No tasks in this project', 'Start one from Home, or clear the project filter above.')
      : emptyState('The queue is clear', 'Create a task and Frontier will pick the best available agent.'))
    renderSurface()
    return
  }
  const visible = scoped.filter(taskMatchesQuery)
  if (!selectedTaskId || !scoped.some((task) => task.id === selectedTaskId)) setSelectedTaskId(visible[0]?.id ?? scoped[0].id)
  if (!visible.length) {
    container.replaceChildren(emptyState('No matching tasks', `Nothing matches “${taskQuery}”.`))
    renderSurface()
    return
  }

  const byGroup = new Map<TaskGroupId, ProxyTask[]>(GROUPS.map((group) => [group.id, []]))
  for (const task of visible) byGroup.get(taskGroup(task))!.push(task)

  const fragment = document.createDocumentFragment()
  for (const group of GROUPS) {
    const tasksInGroup = byGroup.get(group.id)!
    if (!tasksInGroup.length) continue
    const collapsed = collapsedGroups.has(group.id)
    const section = element('div', `task-group${collapsed ? ' collapsed' : ''}`)
    section.setAttribute('role', 'group')
    const headerId = `task-group-head-${group.id}`
    section.setAttribute('aria-labelledby', headerId)
    const header = element('button', 'task-group-head') as HTMLButtonElement
    header.type = 'button'
    header.id = headerId
    header.setAttribute('aria-expanded', String(!collapsed))
    const caret = element('span', 'task-group-caret'); caret.append(icon(collapsed ? 'chevron-right' : 'chevron-down', 14))
    header.append(caret, element('span', 'task-group-label', group.label), element('span', 'task-group-count', String(tasksInGroup.length)))
    header.addEventListener('click', () => {
      if (collapsedGroups.has(group.id)) collapsedGroups.delete(group.id); else collapsedGroups.add(group.id)
      writeLS(GROUP_COLLAPSE_KEY, JSON.stringify([...collapsedGroups]))
      renderTasks()
    })
    section.append(header)
    if (!collapsed) {
      // The rows container is its own `listbox` of `option` rows (axe:
      // aria-required-children) — `#task-list` itself is a plain `group`
      // holding several such listboxes, one per status group, rather than one
      // listbox owning non-option header buttons directly.
      const rows = element('div', 'task-group-rows')
      rows.setAttribute('role', 'listbox')
      rows.setAttribute('aria-label', `${group.label} tasks`)
      for (const task of tasksInGroup) rows.append(taskRow(task))
      section.append(rows)
    }
    fragment.append(section)
  }
  container.replaceChildren(fragment)
  renderSurface()
}

// --- Left/right pane collapse, widths ---

// The conversation is the primary surface, so it gets a hard floor neither
// drag gutter may squeeze past; the list and inspector default to fixed,
// comfortable widths rather than a flex share of whatever is left.
// GUTTER_WIDTH mirrors the stylesheet's own track size for `.content-grid`;
// a width clamped against a different number would overflow the grid.
const QUEUE_MIN_WIDTH = 220
const QUEUE_DEFAULT_WIDTH = 280
const SURFACE_MIN_WIDTH = 420
const INSPECTOR_MIN_WIDTH = 240
const INSPECTOR_DEFAULT_WIDTH = 320
// Below this, the inspector auto-collapses rather than letting the centre
// shrink further — softer than SURFACE_MIN_WIDTH, which is the absolute
// floor a drag can never cross.
const CENTRE_AUTO_COLLAPSE_WIDTH = 480
const GUTTER_WIDTH = 7
let queueWidth: number | undefined
let inspectorWidth: number | undefined
export let applyQueueWidth: () => void = () => undefined
export let applyInspectorWidth: () => void = () => undefined

const LIST_COLLAPSE_KEY = 'fp-list-collapsed'
const INSPECTOR_COLLAPSE_KEY = 'fp-inspector-collapsed'
let listCollapsedManual = readLS(LIST_COLLAPSE_KEY) === 'true'
let inspectorCollapsedManual = readLS(INSPECTOR_COLLAPSE_KEY) === 'true'
// Set only while a panel is auto-collapsed for lack of room; toggling it
// there raises it as a floating overlay instead of trying to squeeze the
// grid below its floor. Transient — not persisted.
let inspectorOverlayOpen = false
let listOverlayOpen = false
let lastAutoCollapse = false
let lastListAutoCollapse = false

export function toggleTaskList(): void {
  // Too narrow for the list to sit inline: its own toggle opens it as a
  // floating overlay instead of fighting the auto-collapse (mirrors the
  // inspector's own toggle below).
  if (lastListAutoCollapse && !listCollapsedManual) {
    listOverlayOpen = !listOverlayOpen
    applyInspectorState()
    return
  }
  listCollapsedManual = !listCollapsedManual
  writeLS(LIST_COLLAPSE_KEY, String(listCollapsedManual))
  applyInspectorState()
}

// Drives both side panels' collapse/overlay state from the grid's real,
// laid-out width — never a fixed viewport breakpoint. The inspector (softer,
// secondary panel) gives way first, once the centre would drop under its
// comfortable width; the list only auto-collapses once even a collapsed
// inspector leaves no room for the centre's hard 420px floor (SURFACE_MIN_WIDTH
// below). Named `applyInspectorState` for the existing
// exported call sites (main.ts, resize handlers) — it now owns the list too
// because the two decisions are coupled (each affects the room left for the
// other).
export function applyInspectorState(): void {
  const grid = byId('content-grid')
  const available = grid.getBoundingClientRect().width
  const inspectorSpaceFull = (inspectorWidth ?? INSPECTOR_DEFAULT_WIDTH) + GUTTER_WIDTH
  const listSpaceFull = (queueWidth ?? QUEUE_DEFAULT_WIDTH) + GUTTER_WIDTH

  // Only a real, laid-out measurement counts — the grid reports 0 while the
  // Tasks view is hidden, which must never look like "too narrow to fit".
  const autoCollapse = available > 0 && (available - listSpaceFull - inspectorSpaceFull) < CENTRE_AUTO_COLLAPSE_WIDTH
  lastAutoCollapse = autoCollapse
  const collapsed = inspectorCollapsedManual || autoCollapse
  const overlay = autoCollapse && !inspectorCollapsedManual && inspectorOverlayOpen
  const inspectorGridSpace = collapsed ? 0 : inspectorSpaceFull

  const autoCollapseList = available > 0 && (available - inspectorGridSpace - listSpaceFull) < SURFACE_MIN_WIDTH
  lastListAutoCollapse = autoCollapseList
  const listCollapsedNow = listCollapsedManual || autoCollapseList
  const listOverlay = autoCollapseList && !listCollapsedManual && listOverlayOpen

  grid.classList.toggle('inspector-collapsed', collapsed)
  grid.classList.toggle('inspector-overlay-open', overlay)
  grid.classList.toggle('list-collapsed', listCollapsedNow)
  grid.classList.toggle('list-overlay-open', listOverlay)

  const visible = !collapsed || overlay
  const toggle = byId<HTMLButtonElement>('inspector-toggle')
  toggle.setAttribute('aria-pressed', String(visible))
  toggle.setAttribute('aria-expanded', String(visible))
  toggle.title = visible ? (autoCollapse ? 'Hide inspector' : 'Collapse inspector') : (autoCollapse ? 'Show inspector' : 'Expand inspector')
  toggle.setAttribute('aria-label', toggle.title)
  toggle.replaceChildren(icon(visible ? 'panel-right-close' : 'panel-right', 16))

  const listVisible = !listCollapsedNow || listOverlay
  const listToggle = byId<HTMLButtonElement>('list-toggle')
  listToggle.setAttribute('aria-pressed', String(listVisible))
  listToggle.setAttribute('aria-expanded', String(listVisible))
  listToggle.title = listVisible ? (autoCollapseList ? 'Hide queue' : 'Collapse queue') : (autoCollapseList ? 'Show queue' : 'Expand queue')
  listToggle.setAttribute('aria-label', listToggle.title)
  listToggle.replaceChildren(icon(listVisible ? 'collapse' : 'expand', 16))
}

export function toggleInspector(): void {
  // Too narrow for the inspector to sit inline: its own toggle opens it as a
  // floating overlay instead, rather than fighting the auto-collapse.
  if (lastAutoCollapse && !inspectorCollapsedManual) {
    inspectorOverlayOpen = !inspectorOverlayOpen
    applyInspectorState()
    return
  }
  inspectorCollapsedManual = !inspectorCollapsedManual
  writeLS(INSPECTOR_COLLAPSE_KEY, String(inspectorCollapsedManual))
  applyInspectorState()
}

// --- Unified task surface ---

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
    const chipEl = element('div', 'meta-chip context-meter')
    chipEl.append(element('span', 'meta-label', task.contextSource === 'estimated' ? 'Context (estimate)' : 'Context'))
    const row = element('div', 'context-row')
    row.append(gaugeSeg(percent, percent >= 80 ? 'caution' : 'cyan', 'Context window occupancy'), element('strong', 'readout', `${Math.round(percent)}%`))
    chipEl.title = `${formatNumber(task.contextTokens)} of ${formatNumber(task.contextWindow)} tokens`
    chipEl.append(row)
    chips.push(chipEl)
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
  identity.append(taskStatusIndicator(lane.status), element('strong', undefined, lane.title))
  head.append(identity, element('span', 'lane-meta', [lane.model, lane.status].filter(Boolean).join(' · ')))
  card.append(head)

  // Everything on this row is measured, never judged: how big the change was,
  // how long it took, what it spent, and whether the repo's own checks passed.
  const elapsed = lane.startedAt && lane.finishedAt ? Date.parse(lane.finishedAt) - Date.parse(lane.startedAt) : undefined
  const measures = [
    lane.filesTouched ? `${lane.filesTouched} file${lane.filesTouched === 1 ? '' : 's'} +${lane.additions ?? 0} −${lane.deletions ?? 0}` : undefined,
    elapsed !== undefined ? formatDuration(elapsed) : undefined,
    lane.usageInputTokens || lane.usageOutputTokens ? `${formatNumber((lane.usageInputTokens ?? 0) + (lane.usageOutputTokens ?? 0))} tokens` : undefined
  ].filter(Boolean) as string[]
  const verificationBadge = verificationChip(lane.verification)
  if (measures.length || verificationBadge) {
    const score = element('div', 'lane-score')
    for (const measure of measures) score.append(element('span', 'lane-measure', measure))
    if (verificationBadge) score.append(verificationBadge)
    card.append(score)
  }

  if (lane.branch) {
    const branch = element('button', 'lane-branch') as HTMLButtonElement
    branch.append(icon('branch', 14), document.createTextNode(lane.committed ? ` ${lane.branch}` : ` ${lane.branch} · no changes`))
    branch.title = lane.committed ? 'Open this branch in Review' : 'Isolated branch; nothing was changed'
    branch.disabled = !lane.committed
    branch.addEventListener('click', () => openBranchInReview(task.cwd, lane.branch!))
    card.append(branch)
  }

  const body = element('div', 'lane-body markdown')
  if (lane.output.trim()) body.appendChild(renderMarkdown(lane.output))
  else if (lane.error) { body.textContent = lane.error; body.classList.add('lane-error') }
  else body.textContent = lane.status === 'running' ? 'Working…' : 'Queued…'
  card.append(body)
  return card
}

// Avoids re-parsing markdown for a finished task on every unrelated snapshot.
let lastBodyRender = { id: '', status: '', length: -1 }

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
      reference.append(icon(attachment.kind === 'folder' ? 'folder' : 'file', 14), element('span', undefined, `@${attachment.path}${attachment.kind === 'folder' ? '/' : ''}`))
      container.append(reference)
    }
  }
  body.append(container)
}

// --- Inspector: Route section ---

function candidateRow(candidate: RoutingCandidate, chosen: boolean): HTMLElement {
  const row = element('div', `receipt-row ${candidate.eligible ? 'eligible' : 'skipped'}${chosen ? ' chosen' : ''}`)
  const head = element('div', 'receipt-head')
  const name = element('strong', undefined, candidate.providerName)
  head.append(name)
  if (chosen) head.append(element('span', 'receipt-chip', 'chosen'))
  head.append(element('span', 'receipt-score readout', candidate.eligible ? String(Math.round(candidate.score ?? 0)) : '—'))
  row.append(head)

  if (candidate.eligible && candidate.factors?.length) {
    const factors = element('div', 'receipt-factors')
    for (const factor of candidate.factors) {
      const bar = probabilityBar(factor.label, factor.points)
      // Jev's own factors (see CLAUDE.md's "Routing advisor" section) are
      // labelled distinctly from the router's own scoring so it is always
      // visible which rows the advisor actually influenced.
      if (factor.label.startsWith('Jev')) bar.querySelector('.probability-bar-label')?.prepend(chip('cyan', 'JEV'))
      factors.append(bar)
    }
    row.append(factors)
  } else if (candidate.skippedReason) {
    row.append(element('p', 'receipt-reason', candidate.skippedReason))
  }
  return row
}

function signalLamp(label: string, value: number | undefined): HTMLElement {
  const row = element('span', 'advice-signal')
  const tone: Tone = value === undefined ? 'muted' : value >= 0.66 ? 'phosphor' : value >= 0.33 ? 'amber' : 'muted'
  row.append(lamp(tone, label), element('span', undefined, `${label}${value !== undefined ? ` · ${Math.round(value * 100)}%` : ''}`))
  return row
}

// Jev's `target` choice keys options as `providerId::model` (see
// `src/main/advisor.ts`); shown to the user as "Agent · model".
function targetLabel(key: string): string {
  const separator = key.indexOf('::')
  if (separator < 0) return key
  const providerId = key.slice(0, separator)
  const model = key.slice(separator + 2)
  return `${providerName(providerId)}${model ? ` · ${model}` : ''}`
}

// Returns the full Jev advisor panel (task type, complexity, signals, best
// fit) or nothing when this task never got an advisor read.
function buildAdvicePanel(task: ProxyTask): HTMLElement | undefined {
  const advice = task.advice
  if (!advice) return undefined
  const panel = element('section', 'advice-card')
  const nodes: HTMLElement[] = [element('p', 'eyebrow', 'ADVISOR')]

  const badgeRow = element('div', 'advice-badge-row')
  if (advice.source === 'jev') {
    badgeRow.append(chip('cyan', `JEV · ${advice.model ?? snapshot.settings.advisor.model}`))
    const meta = [
      advice.latencyMs !== undefined ? formatDuration(advice.latencyMs) : undefined,
      advice.inputTokens !== undefined ? `${formatNumber(advice.inputTokens)} tokens in` : undefined
    ].filter(Boolean).join(' · ')
    if (meta) badgeRow.append(element('span', 'advice-badge-meta', meta))
  } else {
    badgeRow.append(chip('muted', 'LOCAL RULES'))
    if (advice.error) badgeRow.append(element('span', 'advice-badge-meta caution', `Jev unavailable: ${advice.error}`))
  }
  nodes.push(badgeRow)

  const typeSection = element('div', 'advice-section')
  typeSection.append(element('p', 'advice-label', 'Task type'))
  typeSection.append(element('p', 'advice-value', `${advice.taskType}${advice.taskTypeConfidence !== undefined ? ` · ${Math.round(advice.taskTypeConfidence * 100)}% confidence` : ''}`))
  if (advice.taskTypeProbs) {
    const entries = Object.entries(advice.taskTypeProbs).map(([label, value]) => ({ label, value })).sort((left, right) => right.value - left.value)
    typeSection.append(probabilityBars(entries, 'cyan'))
  }
  if (advice.taskType !== advice.heuristicTaskType) typeSection.append(element('p', 'advice-note', `Local rules said ${advice.heuristicTaskType}.`))
  nodes.push(typeSection)

  if (advice.complexity !== undefined) {
    const complexitySection = element('div', 'advice-section')
    const tier = desiredTier(advice.complexity, task.mode).tier
    complexitySection.append(element('p', 'advice-label', 'Complexity'))
    complexitySection.append(gaugeSeg((advice.complexity / 3) * 100, 'amber', 'Complexity', 4))
    complexitySection.append(element('p', 'advice-value', `${advice.complexity.toFixed(1)} → ${tier} tier`))
    nodes.push(complexitySection)
  }

  const signalsSection = element('div', 'advice-section')
  signalsSection.append(element('p', 'advice-label', 'Signals'))
  const signalsRow = element('div', 'advice-signals')
  signalsRow.append(
    signalLamp('Edits files', advice.editsFiles),
    signalLamp('Needs broad context', advice.longContext),
    signalLamp('Splits well', advice.splitWorthy)
  )
  signalsSection.append(signalsRow)
  nodes.push(signalsSection)

  if (advice.target) {
    const bestFitSection = element('div', 'advice-section')
    bestFitSection.append(element('p', 'advice-label', 'Best fit'))
    const entries = Object.entries(advice.target.probabilities)
      .sort((left, right) => right[1] - left[1]).slice(0, 3)
      .map(([key, value]) => ({ label: targetLabel(key), value }))
    bestFitSection.append(probabilityBars(entries, 'cyan'))
    nodes.push(bestFitSection)
  }

  if (task.routedModel) nodes.push(element('p', 'advice-note', `Model chosen: ${task.routedModel.model} — ${task.routedModel.reason}`))

  const advisorDecision = task.routing?.advisor
  if (advisorDecision?.note) nodes.push(element('p', 'advice-note', advisorDecision.note))
  if (advisorDecision?.mode === 'shadow' && advisorDecision.wouldChooseProviderId) {
    const would = `${providerName(advisorDecision.wouldChooseProviderId)}${advisorDecision.wouldChooseModel ? ` · ${advisorDecision.wouldChooseModel}` : ''}`
    nodes.push(element('p', 'advice-note cyan-text', `Shadow: Jev would have picked ${would}.`))
  }

  panel.append(...nodes)
  return panel
}

// "WHY THIS AGENT" — the full candidate list with factor breakdowns.
function buildReceipt(task: ProxyTask): HTMLElement {
  const container = element('div', 'routing-receipt')
  const routing = task.routing
  if (!routing) {
    container.append(element('p', 'detail-empty', task.bench
      ? 'Comparisons target the agents you chose, so no routing decision was made.'
      : 'No routing decision has been recorded for this task yet.'))
    return container
  }
  const summary = element('p', 'receipt-summary')
  const chosenName = snapshot.providers.find((provider) => provider.id === routing.chosenProviderId)?.name ?? 'No agent'
  summary.textContent = `${chosenName} scored highest for this ${routing.taskType} task under the ${routing.mode} policy.`
  container.append(summary, ...routing.candidates.map((candidate) => candidateRow(candidate, candidate.providerId === routing.chosenProviderId)))
  return container
}

function advisorBadge(task: ProxyTask): HTMLElement | undefined {
  const advice = task.advice
  if (!advice) return undefined
  return advice.source === 'jev' ? chip('cyan', `JEV${advice.model ? ` · ${advice.model}` : ''}`) : chip('muted', 'LOCAL RULES')
}

function routeSummarySentence(task: ProxyTask): string {
  const providerId = task.routing?.chosenProviderId ?? task.selectedProviderId
  const name = providerName(providerId)
  const base = task.model ? `${name} · ${task.model}` : name
  if (task.bench) return `${base} — one of the agents chosen for this comparison.`
  const routing = task.routing
  if (!routing) return `${base} — no routing decision recorded yet.`
  let reason = `chosen for ${routing.taskType}`
  const advice = task.advice
  if (advice?.complexity !== undefined) reason += `; Jev rated it ${desiredTier(advice.complexity, task.mode).tier} complexity`
  return `${base} — ${reason}.`
}

// Whether "Details" is expanded — reset whenever the selected task changes.
let routeDetailsOpen = false

function buildRouteSection(task: ProxyTask): HTMLElement {
  const body = element('div', 'inspector-route')
  body.append(element('p', 'inspector-route-sentence', routeSummarySentence(task)))
  const badge = advisorBadge(task)
  if (badge) { const row = element('div', 'inspector-route-badge-row'); row.append(badge); body.append(row) }

  const detailsToggle = element('button', 'text-button inspector-route-details-toggle', routeDetailsOpen ? 'Hide details' : 'Details') as HTMLButtonElement
  detailsToggle.type = 'button'
  const detailsBody = element('div', 'inspector-route-details')
  detailsBody.hidden = !routeDetailsOpen
  const advicePanel = buildAdvicePanel(task)
  if (advicePanel) { const card = element('section', 'route-card screen'); card.append(advicePanel); detailsBody.append(card) }
  const receiptCard = element('section', 'route-card screen')
  receiptCard.append(element('p', 'eyebrow', 'WHY THIS AGENT'), buildReceipt(task))
  detailsBody.append(receiptCard)
  detailsToggle.addEventListener('click', () => {
    routeDetailsOpen = !routeDetailsOpen
    detailsBody.hidden = !routeDetailsOpen
    detailsToggle.textContent = routeDetailsOpen ? 'Hide details' : 'Details'
  })
  body.append(detailsToggle, detailsBody)
  return body
}

// --- Inspector: Files changed section ---

function buildFilesSection(task: ProxyTask): HTMLElement {
  const changes = task.filesChanged ?? []
  if (!changes.length) return element('p', 'detail-empty', 'No files changed yet.')
  const list = element('div', 'inspector-file-list')
  for (const change of changes) {
    const row = element('button', 'inspector-file-row') as HTMLButtonElement
    row.type = 'button'
    row.append(
      element('span', `file-badge ${change.action}`, change.action === 'create' ? 'NEW' : change.action === 'delete' ? 'DEL' : 'EDIT'),
      element('span', 'inspector-file-path', change.path)
    )
    row.title = change.path
    row.addEventListener('click', () => openFileOverlay(task, change.path, row))
    list.append(row)
  }
  return list
}

// --- Inspector: Activity section ---

const ACTIVITY_ICON: Record<string, IconName> = { tool: 'tool', thinking: 'thinking', notice: 'notice' }

function buildActivitySection(task: ProxyTask): HTMLElement {
  const events = [...(task.activity ?? [])].reverse()
  if (!events.length) return element('p', 'detail-empty', 'No activity recorded.')
  const list = element('div', 'inspector-activity-list')
  for (const event of events) {
    const row = element('div', `detail-activity-row ${event.kind}`)
    const body = element('div')
    body.append(element('strong', undefined, event.label))
    if (event.detail) body.append(element('small', undefined, event.detail))
    row.append(icon(ACTIVITY_ICON[event.kind] ?? 'notice', 14), body)
    list.append(row)
  }
  return list
}

// --- Inspector: Context section ---

function buildContextSection(task: ProxyTask): HTMLElement {
  if (task.contextWindow === undefined || task.contextTokens === undefined) return element('p', 'detail-empty', 'No context data reported for this task yet.')
  const percent = Math.min(100, Math.max(0, (task.contextTokens / task.contextWindow) * 100))
  const wrap = element('div', 'inspector-context')
  const head = element('div', 'inspector-context-head')
  head.append(element('span', undefined, task.contextSource === 'estimated' ? 'Context window (estimated)' : 'Context window'), element('strong', 'readout', `${Math.round(percent)}%`))
  wrap.append(head, gaugeSeg(percent, percent >= 80 ? 'caution' : 'cyan', 'Context window occupancy'), element('p', 'inspector-context-detail', `${formatNumber(task.contextTokens)} of ${formatNumber(task.contextWindow)} tokens`))
  return wrap
}

// --- Inspector: Attempts / branch section ---

function buildAttemptsSection(task: ProxyTask): HTMLElement {
  const wrap = element('div', 'inspector-attempts')
  if (!task.attempts.length) wrap.append(element('p', 'detail-empty', 'No agent has been launched yet.'))
  else for (const attempt of task.attempts) {
    const row = element('div', `detail-route-row ${attempt.status}`)
    const body = element('div')
    body.append(element('strong', undefined, providerName(attempt.providerId)), element('small', undefined, `${attempt.status} · ${timeAgo(attempt.startedAt)}`))
    row.append(element('span', 'timeline-dot'), body)
    if (attempt.error) row.title = attempt.error
    wrap.append(row)
  }
  const branches = (task.subtasks ?? []).filter((lane) => lane.branch)
  if (branches.length) {
    wrap.append(element('p', 'eyebrow route-card-second', 'BRANCHES'))
    const list = element('div', 'inspector-branch-list')
    for (const lane of branches) {
      const item = element('div', 'inspector-branch-item')
      const row = element('button', 'lane-branch') as HTMLButtonElement
      row.type = 'button'
      row.append(icon('branch', 14), document.createTextNode(lane.committed ? ` ${lane.branch}` : ` ${lane.branch} · no changes`))
      row.disabled = !lane.committed
      row.title = lane.committed ? 'Open this branch in Review' : 'Isolated branch; nothing was changed'
      row.addEventListener('click', () => openBranchInReview(task.cwd, lane.branch!))
      item.append(row)
      const verificationBadge = verificationChip(lane.verification)
      if (verificationBadge) item.append(verificationBadge)
      list.append(item)
    }
    wrap.append(list)
  }
  return wrap
}

// --- Inspector shell ---

// Per-section open state persists across re-renders (the sections rebuild on
// every snapshot) but is intentionally in-memory only, not per-task.
const inspectorSectionsOpen: Record<string, boolean> = { route: true, files: true, activity: false, context: true, attempts: false }
let lastInspectorSignature = ''

function inspectorSignature(task: ProxyTask): string {
  return [
    task.id, task.status, task.model, task.routing?.chosenProviderId, task.advice?.source,
    task.activity?.length ?? 0, task.filesChanged?.length ?? 0, task.contextTokens, task.contextWindow,
    task.attempts.length, task.subtasks?.map((lane) => `${lane.branch ?? ''}:${lane.committed}`).join(','),
    routeDetailsOpen
  ].join('|')
}

function renderInspector(task: ProxyTask | undefined): void {
  const container = byId('inspector-body')
  if (!task) {
    lastInspectorSignature = ''
    container.replaceChildren(emptyState('Nothing selected', 'Choose a task to see its route, files, and activity.'))
    return
  }
  const signature = inspectorSignature(task)
  if (signature === lastInspectorSignature) return
  lastInspectorSignature = signature

  const filesChanged = task.filesChanged ?? []
  container.replaceChildren(
    inspectorSection('route', 'Route', buildRouteSection(task), { open: inspectorSectionsOpen.route, onToggle: (open) => { inspectorSectionsOpen.route = open } }),
    inspectorSection('files', 'Files changed', buildFilesSection(task), {
      open: inspectorSectionsOpen.files,
      badge: filesChanged.length ? chip('cyan', String(filesChanged.length)) : undefined,
      onToggle: (open) => { inspectorSectionsOpen.files = open }
    }),
    inspectorSection('activity', 'Activity', buildActivitySection(task), { open: inspectorSectionsOpen.activity, onToggle: (open) => { inspectorSectionsOpen.activity = open } }),
    inspectorSection('context', 'Context', buildContextSection(task), { open: inspectorSectionsOpen.context, onToggle: (open) => { inspectorSectionsOpen.context = open } }),
    inspectorSection('attempts', 'Attempts / branch', buildAttemptsSection(task), { open: inspectorSectionsOpen.attempts, onToggle: (open) => { inspectorSectionsOpen.attempts = open } })
  )
}

// --- File viewer overlay (the former Files tab, as a focused dialog) ---

const fileOverlay = dialogHandle(byId<HTMLDialogElement>('task-file-overlay'))
let overlayFilePath: string | undefined
let overlayFileMode: 'diff' | 'source' = 'diff'
let overlayFileState: { taskId: string; path: string; version: string; file: TaskFileContent } | undefined
let overlayFileRequest = 0
let overlayFileLoadingKey: string | undefined
let overlayWorkspaceState: { taskId: string; version: string; workspace: TaskWorkspaceSnapshot } | undefined
let overlayWorkspaceLoadingKey: string | undefined
// A project tree is thousands of rows, so folders start collapsed and only the
// branches holding this task's changes (and the open file) are revealed.
let overlayTreeTaskId: string | undefined
let overlayTreeRevealed: string | undefined
let overlayOpenFolders = new Set<string>()

function ancestorFolders(path = ''): string[] {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
}

function renderOverlayFileViewer(file?: TaskFileContent): void {
  const title = byId('overlay-file-title')
  const language = byId('overlay-file-language')
  const notice = byId('overlay-file-notice')
  const code = byId('overlay-file-code')
  const modes = byId('overlay-file-mode')
  modes.hidden = !file
  modes.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    const isDiff = button.dataset.fileMode === 'diff'
    button.disabled = isDiff && !file?.diff.trim()
    button.classList.toggle('active', button.dataset.fileMode === overlayFileMode)
  })
  if (!file) {
    title.textContent = 'Select a file'; language.textContent = 'SOURCE'
    notice.hidden = false; notice.textContent = 'Choose any project file. Changed files are marked in the tree.'
    code.replaceChildren(); return
  }
  title.textContent = file.relativePath; language.textContent = file.language.toUpperCase()
  if (file.binary) { notice.hidden = false; notice.textContent = 'Binary files cannot be displayed.'; code.replaceChildren(); return }
  if (!file.exists && overlayFileMode === 'source') { notice.hidden = false; notice.textContent = 'This file no longer exists in the task workspace.'; code.replaceChildren(); return }
  if (file.truncated && overlayFileMode === 'source') { notice.hidden = false; notice.textContent = 'Large file: showing the first 1 MB.' } else notice.hidden = true

  if (overlayFileMode === 'diff') {
    if (!file.diff.trim()) { notice.hidden = false; notice.textContent = 'No working-tree diff is available. The change may already be committed.'; code.replaceChildren(); return }
    renderDiffInto(code, file.diff, file.language)
  } else {
    code.replaceChildren(...file.content.replace(/\r\n/g, '\n').split('\n').map((line, index) => codeLine(undefined, index + 1, '', line, 'source', file.language)))
  }
}

async function loadOverlayFile(task: ProxyTask, path: string, version: string): Promise<void> {
  const key = `${task.id}:${path}:${version}`
  if (overlayFileState?.taskId === task.id && overlayFileState.path === path && overlayFileState.version === version) {
    renderOverlayFileViewer(overlayFileState.file); return
  }
  if (overlayFileLoadingKey === key) return
  overlayFileLoadingKey = key
  const request = ++overlayFileRequest
  const notice = byId('overlay-file-notice'); notice.hidden = false; notice.textContent = 'Loading file…'
  byId('overlay-file-code').replaceChildren()
  try {
    const file = await window.frontier.readTaskFile(task.id, path)
    if (request !== overlayFileRequest || overlayFilePath !== path) return
    overlayFileState = { taskId: task.id, path, version, file }
    renderOverlayFileViewer(file)
  } catch (error) {
    if (request !== overlayFileRequest) return
    notice.hidden = false; notice.textContent = errorMessage(error)
  } finally { if (overlayFileLoadingKey === key) overlayFileLoadingKey = undefined }
}

function taskWorkspaceVersion(task: ProxyTask): string {
  return (task.filesChanged ?? []).map((change) => `${change.path}:${change.action}:${change.at}`).join('|')
}

async function loadOverlayWorkspace(task: ProxyTask, version: string): Promise<void> {
  const key = `${task.id}:${version}`
  if (overlayWorkspaceLoadingKey === key) return
  overlayWorkspaceLoadingKey = key
  try {
    const workspace = await window.frontier.getTaskWorkspace(task.id)
    if (!fileOverlay.el.open || taskWorkspaceVersion(task) !== version) return
    overlayWorkspaceState = { taskId: task.id, version, workspace }
    renderOverlayFilesTab(task)
  } catch (error) {
    if (fileOverlay.el.open) byId('overlay-file-list').replaceChildren(element('div', 'detail-empty', errorMessage(error)))
  } finally { if (overlayWorkspaceLoadingKey === key) overlayWorkspaceLoadingKey = undefined }
}

function renderOverlayFilesTab(task: ProxyTask): void {
  const version = taskWorkspaceVersion(task)
  const loaded = overlayWorkspaceState?.taskId === task.id && overlayWorkspaceState.version === version ? overlayWorkspaceState.workspace : undefined
  if (!loaded) {
    byId('overlay-file-list').replaceChildren(element('div', 'detail-empty', 'Loading project files…'))
    renderOverlayFileViewer()
    void loadOverlayWorkspace(task, version)
    return
  }
  const changes = loaded.changes
  const list = byId('overlay-file-list')
  byId('overlay-file-sidebar-summary').textContent = `${loaded.entries.filter((entry) => entry.kind === 'file').length} files · ${changes.length} changed`

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
    overlayFilePath = undefined; renderOverlayFileViewer(); return
  }
  const changeByPath = new Map(changes.map((change) => [change.path, change]))
  if (!overlayFilePath || !entries.has(overlayFilePath) || entries.get(overlayFilePath)?.kind !== 'file') {
    overlayFilePath = changes[0]?.path ?? files[0].path
  }
  // Folders a changed file lives in are worth counting even when collapsed.
  const changedInFolder = new Map<string, number>()
  for (const change of changes) for (const folder of ancestorFolders(change.path)) changedInFolder.set(folder, (changedInFolder.get(folder) ?? 0) + 1)
  if (overlayTreeTaskId !== task.id) {
    overlayTreeTaskId = task.id
    overlayTreeRevealed = undefined
    overlayOpenFolders = new Set(changes.flatMap((change) => ancestorFolders(change.path)))
  }
  // Reveal a newly selected file once; re-revealing every render would make the
  // folder holding the open file impossible to collapse.
  if (overlayTreeRevealed !== overlayFilePath) {
    overlayTreeRevealed = overlayFilePath
    for (const folder of ancestorFolders(overlayFilePath)) overlayOpenFolders.add(folder)
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
        const open = overlayOpenFolders.has(entry.path)
        const folder = element('button', `task-detail-folder ${open ? 'open' : ''}`)
        folder.style.setProperty('--tree-depth', String(depth))
        folder.setAttribute('aria-expanded', String(open))
        const caret = element('span', 'tree-caret'); caret.append(icon(open ? 'chevron-down' : 'chevron-right', 14))
        folder.append(caret, element('strong', undefined, entry.name))
        const changed = changedInFolder.get(entry.path)
        if (changed) folder.append(element('small', 'tree-changed-count', String(changed)))
        folder.addEventListener('click', () => {
          if (open) overlayOpenFolders.delete(entry.path); else overlayOpenFolders.add(entry.path)
          renderOverlayFilesTab(task)
        })
        rows.push(folder)
        if (open) appendRows(entry.path, depth + 1)
        continue
      }
      const change = changeByPath.get(entry.path)
      const button = element('button', `task-detail-file ${change ? 'changed' : ''} ${entry.path === overlayFilePath ? 'active' : ''}`)
      button.style.setProperty('--tree-depth', String(depth))
      const badge = change
        ? element('span', `file-badge ${change.action}`, change.action === 'create' ? 'NEW' : change.action === 'delete' ? 'DEL' : 'EDIT')
        : element('span', 'file-tree-icon', '·')
      const body = element('span')
      body.append(element('strong', undefined, entry.name))
      button.append(badge, body)
      button.title = entry.path
      button.addEventListener('click', () => {
        overlayFilePath = entry.path; overlayFileMode = change ? 'diff' : 'source'; overlayFileState = undefined; renderOverlayFilesTab(task)
      })
      rows.push(button)
    }
  }
  appendRows('', 0)
  list.replaceChildren(...rows)
  const selectedChange = changes.find((change) => change.path === overlayFilePath)
  if (!selectedChange && overlayFileMode === 'diff') overlayFileMode = 'source'
  if (overlayFilePath) void loadOverlayFile(task, overlayFilePath, selectedChange?.at ?? (version || 'workspace'))
}

function openFileOverlay(task: ProxyTask, path: string, trigger?: HTMLElement): void {
  byId('overlay-file-task-title').textContent = task.prompt
  if (overlayTreeTaskId !== task.id) { overlayWorkspaceState = undefined }
  overlayFilePath = path
  overlayFileMode = task.filesChanged?.some((change) => change.path === path) ? 'diff' : 'source'
  overlayFileState = undefined
  renderOverlayFilesTab(task)
  fileOverlay.open(trigger)
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
      setSelectedTaskId(created.id)
    } catch (error) { reportError('Could not re-run this task', error) }
  })
  controls.append(retry)
  target.replaceChildren(controls)
}

export function renderSurface(): void {
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
    renderInspector(undefined)
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
  renderInspector(task)

  // A comparison has no single conversation to continue.
  composer.hidden = Boolean(task.bench) && !taskIsBusy(task)
  if (!composer.hidden) renderComposerState(task, byId<HTMLTextAreaElement>('composer-input'), byId<HTMLButtonElement>('composer-send'))
}

export function openTask(taskId: string): void {
  setSelectedTaskId(taskId)
  overlayFilePath = undefined
  overlayFileState = undefined
  overlayWorkspaceState = undefined
  overlayFileRequest += 1
  routeDetailsOpen = false
  lastInspectorSignature = ''
  switchView('tasks')
  renderTasks()
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

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

export function initTasksView(): void {
  onProjectChange(() => { if (typeof snapshot !== 'undefined') renderTasks() })

  byId('surface-focus').addEventListener('click', () => {
    focusMode = !focusMode
    byId('content-grid').classList.toggle('focus-mode', focusMode)
    const button = byId<HTMLButtonElement>('surface-focus')
    button.setAttribute('aria-pressed', String(focusMode))
    button.replaceChildren(icon(focusMode ? 'collapse' : 'expand', 16))
    button.title = focusMode ? 'Show the queue' : 'Focus this task'
  })

  byId('inspector-toggle').addEventListener('click', () => toggleInspector())

  // Task list keyboard navigation: ↑/↓ move the selection, Enter opens it.
  byId('task-list').addEventListener('keydown', (event) => {
    const scoped = snapshot.tasks.filter((task) => projectMatches(task.cwd))
    const order = orderedVisibleTasks(scoped)
    if (!order.length) return
    const currentIndex = order.findIndex((task) => task.id === selectedTaskId)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const next = order[Math.min(order.length - 1, currentIndex + 1)] ?? order[0]
      setSelectedTaskId(next.id); renderTasks()
      byId('task-list').querySelector(`[data-task-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      const prev = order[Math.max(0, currentIndex - 1)] ?? order[0]
      setSelectedTaskId(prev.id); renderTasks()
      byId('task-list').querySelector(`[data-task-id="${prev.id}"]`)?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'Enter' && selectedTaskId) {
      event.preventDefault(); openTask(selectedTaskId)
    }
  })

  // `[`/`]` collapse and expand the list and the inspector — but never while
  // typing in a field or with a dialog open (the file overlay uses Esc too).
  window.addEventListener('keydown', (event) => {
    if (currentView !== 'tasks') return
    if (isEditableTarget(event.target) || document.querySelector('dialog[open]')) return
    if (event.key === '[') { event.preventDefault(); toggleTaskList() }
    else if (event.key === ']') { event.preventDefault(); toggleInspector() }
  })

  byId('file-overlay-close').addEventListener('click', () => fileOverlay.close())
  byId('overlay-file-mode').querySelectorAll<HTMLElement>('button').forEach((button) => button.addEventListener('click', () => {
    overlayFileMode = button.dataset.fileMode === 'source' ? 'source' : 'diff'
    renderOverlayFileViewer(overlayFileState?.file)
  }))

  byId<HTMLInputElement>('task-search').addEventListener('input', (event) => {
    taskQuery = (event.target as HTMLInputElement).value.trim().toLowerCase()
    renderTasks()
  })
  byId('clear-finished').addEventListener('click', () => void window.frontier.clearFinishedTasks())

  byId('composer-send').addEventListener('click', () => void handleComposerAction())
  byId<HTMLTextAreaElement>('composer-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void handleComposerAction() }
  })

  byId('list-toggle').addEventListener('click', () => toggleTaskList())
  applyInspectorState()

  // How much column width the *other* side panel currently reserves
  // (itself plus its own gutter), so dragging one gutter accounts for the
  // other rather than assuming a fixed constant for it. 0 while that panel
  // is collapsed or floating as an overlay — neither takes grid column space.
  const grid = byId('content-grid')
  const listColumnSpace = (): number => (grid.classList.contains('list-collapsed') ? 0 : (queueWidth ?? QUEUE_DEFAULT_WIDTH) + GUTTER_WIDTH)
  const inspectorColumnSpace = (): number => (grid.classList.contains('inspector-collapsed') ? 0 : (inspectorWidth ?? INSPECTOR_DEFAULT_WIDTH) + GUTTER_WIDTH)

  // Draggable divider between the queue and the task surface.
  ;(function setupResizer(): void {
    const gutter = byId('grid-gutter')
    let dragging = false

    // Clamp the queue column so the task surface always keeps its 420px floor,
    // accounting for whatever the inspector currently reserves too. On a narrow
    // window the upper bound can fall below the lower one; that range is unusable,
    // and a naive `Math.min(Math.max(...))` would silently return a width under
    // the minimum — sometimes zero or negative. Because the result is persisted,
    // one drag in a small window would collapse the queue on every later launch.
    // An unusable range now falls back to the stylesheet's own default column.
    const clampQueueWidth = (width: number): number | undefined => {
      const available = grid.getBoundingClientRect().width
      const widest = available - GUTTER_WIDTH - inspectorColumnSpace() - SURFACE_MIN_WIDTH
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
      else { grid.style.setProperty('--wq-col', `${clamped}px`); queueWidth = clamped }
    }

    // A stored width from before this pane's rules changed is reclamped the
    // moment it is next applied (`applyQueueWidth`/`clampQueueWidth` above),
    // never taken at face value.
    const stored = Number(readLS('fp-wq-width'))
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
      if (clamped === undefined) removeLS('fp-wq-width')
      else writeLS('fp-wq-width', String(clamped))
    })
    // Shrinking the window can invalidate a width that used to fit.
    window.addEventListener('resize', () => { if (currentView === 'tasks') { applyQueueWidth(); applyInspectorState() } })
  })()

  // Draggable divider between the surface and the inspector — same pattern,
  // mirrored to measure from the grid's right edge.
  ;(function setupInspectorResizer(): void {
    const gutter = byId('inspector-gutter')
    let dragging = false

    const clampInspectorWidth = (width: number): number | undefined => {
      const available = grid.getBoundingClientRect().width
      const widest = available - GUTTER_WIDTH - listColumnSpace() - SURFACE_MIN_WIDTH
      if (!Number.isFinite(width) || width <= 0 || widest < INSPECTOR_MIN_WIDTH) return undefined
      return Math.round(Math.min(Math.max(INSPECTOR_MIN_WIDTH, width), widest))
    }

    applyInspectorWidth = (): void => {
      const clamped = inspectorWidth === undefined ? undefined : clampInspectorWidth(inspectorWidth)
      if (clamped === undefined) grid.style.removeProperty('--insp-col')
      else { grid.style.setProperty('--insp-col', `${clamped}px`); inspectorWidth = clamped }
    }

    const stored = Number(readLS('fp-inspector-width'))
    inspectorWidth = Number.isFinite(stored) && stored > 0 ? stored : undefined

    gutter.addEventListener('mousedown', (event) => { dragging = true; gutter.classList.add('dragging'); document.body.style.userSelect = 'none'; event.preventDefault() })
    window.addEventListener('mousemove', (event) => {
      if (!dragging) return
      const rect = grid.getBoundingClientRect()
      const clamped = clampInspectorWidth(rect.right - event.clientX)
      if (clamped === undefined) return
      inspectorWidth = clamped
      applyInspectorWidth()
    })
    window.addEventListener('mouseup', () => {
      if (!dragging) return
      dragging = false; gutter.classList.remove('dragging'); document.body.style.userSelect = ''
      const clamped = inspectorWidth === undefined ? undefined : clampInspectorWidth(inspectorWidth)
      if (clamped === undefined) removeLS('fp-inspector-width')
      else writeLS('fp-inspector-width', String(clamped))
    })
    window.addEventListener('resize', () => { if (currentView === 'tasks') { applyInspectorWidth(); applyInspectorState() } })
  })()
}
