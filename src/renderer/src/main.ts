import './styles.css'
import { renderMarkdown } from './markdown'
import { highlightSourceLine, parseUnifiedDiff } from './syntax'
import type { AppSnapshot, ControlPlaneProfile, ConversationTurn, FileChange, McpServerConfig, McpTransport, ProviderConfig, ProxyTask, TaskAttempt, TaskFileContent } from '../../shared/types'

let snapshot: AppSnapshot
let selectedTaskId: string | undefined
let toastTimer: number | undefined
let controlPlaneDraft: ControlPlaneProfile | undefined
let taskQuery = ''
let currentView = 'tasks'
let detailTaskId: string | undefined
let detailTab: 'conversation' | 'files' = 'conversation'
let detailInspectorOpen = false
let detailFilePath: string | undefined
let detailFileMode: 'diff' | 'source' = 'diff'
let detailFileState: { taskId: string; path: string; version: string; file: TaskFileContent } | undefined
let detailFileRequest = 0
let detailFileLoadingKey: string | undefined
// Avoids re-parsing markdown for a finished task on every unrelated snapshot.
let lastBodyRender = { id: '', status: '', length: -1 }

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const taskDialog = byId<HTMLDialogElement>('task-dialog')

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

function sessionPercent(provider: SnapshotProvider): number | undefined {
  if (provider.runtime.session?.utilizationPercent !== undefined) {
    if (provider.runtime.session.resetsAt && Date.parse(provider.runtime.session.resetsAt) <= Date.now()) return 0
    return provider.runtime.session.utilizationPercent
  }
  if (provider.dailyTokenBudget) return Math.min(100, (trackedTokens(provider) / provider.dailyTokenBudget) * 100)
  return undefined
}

function providerLimitReached(provider: SnapshotProvider): boolean {
  return activeCooldown(provider) || (sessionPercent(provider) ?? 0) >= 100
}

function providerCapacity(provider: SnapshotProvider): { label: string; tone: string } {
  if (!provider.enabled) return { label: 'Disabled', tone: 'muted' }
  if (activeCooldown(provider)) return { label: `Limit reached · ${countdown(provider.runtime.cooldownUntil)}`, tone: 'limited' }
  if (providerLimitReached(provider)) return { label: 'Usage limit reached', tone: 'limited' }
  if (!provider.runtime.available) return { label: 'Offline', tone: 'offline' }
  if (provider.runtime.running) return { label: 'In use', tone: 'busy' }
  return { label: 'Available', tone: 'ready' }
}

function providerSelectableForTask(provider: SnapshotProvider, task: ProxyTask): boolean {
  return provider.enabled && provider.runtime.available && !providerLimitReached(provider) && provider.capabilities.includes(task.type)
}

function renderMetrics(): void {
  const running = snapshot.tasks.filter((task) => task.status === 'running').length
  const queued = snapshot.tasks.filter((task) => task.status === 'queued').length
  const online = snapshot.providers.filter((provider) => provider.enabled && provider.runtime.available).length
  const tokens = snapshot.providers.reduce((total, provider) => total + provider.runtime.usage.estimatedInputTokens + provider.runtime.usage.estimatedOutputTokens, 0)
  const metrics = [
    ['Active tasks', String(running), `${queued} waiting`, 'var(--yellow)'],
    ['Providers online', `${online}/${snapshot.providers.filter((p) => p.enabled).length}`, 'local CLI health', 'var(--green)'],
    ['Estimated tokens', formatNumber(tokens), 'tracked today', 'var(--blue)'],
    ['Completed', String(snapshot.tasks.filter((task) => task.status === 'completed').length), 'recent history', 'var(--green)']
  ]
  const container = byId('metrics')
  container.replaceChildren(...metrics.map(([label, value, detail, color]) => {
    const element = document.createElement('div')
    element.className = 'metric'
    element.style.setProperty('--metric-color', color)
    const labelNode = document.createElement('span'); labelNode.textContent = label
    const valueNode = document.createElement('strong'); valueNode.textContent = value
    const detailNode = document.createElement('small'); detailNode.textContent = detail
    element.append(labelNode, valueNode, detailNode)
    return element
  }))
}

function renderMiniProviders(): void {
  const container = byId('provider-mini-list')
  container.replaceChildren(...snapshot.providers.filter((provider) => provider.enabled).map((provider) => {
    const row = document.createElement('div'); row.className = 'mini-provider'
    const capacity = providerCapacity(provider)
    const dot = document.createElement('span')
    dot.className = `provider-dot ${capacity.tone === 'limited' ? 'limited' : provider.runtime.running ? 'busy' : provider.runtime.available ? 'online' : ''}`
    const name = document.createElement('span'); name.textContent = provider.name
    const status = document.createElement('small'); status.textContent = capacity.label.toLowerCase()
    row.append(dot, name, status)
    return row
  }))
}

function taskMatchesQuery(task: ProxyTask): boolean {
  if (!taskQuery) return true
  const haystack = `${task.prompt} ${task.type} ${task.mode} ${task.status} ${providerName(task.selectedProviderId)}`.toLowerCase()
  return haystack.includes(taskQuery)
}

