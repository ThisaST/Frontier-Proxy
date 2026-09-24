import './styles/index.css'
import { handleWorkspaceStream, renderWorkspaceView } from './workspace'
import { byId } from './ui/dom'
import { hydrateIcons, icon } from './ui/icons'
import { initTheme } from './theme'
import { reportError } from './ui/feedback'
import { snapshot, setSnapshot, currentView, setCurrentView, selectedTaskId } from './state'
import { taskIsBusy } from './task-helpers'
import { renderMiniProviders, renderHome, initHomeView } from './views/home'
import { renderTasks, renderSurface, applyQueueWidth, applyInspectorWidth, applyInspectorState, initTasksView } from './views/tasks'
import { renderReview, loadReview, setReviewSelection, setReviewFilePath, initReviewView } from './views/review'
import { renderAgentsView, refreshAgentDrawer, initAgentsView } from './views/agents'
import { renderControlPlane, initControlView } from './views/control'
import { renderSkills, initSkillsView } from './views/skills'
import { renderRouting, initRoutingView } from './views/routing'
import { renderSettings, initSettingsView } from './views/settings'
import { renderTaskProviderOptions, initNewTaskDialog } from './dialogs/new-task'
import { initCommandPalette } from './command-palette'
import { initComposerInputs } from './composer'
import { initProjectSwitcher } from './project'

// --- Shell ---

// Truthful even while advisor state is in flux (ADR 0002's sidebar exception):
// it must never say "local only" while an advisor is active. Off, or on
// without a stored key, is still exactly local process mode. Collapsed to a
// single line for the sidebar rail — the full sentence still lives in the
// tooltip/aria-label, it just is not spelled out in the row itself any more.
function renderAdvisorStatus(): void {
  const advisor = snapshot.settings.advisor
  const active = advisor.mode !== 'off' && snapshot.advisor.hasKey
  const note = byId('advisor-status')
  note.classList.toggle('active', active)
  byId('advisor-status-lamp').className = `lamp ${active ? 'lamp-cyan' : 'lamp-phosphor'}`
  let shortLabel: string
  let sentence: string
  if (active) {
    const modeLabel = advisor.mode === 'shadow' ? 'Shadow' : 'Active'
    const scope = advisor.shareRepoFacts ? 'Prompt text and repo facts are' : 'Prompt text is'
    shortLabel = `Jev · ${modeLabel}`
    sentence = `Routing advisor: Jev (${modeLabel}). ${scope} sent to TypeSafe.`
  } else {
    shortLabel = 'Local'
    sentence = 'Local process mode. Prompts stay between this app and your CLIs.'
  }
  byId('advisor-status-label').textContent = shortLabel
  note.title = sentence
  note.setAttribute('aria-label', sentence)
}

function render(): void {
  // Every renderer below reads the snapshot. It arrives asynchronously, and the
  // user can click a nav item before it does.
  if (typeof snapshot === 'undefined') return
  renderMiniProviders(); renderTasks(); renderTaskProviderOptions(); renderSettings(); renderAdvisorStatus()
  if (currentView === 'home') renderHome()
  if (currentView === 'agents') renderAgentsView()
  if (currentView === 'review') renderReview()
  if (currentView === 'workspace') renderWorkspaceView(snapshot)
  if (currentView === 'routing') renderRouting()
}

const VIEW_META: Record<string, { title: string; eyebrow: string }> = {
  home: { title: 'Home', eyebrow: 'MISSION CONTROL' },
  tasks: { title: 'Tasks', eyebrow: 'ORCHESTRATION CONSOLE' },
  workspace: { title: 'Workspaces', eyebrow: 'COLLABORATIVE WORKSPACES' },
  review: { title: 'Review', eyebrow: 'BRANCH INBOX' },
  agents: { title: 'Agents', eyebrow: 'LOCAL EXECUTABLES' },
  control: { title: 'Context & Tools', eyebrow: 'CONTROL PLANE' },
  skills: { title: 'Skills', eyebrow: 'AGENT CAPABILITIES' },
  routing: { title: 'Routing', eyebrow: 'ADVISOR & POLICY' },
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
  byId('new-task-button').style.display = view === 'home' || view === 'review' || view === 'control' || view === 'skills' || view === 'workspace' || view === 'routing' ? 'none' : ''
  // The first snapshot may still be in flight — clicking a nav item before it
  // lands used to throw here and leave the view empty. render() repaints the
  // active view as soon as the snapshot arrives.
  if (typeof snapshot === 'undefined') return
  // Render the control plane from the draft only on entry so streaming snapshots
  // never clobber in-progress edits.
  if (view === 'control') renderControlPlane()
  if (view === 'skills') void renderSkills()
  if (view === 'agents') renderAgentsView()
  if (view === 'home') renderHome()
  if (view === 'tasks') { renderTasks(); applyQueueWidth(); applyInspectorWidth(); applyInspectorState() }
  if (view === 'review') { renderReview(); void loadReview(true) }
  if (view === 'workspace') renderWorkspaceView(snapshot)
  if (view === 'routing') renderRouting()
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
byId('advisor-status').addEventListener('click', () => switchView('routing'))
initProjectSwitcher()

initHomeView()
initReviewView()
initTasksView()
initAgentsView()
initNewTaskDialog()
initSkillsView()
initCommandPalette()
initComposerInputs()
initControlView()
initRoutingView()
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
  // The conversation is always the centre pane now — no tab can hide it.
  if (event.taskId === selectedTaskId) {
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
  if (currentView === 'agents') refreshAgentDrawer()
}, 30_000)
