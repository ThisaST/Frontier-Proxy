// The New Task dialog: thin wiring around the shared `task-form` module (Home's
// composer uses the identical implementation, see `views/home.ts`) plus this
// dialog's own chrome — open/close, the free-text working-directory field, and
// pre-filling that field from the current project.
import { byId } from '../ui/dom'
import { errorMessage, reportError } from '../ui/feedback'
import { createTaskForm, type RunMode } from '../task-form'
import { currentProject } from '../project'
import { setSelectedTaskId, setSurfaceTab } from '../state'
import { switchView } from '../main'

export const taskDialog = byId<HTMLDialogElement>('task-dialog')

const form = createTaskForm({
  root: '#task-dialog',
  promptInput: 'prompt',
  singleOptions: 'single-options',
  benchOptions: 'bench-options',
  benchProviders: 'bench-providers',
  modelField: 'model-field',
  modelSelect: 'task-model-select',
  modelCustom: 'task-model',
  routingModeSelect: 'routing-mode',
  providerOverrideSelect: 'provider-override',
  skillsSummary: 'task-skills-summary',
  skillsList: 'task-skills-list'
})

export const renderTaskProviderOptions = form.renderProviderOptions
export const renderTaskModelOptions = form.renderModelOptions

export function openTaskDialog(mode: RunMode = 'single'): void {
  form.setRunMode(mode)
  const cwd = byId<HTMLInputElement>('cwd')
  if (!cwd.value.trim() && currentProject) cwd.value = currentProject
  if (cwd.value.trim()) void form.loadSkills(cwd.value)
  if (!taskDialog.open) taskDialog.showModal()
}

export function initNewTaskDialog(): void {
  form.init()
  byId('new-task-button').addEventListener('click', () => openTaskDialog())
  byId('close-dialog').addEventListener('click', () => taskDialog.close())
  byId('cancel-dialog').addEventListener('click', () => taskDialog.close())
  taskDialog.addEventListener('close', () => form.resetSkills())
  byId<HTMLInputElement>('cwd').addEventListener('input', (event) => form.scheduleSkillsLoad((event.target as HTMLInputElement).value))
  byId('choose-directory').addEventListener('click', async () => {
    const button = byId<HTMLButtonElement>('choose-directory')
    button.disabled = true
    button.textContent = 'Choosing…'
    try {
      const input = byId<HTMLInputElement>('cwd')
      const directory = await window.frontier.chooseDirectory(input.value)
      if (directory) { input.value = directory; void form.loadSkills(directory) }
    } catch (error) {
      byId('form-error').textContent = `Folder picker failed: ${errorMessage(error)}. You can paste the path manually.`
      reportError('Folder picker failed', error)
    } finally {
      button.disabled = false
      button.textContent = 'Choose folder…'
    }
  })

  byId<HTMLFormElement>('task-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const errorNode = byId('form-error'); errorNode.textContent = ''
    try {
      const task = await form.submit(byId<HTMLInputElement>('cwd').value)
      setSelectedTaskId(task.id)
      setSurfaceTab('conversation')
      taskDialog.close()
      switchView('tasks')
    } catch (error) { errorNode.textContent = errorMessage(error) }
  })
}
