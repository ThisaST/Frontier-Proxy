import './styles.css'
import type { AppSnapshot, ProviderConfig, ProxyTask } from '../../shared/types'

let snapshot: AppSnapshot
let selectedTaskId: string | undefined
let toastTimer: number | undefined

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
  if (!selectedTaskId || !snapshot.tasks.some((task) => task.id === selectedTaskId)) selectedTaskId = snapshot.tasks[0].id
  container.replaceChildren(...snapshot.tasks.map((task) => {
    const row = document.createElement('div')
    row.className = `task-row ${task.id === selectedTaskId ? 'selected' : ''}`
    row.dataset.taskId = task.id
    const dot = document.createElement('span'); dot.className = `task-state-dot ${task.status}`
    const body = document.createElement('div')
    const title = document.createElement('div'); title.className = 'task-title'; title.textContent = task.prompt
    const meta = document.createElement('div'); meta.className = 'task-meta'
    for (const value of [task.type, providerName(task.selectedProviderId), task.mode]) {
      const tag = document.createElement('span'); tag.textContent = value; meta.append(tag)
    }
    body.append(title, meta)
    const time = document.createElement('span'); time.className = 'task-time'; time.textContent = timeAgo(task.createdAt)
    row.append(dot, body, time)
    row.addEventListener('click', () => { selectedTaskId = task.id; renderTasks() })
    return row
  }))
  renderOutput()
}

function renderOutput(): void {
  const task = snapshot.tasks.find((item) => item.id === selectedTaskId)
  const title = byId('output-title')
  const status = byId('output-status')
  const output = byId<HTMLPreElement>('output-content')
  const header = title.parentElement?.parentElement
  header?.querySelector('.output-actions')?.remove()
  if (!task) {
    title.textContent = 'Select a task'
    status.textContent = 'Idle'; status.className = 'status-pill muted'
    output.textContent = 'Choose a task from the queue to inspect its routed provider, attempts, and output.'
    return
  }
  title.textContent = providerName(task.selectedProviderId)
  status.textContent = task.status; status.className = `status-pill ${task.status}`
  const attemptSummary = task.attempts.map((attempt) => `${providerName(attempt.providerId)} · ${attempt.status}`).join('  →  ')
  output.textContent = `${attemptSummary ? `Route: ${attemptSummary}\nWorking directory: ${task.cwd}\n\n` : ''}${task.output || task.error || 'Waiting for provider output…'}${task.error && task.output ? `\n\nError: ${task.error}` : ''}`
  output.scrollTop = output.scrollHeight

  const actions = document.createElement('div'); actions.className = 'output-actions'
  if (task.status === 'running' || task.status === 'queued') {
    const cancel = document.createElement('button'); cancel.className = 'secondary-button'; cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => void window.frontier.cancelTask(task.id))
    actions.append(cancel)
  } else {
    const retry = document.createElement('button'); retry.className = 'secondary-button'; retry.textContent = 'Retry'
    retry.addEventListener('click', async () => { const created = await window.frontier.retryTask(task.id); selectedTaskId = created.id })
    actions.append(retry)
  }
  header?.append(actions)
}

function field(labelText: string, input: HTMLInputElement, wide = false): HTMLLabelElement {
  const label = document.createElement('label'); if (wide) label.className = 'wide'
  label.append(labelText, input); return label
}

function textInput(value: string, type = 'text'): HTMLInputElement {
  const input = document.createElement('input'); input.type = type; input.value = value; return input
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
          args: args.value.trim() ? splitArguments(args.value) : undefined
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
}

function renderSettings(): void {
  byId<HTMLInputElement>('max-parallel').value = String(snapshot.settings.maxParallelTasks)
  byId<HTMLInputElement>('cooldown-minutes').value = String(snapshot.settings.quotaCooldownMinutes)
}

function render(): void {
  renderMetrics(); renderMiniProviders(); renderTasks(); renderProviders(); renderTaskProviderOptions(); renderSettings()
}

function switchView(view: string): void {
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', (item as HTMLElement).dataset.view === view))
  document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item.id === `${view}-view`))
  byId('view-title').textContent = view[0].toUpperCase() + view.slice(1)
  byId('new-task-button').style.display = view === 'tasks' ? '' : 'none'
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
byId('clear-finished').addEventListener('click', () => void window.frontier.clearFinishedTasks())
byId('add-provider').addEventListener('click', async () => {
  try {
    await window.frontier.addCustomProvider()
    showToast('Custom CLI added — configure it below')
    requestAnimationFrame(() => document.querySelector('.provider-card:last-child')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  } catch (error) { reportError('Could not add provider', error) }
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

byId<HTMLFormElement>('task-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const errorNode = byId('form-error'); errorNode.textContent = ''
  try {
    const task = await window.frontier.createTask({
      prompt: byId<HTMLTextAreaElement>('prompt').value,
      cwd: byId<HTMLInputElement>('cwd').value,
      mode: byId<HTMLSelectElement>('routing-mode').value as 'balanced' | 'quality' | 'saver',
      preferredProviderId: byId<HTMLSelectElement>('provider-override').value || undefined
    })
    selectedTaskId = task.id
    byId<HTMLTextAreaElement>('prompt').value = ''
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
