// Tasks' compose state (P4): the one composer and the one place to start work. It replaced both
// Home and the ⌘N dialog. The dock's New button, ⌘N, the queue's + button and the palette's
// "New task" / "Compare agents" all land here through enterCompose(). It lives in the Tasks
// centre pane (#compose-pane); views/tasks.ts shows it whenever state.composing is true.
import type { AdvisorPreviewResult, RoutingMode } from '../../../shared/types'
import { byId, element, emptyState } from '../ui/dom'
import { status } from '../ui/components'
import { icon } from '../ui/icons'
import { announce } from '../ui/announce'
import { errorMessage, reportError } from '../ui/feedback'
import { baseName, timeAgo } from '../ui/format'
import { providerName } from '../providers-view-model'
import { benchPreviewText, routePreview, routePreviewText, taskNeedsReview, taskStatusIndicator, taskStatusWord } from '../task-helpers'
import { createTaskForm, type RunMode } from '../task-form'
import { chooseProjectInteractively, currentProject, onProjectChange, projectMatches } from '../project'
import { applyTaskSurface, currentView, snapshot } from '../state'
import { openTask } from './tasks'
import { switchView } from '../main'

const MODE_HELP: Record<RunMode, string> = {
  single: 'Frontier picks the best available agent, and fails over if it hits a limit.',
  orchestrate: 'A planner breaks the work into subtasks, runs each on its own isolated branch, then reports back.',
  bench: 'The same prompt runs on several agents at once, each on its own branch, so you can compare the results side by side.'
}
const POLICY_NAMES: Record<string, string> = { balanced: 'Balanced', quality: 'Quality first', saver: 'Token saver' }
const RECENT_COUNT = 5

const form = createTaskForm({
  root: '#compose-root',
  promptInput: 'compose-prompt',
  singleOptions: 'compose-single-options',
  benchOptions: 'compose-bench-options',
  benchProviders: 'compose-bench-providers',
  modelField: 'compose-model-field',
  modelSelect: 'compose-model-select',
  modelCustom: 'compose-model',
  routingModeSelect: 'compose-routing-mode',
  providerOverrideSelect: 'compose-provider-override',
  skillsSummary: 'compose-skills-summary',
  skillsList: 'compose-skills-list',
  onRunModeChange: (mode) => {
    byId('compose-mode-help').textContent = MODE_HELP[mode]
    renderOptionsSummary()
    schedulePreview()
  }
})

// --- Entering compose ---

// Clears the selection, shows the composer, and puts the cursor in it. The prompt is not
// cleared: a draft typed earlier is still there when the user comes back.
export function enterCompose(mode?: RunMode): void {
  applyTaskSurface({ kind: 'compose' })
  switchView('tasks')
  if (mode) form.setRunMode(mode)
  // After the palette's own close (which restores focus to its opener) has run.
  window.setTimeout(() => byId<HTMLTextAreaElement>('compose-prompt').focus(), 0)
}

// --- Project field ---
// Start needs a concrete project even when the header switcher says "All projects", so the field
// stays inside the composer (ui-plan §10.1 row 12). Choosing here scopes the whole app, as the
// header switcher does.
function renderProjectField(): void {
  const field = byId<HTMLButtonElement>('compose-project')
  field.replaceChildren(icon(currentProject ? 'folder' : 'folder-open', 14), element('span', 'compose-project-name', currentProject ? baseName(currentProject) : 'Choose project'))
  field.title = currentProject ?? 'Choose a project to start work in'
  field.classList.toggle('unset', !currentProject)
  const start = byId<HTMLButtonElement>('compose-start')
  start.disabled = !currentProject
  start.title = currentProject ? 'Start task (⌘↵)' : 'Choose a project before starting a task'
}

// --- Options summary (shown while the Options row is collapsed) ---

