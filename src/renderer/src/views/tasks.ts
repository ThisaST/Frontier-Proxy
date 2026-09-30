// Tasks — three panes: the work queue (grouped by status), the centre pane,
// and a collapsible route/files/activity inspector. The centre pane is either
// the composer (compose state, views/compose.ts; it replaced Home in P4) or one
// task's conversation, never neither (nav.ts, nextTaskSurface). The old Files
// tab lives on in the file-viewer overlay, opened from "Files changed".
import type { ChatContextItem, ConversationTurn, ProxyTask, RoutingCandidate, RoutingFactor, SubTask, TaskFileContent, TaskWorkspaceSnapshot, WorkspaceEntry } from '../../../shared/types'
import { renderMarkdown } from '../markdown'
import { byId, codeLine, element, emptyState, renderDiffInto } from '../ui/dom'
import { dialogHandle, inspectorSection, meterRow, status, tag, type MeterTone, type StatusTone } from '../ui/components'
import { icon, type IconName } from '../ui/icons'
import { errorMessage, reportError, showToast } from '../ui/feedback'
import { baseName, formatCost, formatDuration, formatNumber, timeAgo } from '../ui/format'
import { providerName, providerSelectableForTask } from '../providers-view-model'
import { queueGroups, taskElapsed, taskIsBusy, taskKindLabel, taskNeedsReview, taskStatusIndicator, taskTokens, verificationChip, type TaskGroupId } from '../task-helpers'
import { snapshot, selectedTaskId, applyTaskSurface, composing, currentView } from '../state'
import { attachmentPreviewCache, composerDraft, messageContext, clearComposerDraft, renderDraftImages } from '../composer'
import { persistControlPlaneDraft } from '../views/control'
import { currentProject, onProjectChange, projectMatches } from '../project'
import { openBranchInReview, switchView } from '../main'
import { renderCompose } from './compose'
import { desiredTier, tierFor } from '../../../shared/model-profiles'

function readLS(key: string): string | undefined { try { return localStorage.getItem(key) ?? undefined } catch { return undefined } }
function writeLS(key: string, value: string): void { try { localStorage.setItem(key, value) } catch { /* private mode / disabled storage */ } }
function removeLS(key: string): void { try { localStorage.removeItem(key) } catch { /* private mode / disabled storage */ } }

let taskQuery = ''
let focusMode = false

// --- Work queue ---

const GROUP_COLLAPSE_KEY = 'fp-task-groups-collapsed'
function loadCollapsedGroups(): Set<TaskGroupId> {
  try { const raw = readLS(GROUP_COLLAPSE_KEY); return raw ? new Set(JSON.parse(raw) as TaskGroupId[]) : new Set() } catch { return new Set() }
}
let collapsedGroups = loadCollapsedGroups()

function scopedTasks(): ProxyTask[] { return snapshot.tasks.filter((task) => projectMatches(task.cwd)) }

// Keyboard order: the rows actually on screen, group by group.
function orderedVisibleTasks(scoped: ProxyTask[]): ProxyTask[] {
  return queueGroups(scoped, taskQuery, providerName).filter((group) => !collapsedGroups.has(group.id)).flatMap((group) => group.tasks)
}

// A comparison has no single agent; everything else names the one that ran (or is routing).
function taskAgentLabel(task: ProxyTask): string {
  return task.bench ? `Compare · ${task.subtasks?.length ?? 0} agents` : providerName(task.selectedProviderId)
}

function selectTask(taskId: string): void {
  applyTaskSurface({ kind: 'select', taskId })
  renderTasks()
}

