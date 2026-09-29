import './styles/index.css'
import { handleWorkspaceStream, renderWorkspaceView } from './workspace'
import { byId } from './ui/dom'
import { hydrateIcons } from './ui/icons'
import { bindTooltip } from './ui/tooltip'
import { announce } from './ui/announce'
import { initTheme } from './theme'
import { reportError } from './ui/feedback'
import { snapshot, setSnapshot, currentView, setCurrentView, selectedTaskId, applyTaskSurface } from './state'
import { taskIsBusy } from './task-helpers'
import { resolveView, type SettingsTab, type ViewId } from './nav'
import { advisorDisclosure } from './advisor-disclosure'
import { renderTasks, applyQueueWidth, applyInspectorWidth, applyInspectorState, initTasksView } from './views/tasks'
import { initComposeView } from './views/compose'
import { renderReview, renderReviewBadge, loadReview, setReviewSelection, setReviewFilePath, initReviewView } from './views/review'
import { renderAgentsView, refreshAgentDrawer, initAgentsView } from './views/agents'
import { initControlView } from './views/control'
import { initSkillsView } from './views/skills'
import { renderRouting, initRoutingView } from './views/routing'
import { renderSettings, initSettingsView, showSettingsTab, currentSettingsTab } from './views/settings'
import { initCommandPalette, openCommandPalette } from './command-palette'
import { initComposerInputs } from './composer'
import { initProjectSwitcher } from './project'

// --- Shell: the header row (ui-plan §6.2) ---

// The one place a screen declares its header: the title, which buttons of #app-header-actions it
// shows (by id; the buttons live in index.html and their own view binds them), and whether the
// project switcher applies. A later phase adds a header action by putting its button in that slot
// and its id here.
const HEADER: Record<ViewId, { title: string; actions?: string[]; project?: boolean }> = {
  tasks: { title: 'Tasks', actions: ['clear-finished'], project: true },
  workspace: { title: 'Workspaces', actions: ['workspace-participants-button'], project: true },
  review: { title: 'Review', actions: ['review-refresh'], project: true },
  agents: { title: 'Agents', actions: ['health-check', 'add-provider'] },
  settings: { title: 'Settings' }
}

function renderHeader(view: ViewId): void {
  const { title, actions = [], project = false } = HEADER[view]
  byId('view-title').textContent = title
  byId('project-switcher').hidden = !project
  for (const action of byId('app-header-actions').children) (action as HTMLElement).hidden = !actions.includes(action.id)
}

// The privacy chip is on every screen because the header is one element (ADR 0002). Its words
// come from advisorDisclosure(), read from live settings on every render, so it can never go
// stale or say "local" while an advisor is active. The full sentence is the accessible name and
// the shared tooltip (hover and keyboard focus); `title` stays unset so the two never double up.
let disclosure = ''
function renderAdvisorStatus(): void {
  const { label, tone, sentence } = advisorDisclosure(snapshot.settings, snapshot.advisor.hasKey)
  disclosure = sentence
  byId('advisor-status-lamp').className = `status ${tone}`
  byId('advisor-status-label').textContent = label
  byId('advisor-status').setAttribute('aria-label', sentence)
}

function render(): void {
  // Every renderer below reads the snapshot. It arrives asynchronously, and the
  // user can click a dock item before it does.
  if (typeof snapshot === 'undefined') return
  renderTasks(); renderSettings(); renderAdvisorStatus(); renderReviewBadge()
  if (currentView === 'agents') renderAgentsView()
  if (currentView === 'review') renderReview()
  if (currentView === 'workspace') renderWorkspaceView(snapshot)
  if (currentView === 'settings' && currentSettingsTab === 'routing') renderRouting()
}

// Single code path for "open this branch in Review" — used by the lane and
// inspector branch buttons and the workspace turn's branch chip, so they all
// land on the same diff instead of just the Review view.
export function openBranchInReview(cwd: string, branch: string): void {
  setReviewSelection({ cwd, branch })
  setReviewFilePath(undefined)
  switchView('review')
}

