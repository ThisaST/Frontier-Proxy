// Home — composer-first: start work with a live route preview, then Running
// now / Needs your review / Agents below it, all scoped to the current project.
import type { AdvisorPreviewResult, RoutingMode } from '../../../shared/types'
import { tierFor } from '../../../shared/model-profiles'
import { byId, element, emptyState } from '../ui/dom'
import { chip, gaugeSeg, lamp, radar, type Tone } from '../ui/components'
import { icon } from '../ui/icons'
import { errorMessage, reportError } from '../ui/feedback'
import { countdown, formatCost, formatNumber, timeAgo } from '../ui/format'
import { providerCapacity, providerName, providerQuota, trackedTokens, type SnapshotProvider } from '../providers-view-model'
import { taskElapsed, taskKindLabel, taskStatusIndicator } from '../task-helpers'
import { createTaskForm } from '../task-form'
import { currentProject, onProjectChange, openProjectSwitcher, projectMatches } from '../project'
import { snapshot } from '../state'
import { reviewRepos, reviewLoaded } from './review'
import { openTask } from './tasks'
import { openBranchInReview, switchView } from '../main'

// Shared by the sidebar rail, Home's agent cards, and Agents/Usage cards: what
// lamp tone a provider's capacity reads as right now.
export function providerLampTone(provider: SnapshotProvider): Tone {
  const capacity = providerCapacity(provider)
  if (capacity.tone === 'limited') return 'alarm'
  if (provider.runtime.running) return 'caution'
  if (provider.runtime.available) return 'phosphor'
  return 'muted'
}

// --- Sidebar rail ---

// Two representations of the same data: one compact row per agent (lamp,
// name, short readout — no gauges), and, for short windows, a single row of
// lamps (CSS picks which is visible at `max-height: 820px`, see base.css).
// Both stay in the DOM together so there is nothing to (re)build on resize.
export function renderMiniProviders(): void {
  const enabled = snapshot.providers.filter((provider) => provider.enabled)

  byId('provider-mini-list').replaceChildren(...enabled.map((provider) => {
    const row = element('div', 'mini-provider')
    const capacity = providerCapacity(provider)
    row.title = `${provider.name} · ${capacity.label}`
    row.setAttribute('aria-label', `${provider.name}: ${capacity.label}`)
    row.append(lamp(providerLampTone(provider), capacity.label), element('span', 'mini-provider-name', provider.name), element('small', undefined, capacity.label.toLowerCase()))
    return row
  }))

  byId('provider-mini-lamps').replaceChildren(...enabled.map((provider) => {
    const capacity = providerCapacity(provider)
    const button = element('button', 'mini-provider-lamp') as HTMLButtonElement
    button.type = 'button'
    button.title = `${provider.name} · ${capacity.label}`
    button.setAttribute('aria-label', `${provider.name}: ${capacity.label}`)
    button.append(lamp(providerLampTone(provider), capacity.label))
    button.addEventListener('click', () => switchView('agents'))
    return button
  }))
}

// --- Composer: start work ---

const form = createTaskForm({
  root: '#home-composer',
  promptInput: 'home-prompt',
  singleOptions: 'home-single-options',
  benchOptions: 'home-bench-options',
  benchProviders: 'home-bench-providers',
  modelField: 'home-model-field',
  modelSelect: 'home-model-select',
  modelCustom: 'home-model',
  routingModeSelect: 'home-routing-mode',
  providerOverrideSelect: 'home-provider-override',
  skillsSummary: 'home-skills-summary',
  skillsList: 'home-skills-list'
})

const TIER_TONE: Record<string, Tone> = { local: 'phosphor', fast: 'cyan', standard: 'amber', frontier: 'caution' }

function renderProjectField(): void {
  const field = byId<HTMLButtonElement>('home-project-field')
  field.replaceChildren(icon(currentProject ? 'folder' : 'folder-open', 14), element('span', undefined, currentProject ? currentProject.split(/[\\/]/).pop() || currentProject : 'Choose project'))
  field.title = currentProject ?? 'Choose a project to start work in'
  field.classList.toggle('unset', !currentProject)
  const start = byId<HTMLButtonElement>('home-start-task')
  start.disabled = !currentProject
  start.title = currentProject ? '' : 'Choose a project before starting a task'
}