function renderOptionsSummary(): void {
  const provider = byId<HTMLSelectElement>('compose-provider-override')
  const parts = form.runMode() === 'bench' ? [] : [
    POLICY_NAMES[byId<HTMLSelectElement>('compose-routing-mode').value] ?? 'Balanced',
    provider.selectedOptions[0]?.textContent ?? 'Automatic',
    form.selectedModel() ?? 'Provider default'
  ]
  parts.push(`Skills ${byId('compose-skills-summary').textContent?.toLowerCase() ?? ''}`.trim())
  byId('compose-options-summary').textContent = parts.join(' · ')
}

// --- Route preview: one line ---

function setRouteLine(nodes: Array<Node | string>, state: 'idle' | 'loading' | 'ready' = 'ready'): void {
  const line = byId('compose-route')
  line.dataset.state = state
  line.replaceChildren(...nodes)
}

function renderRouteIdle(message = 'Type a prompt to see which agent Frontier would pick.'): void { setRouteLine([message], 'idle') }

function renderRouteResult(result: AdvisorPreviewResult): void {
  const providerId = result.decision.chosenProviderId
  const provider = providerId ? snapshot.providers.find((item) => item.id === providerId) : undefined
  const advisor = snapshot.settings.advisor
  const options = { runMode: form.runMode() === 'orchestrate' ? 'orchestrate' as const : 'single' as const, advisorDecidesAtStart: advisor.mode !== 'off' && snapshot.advisor.hasKey && !advisor.previewWhileTyping }
  const preview = routePreview(result, provider, options)
  announce('route-preview', `Route preview: ${routePreviewText(result, provider, options)}`)
  if (!preview) { renderRouteIdle('No agent is currently eligible to run this.'); return }
  setRouteLine([
    `${preview.lead} `, element('strong', undefined, preview.agent), ' · ', element('span', 'readout', preview.model), ` · ${preview.tier}`,
    ...(preview.notes.length ? [` — ${preview.notes.join('. ')}`] : [])
  ])
}

function renderBenchPreview(): void {
  const names = form.selectedBenchProviders().map((id) => providerName(id))
  setRouteLine([benchPreviewText(names)], names.length < 2 ? 'idle' : 'ready')
}

let previewSeq = 0
let previewDebounce: number | undefined

function schedulePreview(): void {
  window.clearTimeout(previewDebounce)
  if (form.runMode() === 'bench') { previewSeq += 1; renderBenchPreview(); return }
  const prompt = byId<HTMLTextAreaElement>('compose-prompt').value.trim()
  if (!prompt || !currentProject) { previewSeq += 1; renderRouteIdle(currentProject ? undefined : 'Choose a project to see which agent Frontier would pick.'); return }
  const cwd = currentProject
  previewDebounce = window.setTimeout(() => void runPreview(prompt, cwd), 400)
}

async function runPreview(prompt: string, cwd: string): Promise<void> {
  setRouteLine([status('running', 'Working out the route…')], 'loading')
  const sequence = ++previewSeq
  try {
    const result = await window.frontier.previewAdvisor({
      prompt,
      cwd,
      policy: byId<HTMLSelectElement>('compose-routing-mode').value as RoutingMode,
      preferredProviderId: byId<HTMLSelectElement>('compose-provider-override').value || undefined,
      model: form.selectedModel(),
      modelProviderId: form.selectedModelProvider()
    })
    if (sequence !== previewSeq) return // a newer keystroke already asked again
    renderRouteResult(result)
  } catch (error) {
    if (sequence !== previewSeq) return
    renderRouteIdle(errorMessage(error))
  }
}

// --- Skills: the catalog belongs to the project ---

let skillsCwd: string | undefined
let skillsLoaded = false
// Needs the snapshot (the default selection is the global disabled-set), so it runs from render.
function ensureSkills(force = false): void {
  if (typeof snapshot === 'undefined' || (!force && skillsLoaded && skillsCwd === currentProject)) return
  skillsLoaded = true
  skillsCwd = currentProject
  if (currentProject) void form.loadSkills(currentProject).then(renderOptionsSummary)
  else { form.resetSkills(); renderOptionsSummary() }
}