function renderTasks(): void {
  const container = byId('task-list')
  if (!snapshot.tasks.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state'
    const strong = document.createElement('strong'); strong.textContent = 'The queue is clear'
    empty.append(strong, 'Create a task and Frontier will select the best available local agent.')
    container.replaceChildren(empty)
    renderOutput()
    return
  }
  const visible = snapshot.tasks.filter(taskMatchesQuery)
  if (!selectedTaskId || !snapshot.tasks.some((task) => task.id === selectedTaskId)) selectedTaskId = visible[0]?.id ?? snapshot.tasks[0].id
  if (!visible.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state'
    const strong = document.createElement('strong'); strong.textContent = 'No matching tasks'
    empty.append(strong, `Nothing matches “${taskQuery}”.`)
    container.replaceChildren(empty)
    renderOutput()
    return
  }
  container.replaceChildren(...visible.map((task) => {
    const row = document.createElement('div')
    row.className = `task-row ${task.id === selectedTaskId ? 'selected' : ''}`
    row.dataset.taskId = task.id
    const dot = document.createElement('span'); dot.className = `task-state-dot ${task.status}`
    const body = document.createElement('div')
    const title = document.createElement('div'); title.className = 'task-title'; title.textContent = task.prompt
    const meta = document.createElement('div'); meta.className = 'task-meta'
    const tags = [task.type, providerName(task.selectedProviderId), task.mode]
    for (const value of tags) { const tag = document.createElement('span'); tag.textContent = value; meta.append(tag) }
    if (task.contextWindow && task.contextTokens !== undefined) {
      const context = document.createElement('span'); context.className = 'tag-context'
      context.textContent = `context ${Math.round((task.contextTokens / task.contextWindow) * 100)}%`
      meta.append(context)
    }
    if (task.orchestrated) { const tag = document.createElement('span'); tag.className = 'tag-orchestrated'; tag.textContent = 'orchestrated'; meta.append(tag) }
    body.append(title, meta)
    const time = document.createElement('span'); time.className = 'task-time'; time.textContent = timeAgo(task.createdAt)
    row.append(dot, body, time)
    row.addEventListener('click', () => { selectedTaskId = task.id; renderTasks() })
    row.addEventListener('dblclick', () => openTaskDetail(task.id))
    return row
  }))
  renderOutput()
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

function metaChip(label: string, value: string): HTMLElement {
  const chip = document.createElement('div'); chip.className = 'meta-chip'
  const l = document.createElement('span'); l.className = 'meta-label'; l.textContent = label
  const v = document.createElement('strong'); v.textContent = value
  chip.append(l, v); return chip
}

function renderTimeline(task: ProxyTask): void {
  const container = byId('output-timeline')
  if (!task.attempts.length) { container.replaceChildren(); return }
  const nodes: HTMLElement[] = []
  task.attempts.forEach((attempt: TaskAttempt, index) => {
    if (index > 0) { const arrow = document.createElement('span'); arrow.className = 'timeline-arrow'; arrow.textContent = '→'; nodes.push(arrow) }
    const step = document.createElement('span'); step.className = `timeline-step ${attempt.status}`
    step.title = attempt.error ?? ''
    const dot = document.createElement('span'); dot.className = 'timeline-dot'
    const name = document.createElement('span'); name.textContent = providerName(attempt.providerId)
    step.append(dot, name); nodes.push(step)
  })
  container.replaceChildren(...nodes)
}

const ORCH_STAGES = ['planning', 'delegating', 'synthesizing', 'done'] as const

function renderSubtasks(task: ProxyTask): void {
  const container = byId('output-subtasks')
  if (!task.orchestrated) { container.replaceChildren(); return }
  const subs = task.subtasks ?? []
  const stage = task.orchestrationStage ?? 'planning'
  const stageIndex = ORCH_STAGES.indexOf(stage)

  const bar = document.createElement('div'); bar.className = 'stage-bar'
  ORCH_STAGES.forEach((name, index) => {
    if (index > 0) { const sep = document.createElement('span'); sep.className = 'stage-sep'; sep.textContent = '→'; bar.append(sep) }
    const step = document.createElement('span')
    step.className = `stage-step${index === stageIndex ? ' active' : ''}${index < stageIndex ? ' past' : ''}`
    step.textContent = name
    bar.append(step)
  })

  const nodes: HTMLElement[] = [bar]
  if (subs.length) {
    const head = document.createElement('div'); head.className = 'subtasks-head'; head.textContent = `Subtasks · ${subs.length}`
    nodes.push(head)
    for (const sub of subs) {
      const card = document.createElement('details'); card.className = `subtask ${sub.status}`
      if (sub.status === 'running') card.open = true
      const summary = document.createElement('summary')
      const dot = document.createElement('span'); dot.className = `task-state-dot ${sub.status}`
      const title = document.createElement('span'); title.className = 'subtask-title'; title.textContent = sub.title
      const meta = document.createElement('span'); meta.className = 'subtask-meta'
      meta.textContent = [providerName(sub.providerId), sub.model].filter(Boolean).join(' · ') || sub.type
      summary.append(dot, title, meta)
      if (sub.branch) {
        const branch = document.createElement('span'); branch.className = 'subtask-branch'
        branch.textContent = sub.committed ? `⎇ ${sub.branch}` : `⎇ ${sub.branch} · no changes`
        branch.title = sub.committed ? 'Changes committed to this branch — merge to apply' : 'Isolated worktree; no file changes'
        summary.append(branch)
      }
      const body = document.createElement('div'); body.className = 'subtask-body markdown'
      if (sub.output.trim()) body.appendChild(renderMarkdown(sub.output))
      else if (sub.error) { body.textContent = sub.error; body.classList.add('subtask-error') }
      else body.textContent = sub.status === 'running' ? 'Working…' : 'Queued…'
      card.append(summary, body)
      nodes.push(card)
    }
    if (subs.some((sub) => sub.committed)) {
      const note = document.createElement('div'); note.className = 'subtask-note'
      note.textContent = 'Each subtask ran in an isolated git worktree. Committed changes are on the branches above — review and merge the ones you want.'
      nodes.push(note)
    }
  }
  container.replaceChildren(...nodes)
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function renderFilesChanged(task: ProxyTask): void {
  const container = byId('output-files')
  const files = task.filesChanged ?? []
  if (!files.length) { container.replaceChildren(); return }
  const head = document.createElement('div'); head.className = 'files-head'
  head.textContent = `Files changed · ${files.length}`
  const rows = files.map((file) => {
    const row = document.createElement('div'); row.className = `file-row ${file.action}`
    const badge = document.createElement('span'); badge.className = 'file-badge'; badge.textContent = file.action === 'create' ? 'NEW' : file.action === 'delete' ? 'DEL' : 'EDIT'
    const name = document.createElement('span'); name.className = 'file-name'; name.textContent = baseName(file.path)
    const dir = document.createElement('span'); dir.className = 'file-dir'; dir.textContent = file.path
    row.append(badge, name, dir)
    return row
  })
  container.replaceChildren(head, ...rows)
}

const ACTIVITY_ICON: Record<string, string> = { tool: '⚙', thinking: '✳', notice: '•' }

function renderActivity(task: ProxyTask): void {
  const container = byId('output-activity')
  const events = task.activity ?? []
  if (!events.length) { container.replaceChildren(); return }
  const items = events.map((event) => {
    const row = document.createElement('div'); row.className = `activity-item ${event.kind}`
    const icon = document.createElement('span'); icon.className = 'activity-icon'; icon.textContent = ACTIVITY_ICON[event.kind] ?? '•'
    const label = document.createElement('span'); label.className = 'activity-label'; label.textContent = event.label
    row.append(icon, label)
    if (event.detail) { const detail = document.createElement('span'); detail.className = 'activity-detail'; detail.textContent = event.detail; row.append(detail) }
    return row
  })
  const head = document.createElement('div'); head.className = 'activity-head'
  head.textContent = task.status === 'running' ? `Working · ${events.length} step${events.length === 1 ? '' : 's'}` : `${events.length} step${events.length === 1 ? '' : 's'}`
  container.replaceChildren(head, ...items)
  if (task.status === 'running') container.scrollTop = container.scrollHeight
}

function renderOutputBody(task: ProxyTask): void {
  const output = byId<HTMLDivElement>('output-content')
  const streaming = task.status === 'running' || task.status === 'queued'
  const turns = task.turns ?? []
  const historyLength = turns.reduce((total, turn) => total + turn.content.length, 0)
  const signature = { id: task.id, status: task.status, length: turns.length * 1_000_000 + historyLength + (task.output?.length ?? 0) }
  if (lastBodyRender.id === signature.id && lastBodyRender.status === signature.status && lastBodyRender.length === signature.length) return
  lastBodyRender = signature
  const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40

  // Legacy tasks without a conversation: render the single output blob.
  if (!turns.length) {
    output.className = streaming ? 'output-content streaming' : 'output-content markdown'
    if (streaming) output.textContent = task.output || 'Waiting for provider output…'
    else { const frag = document.createDocumentFragment(); if (task.output) frag.appendChild(renderMarkdown(task.output)); if (task.error) { const e = document.createElement('div'); e.className = 'output-error'; e.textContent = task.error; frag.appendChild(e) } output.replaceChildren(frag) }
    if (streaming || atBottom) output.scrollTop = output.scrollHeight
    return
  }

  output.className = 'output-content conversation'
  const fragment = document.createDocumentFragment()
  turns.forEach((turn, index) => {
    const isLastAssistant = turn.role === 'assistant' && index === turns.length - 1
    const live = isLastAssistant && streaming
    const block = document.createElement('div'); block.className = `turn ${turn.role}`
    const head = document.createElement('div'); head.className = 'turn-head'
    head.textContent = turn.role === 'user' ? 'You' : `${providerName(turn.providerId)}${turn.model ? ` · ${turn.model}` : ''}`
    const body = document.createElement('div'); body.className = 'turn-body'
    const content = live ? task.output : turn.content
    if (turn.role === 'user') body.textContent = content
    else if (live) { body.classList.add('streaming'); body.textContent = content || 'Working…' }
    else if (content.trim()) { body.classList.add('markdown'); body.appendChild(renderMarkdown(content)) }
    else { body.textContent = turn.status === 'failed' ? (task.error ?? 'Failed.') : '—' }
    block.append(head, body)
    fragment.appendChild(block)
  })
  if (task.error && !streaming) { const err = document.createElement('div'); err.className = 'output-error'; err.textContent = task.error; fragment.appendChild(err) }
  output.replaceChildren(fragment)
  if (streaming || atBottom) output.scrollTop = output.scrollHeight
}

function renderOutput(): void {
  const task = snapshot.tasks.find((item) => item.id === selectedTaskId)
  const title = byId('output-title')
  const status = byId('output-status')
  const actions = byId('output-actions')
  const meta = byId('output-meta')
  const output = byId<HTMLDivElement>('output-content')

  if (!task) {
    title.textContent = 'Select a task'
    status.textContent = 'Idle'; status.className = 'status-pill muted'
    actions.replaceChildren(); meta.replaceChildren(); byId('output-timeline').replaceChildren(); byId('output-subtasks').replaceChildren(); byId('output-files').replaceChildren(); byId('output-activity').replaceChildren()
    output.className = 'output-content'
    output.textContent = 'Choose a task from the queue to inspect its routed provider, attempts, and output.'
    byId('output-composer').hidden = true
    lastBodyRender = { id: '', status: '', length: -1 }
    return
  }

  title.textContent = providerName(task.selectedProviderId)
  status.textContent = task.status; status.className = `status-pill ${task.status}`

  const chips = [
    metaChip('Directory', task.cwd),
    metaChip('Input', `${formatNumber(task.estimatedInputTokens)} tok`),
    metaChip('Output', `${formatNumber(task.estimatedOutputTokens)} tok`),
    metaChip('Elapsed', taskElapsed(task))
  ]
  if (task.model) { const modelChip = metaChip('Model', task.model); modelChip.classList.add('model'); chips.unshift(modelChip) }
  if (task.contextWindow && task.contextTokens !== undefined) {
    const pct = Math.round((task.contextTokens / task.contextWindow) * 100)
    const chip = metaChip('Context', `${formatNumber(task.contextTokens)} / ${formatNumber(task.contextWindow)} · ${pct}%`)
    if (pct >= 80) chip.classList.add('context-high')
    chips.push(chip)
  }
  meta.replaceChildren(...chips)
  renderTimeline(task)
  renderSubtasks(task)
  renderFilesChanged(task)
  renderActivity(task)
  renderOutputBody(task)

  const composer = byId('output-composer'); composer.hidden = false
  const composerInput = byId<HTMLTextAreaElement>('composer-input')
  const composerSend = byId<HTMLButtonElement>('composer-send')
  const busy = task.status === 'running' || task.status === 'queued'
  composerInput.disabled = busy; composerSend.disabled = busy
  composerInput.placeholder = busy ? 'Working… you can reply when this turn finishes' : 'Continue the conversation…'

  const controls = document.createElement('div'); controls.className = 'output-actions-inner'
  const details = document.createElement('button'); details.className = 'secondary-button'; details.textContent = 'Open details'
  details.addEventListener('click', () => openTaskDetail(task.id))
  controls.append(details)
  if (task.status === 'running' || task.status === 'queued') {
    const cancel = document.createElement('button'); cancel.className = 'secondary-button'; cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => void window.frontier.cancelTask(task.id))
    controls.append(cancel)
  } else {
    const switcher = document.createElement('label'); switcher.className = 'provider-switch'
    const switchLabel = document.createElement('span'); switchLabel.textContent = 'Next provider'
    const select = document.createElement('select'); select.title = 'Choose the provider for the next message'
    const selectedProviderId = task.continuationProviderId ?? task.selectedProviderId ?? ''
    for (const provider of snapshot.providers) {
      const option = document.createElement('option'); option.value = provider.id
      const selectable = providerSelectableForTask(provider, task)
      option.textContent = `${provider.name}${selectable ? '' : ' · unavailable'}`
      option.disabled = !selectable
      select.append(option)
    }
    select.value = selectedProviderId
    select.addEventListener('change', async () => {
      const providerId = select.value
      if (!providerId || providerId === selectedProviderId) return
      select.disabled = true
      try {
        await window.frontier.changeTaskProvider(task.id, providerId)
        showToast(`${providerName(providerId)} selected for the next message`)
      } catch (error) {
        select.value = selectedProviderId
        reportError('Could not change provider', error)
      } finally { select.disabled = false }
    })
    switcher.append(switchLabel, select)

    const retry = document.createElement('button'); retry.className = 'secondary-button'; retry.textContent = 'Retry'
    retry.addEventListener('click', async () => {
      try {
        await persistControlPlaneDraft()
        const created = await window.frontier.retryTask(task.id)
        selectedTaskId = created.id
      } catch (error) { reportError('Could not retry task', error) }
    })
    controls.append(switcher, retry)
  }
  actions.replaceChildren(controls)
}

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

function renderProviders(): void {
  const grid = byId('provider-grid')
  grid.replaceChildren(...snapshot.providers.map((provider) => {
    const card = document.createElement('article'); card.className = 'provider-card'
    const header = document.createElement('div'); header.className = 'provider-card-header'
    const identity = document.createElement('div'); identity.className = 'provider-name'
    const dot = document.createElement('span'); dot.className = `provider-dot ${provider.runtime.available ? 'online' : ''}`
    const identityText = document.createElement('div')
    const nameTitle = document.createElement('h3'); nameTitle.textContent = provider.name
    const kind = document.createElement('small'); kind.textContent = provider.kind.toUpperCase()
    identityText.append(nameTitle, kind); identity.append(dot, identityText)
    const toggleLabel = document.createElement('label'); toggleLabel.className = 'switch'
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = provider.enabled
    const slider = document.createElement('span'); slider.className = 'slider'; toggleLabel.append(toggle, slider)
    header.append(identity, toggleLabel)

    const form = document.createElement('div'); form.className = 'provider-form'
    const displayName = textInput(provider.name)
    const executable = textInput(provider.executable)
    const model = textInput(provider.model ?? '')
    const priority = textInput(String(provider.priority), 'number'); priority.min = '0'; priority.max = '100'
    const budget = textInput(provider.dailyTokenBudget ? String(provider.dailyTokenBudget) : '', 'number'); budget.min = '0'; budget.placeholder = 'Unlimited'
    const contextWindow = textInput(provider.contextWindow ? String(provider.contextWindow) : '', 'number'); contextWindow.min = '0'; contextWindow.placeholder = 'Auto-detect'
    const args = textInput(formatArguments(provider.args ?? []))
    form.append(field('Display name', displayName), field('Executable', executable), field('Model (optional)', model), field('Routing priority', priority), field('Tracked usage limit', budget), field('Context window (tokens)', contextWindow), field('Extra arguments (quotes supported)', args, true))

    const cpCapable = ['claude', 'copilot', 'codex', 'codex-oss'].includes(provider.kind)
    let cpToggle: HTMLInputElement | undefined
    if (cpCapable) {
      cpToggle = document.createElement('input'); cpToggle.type = 'checkbox'; cpToggle.checked = provider.useControlPlane !== false
      const row = document.createElement('label'); row.className = 'checkbox-row wide'
      row.append(cpToggle, ' Apply shared Context & Tools profile')
      form.append(row)
    }

    const footer = document.createElement('div'); footer.className = 'provider-card-footer'
    const health = document.createElement('span'); health.className = 'health-label'
    health.textContent = provider.runtime.available ? `● Ready · ${provider.runtime.version ?? 'detected'}` : provider.enabled ? '● Not detected' : '○ Disabled'
    const save = document.createElement('button'); save.className = 'secondary-button'; save.textContent = 'Save provider'
    save.addEventListener('click', async () => {
      save.setAttribute('disabled', '')
      try {
        await window.frontier.updateProvider({ id: provider.id, changes: {
          enabled: toggle.checked,
          name: displayName.value.trim() || provider.name,
          executable: executable.value.trim(),
          model: model.value.trim() || undefined,
          priority: Number(priority.value) || 0,
          dailyTokenBudget: Number(budget.value) > 0 ? Number(budget.value) : undefined,
          contextWindow: Number(contextWindow.value) > 0 ? Number(contextWindow.value) : undefined,
          args: args.value.trim() ? splitArguments(args.value) : undefined,
          ...(cpToggle ? { useControlPlane: cpToggle.checked } : {})
        } })
        showToast(`${provider.name} updated`)
      } catch (error) { reportError(`Could not update ${provider.name}`, error) } finally { save.removeAttribute('disabled') }
    })
    toggle.addEventListener('change', () => save.click())
    const buttons = document.createElement('div'); buttons.className = 'header-actions'
    if (provider.kind === 'custom') {
      const remove = document.createElement('button'); remove.className = 'text-button'; remove.textContent = 'Remove'
      remove.addEventListener('click', async () => {
        try { await window.frontier.removeProvider(provider.id); showToast('Custom provider removed') }
        catch (error) { reportError('Could not remove provider', error) }
      })
      buttons.append(remove)
    }
    buttons.append(save)
    footer.append(health, buttons)
    card.append(header, form, footer)
    return card
  }))
}

function renderTaskProviderOptions(): void {
  const select = byId<HTMLSelectElement>('provider-override')
  const current = select.value
  select.replaceChildren(new Option('Automatic', ''), ...snapshot.providers.filter((p) => p.enabled).map((p) => new Option(p.name, p.id)))
  select.value = current
  renderTaskModelOptions()
}

// Populate the model dropdown from the providers' discovered/known models,
// scoped to the chosen provider override (or all enabled providers when
// Automatic). "Custom model…" reveals a free-text input for anything else.
function renderTaskModelOptions(): void {
  const select = byId<HTMLSelectElement>('task-model-select')
  const custom = byId<HTMLInputElement>('task-model')
  const current = select.value
  const overrideId = byId<HTMLSelectElement>('provider-override').value
  const providers = snapshot.providers.filter((p) => p.enabled && (!overrideId || p.id === overrideId))
  const groups = providers
    .map((p) => ({ name: p.name, models: p.runtime.models ?? [] }))
    .filter((g) => g.models.length)
    .map((g) => {
      const group = document.createElement('optgroup'); group.label = g.name
      for (const model of g.models) group.append(new Option(model, model))
      return group
    })
  select.replaceChildren(new Option('Provider default', ''), ...groups, new Option('Custom model…', '__custom__'))
  // Preserve the prior choice when it's still offered.
  const values = new Set(['', '__custom__', ...groups.flatMap((g) => [...g.children].map((o) => (o as HTMLOptionElement).value))])
  select.value = values.has(current) ? current : ''
  custom.hidden = select.value !== '__custom__'
}

function renderSettings(): void {
  byId<HTMLInputElement>('max-parallel').value = String(snapshot.settings.maxParallelTasks)
  byId<HTMLInputElement>('cooldown-minutes').value = String(snapshot.settings.quotaCooldownMinutes)
  // Don't clobber the memory textarea while the user is editing it.
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
// Flush the renderer draft before any action that launches a provider so a
// server the user just added cannot be left behind in the Context & Tools UI.
async function persistControlPlaneDraft(showConfirmation = false): Promise<void> {
  if (!controlPlaneDraft) return
  const saved = await window.frontier.updateControlPlane(syncDraftFromInputs())
  controlPlaneDraft = cloneProfile(saved.settings.controlPlane)
  if (showConfirmation) showToast('Context & Tools configuration saved')
}

function textLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

function newId(): string {
  return typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

// Pull the free-text fields into the draft so save and preview see current edits.
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
    const empty = document.createElement('p'); empty.className = 'cp-empty'
    empty.textContent = 'No MCP servers yet. Add one to share it across every agent.'
    list.replaceChildren(empty)
    return
  }
  list.replaceChildren(...draft.mcpServers.map((server) => {
    const row = document.createElement('div'); row.className = 'cp-server'

    const top = document.createElement('div'); top.className = 'cp-server-top'
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = server.enabled
    toggle.addEventListener('change', () => { server.enabled = toggle.checked })
    const toggleWrap = document.createElement('label'); toggleWrap.className = 'switch small'
    const slider = document.createElement('span'); slider.className = 'slider'; toggleWrap.append(toggle, slider)

    const name = textInput(server.name); name.placeholder = 'server-name'
    name.addEventListener('input', () => { server.name = name.value; refreshPreview() })

    const transport = document.createElement('select')
    for (const option of ['stdio', 'http', 'sse']) transport.append(new Option(option, option))
    transport.value = server.transport
    transport.addEventListener('change', () => { server.transport = transport.value as McpTransport; renderMcpServers(); refreshPreview() })

    const remove = document.createElement('button'); remove.className = 'text-button'; remove.textContent = 'Remove'
    remove.addEventListener('click', () => {
      draft.mcpServers = draft.mcpServers.filter((item) => item.id !== server.id)
      renderMcpServers(); refreshPreview()
    })
    top.append(toggleWrap, name, transport, remove)

    const detail = document.createElement('div'); detail.className = 'cp-server-detail'
    if (server.transport === 'stdio') {
      const command = textInput(server.command ?? ''); command.placeholder = 'command (e.g. npx)'
      command.addEventListener('input', () => { server.command = command.value; refreshPreview() })
      const args = textInput((server.args ?? []).join(' ')); args.placeholder = 'arguments (space-separated)'
      args.addEventListener('input', () => { server.args = splitArguments(args.value); refreshPreview() })
      const env = textArea(recordToLines(server.env, '='), 2); env.placeholder = 'KEY=value (one per line)'
      env.addEventListener('input', () => { server.env = linesToRecord(env.value, '='); refreshPreview() })
      detail.append(field('Command', command), field('Arguments', args), field('Environment variables', env, true))
    } else {
      const url = textInput(server.url ?? ''); url.placeholder = 'https://host/mcp'
      url.addEventListener('input', () => { server.url = url.value; refreshPreview() })
      const headers = textArea(recordToLines(server.headers, ': '), 2); headers.placeholder = 'Header-Name: value (one per line)'
      headers.addEventListener('input', () => { server.headers = linesToRecord(headers.value, ':'); refreshPreview() })
      detail.append(field('Server URL', url, true), field('Headers', headers, true))
    }
    row.append(top, detail)
    return row
  }))
}

function renderPreviewProviderOptions(): void {
  const select = byId<HTMLSelectElement>('cp-preview-provider')
  const current = select.value
  const capable = snapshot.providers.filter((provider) => ['claude', 'copilot', 'codex', 'codex-oss'].includes(provider.kind))
  select.replaceChildren(new Option('Select provider…', ''), ...capable.map((provider) => new Option(provider.name, provider.id)))
  if (capable.some((provider) => provider.id === current)) select.value = current
}

async function refreshPreview(): Promise<void> {
  const select = byId<HTMLSelectElement>('cp-preview-provider')
  const preview = byId<HTMLPreElement>('cp-preview')
  if (!select.value) { preview.textContent = 'Select a provider to preview the exact flags Frontier will inject.'; return }
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

function formatCost(usd: number): string {
  if (usd >= 0.005) return `$${usd.toFixed(2)}`
  return usd > 0 ? '<$0.01' : '$0.00'
}

function countdown(iso?: string): string {
  if (!iso) return '—'
  const ms = Date.parse(iso) - Date.now()
  if (ms <= 0) return 'resetting…'
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

function usageStat(label: string, value: string): HTMLElement {
  const stat = document.createElement('div'); stat.className = 'usage-stat'
  const l = document.createElement('span'); l.className = 'usage-stat-label'; l.textContent = label
  const v = document.createElement('strong'); v.textContent = value
  stat.append(l, v); return stat
}

function usageGauge(label: string, percent: number | undefined, detail: string, tone = ''): HTMLElement {
  const gauge = document.createElement('div'); gauge.className = `usage-gauge ${tone}`.trim()
  const head = document.createElement('div'); head.className = 'usage-gauge-head'
  const title = document.createElement('span'); title.textContent = label
  const value = document.createElement('strong'); value.textContent = percent === undefined ? '—' : `${Math.round(percent)}%`
  head.append(title, value)
  const bar = document.createElement('div'); bar.className = 'usage-bar'
  const fill = document.createElement('div'); fill.className = 'usage-bar-fill'; fill.style.width = `${Math.min(100, Math.max(0, percent ?? 0))}%`
  bar.append(fill)
  const description = document.createElement('div'); description.className = 'usage-budget-label'; description.textContent = detail
  gauge.append(head, bar, description)
  return gauge
}

function renderUsage(): void {
  const grid = byId('usage-grid')
  grid.replaceChildren(...snapshot.providers.map((provider) => {
    const usage = provider.runtime.usage
    const actual = usage.inputTokens + usage.outputTokens
    const estimated = usage.estimatedInputTokens + usage.estimatedOutputTokens
    const hasActual = actual > 0

    const capacity = providerCapacity(provider)
    const card = document.createElement('article'); card.className = `panel usage-card ${capacity.tone === 'limited' ? 'limited' : ''}`
    const header = document.createElement('div'); header.className = 'usage-card-header'
    const identity = document.createElement('div'); identity.className = 'usage-card-identity'
    const dot = document.createElement('span'); dot.className = `provider-dot ${capacity.tone === 'limited' ? 'limited' : provider.runtime.running ? 'busy' : provider.runtime.available ? 'online' : ''}`
    const name = document.createElement('h3'); name.textContent = provider.name
    identity.append(dot, name)
    const badge = document.createElement('span'); badge.className = `capacity-badge ${capacity.tone}`; badge.textContent = capacity.label
    header.append(identity, badge)

    const stats = document.createElement('div'); stats.className = 'usage-stats'
    stats.append(
      usageStat('Cost today', formatCost(usage.costUsd)),
      usageStat(hasActual ? 'Input tokens' : 'Input (est.)', formatNumber(hasActual ? usage.inputTokens : usage.estimatedInputTokens)),
      usageStat(hasActual ? 'Output tokens' : 'Output (est.)', formatNumber(hasActual ? usage.outputTokens : usage.estimatedOutputTokens)),
      usageStat('Tasks', String(usage.tasks))
    )

    const session = provider.runtime.session
    const trackedPct = sessionPercent(provider)
    const limitPct = providerLimitReached(provider) ? 100 : trackedPct
    const sessionLabel = session?.limitType ? `${session.limitType} limit` : 'Session usage'
    const resetAt = session?.resetsAt ?? session?.overageResetsAt
    const sessionDetail = providerLimitReached(provider)
      ? activeCooldown(provider) ? `Automatic fallback active · retries in ${countdown(provider.runtime.cooldownUntil)}` : 'Automatic fallback active · tracked limit reached'
      : resetAt
        ? `Resets in ${countdown(resetAt)}${session?.usingOverage ? ' · overage in use' : ''}`
        : provider.dailyTokenBudget
          ? `${formatNumber(trackedTokens(provider))} / ${formatNumber(provider.dailyTokenBudget)} tracked tokens`
          : `${formatNumber(trackedTokens(provider))} tracked tokens · no limit reported`
    const sessionGauge = usageGauge(sessionLabel, limitPct, sessionDetail, providerLimitReached(provider) || (limitPct ?? 0) >= 90 ? 'high' : '')

    const footer = document.createElement('div'); footer.className = 'usage-card-footer'
    const note = document.createElement('span'); note.className = 'usage-session'
    note.textContent = providerLimitReached(provider)
      ? `Frontier will skip ${provider.name} while this limit is active and route work elsewhere.`
      : session?.status && session.status !== 'allowed'
        ? `Provider status: ${session.status}`
        : 'Limits are detected from CLI events and configured tracked-usage thresholds.'
    footer.append(note)

    card.append(header, sessionGauge, stats, footer)
    return card
  }))
}

function renderTaskDetailSummary(task: ProxyTask): void {
  const summary = byId('task-detail-summary')
  const provider = providerName(task.selectedProviderId)
  const meta = document.createElement('div'); meta.className = 'task-detail-meta'
  const values = [
    { label: 'Model', value: task.model ?? provider },
    { label: 'Tokens', value: `${formatNumber(task.estimatedInputTokens)} in · ${formatNumber(task.estimatedOutputTokens)} out` },
    { label: 'Elapsed', value: taskElapsed(task) }
  ]
  for (const item of values) {
    const value = document.createElement('span'); value.textContent = item.value; value.title = `${item.label}: ${item.value}`
    meta.append(value)
  }
  const context = document.createElement('div'); context.className = 'task-context-card'
  const label = document.createElement('span'); label.className = 'task-context-label'; label.textContent = 'Context'
  const detail = document.createElement('span'); detail.className = 'task-context-detail'
  const value = document.createElement('strong')
  let percent: number | undefined
  if (task.contextWindow && task.contextTokens !== undefined) {
    percent = Math.min(100, (task.contextTokens / task.contextWindow) * 100)
    value.textContent = `${Math.round(percent)}%`
    detail.textContent = `${formatNumber(task.contextTokens)} / ${formatNumber(task.contextWindow)}`
  } else {
    value.textContent = '—'
    detail.textContent = 'Not reported'
  }
  const bar = document.createElement('div'); bar.className = 'task-context-bar'
  const fill = document.createElement('div'); fill.style.width = `${percent ?? 0}%`
  if ((percent ?? 0) >= 80) fill.classList.add('high')
  bar.append(fill); context.append(label, detail, bar, value)
  summary.replaceChildren(meta, context)
}

function renderTaskDetailThread(task: ProxyTask): void {
  const thread = byId('task-detail-thread')
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60
  const streaming = task.status === 'running' || task.status === 'queued'
  const turns: ConversationTurn[] = task.turns?.length ? task.turns : [
    { id: 'legacy-user', role: 'user', content: task.prompt, at: task.createdAt },
    ...(task.output || task.error ? [{ id: 'legacy-assistant', role: 'assistant' as const, content: task.output, providerId: task.selectedProviderId, model: task.model, status: task.status, at: task.finishedAt ?? task.createdAt }] : [])
  ]
  const fragment = document.createDocumentFragment()
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]
    const live = streaming && turn.role === 'assistant' && index === turns.length - 1
    const block = document.createElement('article'); block.className = `detail-turn ${turn.role}`
    const head = document.createElement('div'); head.className = 'detail-turn-head'
    const identity = document.createElement('strong')
    identity.textContent = turn.role === 'user' ? 'You' : providerName(turn.providerId)
    const meta = document.createElement('span')
    meta.textContent = [turn.model, turn.status, timeAgo(turn.at)].filter(Boolean).join(' · ')
    head.append(identity, meta)
    const body = document.createElement('div'); body.className = 'detail-turn-body markdown'
    const content = live ? task.output : turn.content
    if (turn.role === 'user' || live) body.textContent = content || (live ? 'Working…' : '')
    else if (content.trim()) body.appendChild(renderMarkdown(content))
    else body.textContent = turn.status === 'failed' ? (task.error ?? 'Failed.') : '—'
    block.append(head, body); fragment.append(block)
  }
  if (task.error && !streaming) { const error = document.createElement('div'); error.className = 'output-error'; error.textContent = task.error; fragment.append(error) }
  thread.replaceChildren(fragment)
  if (streaming || atBottom) thread.scrollTop = thread.scrollHeight

  const input = byId<HTMLTextAreaElement>('task-detail-composer-input')
  const send = byId<HTMLButtonElement>('task-detail-composer-send')
  input.disabled = streaming; send.disabled = streaming
  input.placeholder = streaming ? 'Working… you can reply when this turn finishes' : 'Continue the conversation…'
}

function renderTaskDetailInspector(task: ProxyTask): void {
  const timeline = byId('task-detail-timeline')
  const attempts = task.attempts.map((attempt) => {
    const row = document.createElement('div'); row.className = `detail-route-row ${attempt.status}`
    const dot = document.createElement('span'); dot.className = 'timeline-dot'
    const body = document.createElement('div')
    const name = document.createElement('strong'); name.textContent = providerName(attempt.providerId)
    const timing = document.createElement('small'); timing.textContent = `${attempt.status} · ${timeAgo(attempt.startedAt)}`
    body.append(name, timing); row.append(dot, body)
    if (attempt.error) row.title = attempt.error
    return row
  })
  if (!attempts.length) { const empty = document.createElement('p'); empty.className = 'detail-empty'; empty.textContent = 'No provider attempts yet.'; timeline.replaceChildren(empty) }
  else timeline.replaceChildren(...attempts)

  const activity = byId('task-detail-activity')
  const events = (task.activity ?? []).map((event) => {
    const row = document.createElement('div'); row.className = `detail-activity-row ${event.kind}`
    const icon = document.createElement('span'); icon.textContent = ACTIVITY_ICON[event.kind] ?? '•'
    const body = document.createElement('div')
    const label = document.createElement('strong'); label.textContent = event.label
    body.append(label)
    if (event.detail) { const detail = document.createElement('small'); detail.textContent = event.detail; body.append(detail) }
    row.append(icon, body); return row
  })
  if (!events.length) { const empty = document.createElement('p'); empty.className = 'detail-empty'; empty.textContent = 'No activity recorded.'; activity.replaceChildren(empty) }
  else activity.replaceChildren(...events)
}

function codeLine(oldNumber: number | undefined, newNumber: number | undefined, marker: string, source: string, kind: string, language: string): HTMLElement {
  const row = document.createElement('div'); row.className = `task-code-line ${kind}`
  const old = document.createElement('span'); old.className = 'task-code-number'; old.textContent = oldNumber ? String(oldNumber) : ''
  const next = document.createElement('span'); next.className = 'task-code-number'; next.textContent = newNumber ? String(newNumber) : ''
  const mark = document.createElement('span'); mark.className = 'task-code-marker'; mark.textContent = marker
  const code = document.createElement('code')
  // highlight.js escapes source text and emits only span markup for token classes.
  code.innerHTML = highlightSourceLine(source, language)
  row.append(old, next, mark, code); return row
}

function renderTaskFileViewer(file?: TaskFileContent): void {
  const title = byId('task-file-title')
  const language = byId('task-file-language')
  const notice = byId('task-file-notice')
  const code = byId('task-file-code')
  const modes = byId('task-file-mode')
  modes.hidden = !file
  modes.querySelectorAll('button').forEach((button) => button.classList.toggle('active', (button as HTMLElement).dataset.fileMode === detailFileMode))
  if (!file) {
    title.textContent = 'Select a changed file'; language.textContent = 'SOURCE'
    notice.hidden = false; notice.textContent = 'Choose a file to inspect its current source and working-tree changes.'
    code.replaceChildren(); return
  }
  title.textContent = file.relativePath; language.textContent = file.language.toUpperCase()
  if (file.binary) { notice.hidden = false; notice.textContent = 'Binary files cannot be displayed.'; code.replaceChildren(); return }
  if (!file.exists && detailFileMode === 'source') { notice.hidden = false; notice.textContent = 'This file no longer exists in the task workspace.'; code.replaceChildren(); return }
  if (file.truncated && detailFileMode === 'source') { notice.hidden = false; notice.textContent = 'Large file: showing the first 1 MB.' } else notice.hidden = true

  if (detailFileMode === 'diff') {
    if (!file.diff.trim()) { notice.hidden = false; notice.textContent = 'No working-tree diff is available. The change may already be committed or the workspace may have moved.'; code.replaceChildren(); return }
    const rows = parseUnifiedDiff(file.diff).map((line) => {
      if (line.kind === 'header' || line.kind === 'hunk') {
        const row = document.createElement('div'); row.className = `task-code-line ${line.kind}`
        const text = document.createElement('code'); text.textContent = line.source; row.append(text); return row
      }
      return codeLine(line.oldNumber, line.newNumber, line.marker, line.source, line.kind, file.language)
    })
    code.replaceChildren(...rows)
  } else {
    const rows = file.content.replace(/\r\n/g, '\n').split('\n').map((line, index) => codeLine(undefined, index + 1, '', line, 'source', file.language))
    code.replaceChildren(...rows)
  }
}

async function loadDetailFile(task: ProxyTask, change: FileChange): Promise<void> {
  const version = change.at
  const key = `${task.id}:${change.path}:${version}`
  if (detailFileState?.taskId === task.id && detailFileState.path === change.path && detailFileState.version === version) {
    renderTaskFileViewer(detailFileState.file); return
  }
  if (detailFileLoadingKey === key) return
  detailFileLoadingKey = key
  const request = ++detailFileRequest
  const notice = byId('task-file-notice'); notice.hidden = false; notice.textContent = 'Loading file…'
  byId('task-file-code').replaceChildren()
  try {
    const file = await window.frontier.readTaskFile(task.id, change.path)
    if (request !== detailFileRequest || detailTaskId !== task.id || detailFilePath !== change.path) return
    detailFileState = { taskId: task.id, path: change.path, version, file }
    renderTaskFileViewer(file)
  } catch (error) {
    if (request !== detailFileRequest) return
    notice.hidden = false; notice.textContent = errorMessage(error)
  } finally { if (detailFileLoadingKey === key) detailFileLoadingKey = undefined }
}

function renderTaskDetailFiles(task: ProxyTask): void {
  const changes = task.filesChanged ?? []
  byId('task-detail-file-count').textContent = String(changes.length)
  const list = byId('task-detail-file-list')
  if (!changes.length) {
    const empty = document.createElement('div'); empty.className = 'detail-empty'; empty.textContent = 'No changed files were recorded for this task.'
    list.replaceChildren(empty); detailFilePath = undefined; renderTaskFileViewer(); return
  }
  if (!detailFilePath || !changes.some((change) => change.path === detailFilePath)) detailFilePath = changes[0].path
  const rows = changes.map((change) => {
    const button = document.createElement('button'); button.className = `task-detail-file ${change.path === detailFilePath ? 'active' : ''}`
    const badge = document.createElement('span'); badge.className = `file-badge ${change.action}`; badge.textContent = change.action === 'create' ? 'NEW' : change.action === 'delete' ? 'DEL' : 'EDIT'
    const body = document.createElement('span')
    const name = document.createElement('strong'); name.textContent = baseName(change.path)
    const path = document.createElement('small'); path.textContent = change.path
    body.append(name, path); button.append(badge, body)
    button.addEventListener('click', () => { detailFilePath = change.path; detailFileState = undefined; renderTaskDetailFiles(task) })
    return button
  })
  list.replaceChildren(...rows)
  const selected = changes.find((change) => change.path === detailFilePath)
  if (selected) void loadDetailFile(task, selected)
}

function renderTaskDetailActions(task: ProxyTask): void {
  const target = byId('task-detail-actions')
  const controls = document.createElement('div'); controls.className = 'output-actions-inner'
  const busy = task.status === 'running' || task.status === 'queued'
  if (busy) {
    const cancel = document.createElement('button'); cancel.className = 'secondary-button'; cancel.textContent = 'Cancel task'
    cancel.addEventListener('click', () => void window.frontier.cancelTask(task.id)); controls.append(cancel)
  } else {
    const select = document.createElement('select'); select.className = 'detail-provider-select'; select.title = 'Provider for the next message'
    const current = task.continuationProviderId ?? task.selectedProviderId ?? ''
    for (const provider of snapshot.providers) {
      const option = document.createElement('option'); option.value = provider.id
      const selectable = providerSelectableForTask(provider, task)
      option.textContent = `${provider.name}${selectable ? '' : ' · unavailable'}`; option.disabled = !selectable; select.append(option)
    }
    select.value = current
    select.addEventListener('change', async () => {
      const next = select.value
      if (!next || next === current) return
      select.disabled = true
      try { await window.frontier.changeTaskProvider(task.id, next); showToast(`${providerName(next)} selected for the next message`) }
      catch (error) { select.value = current; reportError('Could not change provider', error) }
      finally { select.disabled = false }
    })
    const retry = document.createElement('button'); retry.className = 'secondary-button'; retry.textContent = 'Retry as new task'
    retry.addEventListener('click', async () => {
      try { await persistControlPlaneDraft(); const created = await window.frontier.retryTask(task.id); openTaskDetail(created.id) }
      catch (error) { reportError('Could not retry task', error) }
    })
    controls.append(select, retry)
  }
  target.replaceChildren(controls)
}

function renderTaskDetail(): void {
  if (currentView !== 'task-detail') return
  const task = snapshot.tasks.find((item) => item.id === detailTaskId)
  if (!task) { switchView('tasks'); return }
  byId('task-detail-title').textContent = task.prompt
  byId('task-detail-prompt').textContent = `${task.type} task · ${task.cwd}`
  const status = byId('task-detail-status'); status.textContent = task.status; status.className = `status-pill ${task.status}`
  renderTaskDetailActions(task)
  renderTaskDetailSummary(task)
  renderTaskDetailThread(task)
  renderTaskDetailInspector(task)
  byId('task-detail-file-count').textContent = String(task.filesChanged?.length ?? 0)
  if (detailTab === 'files') renderTaskDetailFiles(task)
  document.querySelectorAll<HTMLElement>('.task-detail-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.detailTab === detailTab))
  const conversation = byId('task-detail-conversation-tab')
  conversation.classList.toggle('active', detailTab === 'conversation')
  conversation.classList.toggle('inspector-open', detailInspectorOpen)
  byId('task-detail-files-tab').classList.toggle('active', detailTab === 'files')
  const inspectorToggle = byId<HTMLButtonElement>('task-detail-inspector-toggle')
  inspectorToggle.hidden = detailTab !== 'conversation'
  inspectorToggle.textContent = detailInspectorOpen ? 'Hide activity' : 'Show activity'
  inspectorToggle.setAttribute('aria-pressed', String(detailInspectorOpen))
}

function openTaskDetail(taskId: string): void {
  selectedTaskId = taskId
  if (detailTaskId !== taskId) {
    detailTaskId = taskId; detailTab = 'conversation'; detailInspectorOpen = false; detailFilePath = undefined; detailFileState = undefined; detailFileRequest += 1
  }
  switchView('task-detail')
}

function render(): void {
  renderMetrics(); renderMiniProviders(); renderTasks(); renderProviders(); renderTaskProviderOptions(); renderUsage(); renderSettings(); renderTaskDetail()
}

const VIEW_TITLES: Record<string, string> = { tasks: 'Tasks', 'task-detail': 'Task workspace', providers: 'Providers', control: 'Context & Tools', usage: 'Usage', settings: 'Settings' }

function switchView(view: string): void {
  currentView = view
  document.querySelector('main')?.classList.toggle('task-detail-active', view === 'task-detail')
  const navView = view === 'task-detail' ? 'tasks' : view
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', (item as HTMLElement).dataset.view === navView))
  document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item.id === `${view}-view`))
  byId('view-title').textContent = VIEW_TITLES[view] ?? view
  byId('new-task-button').style.display = view === 'tasks' ? '' : 'none'
  // Render the control plane from the draft only on entry so streaming snapshots
  // never clobber in-progress edits.
  if (view === 'control') renderControlPlane()
  if (view === 'task-detail') renderTaskDetail()
}