function renderRouteIdle(message?: string): void {
  const line = byId('home-route-preview')
  line.className = 'route-preview idle'
  line.replaceChildren(element('span', undefined, message ?? 'Type a prompt to see which agent Frontier would pick.'))
}

function renderRouteLoading(): void {
  const line = byId('home-route-preview')
  line.className = 'route-preview loading'
  line.replaceChildren(radar(16, 'Computing route preview'), element('span', undefined, 'Routing…'))
}

function renderRouteResult(result: AdvisorPreviewResult): void {
  const line = byId('home-route-preview')
  const providerId = result.decision.chosenProviderId
  const provider = providerId ? snapshot.providers.find((item) => item.id === providerId) : undefined
  if (!provider) { renderRouteIdle('No agent is currently eligible to run this.'); return }
  line.className = 'route-preview'
  const tier = tierFor(result.model, provider.kind)
  const nodes: HTMLElement[] = [
    element('span', 'route-preview-arrow', '→'),
    element('strong', undefined, provider.name),
    element('span', 'readout', result.model ?? provider.model ?? 'default model'),
    chip(TIER_TONE[tier] ?? 'muted', `${tier} tier`)
  ]
  const factors = result.decision.candidates.find((candidate) => candidate.providerId === providerId)?.factors ?? []
  const top = [...factors].sort((left, right) => Math.abs(right.points) - Math.abs(left.points)).slice(0, 2)
  for (const factor of top) nodes.push(element('small', 'route-preview-factor', factor.label))
  const hints: string[] = []
  const advisor = snapshot.settings.advisor
  if (advisor.mode !== 'off' && !advisor.previewWhileTyping) hints.push('Jev decides the real route when you start the task.')
  if (result.heuristic.error) hints.push(result.heuristic.error)
  if (hints.length) nodes.push(element('small', 'route-preview-hint', hints.join(' ')))
  line.replaceChildren(...nodes)
}

let previewSeq = 0
let previewDebounce: number | undefined

function schedulePreview(): void {
  window.clearTimeout(previewDebounce)
  const prompt = byId<HTMLTextAreaElement>('home-prompt').value.trim()
  if (!prompt || !currentProject) { previewSeq += 1; renderRouteIdle(); return }
  const cwd = currentProject
  previewDebounce = window.setTimeout(() => void runPreview(prompt, cwd), 400)
}

