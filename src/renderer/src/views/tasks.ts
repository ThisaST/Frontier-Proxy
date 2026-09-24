// Tasks — the work queue and the unified task surface: conversation thread,
// subtask/bench lanes, the Route tab, and the Files & changes tab.
import type { ChatContextItem, ConversationTurn, ProxyTask, RoutingCandidate, SubTask, TaskFileContent, TaskWorkspaceSnapshot, WorkspaceEntry } from '../../../shared/types'
import { renderMarkdown } from '../markdown'
import { byId, codeLine, element, emptyState, metaChip, renderDiffInto } from '../ui/dom'
import { chip, gaugeSeg, lamp, probabilityBar, probabilityBars, type Tone } from '../ui/components'
import { icon, type IconName } from '../ui/icons'
import { errorMessage, reportError, showToast } from '../ui/feedback'
import { baseName, formatCost, formatDuration, formatNumber, timeAgo } from '../ui/format'
import { providerName, providerSelectableForTask } from '../providers-view-model'
import { taskElapsed, taskIsBusy, taskKindLabel, taskStatusIndicator, taskTokens, verificationChip } from '../task-helpers'
import { snapshot, selectedTaskId, setSelectedTaskId, currentView, surfaceTab, setSurfaceTab } from '../state'
import { attachmentPreviewCache, composerDraft, messageContext, clearComposerDraft, renderDraftImages } from '../composer'
import { persistControlPlaneDraft } from '../views/control'
import { desiredTierForDisplay } from '../views/routing'
import { openBranchInReview, switchView } from '../main'

let taskQuery = ''
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
export let applyQueueWidth: () => void = () => undefined

function ancestorFolders(path = ''): string[] {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
}

function taskMatchesQuery(task: ProxyTask): boolean {
  if (!taskQuery) return true
  const haystack = `${task.prompt} ${task.type} ${task.mode} ${task.status} ${providerName(task.selectedProviderId)}`.toLowerCase()
  return haystack.includes(taskQuery)
}

export function renderTasks(): void {
  const container = byId('task-list')
  if (!snapshot.tasks.length) {
    container.replaceChildren(emptyState('The queue is clear', 'Create a task and Frontier will pick the best available agent.'))
    renderSurface()
    return
  }
  const visible = snapshot.tasks.filter(taskMatchesQuery)
  if (!selectedTaskId || !snapshot.tasks.some((task) => task.id === selectedTaskId)) setSelectedTaskId(visible[0]?.id ?? snapshot.tasks[0].id)
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
    row.append(taskStatusIndicator(task.status), body, element('span', 'task-time', timeAgo(task.createdAt)))
    row.addEventListener('click', () => { setSelectedTaskId(task.id); setSurfaceTab('conversation'); renderTasks() })
    return row
  }))
  renderSurface()
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
    const chip = element('div', 'meta-chip context-meter')
    chip.append(element('span', 'meta-label', task.contextSource === 'estimated' ? 'Context (estimate)' : 'Context'))
    const row = element('div', 'context-row')
    row.append(gaugeSeg(percent, percent >= 80 ? 'caution' : 'cyan', 'Context window occupancy'), element('strong', 'readout', `${Math.round(percent)}%`))
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
  const chip = verificationChip(lane.verification)
  if (measures.length || chip) {
    const score = element('div', 'lane-score')
    for (const measure of measures) score.append(element('span', 'lane-measure', measure))
    if (chip) score.append(chip)
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

// --- Routing receipt ---

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

// --- Advisor panel (Jev) ---

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

function ensureAdvicePanel(): HTMLElement {
  let panel = document.getElementById('surface-advice')
  if (!panel) {
    panel = element('section', 'route-card screen advice-card')
    panel.id = 'surface-advice'
    const grid = document.querySelector('#surface-route .route-grid')
    grid?.insertBefore(panel, grid.firstElementChild)
  }
  return panel
}

function renderAdvicePanel(task: ProxyTask): void {
  const panel = ensureAdvicePanel()
  const advice = task.advice
  if (!advice) { panel.hidden = true; panel.replaceChildren(); return }
  panel.hidden = false
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
    const tier = desiredTierForDisplay(advice.complexity, task.mode)
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

  panel.replaceChildren(...nodes)
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

const ACTIVITY_ICON: Record<string, IconName> = { tool: 'tool', thinking: 'thinking', notice: 'notice' }

function renderRouteTab(task: ProxyTask): void {
  renderAdvicePanel(task)
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
    row.append(icon(ACTIVITY_ICON[event.kind] ?? 'notice', 14), body)
    return row
  }))
}

// --- Files tab ---

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
        const caret = element('span', 'tree-caret'); caret.append(icon(open ? 'chevron-down' : 'chevron-right', 14))
        folder.append(caret, element('strong', undefined, entry.name))
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

export function openTask(taskId: string): void {
  setSelectedTaskId(taskId)
  setSurfaceTab('conversation')
  detailFilePath = undefined
  detailFileState = undefined
  detailWorkspaceState = undefined
  detailFileRequest += 1
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

export function initTasksView(): void {
  document.querySelectorAll<HTMLElement>('.surface-tab').forEach((tab) => tab.addEventListener('click', () => {
    setSurfaceTab((tab.dataset.surfaceTab as typeof surfaceTab) ?? 'conversation')
    renderSurface()
  }))
  byId('surface-focus').addEventListener('click', () => {
    focusMode = !focusMode
    byId('content-grid').classList.toggle('focus-mode', focusMode)
    const button = byId<HTMLButtonElement>('surface-focus')
    button.setAttribute('aria-pressed', String(focusMode))
    button.replaceChildren(icon(focusMode ? 'collapse' : 'expand', 16))
    button.title = focusMode ? 'Show the queue' : 'Focus this task'
  })
  byId('task-file-mode').querySelectorAll<HTMLElement>('button').forEach((button) => button.addEventListener('click', () => {
    detailFileMode = button.dataset.fileMode === 'source' ? 'source' : 'diff'
    renderTaskFileViewer(detailFileState?.file)
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
}