function taskRow(task: ProxyTask): HTMLElement {
  const selected = !composing && task.id === selectedTaskId
  const row = element('div', 'task-row row')
  row.id = `task-row-${task.id}`
  row.dataset.taskId = task.id
  row.setAttribute('role', 'option')
  row.setAttribute('aria-selected', String(selected))
  const files = task.filesChanged?.length ?? 0
  const main = element('div', 'row-main')
  main.append(
    element('div', 'task-title', task.prompt),
    element('div', 'task-meta', [taskAgentLabel(task), timeAgo(task.createdAt), files ? `${files} file${files === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '))
  )
  row.append(taskStatusIndicator(task.status, { needsReview: taskNeedsReview(task) }), main)
  row.addEventListener('click', () => {
    // A queue floating over a narrow window has done its job once a row is clicked.
    if (listOverlayOpen) { listOverlayOpen = false; applyInspectorState() }
    selectTask(task.id)
  })
  return row
}

function renderQueue(scoped: ProxyTask[]): void {
  const container = byId('task-list')
  if (!scoped.length) {
    container.replaceChildren(currentProject
      ? emptyState('No tasks in this project', 'Start one in the composer, or pick another project in the header.')
      : emptyState('The queue is clear', 'Start a task and Frontier picks the best available agent.'))
    return
  }
  const groups = queueGroups(scoped, taskQuery, providerName).filter((group) => group.tasks.length)
  if (!groups.length) { container.replaceChildren(emptyState('No matching tasks', `Nothing matches “${taskQuery}”.`)); return }

  const fragment = document.createDocumentFragment()
  for (const group of groups) {
    const collapsed = collapsedGroups.has(group.id)
    const section = element('div', `task-group${collapsed ? ' collapsed' : ''}`)
    section.setAttribute('role', 'group')
    const headerId = `task-group-head-${group.id}`
    section.setAttribute('aria-labelledby', headerId)
    const header = element('button', 'task-group-head') as HTMLButtonElement
    header.type = 'button'
    header.id = headerId
    header.setAttribute('aria-expanded', String(!collapsed))
    const caret = element('span', 'task-group-caret'); caret.append(icon('chevron-down', 14))
    header.append(caret, element('span', 'section-title task-group-label', group.label), element('span', 'task-group-count', String(group.tasks.length)))
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
      for (const task of group.tasks) rows.append(taskRow(task))
      section.append(rows)
    }
    fragment.append(section)
  }
  container.replaceChildren(fragment)
}

let lastComposing: boolean | undefined

export function renderTasks(): void {
  const scoped = scopedTasks()
  // A selection that left scope falls back to compose; compose never picks a task by itself.
  applyTaskSurface({ kind: 'reconcile', taskIds: scoped.map((task) => task.id) })
  renderQueue(scoped)
  byId('compose-pane').hidden = !composing
  byId('conversation-pane').hidden = composing
  if (lastComposing !== composing) {
    lastComposing = composing
    byId('content-grid').classList.toggle('composing', composing)
    if (currentView === 'tasks') { applyQueueWidth(); applyInspectorWidth(); applyInspectorState() }
  }
  if (composing) { renderCompose(); resetSurfaceCaches() } else renderSurface()
}

// --- Left/right pane collapse, widths ---

// The centre is the primary surface, so it gets a hard floor neither drag
// gutter may squeeze past; the queue and inspector default to the
// `--queue-w` / `--inspector-w` tokens (compact density narrows both).
// GUTTER_WIDTH mirrors the stylesheet's own track size for `.content-grid`;
// a width clamped against a different number would overflow the grid.
const QUEUE_MIN_WIDTH = 220
const SURFACE_MIN_WIDTH = 420
const INSPECTOR_MIN_WIDTH = 240
// Below this, the inspector auto-collapses rather than letting the centre
// shrink further — softer than SURFACE_MIN_WIDTH, which is the absolute
// floor a drag can never cross.
const CENTRE_AUTO_COLLAPSE_WIDTH = 480
const GUTTER_WIDTH = 12
function tokenPx(name: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name))
  return Number.isFinite(value) && value > 0 ? value : fallback
}
const queueDefaultWidth = (): number => tokenPx('--queue-w', 300)
const inspectorDefaultWidth = (): number => tokenPx('--inspector-w', 320)
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

function syncToggle(button: HTMLButtonElement, visible: boolean, auto: boolean, noun: string, shown: IconName, hidden: IconName): void {
  button.setAttribute('aria-pressed', String(visible))
  button.setAttribute('aria-expanded', String(visible))
  button.title = visible ? (auto ? `Hide ${noun}` : `Collapse ${noun}`) : (auto ? `Show ${noun}` : `Expand ${noun}`)
  button.setAttribute('aria-label', button.title)
  button.replaceChildren(icon(visible ? shown : hidden, 16))
}

// Drives both side panels' collapse/overlay state from the grid's real,
// laid-out width — never a fixed viewport breakpoint. The grid sits inside
// `main`, which already pads itself clear of the dock, so the measurement
// absorbs the dock wherever it is. The inspector (softer, secondary panel)
// gives way first, once the centre would drop under its comfortable width;
// the list only auto-collapses once even a collapsed inspector leaves no room
// for the centre's hard 420px floor. In compose state there is no inspector.
// Named `applyInspectorState` for the existing exported call sites (main.ts,
// resize handlers) — it owns the list too because the two decisions are coupled.
export function applyInspectorState(): void {
  const grid = byId('content-grid')
  const available = grid.getBoundingClientRect().width
  const inspectorSpaceFull = (inspectorWidth ?? inspectorDefaultWidth()) + GUTTER_WIDTH
  const listSpaceFull = (queueWidth ?? queueDefaultWidth()) + GUTTER_WIDTH

  // Only a real, laid-out measurement counts — the grid reports 0 while the
  // Tasks view is hidden, which must never look like "too narrow to fit".
  const autoCollapse = available > 0 && (available - listSpaceFull - inspectorSpaceFull) < CENTRE_AUTO_COLLAPSE_WIDTH
  lastAutoCollapse = autoCollapse
  const collapsed = inspectorCollapsedManual || autoCollapse
  const overlay = autoCollapse && !inspectorCollapsedManual && inspectorOverlayOpen && !composing
  const inspectorGridSpace = collapsed || composing ? 0 : inspectorSpaceFull

  const autoCollapseList = available > 0 && (available - inspectorGridSpace - listSpaceFull) < SURFACE_MIN_WIDTH
  lastListAutoCollapse = autoCollapseList
  const listCollapsedNow = listCollapsedManual || autoCollapseList
  const listOverlay = autoCollapseList && !listCollapsedManual && listOverlayOpen

  grid.classList.toggle('inspector-collapsed', collapsed)
  grid.classList.toggle('inspector-overlay-open', overlay)
  grid.classList.toggle('list-collapsed', listCollapsedNow)
  grid.classList.toggle('list-overlay-open', listOverlay)

  syncToggle(byId<HTMLButtonElement>('inspector-toggle'), !collapsed || overlay, autoCollapse, 'inspector', 'panel-right-close', 'panel-right')
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-pane-toggle="list"]')) syncToggle(button, !listCollapsedNow || listOverlay, autoCollapseList, 'queue', 'panel-left', 'panel-left')
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

// --- Conversation header: title, status and one mono meta line ---

function renderSurfaceMeta(task: ProxyTask): void {
  const meta = byId('surface-meta')
  const tokens = taskTokens(task)
  const parts = [
    taskAgentLabel(task),
    task.model,
    `${formatNumber(tokens.input)} in · ${formatNumber(tokens.output)} out${tokens.estimated ? ' (est.)' : ''}`,
    taskElapsed(task)
  ]
  if (task.contextWindow && task.contextTokens !== undefined) {
    const percent = Math.min(100, Math.max(0, (task.contextTokens / task.contextWindow) * 100))
    parts.push(`${Math.round(percent)}% ctx${task.contextSource === 'estimated' ? ' (est.)' : ''}`)
  }
  if (task.usageCostUsd) parts.push(formatCost(task.usageCostUsd))
  meta.textContent = parts.filter(Boolean).join(' · ')
  meta.title = `${taskKindLabel(task)} · ${task.type} · ${task.cwd}`
  byId('surface-status').replaceChildren(taskStatusIndicator(task.status, { needsReview: taskNeedsReview(task), withText: true }))
}

const ORCH_STAGES = ['planning', 'delegating', 'synthesizing', 'done'] as const

// One line of plain text; the current stage reads in --fg.
function renderSurfaceStages(task: ProxyTask): void {
  const container = byId('surface-stages')
  if (!task.orchestrated) { container.replaceChildren(); return }
  const stageIndex = ORCH_STAGES.indexOf(task.orchestrationStage ?? 'planning')
  const line = element('p', 'stage-line')
  line.setAttribute('aria-label', `Stage: ${ORCH_STAGES[stageIndex]}`)
  ORCH_STAGES.forEach((name, index) => {
    if (index > 0) line.append(element('span', 'stage-sep', '→'))
    const step = element('span', `stage-step${index === stageIndex ? ' active' : index < stageIndex ? ' past' : ''}`, name.charAt(0).toUpperCase() + name.slice(1))
    if (index === stageIndex) step.setAttribute('aria-current', 'step')
    line.append(step)
  })
  container.replaceChildren(line)
}

// --- Thread ---

function branchButton(cwd: string, lane: SubTask): HTMLButtonElement {
  const button = element('button', 'btn btn-ghost btn-sm lane-branch') as HTMLButtonElement
  button.type = 'button'
  button.append(icon('branch', 14), element('span', 'lane-branch-name', lane.committed ? lane.branch! : `${lane.branch} · no changes`))
  button.title = lane.committed ? 'Open this branch in Review' : 'Isolated branch; nothing was changed'
  button.disabled = !lane.committed
  button.addEventListener('click', () => openBranchInReview(cwd, lane.branch!))
  return button
}

function laneCard(task: ProxyTask, lane: SubTask, columns: boolean): HTMLElement {
  const card = element('article', `card lane ${lane.status}${columns ? ' lane-column' : ''}`)
  const head = element('div', 'lane-head')
  head.append(taskStatusIndicator(lane.status), element('strong', 'lane-title', lane.title))
  card.append(head)
  const who = [lane.providerId ? providerName(lane.providerId) : undefined, lane.model].filter(Boolean).join(' · ')
  if (who) card.append(element('p', 'lane-meta', who))

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
    if (measures.length) score.append(element('span', 'lane-measures', measures.join(' · ')))
    if (verificationBadge) score.append(verificationBadge)
    card.append(score)
  }
  if (lane.branch) card.append(branchButton(task.cwd, lane))

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

  const inner = element('div', 'thread-inner')

  // A comparison is read side by side, not as a transcript.
  if (task.bench) {
    inner.classList.add('wide')
    inner.append(element('p', 'lane-note', 'The same prompt ran on each agent, each on its own isolated branch.'))
    const columns = element('div', 'lane-columns')
    for (const lane of lanes) columns.append(laneCard(task, lane, true))
    inner.append(columns)
    if (task.output.trim() && !streaming) { const summary = element('div', 'turn-body markdown'); summary.append(renderMarkdown(task.output)); inner.append(summary) }
    if (task.error) inner.append(element('div', 'output-error', task.error))
    thread.replaceChildren(inner)
    if (streaming || atBottom) thread.scrollTop = thread.scrollHeight
    return
  }

  const turns: ConversationTurn[] = task.turns?.length ? task.turns : [
    { id: 'legacy-user', role: 'user', content: task.prompt, at: task.createdAt },
    ...(task.output || task.error ? [{ id: 'legacy-assistant', role: 'assistant' as const, content: task.output, providerId: task.selectedProviderId, model: task.model, status: task.status, at: task.finishedAt ?? task.createdAt }] : [])
  ]
  turns.forEach((turn, index) => {
    const live = streaming && turn.role === 'assistant' && index === turns.length - 1
    const content = live ? task.output : turn.content
    if (turn.role === 'user') {
      const bubble = element('article', 'turn turn-user')
      const body = element('div', 'turn-body', content)
      appendTurnAttachments(task.id, body, turn.attachments)
      bubble.append(body, element('span', 'turn-when', timeAgo(turn.at)))
      inner.append(bubble)
    } else {
      const block = element('article', 'turn turn-assistant')
      const who = element('div', 'turn-who')
      who.append(element('span', 'turn-agent', providerName(turn.providerId)), element('span', 'turn-detail', [turn.model, live ? 'running' : turn.status, timeAgo(turn.at)].filter(Boolean).join(' · ')))
      const body = element('div', 'turn-body markdown')
      if (live) { body.textContent = content || 'Working…'; body.classList.add('live') }
      else if (content.trim()) body.appendChild(renderMarkdown(content))
      else body.textContent = turn.status === 'failed' ? (task.error ?? 'Failed.') : '—'
      block.append(who, body)
      inner.append(block)
    }

    // Subtasks belong with the assistant turn that produced them.
    if (task.orchestrated && lanes.length && index === turns.length - 1) {
      const group = element('div', 'lane-stack')
      group.append(element('p', 'lane-note', `${lanes.length} subtask${lanes.length === 1 ? '' : 's'}, each on its own isolated branch.`))
      for (const lane of lanes) group.append(laneCard(task, lane, false))
      inner.append(group)
    }
  })
  if (task.error && !streaming) inner.append(element('div', 'output-error', task.error))
  thread.replaceChildren(inner)
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

const sub = (text: string): HTMLElement => element('p', 'inspector-sub', text)
const note = (text: string): HTMLElement => element('p', 'inspector-note', text)
const percentText = (value: number): string => `${Math.round(value * 100)}%`

// Routing factors are bounded (CLAUDE.md's routing sections), but a configured priority can
// outscore the ±20 advisor factors, so each candidate's bars share that candidate's own scale.
function factorRows(factors: RoutingFactor[]): HTMLElement {
  const wrap = element('div', 'inspector-meters')
  const scale = Math.max(20, ...factors.map((factor) => Math.abs(factor.points)))
  for (const factor of factors) {
    const tone: MeterTone = factor.points < 0 ? 'warn' : 'accent'
    wrap.append(meterRow(factor.label, (Math.abs(factor.points) / scale) * 100, `${factor.points > 0 ? '+' : factor.points < 0 ? '−' : ''}${Math.abs(Math.round(factor.points))}`, tone))
  }
  return wrap
}

// Probabilities (0..1) as meter rows, strongest first; only the leader is in the accent.
function probabilityRows(entries: Array<{ label: string; value: number }>, limit = 3): HTMLElement {
  const wrap = element('div', 'inspector-meters')
  entries.sort((left, right) => right.value - left.value).slice(0, limit)
    .forEach(({ label, value }, index) => wrap.append(meterRow(label, value * 100, percentText(value), index === 0 ? 'accent' : undefined)))
  return wrap
}

// Jev's `target` choice keys options as `providerId::model` (see
// `src/main/advisor.ts`); shown to the user as "Agent · model".
function targetLabel(key: string): string {
  const separator = key.indexOf('::')
  if (separator < 0) return key
  const model = key.slice(separator + 2)
  return `${providerName(key.slice(0, separator))}${model ? ` · ${model}` : ''}`
}

function signalStatus(label: string, value: number | undefined): HTMLElement {
  const tone: StatusTone = value === undefined ? 'neutral' : value >= 0.5 ? 'info' : 'neutral'
  return status(tone, `${label}${value !== undefined ? ` · ${percentText(value)}` : ' · not asked'}`)
}

// Jev's read (task type, complexity, signals, best fit), or the local rules' when Jev was off or
// unreachable. Nothing when the task never got a read (continuations, comparisons).
function buildAdviceBlock(task: ProxyTask): HTMLElement | undefined {
  const advice = task.advice
  if (!advice) return undefined
  const block = element('div', 'route-advice')
  const head = element('div', 'route-advice-head')
  if (advice.source === 'jev') {
    head.append(tag(advice.model ?? snapshot.settings.advisor.model))
    const meta = [advice.latencyMs !== undefined ? formatDuration(advice.latencyMs) : undefined, advice.inputTokens !== undefined ? `${formatNumber(advice.inputTokens)} tokens in` : undefined].filter(Boolean).join(' · ')
    if (meta) head.append(element('span', 'route-advice-meta', meta))
  } else {
    head.append(tag('Local rules'))
    if (advice.error) head.append(status('warn', `Jev unavailable: ${advice.error}`))
  }
  block.append(head)

  block.append(sub('Task type'))
  const type = element('p', 'route-advice-value')
  type.append(element('strong', undefined, advice.taskType))
  if (advice.taskTypeConfidence !== undefined) type.append(element('span', undefined, ` · ${percentText(advice.taskTypeConfidence)} confidence`))
  block.append(type)
  if (advice.taskTypeProbs) block.append(probabilityRows(Object.entries(advice.taskTypeProbs).map(([label, value]) => ({ label, value }))))
  if (advice.taskType !== advice.heuristicTaskType) block.append(note(`Local rules said ${advice.heuristicTaskType}.`))

  if (advice.complexity !== undefined) {
    const tier = desiredTier(advice.complexity, task.mode).tier
    block.append(sub('Complexity'), meterRow(`${tier} tier`, (advice.complexity / 3) * 100, advice.complexity.toFixed(1), 'accent'))
  }

  block.append(sub('Signals'))
  const signals = element('div', 'route-signals')
  signals.append(signalStatus('Edits files', advice.editsFiles), signalStatus('Needs broad context', advice.longContext), signalStatus('Splits well', advice.splitWorthy))
  block.append(signals)

  if (advice.target) {
    block.append(sub('Best fit'), probabilityRows(Object.entries(advice.target.probabilities).map(([key, value]) => ({ label: targetLabel(key), value }))))
  }

  if (task.routedModel) block.append(note(`Model chosen: ${task.routedModel.model}. ${task.routedModel.reason}`))
  const advisorDecision = task.routing?.advisor
  if (advisorDecision?.note) block.append(note(advisorDecision.note))
  if (advisorDecision?.mode === 'shadow' && advisorDecision.wouldChooseProviderId) {
    block.append(note(`Shadow mode: Jev would have picked ${providerName(advisorDecision.wouldChooseProviderId)}${advisorDecision.wouldChooseModel ? ` · ${advisorDecision.wouldChooseModel}` : ''}.`))
  }
  return block
}

function routeReason(task: ProxyTask): string {
  if (task.bench) return 'One of the agents chosen for this comparison, so no routing decision was made.'
  const routing = task.routing
  if (!routing) return 'No routing decision has been recorded for this task yet.'
  let reason = `Chosen for ${routing.taskType} under the ${routing.mode} policy`
  if (task.advice?.source === 'jev' && task.advice.complexity !== undefined) reason += `; Jev rated it ${desiredTier(task.advice.complexity, task.mode).tier} complexity`
  return `${reason}.`
}

function candidateRow(candidate: RoutingCandidate): HTMLElement {
  const row = element('div', `route-candidate${candidate.eligible ? '' : ' skipped'}`)
  const head = element('div', 'route-candidate-head')
  head.append(element('span', 'route-candidate-name', candidate.providerName), element('span', 'route-candidate-score', candidate.eligible ? String(Math.round(candidate.score ?? 0)) : '—'))
  row.append(head)
  if (candidate.eligible && candidate.factors?.length) row.append(factorRows(candidate.factors))
  else if (candidate.skippedReason) row.append(note(candidate.skippedReason))
  return row
}

// Whether the other candidates are shown — reset whenever the selected task changes.
let routeDetailsOpen = false

function buildRouteSection(task: ProxyTask): HTMLElement {
  const body = element('div', 'inspector-route')
  const providerId = task.routing?.chosenProviderId ?? task.selectedProviderId
  const provider = snapshot.providers.find((item) => item.id === providerId)
  const model = task.model ?? provider?.model
  const pick = element('div', 'route-pick')
  pick.append(element('strong', undefined, providerName(providerId)))
  if (model) pick.append(element('span', 'route-pick-model', model))
  if (provider || model) pick.append(tag(tierFor(model, provider?.kind)))
  body.append(pick, element('p', 'inspector-text', routeReason(task)))

  const routing = task.routing
  const chosen = routing?.candidates.find((candidate) => candidate.providerId === routing.chosenProviderId)
  if (chosen?.factors?.length) body.append(sub('Factors'), factorRows(chosen.factors))

  const advice = buildAdviceBlock(task)
  if (advice) body.append(advice)

  const others = routing?.candidates.filter((candidate) => candidate.providerId !== routing.chosenProviderId) ?? []
  if (others.length) {
    const toggle = element('button', 'btn btn-ghost btn-sm inspector-more', routeDetailsOpen ? 'Hide other agents' : `Other agents (${others.length})`) as HTMLButtonElement
    toggle.type = 'button'
    toggle.setAttribute('aria-expanded', String(routeDetailsOpen))
    const list = element('div', 'route-candidates')
    list.hidden = !routeDetailsOpen
    list.append(...others.map(candidateRow))
    toggle.addEventListener('click', () => {
      routeDetailsOpen = !routeDetailsOpen
      list.hidden = !routeDetailsOpen
      toggle.textContent = routeDetailsOpen ? 'Hide other agents' : `Other agents (${others.length})`
      toggle.setAttribute('aria-expanded', String(routeDetailsOpen))
    })
    body.append(toggle, list)
  }
  return body
}

// --- Inspector: Files changed section ---

const FILE_ACTION: Record<string, string> = { create: 'new', edit: 'edit', delete: 'deleted' }

function buildFilesSection(task: ProxyTask): HTMLElement {
  const changes = task.filesChanged ?? []
  if (!changes.length) return element('p', 'inspector-text', 'No files changed yet.')
  const list = element('div', 'inspector-file-list')
  for (const change of changes) {
    const row = element('button', 'inspector-file-row') as HTMLButtonElement
    row.type = 'button'
    row.append(tag(FILE_ACTION[change.action] ?? change.action), element('span', 'inspector-file-path', change.path))
    row.title = `Open ${change.path}`
    row.addEventListener('click', () => openFileOverlay(task, change.path, row))
    list.append(row)
  }
  return list
}

// --- Inspector: Activity section ---

const ACTIVITY_ICON: Record<string, IconName> = { tool: 'tool', thinking: 'thinking', notice: 'notice' }

function buildActivitySection(task: ProxyTask): HTMLElement {
  const events = [...(task.activity ?? [])].reverse()
  if (!events.length) return element('p', 'inspector-text', 'No activity recorded yet.')
  const list = element('ol', 'activity-list')
  for (const event of events) {
    const row = element('li', `activity-row ${event.kind}`)
    const glyph = element('span', 'activity-icon'); glyph.append(icon(ACTIVITY_ICON[event.kind] ?? 'notice', 14))
    const body = element('span', 'activity-body')
    body.append(element('span', 'activity-label', event.label))
    if (event.detail) { const detail = element('span', 'activity-detail', event.detail); detail.title = event.detail; body.append(detail) }
    row.append(glyph, body, element('span', 'activity-time', timeAgo(event.at)))
    list.append(row)
  }
  return list
}

// --- Inspector: Context section ---

function buildContextSection(task: ProxyTask): HTMLElement {
  if (task.contextWindow === undefined || task.contextTokens === undefined) return element('p', 'inspector-text', 'No context data reported for this task yet.')
  const percent = Math.min(100, Math.max(0, (task.contextTokens / task.contextWindow) * 100))
  const wrap = element('div', 'inspector-context')
  wrap.append(
    meterRow(task.contextSource === 'estimated' ? 'Window (estimated)' : 'Window', percent, `${Math.round(percent)}%`, percent >= 80 ? 'warn' : 'accent'),
    element('p', 'inspector-note', `${formatNumber(task.contextTokens)} of ${formatNumber(task.contextWindow)} tokens`)
  )
  return wrap
}

// --- Inspector: Attempts / branch section ---

const ATTEMPT_TONE: Record<string, StatusTone> = { running: 'running', completed: 'ok', failed: 'danger', cancelled: 'neutral' }

function buildAttemptsSection(task: ProxyTask): HTMLElement {
  const wrap = element('div', 'inspector-attempts')
  if (!task.attempts.length) wrap.append(element('p', 'inspector-text', 'No agent has been launched yet.'))
  else for (const attempt of task.attempts) {
    const row = element('div', 'attempt-row')
    const body = element('span', 'attempt-body')
    body.append(element('span', 'attempt-name', providerName(attempt.providerId)), element('span', 'attempt-meta', `${attempt.status} · ${timeAgo(attempt.startedAt)}`))
    row.append(status(ATTEMPT_TONE[attempt.status] ?? 'neutral', '', { ariaLabel: attempt.status }), body)
    if (attempt.error) row.title = attempt.error
    wrap.append(row)
  }
  const branches = (task.subtasks ?? []).filter((lane) => lane.branch)
  if (branches.length) {
    wrap.append(sub('Branches'))
    const list = element('div', 'inspector-branch-list')
    for (const lane of branches) {
      const item = element('div', 'inspector-branch-item')
      item.append(branchButton(task.cwd, lane))
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

function renderInspector(task: ProxyTask): void {
  const signature = inspectorSignature(task)
  if (signature === lastInspectorSignature) return
  lastInspectorSignature = signature

  const section = (id: string, title: string, body: HTMLElement, count?: number): HTMLElement => inspectorSection(id, title, body, {
    open: inspectorSectionsOpen[id],
    badge: count ? element('span', 'inspector-count', String(count)) : undefined,
    onToggle: (open) => { inspectorSectionsOpen[id] = open }
  })
  byId('inspector-body').replaceChildren(
    section('route', 'Route', buildRouteSection(task)),
    section('files', 'Files changed', buildFilesSection(task), task.filesChanged?.length),
    section('activity', 'Activity', buildActivitySection(task), task.activity?.length),
    section('context', 'Context', buildContextSection(task)),
    section('attempts', 'Attempts', buildAttemptsSection(task), task.attempts.length > 1 ? task.attempts.length : undefined)
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
    button.setAttribute('aria-pressed', String(button.dataset.fileMode === overlayFileMode))
  })
  if (!file) {
    title.textContent = 'Select a file'; language.textContent = 'source'
    notice.hidden = false; notice.textContent = 'Choose any project file. Changed files are marked in the tree.'
    code.replaceChildren(); return
  }
  title.textContent = file.relativePath; language.textContent = file.language
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
        ? tag(FILE_ACTION[change.action] ?? change.action)
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
  input.placeholder = busy ? 'Working…' : 'Continue the conversation. @ to add files.'
  input.closest('.composer-draft')?.querySelectorAll<HTMLButtonElement>('.composer-attach').forEach((control) => { control.disabled = busy })
  button.disabled = false
  button.textContent = busy ? 'Stop' : 'Send'
  button.classList.toggle('btn-primary', !busy)
  button.classList.toggle('btn-secondary', busy)
  button.classList.toggle('stop-button', busy)
  button.setAttribute('aria-label', busy ? 'Stop this task' : 'Send message')
}

function renderSurfaceActions(task: ProxyTask): void {
  const target = byId('surface-actions')
  if (taskIsBusy(task)) { target.replaceChildren(); return }
  const retry = element('button', 'btn btn-secondary btn-sm') as HTMLButtonElement
  retry.type = 'button'
  retry.append(icon('refresh', 14), document.createTextNode('Run again'))
  retry.addEventListener('click', async () => {
    try {
      await persistControlPlaneDraft()
      const created = await window.frontier.retryTask(task.id)
      applyTaskSurface({ kind: 'select', taskId: created.id })
    } catch (error) { reportError('Could not re-run this task', error) }
  })
  const controls: HTMLElement[] = [retry]

  if (!task.bench) {
    const select = document.createElement('select'); select.className = 'select surface-agent-select'
    select.title = 'Agent for the next message'; select.setAttribute('aria-label', 'Change agent for the next message')
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
    controls.push(select)
  }
  target.replaceChildren(...controls)
}

function resetSurfaceCaches(): void {
  lastBodyRender = { id: '', status: '', length: -1 }
  lastInspectorSignature = ''
}

export function renderSurface(): void {
  const task = snapshot.tasks.find((item) => item.id === selectedTaskId)
  // Unreachable while not composing (renderTasks reconciles first); kept as a guard.
  if (!task) return

  byId('surface-title').textContent = task.prompt
  renderSurfaceMeta(task)
  renderSurfaceActions(task)
  renderSurfaceStages(task)
  renderThread(task)
  renderInspector(task)

  // A comparison has no single conversation to continue.
  const composer = byId('surface-composer')
  composer.hidden = Boolean(task.bench) && !taskIsBusy(task)
  if (!composer.hidden) renderComposerState(task, byId<HTMLTextAreaElement>('composer-input'), byId<HTMLButtonElement>('composer-send'))
}

export function openTask(taskId: string): void {
  applyTaskSurface({ kind: 'select', taskId })
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
  if (!taskId || composing) return
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
    button.title = focusMode ? 'Show the queue and inspector' : 'Expand the conversation'
    button.setAttribute('aria-label', button.title)
  })

  byId('inspector-toggle').addEventListener('click', () => toggleInspector())
  for (const button of document.querySelectorAll<HTMLElement>('[data-pane-toggle="list"]')) button.addEventListener('click', () => toggleTaskList())

  // Task list keyboard navigation: ↑/↓ move the selection (from compose, ↓ takes the first row).
  byId('task-list').addEventListener('keydown', (event) => {
    const order = orderedVisibleTasks(scopedTasks())
    if (!order.length) return
    const currentIndex = composing ? -1 : order.findIndex((task) => task.id === selectedTaskId)
    let next: ProxyTask | undefined
    if (event.key === 'ArrowDown') next = order[Math.min(order.length - 1, currentIndex + 1)]
    else if (event.key === 'ArrowUp') next = order[Math.max(0, currentIndex - 1)]
    else if (event.key === 'Home') next = order[0]
    else if (event.key === 'End') next = order[order.length - 1]
    if (!next) return
    event.preventDefault()
    selectTask(next.id)
    byId('task-list').querySelector(`[data-task-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' })
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

  applyInspectorState()

  // How much column width the *other* side panel currently reserves
  // (itself plus its own gutter), so dragging one gutter accounts for the
  // other rather than assuming a fixed constant for it. 0 while that panel
  // is collapsed or floating as an overlay — neither takes grid column space.
  const grid = byId('content-grid')
  const listColumnSpace = (): number => (grid.classList.contains('list-collapsed') ? 0 : (queueWidth ?? queueDefaultWidth()) + GUTTER_WIDTH)
  const inspectorColumnSpace = (): number => (grid.classList.contains('inspector-collapsed') ? 0 : (inspectorWidth ?? inspectorDefaultWidth()) + GUTTER_WIDTH)

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