async function runPreview(prompt: string, cwd: string): Promise<void> {
  renderRouteLoading()
  const sequence = ++previewSeq
  try {
    const result = await window.frontier.previewAdvisor({
      prompt,
      cwd,
      policy: byId<HTMLSelectElement>('home-routing-mode').value as RoutingMode,
      preferredProviderId: byId<HTMLSelectElement>('home-provider-override').value || undefined,
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

async function submitHomeTask(): Promise<void> {
  const errorNode = byId('home-form-error'); errorNode.textContent = ''
  if (!currentProject) { errorNode.textContent = 'Choose a project before starting a task.'; return }
  const button = byId<HTMLButtonElement>('home-start-task')
  button.disabled = true
  try {
    const task = await form.submit(currentProject)
    renderRouteIdle()
    openTask(task.id)
  } catch (error) {
    errorNode.textContent = errorMessage(error)
    reportError('Could not start the task', error)
  } finally {
    button.disabled = !currentProject
  }
}

// --- Below the composer: capacity, in flight, and what needs review ---

export function renderHome(): void {
  renderProjectField()
  form.renderProviderOptions()

  const agents = byId('home-agents')
  const enabled = snapshot.providers.filter((provider) => provider.enabled)
  if (!enabled.length) {
    agents.replaceChildren(emptyState('No agents enabled', 'Turn on an agent under Agents to start routing work.'))
  } else {
    agents.replaceChildren(...enabled.map((provider) => {
      const capacity = providerCapacity(provider)
      const card = element('article', `home-agent ${capacity.tone}`)
      const head = element('div', 'home-agent-head')
      const identity = element('div', 'home-agent-identity')
      identity.append(lamp(providerLampTone(provider), capacity.label), element('strong', undefined, provider.name))
      head.append(identity, element('span', `capacity-badge ${capacity.tone}`, capacity.label))

      const plan = providerQuota(provider)
      const quota = element('div', 'home-agent-quota')
      const quotaHead = element('div', 'home-agent-quota-head')
      quotaHead.append(
        element('span', undefined, plan.text),
        element('small', undefined, plan.reset ? `resets in ${countdown(plan.reset)}` : '')
      )
      // Without a reported percentage the bar tracks the window's clock, not
      // usage — a muted tone so it never reads as "how much you have left".
      quota.append(quotaHead, gaugeSeg(plan.percent ?? plan.timePercent, plan.percent === undefined ? 'muted' : plan.percent >= 90 ? 'caution' : 'amber', plan.text))

      const running = snapshot.tasks.find((task) => task.status === 'running' && task.selectedProviderId === provider.id && projectMatches(task.cwd))
      const foot = element('div', 'home-agent-foot')
      foot.append(
        element('span', undefined, running ? `Working: ${running.prompt.slice(0, 44)}${running.prompt.length > 44 ? '…' : ''}` : `${formatNumber(trackedTokens(provider))} tokens today`),
        element('small', undefined, formatCost(provider.runtime.usage.costUsd))
      )
      if (running) {
        card.classList.add('active')
        card.addEventListener('click', () => openTask(running.id))
      }
      card.append(head, quota, foot)
      return card
    }))
  }

  const activeTasks = snapshot.tasks.filter((task) => (task.status === 'running' || task.status === 'queued') && projectMatches(task.cwd))
  const active = byId('home-active')
  if (!activeTasks.length) {
    active.replaceChildren(emptyState('Nothing running', currentProject ? 'Nothing is running in this project right now.' : 'Start a task and it will appear here while it works.'))
  } else {
    active.replaceChildren(...activeTasks.map((task) => {
      const row = element('button', 'home-task')
      const latest = task.activity?.at(-1)
      row.append(
        taskStatusIndicator(task.status),
        (() => {
          const body = element('div', 'home-task-body')
          body.append(element('strong', undefined, task.prompt), element('small', undefined, latest ? `${latest.label}${latest.detail ? ` · ${latest.detail}` : ''}` : `${taskKindLabel(task)} · ${providerName(task.selectedProviderId)}`))
          return body
        })(),
        element('span', 'home-task-time', taskElapsed(task))
      )
      row.addEventListener('click', () => openTask(task.id))
      return row
    }))
  }

  const waiting = reviewRepos.filter((repo) => projectMatches(repo.cwd)).flatMap((repo) => repo.branches.filter((branch) => !branch.merged).map((branch) => ({ repo, branch })))
  const review = byId('home-review')
  if (!reviewLoaded) review.replaceChildren(element('p', 'detail-empty', 'Checking for branches…'))
  else if (!waiting.length) review.replaceChildren(emptyState('Nothing to review', 'Branches from split & compare runs will collect here.'))
  else {
    review.replaceChildren(...waiting.slice(0, 6).map(({ repo, branch }) => {
      const row = element('button', 'home-branch')
      const body = element('div', 'home-task-body')
      body.append(element('strong', undefined, branch.subject), element('small', undefined, `${repo.name} · ${branch.files.length} file${branch.files.length === 1 ? '' : 's'}`))
      const branchIcon = element('span', 'branch-glyph'); branchIcon.append(icon('branch', 14))
      row.append(branchIcon, body, element('span', 'home-task-time', timeAgo(branch.committedAt)))
      row.addEventListener('click', () => openBranchInReview(branch.cwd, branch.branch))
      return row
    }))
  }

  const count = waiting.length
  const badge = byId('nav-review-count')
  badge.hidden = count === 0
  badge.textContent = String(count)
}

export function initHomeView(): void {
  form.init()
  byId('home-view-tasks').addEventListener('click', () => switchView('tasks'))
  byId('home-view-review').addEventListener('click', () => switchView('review'))
  byId('home-project-field').addEventListener('click', () => openProjectSwitcher())
  byId('home-start-task').addEventListener('click', () => void submitHomeTask())

  const prompt = byId<HTMLTextAreaElement>('home-prompt')
  prompt.addEventListener('input', schedulePreview)
  prompt.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void submitHomeTask() }
  })
  for (const id of ['home-routing-mode', 'home-provider-override', 'home-model-select']) byId(id).addEventListener('change', schedulePreview)
  byId('home-model').addEventListener('input', schedulePreview)

  onProjectChange(() => {
    renderProjectField()
    schedulePreview()
    if (typeof snapshot !== 'undefined') renderHome()
  })
  renderProjectField()
  renderRouteIdle()
}