document.querySelectorAll<HTMLElement>('.nav-item').forEach((item) => item.addEventListener('click', () => switchView(item.dataset.view ?? 'tasks')))
byId('task-detail-back').addEventListener('click', () => switchView('tasks'))
document.querySelectorAll<HTMLElement>('.task-detail-tab').forEach((tab) => tab.addEventListener('click', () => {
  detailTab = tab.dataset.detailTab === 'files' ? 'files' : 'conversation'
  renderTaskDetail()
}))
byId('task-detail-inspector-toggle').addEventListener('click', () => {
  detailInspectorOpen = !detailInspectorOpen
  renderTaskDetail()
})
byId('task-file-mode').querySelectorAll<HTMLElement>('button').forEach((button) => button.addEventListener('click', () => {
  detailFileMode = button.dataset.fileMode === 'source' ? 'source' : 'diff'
  renderTaskFileViewer(detailFileState?.file)
}))
byId('new-task-button').addEventListener('click', () => taskDialog.showModal())
byId('close-dialog').addEventListener('click', () => taskDialog.close())
byId('cancel-dialog').addEventListener('click', () => taskDialog.close())
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
  try { await window.frontier.checkProviders(); showToast('Provider health refreshed') }
  catch (error) { reportError('Provider check failed', error) }
  finally { button.disabled = false; button.textContent = '↻ Check providers' }
})
byId<HTMLInputElement>('task-search').addEventListener('input', (event) => {
  taskQuery = (event.target as HTMLInputElement).value.trim().toLowerCase()
  renderTasks()
})
// Keyboard shortcuts: ⌘/Ctrl+K focuses search, ⌘/Ctrl+N opens a new task.
window.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey)) return
  if (event.key === 'k') { event.preventDefault(); switchView('tasks'); byId<HTMLInputElement>('task-search').focus() }
  else if (event.key === 'n') { event.preventDefault(); if (!taskDialog.open) taskDialog.showModal() }
})
// Draggable divider between the work queue and live output.
;(function setupResizer(): void {
  const grid = byId('content-grid')
  const gutter = byId('grid-gutter')
  const stored = Number(localStorage.getItem('fp-wq-width'))
  if (stored > 0) grid.style.gridTemplateColumns = `${stored}px 7px minmax(430px, 1.1fr)`
  let dragging = false
  gutter.addEventListener('mousedown', (event) => { dragging = true; gutter.classList.add('dragging'); document.body.style.userSelect = 'none'; event.preventDefault() })
  window.addEventListener('mousemove', (event) => {
    if (!dragging) return
    const rect = grid.getBoundingClientRect()
    const left = Math.min(Math.max(300, event.clientX - rect.left), rect.width - 360)
    grid.style.gridTemplateColumns = `${left}px 7px minmax(360px, 1.1fr)`
  })
  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false; gutter.classList.remove('dragging'); document.body.style.userSelect = ''
    const left = Math.round(byId('task-list').closest('.task-panel')!.getBoundingClientRect().width)
    localStorage.setItem('fp-wq-width', String(left))
  })
})()