// Accepts every id nav.ts resolves: the five sections, legacy `home` (Tasks in compose state), and
// a Settings tab id (the old `routing`, `control` and `skills` screens included). `tab` picks a
// Settings tab explicitly.
export function switchView(id: string, tab?: SettingsTab): void {
  const resolved = resolveView(id)
  if (!resolved) return
  const { view } = resolved
  if (resolved.compose) applyTaskSurface({ kind: 'compose' })
  setCurrentView(view)
  document.querySelectorAll<HTMLElement>('.nav-item').forEach((item) => {
    const active = item.dataset.view === view
    item.classList.toggle('active', active)
    if (active) item.setAttribute('aria-current', 'page')
    else item.removeAttribute('aria-current')
  })
  document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item.id === `${view}-view`))
  renderHeader(view)
  // Settings shows its tab and runs that tab's entry render itself (the Context & Tools draft is
  // rendered on entry only, so streamed snapshots never clobber it). The first snapshot may still
  // be in flight; render() repaints the active view as soon as it lands.
  if (view === 'settings') showSettingsTab(tab ?? resolved.tab)
  if (typeof snapshot === 'undefined') return
  if (view === 'agents') renderAgentsView()
  if (view === 'tasks') { renderTasks(); applyQueueWidth(); applyInspectorWidth(); applyInspectorState() }
  if (view === 'review') { renderReview(); void loadReview(true) }
  if (view === 'workspace') renderWorkspaceView(snapshot)
}

initTheme()
hydrateIcons()
document.querySelectorAll<HTMLElement>('.nav-item').forEach((item) => item.addEventListener('click', () => switchView(item.dataset.view ?? 'tasks')))
byId('dock-search').addEventListener('click', () => openCommandPalette())
const advisorChip = byId('advisor-status')
advisorChip.addEventListener('click', () => switchView('routing'))
bindTooltip(advisorChip, () => disclosure)
initProjectSwitcher()

initReviewView()
initTasksView()
initComposeView()
initAgentsView()
initSkillsView()
initCommandPalette()
initComposerInputs()
initControlView()
initRoutingView()
initSettingsView()

window.addEventListener('unhandledrejection', (event) => reportError('Unexpected application error', event.reason))

window.frontier.onSnapshot((next) => {
  const finishedBefore = new Set(snapshot?.tasks.filter((task) => taskIsBusy(task)).map((task) => task.id) ?? [])
  const previousSelectedStatus = snapshot?.tasks.find((task) => task.id === selectedTaskId)?.status
  setSnapshot(next)
  render()
  // A task that just stopped may have left new branches behind.
  if ([...finishedBefore].some((id) => { const task = next.tasks.find((item) => item.id === id); return task && !taskIsBusy(task) })) void loadReview()
  // Only the selected task's own finish is worth interrupting the user for —
  // announced once, when its status actually changes (never mid-stream).
  const selected = next.tasks.find((task) => task.id === selectedTaskId)
  if (selected && selected.status !== previousSelectedStatus) {
    if (selected.status === 'completed') announce('task-status', `Task completed: ${selected.prompt.slice(0, 80)}`)
    else if (selected.status === 'failed') announce('task-status', `Task failed: ${selected.error ?? 'see the conversation for details'}`)
    else if (selected.status === 'cancelled') announce('task-status', 'Task cancelled')
  }
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
  .then((initial) => { setSnapshot(initial); switchView('tasks'); render(); void loadReview() })
  .catch((error) => reportError('Could not connect to the Frontier service', error))

// Reset countdowns and expired-window state should keep moving even when no
// provider emits a new snapshot.
window.setInterval(() => {
  if (typeof snapshot === 'undefined') return
  if (currentView === 'agents') refreshAgentDrawer()
}, 30_000)
