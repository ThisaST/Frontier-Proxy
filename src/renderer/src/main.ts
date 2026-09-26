import './styles/index.css'
import { handleWorkspaceStream, renderWorkspaceView } from './workspace'
import { byId } from './ui/dom'
import { hydrateIcons, icon } from './ui/icons'
import { bindTooltip } from './ui/tooltip'
import { announce } from './ui/announce'
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
    // ADR 0002's sidebar exception: this must stay truthful about everything
    // that can leave the machine while the advisor is on, including the extra
    // split & delegate planning call (subtask titles/prompts, which can quote
    // code the planner read) — not just the per-turn routing prompt.
    const scope = advisor.shareRepoFacts ? 'Prompt text, repo facts and split-run subtask prompts are' : 'Prompt text and split-run subtask prompts are'
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

function readLocal(key: string): string | undefined { try { return localStorage.getItem(key) ?? undefined } catch { return undefined } }
function writeLocal(key: string, value: string): void { try { localStorage.setItem(key, value) } catch { /* private mode / disabled storage */ } }

const SIDEBAR_STATE_KEY = 'fp-sidebar-collapsed'

function setSidebarCollapsed(collapsed: boolean, persist = true): void {
  const shell = document.querySelector<HTMLElement>('.shell')
  const toggle = byId<HTMLButtonElement>('sidebar-toggle')
  shell?.classList.toggle('sidebar-collapsed', collapsed)
  toggle.setAttribute('aria-expanded', String(!collapsed))
  toggle.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation')
  toggle.title = collapsed ? 'Expand navigation' : 'Collapse navigation'
  toggle.replaceChildren(icon(collapsed ? 'chevron-right' : 'chevron-left'))
  // Collapsed: the `.nav-label` text (the button's only accessible name
  // source) is visually hidden, so `aria-label` takes over; `title` is
  // cleared so the browser's own delayed tooltip does not double up with the
  // JS one bound below. Expanded: the visible label already names the
  // button, so this just restores the original hover tooltip.
  document.querySelectorAll<HTMLElement>('.nav-item').forEach((item) => {
    if (collapsed) { item.setAttribute('aria-label', item.dataset.label ?? ''); item.removeAttribute('title') }
    else { item.removeAttribute('aria-label'); item.title = item.dataset.label ?? '' }
  })
  if (persist) writeLocal(SIDEBAR_STATE_KEY, String(collapsed))
}

// Below 1024px the sidebar defaults to icon-only, purely as a starting point
// for a narrower window — an explicit toggle click (`persist`d above) always
// wins over this from then on, at any width.
const NARROW_SIDEBAR_WIDTH = 1024
function applyResponsiveSidebarDefault(): void {
  if (readLocal(SIDEBAR_STATE_KEY) !== undefined) return
  setSidebarCollapsed(window.innerWidth < NARROW_SIDEBAR_WIDTH, false)
}

initTheme()
hydrateIcons()
{
  const storedSidebar = readLocal(SIDEBAR_STATE_KEY)
  setSidebarCollapsed(storedSidebar !== undefined ? storedSidebar === 'true' : window.innerWidth < NARROW_SIDEBAR_WIDTH, false)
}
byId('sidebar-toggle').addEventListener('click', () => {
  setSidebarCollapsed(!document.querySelector('.shell')?.classList.contains('sidebar-collapsed'))
})
window.addEventListener('resize', applyResponsiveSidebarDefault)
document.querySelectorAll<HTMLElement>('.nav-item').forEach((item) => {
  item.addEventListener('click', () => switchView(item.dataset.view ?? 'home'))
  // Only meaningful once the sidebar is collapsed to icons — the nav label is
  // visible text otherwise. Shows on hover and keyboard focus alike (the old
  // CSS `::after` version this replaces did not respond to focus at all
  // reliably once `.sidebar` started scrolling — see ui/tooltip.ts).
  bindTooltip(item, () => document.querySelector('.shell')?.classList.contains('sidebar-collapsed') ? (item.dataset.label ?? '') : '')
})
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