// --- Start ---

async function submitComposeTask(): Promise<void> {
  const errorNode = byId('compose-error'); errorNode.textContent = ''
  if (!currentProject) { errorNode.textContent = 'Choose a project before starting a task.'; return }
  if (!byId<HTMLTextAreaElement>('compose-prompt').value.trim()) { errorNode.textContent = 'Describe the task first.'; byId('compose-prompt').focus(); return }
  const button = byId<HTMLButtonElement>('compose-start')
  button.disabled = true
  try {
    const task = await form.submit(currentProject)
    renderRouteIdle()
    ensureSkills(true) // the next task starts from the default skill set again
    openTask(task.id)
  } catch (error) {
    errorNode.textContent = errorMessage(error)
    reportError('Could not start the task', error)
  } finally {
    button.disabled = !currentProject
  }
}

// --- Recent: the last five tasks in this project ---

function renderRecent(): void {
  const list = byId('compose-recent-list')
  const recent = snapshot.tasks.filter((task) => projectMatches(task.cwd))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).slice(0, RECENT_COUNT)
  if (!recent.length) { list.replaceChildren(emptyState('Nothing yet', 'Tasks you start appear here and in the queue.')); return }
  list.replaceChildren(...recent.map((task) => {
    const needsReview = taskNeedsReview(task)
    const row = element('button', 'row compose-recent-row') as HTMLButtonElement
    row.type = 'button'
    const main = element('span', 'row-main')
    main.append(element('span', 'row-title', task.prompt), element('span', 'row-meta', `${task.bench ? 'Compare' : providerName(task.selectedProviderId)} · ${timeAgo(task.createdAt)}`))
    row.append(taskStatusIndicator(task.status, { needsReview }), main, element('span', 'compose-recent-status', taskStatusWord(task.status, needsReview)))
    row.addEventListener('click', () => openTask(task.id))
    return row
  }))
}

// Provider and model options are rebuilt only when what they list changes, so a streamed
// snapshot never closes an open dropdown or resets a choice (CLAUDE.md, "Live snapshots must not
// clobber an unsaved form edit"). The selects keep their value across a rebuild as well.
let providerSignature = ''

export function renderCompose(): void {
  renderProjectField()
  ensureSkills()
  const signature = snapshot.providers.map((provider) => `${provider.id}:${provider.enabled}:${provider.runtime.available}:${provider.name}:${(provider.runtime.models ?? []).join(',')}`).join('|')
  if (signature !== providerSignature) {
    providerSignature = signature
    form.renderProviderOptions()
    if (form.runMode() === 'bench') { form.renderBenchProviders(); renderBenchPreview() }
    renderOptionsSummary()
  }
  renderRecent()
}

export function initComposeView(): void {
  form.init()
  byId('compose-project').addEventListener('click', () => void chooseProjectInteractively())
  byId('compose-start').addEventListener('click', () => void submitComposeTask())
  byId('new-task-button').addEventListener('click', () => enterCompose())
  byId('queue-new-task').addEventListener('click', () => enterCompose())

  const prompt = byId<HTMLTextAreaElement>('compose-prompt')
  prompt.addEventListener('input', () => { byId('compose-error').textContent = ''; schedulePreview() })
  prompt.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void submitComposeTask() }
  })
  for (const id of ['compose-routing-mode', 'compose-provider-override', 'compose-model-select']) {
    byId(id).addEventListener('change', () => { renderOptionsSummary(); schedulePreview() })
  }
  byId('compose-model').addEventListener('input', () => { renderOptionsSummary(); schedulePreview() })
  byId('compose-bench-providers').addEventListener('change', () => schedulePreview())
  byId('compose-skills-list').addEventListener('change', () => renderOptionsSummary())

  onProjectChange(() => {
    renderProjectField()
    ensureSkills()
    schedulePreview()
    if (typeof snapshot !== 'undefined' && currentView === 'tasks') renderRecent()
  })
  renderProjectField()
  renderRouteIdle()
}
