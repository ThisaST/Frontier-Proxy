import './styles/index.css'
import { handleWorkspaceStream, renderWorkspaceView } from './workspace'
import { byId } from './ui/dom'
import { hydrateIcons, icon } from './ui/icons'
import { initTheme } from './theme'
import { reportError } from './ui/feedback'
import { snapshot, setSnapshot, currentView, setCurrentView, selectedTaskId, surfaceTab } from './state'
import { taskIsBusy } from './task-helpers'
import { renderMiniProviders, renderHome, initHomeView } from './views/home'
import { renderTasks, renderSurface, applyQueueWidth, initTasksView } from './views/tasks'
import { renderReview, loadReview, setReviewSelection, setReviewFilePath, initReviewView } from './views/review'
import { agentsTab, renderAgentsTab, renderUsage, initAgentsView } from './views/agents'
import { renderControlPlane, initControlView } from './views/control'
import { renderSkills, initSkillsView } from './views/skills'
import { renderSettings, initSettingsView } from './views/settings'
import { renderTaskProviderOptions, initNewTaskDialog } from './dialogs/new-task'
import { initCommandPalette } from './command-palette'
import { initComposerInputs } from './composer'

// --- Shell ---

function render(): void {
  // Every renderer below reads the snapshot. It arrives asynchronously, and the
  // user can click a nav item before it does.
  if (typeof snapshot === 'undefined') return
  renderMiniProviders(); renderTasks(); renderTaskProviderOptions(); renderSettings()
  if (currentView === 'home') renderHome()
  if (currentView === 'agents') renderAgentsTab()
  if (currentView === 'review') renderReview()
  if (currentView === 'workspace') renderWorkspaceView(snapshot)
}

const VIEW_META: Record<string, { title: string; eyebrow: string }> = {
  home: { title: 'Home', eyebrow: 'MISSION CONTROL' },
  tasks: { title: 'Tasks', eyebrow: 'ORCHESTRATION CONSOLE' },
  workspace: { title: 'Workspaces', eyebrow: 'COLLABORATIVE WORKSPACES' },
  review: { title: 'Review', eyebrow: 'BRANCH INBOX' },
  agents: { title: 'Agents', eyebrow: 'LOCAL EXECUTABLES' },
  control: { title: 'Context & Tools', eyebrow: 'CONTROL PLANE' },
  skills: { title: 'Skills', eyebrow: 'AGENT CAPABILITIES' },
  settings: { title: 'Settings', eyebrow: 'PREFERENCES' }
}

// Single code path for "open this branch in Review" — used by the bench-lane
// chip, the home-screen waiting-review list, and the workspace turn's branch
// chip, so all three land on the same diff instead of just the Review view.
export function openBranchInReview(cwd: string, branch: string): void {
  setReviewSelection({ cwd, branch })
  setReviewFilePath(undefined)
  switchView('review')
}

export function switchView(view: string): void {
  setCurrentView(view)
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
  byId('new-task-button').style.display = view === 'review' || view === 'control' || view === 'skills' || view === 'workspace' ? 'none' : ''
  // The first snapshot may still be in flight — clicking a nav item before it
  // lands used to throw here and leave the view empty. render() repaints the
  // active view as soon as the snapshot arrives.
  if (typeof snapshot === 'undefined') return
  // Render the control plane from the draft only on entry so streaming snapshots
  // never clobber in-progress edits.
  if (view === 'control') renderControlPlane()
  if (view === 'skills') void renderSkills()
  if (view === 'agents') renderAgentsTab()
  if (view === 'home') renderHome()
  if (view === 'tasks') { renderTasks(); applyQueueWidth() }
  if (view === 'review') { renderReview(); void loadReview(true) }
  if (view === 'workspace') renderWorkspaceView(snapshot)
}

const SIDEBAR_STATE_KEY = 'fp-sidebar-collapsed'

function setSidebarCollapsed(collapsed: boolean, persist = true): void {
  const shell = document.querySelector<HTMLElement>('.shell')
  const toggle = byId<HTMLButtonElement>('sidebar-toggle')
  shell?.classList.toggle('sidebar-collapsed', collapsed)
  toggle.setAttribute('aria-expanded', String(!collapsed))
  toggle.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation')
  toggle.title = collapsed ? 'Expand navigation' : 'Collapse navigation'
  toggle.replaceChildren(icon(collapsed ? 'chevron-right' : 'chevron-left'))
  if (persist) localStorage.setItem(SIDEBAR_STATE_KEY, String(collapsed))
}

initTheme()
hydrateIcons()
setSidebarCollapsed(localStorage.getItem(SIDEBAR_STATE_KEY) === 'true', false)
byId('sidebar-toggle').addEventListener('click', () => {
  setSidebarCollapsed(!document.querySelector('.shell')?.classList.contains('sidebar-collapsed'))
})
document.querySelectorAll<HTMLElement>('.nav-item').forEach((item) => item.addEventListener('click', () => switchView(item.dataset.view ?? 'home')))

initHomeView()
initReviewView()
initTasksView()
initAgentsView()
initNewTaskDialog()
initSkillsView()
initCommandPalette()
initComposerInputs()
initControlView()
initSettingsView()

window.addEventListener('unhandledrejection', (event) => reportError('Unexpected application error', event.reason))

window.frontier.onSnapshot((next) => {
  const finishedBefore = new Set(snapshot?.tasks.filter((task) => taskIsBusy(task)).map((task) => task.id) ?? [])
  setSnapshot(next)
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
window.frontier.onWorkspaceStream(handleWorkspaceStream)

void window.frontier.getSnapshot()
  .then((initial) => { setSnapshot(initial); switchView('home'); render(); void loadReview() })
  .catch((error) => reportError('Could not connect to the Frontier service', error))

// Reset countdowns and expired-window state should keep moving even when no
// provider emits a new snapshot.
window.setInterval(() => {
  if (typeof snapshot === 'undefined') return
  renderMiniProviders()
  if (currentView === 'home') renderHome()
  if (currentView === 'agents' && agentsTab === 'usage') renderUsage()
}, 30_000)
