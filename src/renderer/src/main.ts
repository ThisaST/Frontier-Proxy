import './styles.css'
import { renderMarkdown } from './markdown'
import type { AppSnapshot, ControlPlaneProfile, McpServerConfig, McpTransport, ProviderConfig, ProxyTask, TaskAttempt } from '../../shared/types'

let snapshot: AppSnapshot
let selectedTaskId: string | undefined
let toastTimer: number | undefined
let controlPlaneDraft: ControlPlaneProfile | undefined
let taskQuery = ''
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
    const dot = document.createElement('span')
    dot.className = `provider-dot ${provider.runtime.running ? 'busy' : provider.runtime.available ? 'online' : ''}`
    const name = document.createElement('span'); name.textContent = provider.name
    const status = document.createElement('small'); status.textContent = provider.runtime.running ? 'busy' : provider.runtime.available ? 'ready' : 'offline'
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
    if (task.orchestrated) { const tag = document.createElement('span'); tag.className = 'tag-orchestrated'; tag.textContent = 'orchestrated'; meta.append(tag) }
    body.append(title, meta)
    const time = document.createElement('span'); time.className = 'task-time'; time.textContent = timeAgo(task.createdAt)
    row.append(dot, body, time)
    row.addEventListener('click', () => { selectedTaskId = task.id; renderTasks() })
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
  if (task.contextWindow && task.contextTokens) {
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
  if (task.status === 'running' || task.status === 'queued') {
    const cancel = document.createElement('button'); cancel.className = 'secondary-button'; cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => void window.frontier.cancelTask(task.id))
    controls.append(cancel)
  } else {
    const retry = document.createElement('button'); retry.className = 'secondary-button'; retry.textContent = 'Retry'
    retry.addEventListener('click', async () => { const created = await window.frontier.retryTask(task.id); selectedTaskId = created.id })
    controls.append(retry)
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
    const args = textInput(formatArguments(provider.args ?? []))
    form.append(field('Display name', displayName), field('Executable', executable), field('Model (optional)', model), field('Routing priority', priority), field('Daily token budget', budget), field('Extra arguments (quotes supported)', args, true))

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

function renderUsage(): void {
  const grid = byId('usage-grid')
  grid.replaceChildren(...snapshot.providers.map((provider) => {
    const usage = provider.runtime.usage
    const actual = usage.inputTokens + usage.outputTokens
    const estimated = usage.estimatedInputTokens + usage.estimatedOutputTokens
    const hasActual = actual > 0

    const card = document.createElement('article'); card.className = 'panel usage-card'
    const header = document.createElement('div'); header.className = 'usage-card-header'
    const dot = document.createElement('span'); dot.className = `provider-dot ${provider.runtime.running ? 'busy' : provider.runtime.available ? 'online' : ''}`
    const name = document.createElement('h3'); name.textContent = provider.name
    header.append(dot, name)

    const stats = document.createElement('div'); stats.className = 'usage-stats'
    stats.append(
      usageStat('Cost today', formatCost(usage.costUsd)),
      usageStat(hasActual ? 'Input tokens' : 'Input (est.)', formatNumber(hasActual ? usage.inputTokens : usage.estimatedInputTokens)),
      usageStat(hasActual ? 'Output tokens' : 'Output (est.)', formatNumber(hasActual ? usage.outputTokens : usage.estimatedOutputTokens)),
      usageStat('Tasks', String(usage.tasks))
    )

    const footer = document.createElement('div'); footer.className = 'usage-card-footer'
    const session = provider.runtime.session
    if (session?.resetsAt || session?.overageResetsAt) {
      const rows = document.createElement('div'); rows.className = 'usage-session-rows'
      const line = (label: string, iso: string, badge?: string): HTMLElement => {
        const row = document.createElement('div'); row.className = 'usage-session-row'
        const l = document.createElement('span'); l.className = 'usage-session-label'; l.textContent = label
        const v = document.createElement('span'); v.className = 'usage-session-val'; v.textContent = `resets in ${countdown(iso)}`
        row.append(l, v)
        if (badge) { const b = document.createElement('span'); b.className = 'usage-overage'; b.textContent = badge; row.append(b) }
        return row
      }
      if (session.resetsAt) rows.append(line('Limit', session.resetsAt, session.status && session.status !== 'allowed' ? session.status : undefined))
      if (session.overageResetsAt && session.overageResetsAt !== session.resetsAt) rows.append(line('Overage', session.overageResetsAt, session.usingOverage ? 'in use' : undefined))
      else if (session.usingOverage) rows.append((() => { const r = document.createElement('div'); r.className = 'usage-session-row'; const b = document.createElement('span'); b.className = 'usage-overage'; b.textContent = 'overage in use'; r.append(b); return r })())
      footer.append(rows)
    } else {
      const none = document.createElement('span'); none.className = 'usage-session muted'; none.textContent = 'No session data reported'
      footer.append(none)
    }

    card.append(header, stats)
    if (provider.dailyTokenBudget) {
      const used = hasActual ? actual : estimated
      const pct = Math.min(100, Math.round((used / provider.dailyTokenBudget) * 100))
      const budget = document.createElement('div'); budget.className = 'usage-budget'
      const bar = document.createElement('div'); bar.className = 'usage-bar'
      const fill = document.createElement('div'); fill.className = 'usage-bar-fill'; fill.style.width = `${pct}%`
      if (pct >= 90) fill.classList.add('high')
      bar.append(fill)
      const label = document.createElement('div'); label.className = 'usage-budget-label'
      label.textContent = `${pct}% of ${formatNumber(provider.dailyTokenBudget)} daily budget`
      budget.append(bar, label); card.append(budget)
    }
    card.append(footer)
    return card
  }))
}

function render(): void {
  renderMetrics(); renderMiniProviders(); renderTasks(); renderProviders(); renderTaskProviderOptions(); renderUsage(); renderSettings()
}

const VIEW_TITLES: Record<string, string> = { tasks: 'Tasks', providers: 'Providers', control: 'Context & Tools', usage: 'Usage', settings: 'Settings' }

function switchView(view: string): void {
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', (item as HTMLElement).dataset.view === view))
  document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item.id === `${view}-view`))
  byId('view-title').textContent = VIEW_TITLES[view] ?? view
  byId('new-task-button').style.display = view === 'tasks' ? '' : 'none'
  // Render the control plane from the draft only on entry so streaming snapshots
  // never clobber in-progress edits.
  if (view === 'control') renderControlPlane()
}

document.querySelectorAll<HTMLElement>('.nav-item').forEach((item) => item.addEventListener('click', () => switchView(item.dataset.view ?? 'tasks')))
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
  try { await window.frontier.continueTask(selectedTaskId, text); input.value = '' }
  catch (error) { reportError('Could not continue the conversation', error) }
  finally { send.disabled = false; input.disabled = false; input.focus() }
}
byId('composer-send').addEventListener('click', () => void sendFollowUp())
byId<HTMLTextAreaElement>('composer-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendFollowUp() }
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
    const saved = await window.frontier.updateControlPlane(syncDraftFromInputs())
    controlPlaneDraft = cloneProfile(saved.settings.controlPlane)
    showToast('Context & Tools configuration saved')
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