async function sendFollowUp(): Promise<void> {
  const input = byId<HTMLTextAreaElement>('composer-input')
  const text = input.value.trim()
  if (!text || !selectedTaskId) return
  const send = byId<HTMLButtonElement>('composer-send'); send.disabled = true; input.disabled = true
  try { await persistControlPlaneDraft(); await window.frontier.continueTask(selectedTaskId, text); input.value = '' }
  catch (error) { reportError('Could not continue the conversation', error) }
  finally { send.disabled = false; input.disabled = false; input.focus() }
}
byId('composer-send').addEventListener('click', () => void sendFollowUp())
byId<HTMLTextAreaElement>('composer-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendFollowUp() }
})
async function sendTaskDetailFollowUp(): Promise<void> {
  const input = byId<HTMLTextAreaElement>('task-detail-composer-input')
  const text = input.value.trim()
  if (!text || !detailTaskId) return
  const send = byId<HTMLButtonElement>('task-detail-composer-send'); send.disabled = true; input.disabled = true
  try { await persistControlPlaneDraft(); await window.frontier.continueTask(detailTaskId, text); input.value = '' }
  catch (error) { reportError('Could not continue the conversation', error) }
  finally { send.disabled = false; input.disabled = false; input.focus() }
}
byId('task-detail-composer-send').addEventListener('click', () => void sendTaskDetailFollowUp())
byId<HTMLTextAreaElement>('task-detail-composer-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendTaskDetailFollowUp() }
})
byId('clear-finished').addEventListener('click', () => void window.frontier.clearFinishedTasks())
byId('usage-refresh').addEventListener('click', async () => {
  try { await window.frontier.checkProviders(); showToast('Usage refreshed') } catch (error) { reportError('Refresh failed', error) }
})
byId('add-provider').addEventListener('click', async () => {
  try {
    await window.frontier.addCustomProvider()
    showToast('Custom CLI added — configure it below')
    requestAnimationFrame(() => document.querySelector('.provider-card:last-child')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  } catch (error) { reportError('Could not add provider', error) }
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
  for (const [name, def] of Object.entries(map)) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) continue
    const isStdio = typeof def.command === 'string'
    draft.mcpServers.push({
      id: newId(), name, enabled: def.enabled !== false,
      transport: isStdio ? 'stdio' : def.type === 'sse' ? 'sse' : 'http',
      command: isStdio ? String(def.command) : undefined,
      args: Array.isArray(def.args) ? def.args.map(String) : undefined,
      env: def.env && typeof def.env === 'object' ? def.env as Record<string, string> : undefined,
      url: !isStdio && typeof def.url === 'string' ? def.url : undefined,
      headers: def.headers && typeof def.headers === 'object' ? def.headers as Record<string, string> : undefined
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
    renderMcpServers(); void refreshPreview()
    showToast(`Imported ${count} MCP server${count === 1 ? '' : 's'}`)
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

// Re-scope the model dropdown when the provider override changes; toggle the
// custom-model input when "Custom model…" is picked.
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

byId<HTMLFormElement>('task-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const errorNode = byId('form-error'); errorNode.textContent = ''
  try {
    await persistControlPlaneDraft()
    const task = await window.frontier.createTask({
      prompt: byId<HTMLTextAreaElement>('prompt').value,
      cwd: byId<HTMLInputElement>('cwd').value,
      mode: byId<HTMLSelectElement>('routing-mode').value as 'balanced' | 'quality' | 'saver',
      preferredProviderId: byId<HTMLSelectElement>('provider-override').value || undefined,
      model: selectedModel(),
      orchestrate: byId<HTMLInputElement>('task-orchestrate').checked
    })
    selectedTaskId = task.id
    byId<HTMLTextAreaElement>('prompt').value = ''
    byId<HTMLSelectElement>('task-model-select').value = ''
    byId<HTMLInputElement>('task-model').value = ''
    byId<HTMLInputElement>('task-model').hidden = true
    byId<HTMLInputElement>('task-orchestrate').checked = false
    taskDialog.close()
    switchView('tasks')
  } catch (error) { errorNode.textContent = error instanceof Error ? error.message : String(error) }
})

window.addEventListener('unhandledrejection', (event) => reportError('Unexpected application error', event.reason))

window.frontier.onSnapshot((next) => { snapshot = next; render() })
window.frontier.onStream((event) => {
  if (event.taskId === selectedTaskId) {
    const output = byId<HTMLPreElement>('output-content')
    output.scrollTop = output.scrollHeight
  }
})

void window.frontier.getSnapshot()
  .then((initial) => { snapshot = initial; render() })
  .catch((error) => reportError('Could not connect to the Frontier service', error))
