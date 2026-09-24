// The New Task dialog: run mode (single/split/compare), bench agent picker,
// per-task skills selector, model picker, and the create-task submit flow.
import type { SkillCatalog } from '../../../shared/types'
import { byId, element, emptyState } from '../ui/dom'
import { errorMessage, reportError } from '../ui/feedback'
import { messageContext, composerDraft, clearComposerDraft, attachmentPreviewCache } from '../composer'
import { persistControlPlaneDraft } from '../views/control'
import { snapshot, setSelectedTaskId, setSurfaceTab } from '../state'
import { switchView } from '../main'

export const taskDialog = byId<HTMLDialogElement>('task-dialog')

export type RunMode = 'single' | 'orchestrate' | 'bench'
let runMode: RunMode = 'single'

export function setRunMode(mode: RunMode): void {
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
  resetTaskSkillsState()
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

// --- New-task dialog: skills selector ---
// Absolute pre-check set (not a delta): everything not globally disabled.
let taskSkillsCatalog: SkillCatalog | undefined
let taskSkillsSelection = new Set<string>()
let taskSkillsTouched = false
let taskSkillsDebounce: number | undefined

function defaultTaskSkillsSelection(catalog: SkillCatalog): Set<string> {
  const disabled = new Set(snapshot.settings.skills.disabledIds)
  return new Set(catalog.skills.filter((skill) => !disabled.has(skill.id)).map((skill) => skill.id))
}

function updateTaskSkillsSummary(): void {
  byId('task-skills-summary').textContent = `Skills · ${taskSkillsSelection.size} enabled${runMode === 'bench' ? ' · applies to every lane' : ''}`
}

function renderTaskSkillsField(): void {
  const list = byId('task-skills-list')
  updateTaskSkillsSummary()
  if (!taskSkillsCatalog) { list.replaceChildren(emptyState('No skills scanned yet', 'Choose a working directory to see the skills Frontier found.')); return }
  if (!taskSkillsCatalog.skills.length) { list.replaceChildren(emptyState('No skills found', 'No SKILL.md folders were found for this project.')); return }
  list.replaceChildren(...taskSkillsCatalog.skills.map((skill) => {
    const label = document.createElement('label'); label.className = 'task-skill-item'
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = taskSkillsSelection.has(skill.id)
    input.addEventListener('change', () => {
      taskSkillsTouched = true
      if (input.checked) taskSkillsSelection.add(skill.id); else taskSkillsSelection.delete(skill.id)
      // Only the count changed — repainting the list would drop focus mid-toggle.
      updateTaskSkillsSummary()
    })
    const body = element('span', 'task-skill-body')
    body.append(element('strong', undefined, skill.name), element('small', undefined, skill.description || 'No description provided.'))
    label.append(input, body)
    return label
  }))
}

function resetTaskSkillsState(): void {
  window.clearTimeout(taskSkillsDebounce)
  taskSkillsCatalog = undefined
  taskSkillsSelection = new Set()
  taskSkillsTouched = false
  renderTaskSkillsField()
}

// A new cwd means a different catalog, so the pre-check set is recomputed and
// any prior touch no longer applies to skills that may not even exist here.
async function loadTaskSkills(cwd: string): Promise<void> {
  const trimmed = cwd.trim()
  if (!trimmed) { resetTaskSkillsState(); return }
  try {
    const catalog = await window.frontier.listSkills(trimmed)
    taskSkillsCatalog = catalog
    taskSkillsSelection = defaultTaskSkillsSelection(catalog)
    taskSkillsTouched = false
  } catch {
    // A path that doesn't resolve yet is normal mid-typing; leave the field as-is.
    return
  }
  renderTaskSkillsField()
}

function scheduleTaskSkillsLoad(cwd: string): void {
  window.clearTimeout(taskSkillsDebounce)
  taskSkillsDebounce = window.setTimeout(() => void loadTaskSkills(cwd), 300)
}

export function renderTaskProviderOptions(): void {
  const select = byId<HTMLSelectElement>('provider-override')
  const current = select.value
  select.replaceChildren(new Option('Automatic', ''), ...snapshot.providers.filter((provider) => provider.enabled).map((provider) => new Option(provider.name, provider.id)))
  select.value = current
  renderTaskModelOptions()
}

// Populate the model dropdown from discovered/known models, scoped to the chosen
// agent (or grouped by agent under Automatic).
export function renderTaskModelOptions(): void {
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

export function openTaskDialog(mode: RunMode = 'single'): void {
  setRunMode(mode)
  const cwd = byId<HTMLInputElement>('cwd').value
  if (cwd.trim()) void loadTaskSkills(cwd)
  if (!taskDialog.open) taskDialog.showModal()
}

export function initNewTaskDialog(): void {
  byId('new-task-button').addEventListener('click', () => openTaskDialog())
  byId('close-dialog').addEventListener('click', () => taskDialog.close())
  byId('cancel-dialog').addEventListener('click', () => taskDialog.close())
  taskDialog.addEventListener('close', () => resetTaskSkillsState())
  document.querySelectorAll<HTMLElement>('.run-mode').forEach((button) => button.addEventListener('click', () => setRunMode((button.dataset.runMode as RunMode) ?? 'single')))
  byId<HTMLInputElement>('cwd').addEventListener('input', (event) => scheduleTaskSkillsLoad((event.target as HTMLInputElement).value))
  byId('choose-directory').addEventListener('click', async () => {
    const button = byId<HTMLButtonElement>('choose-directory')
    button.disabled = true
    button.textContent = 'Choosing…'
    try {
      const input = byId<HTMLInputElement>('cwd')
      const directory = await window.frontier.chooseDirectory(input.value)
      if (directory) { input.value = directory; void loadTaskSkills(directory) }
    } catch (error) {
      byId('form-error').textContent = `Folder picker failed: ${errorMessage(error)}. You can paste the path manually.`
      reportError('Folder picker failed', error)
    } finally {
      button.disabled = false
      button.textContent = 'Choose folder…'
    }
  })

  byId<HTMLSelectElement>('provider-override').addEventListener('change', renderTaskModelOptions)
  byId<HTMLSelectElement>('task-model-select').addEventListener('change', () => {
    const custom = byId<HTMLInputElement>('task-model')
    custom.hidden = byId<HTMLSelectElement>('task-model-select').value !== '__custom__'
    if (!custom.hidden) custom.focus()
  })

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
        attachments: messageContext('prompt', prompt),
        skillIds: taskSkillsTouched ? [...taskSkillsSelection] : undefined
      })
      for (const item of composerDraft('prompt').items) {
        const preview = composerDraft('prompt').previews.get(item.id)
        if (preview) attachmentPreviewCache.set(`${task.id}:${item.id}`, preview)
      }
      setSelectedTaskId(task.id)
      setSurfaceTab('conversation')
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
}
