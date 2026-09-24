// Home — Mission Control: agent capacity, what's running, and branches waiting
// for review.
import { byId, element, emptyState } from '../ui/dom'
import { gaugeSeg, lamp, type Tone } from '../ui/components'
import { icon } from '../ui/icons'
import { countdown, formatCost, formatNumber, timeAgo } from '../ui/format'
import { providerCapacity, providerName, providerQuota, trackedTokens, type SnapshotProvider } from '../providers-view-model'
import { taskElapsed, taskKindLabel, taskStatusIndicator } from '../task-helpers'
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

export function renderMiniProviders(): void {
  const container = byId('provider-mini-list')
  container.replaceChildren(...snapshot.providers.filter((provider) => provider.enabled).map((provider) => {
    const row = element('div', 'mini-provider')
    const capacity = providerCapacity(provider)
    row.title = `${provider.name} · ${capacity.label}`
    row.setAttribute('aria-label', `${provider.name}: ${capacity.label}`)
    row.append(lamp(providerLampTone(provider), capacity.label), element('span', undefined, provider.name), element('small', undefined, capacity.label.toLowerCase()))
    return row
  }))
}

// --- Mission Control ---

export function renderHome(): void {
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

      const running = snapshot.tasks.find((task) => task.status === 'running' && task.selectedProviderId === provider.id)
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

  const activeTasks = snapshot.tasks.filter((task) => task.status === 'running' || task.status === 'queued')
  const active = byId('home-active')
  if (!activeTasks.length) {
    active.replaceChildren(emptyState('Nothing running', 'Start a task and it will appear here while it works.'))
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

  const waiting = reviewRepos.flatMap((repo) => repo.branches.filter((branch) => !branch.merged).map((branch) => ({ repo, branch })))
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
  byId('home-view-tasks').addEventListener('click', () => switchView('tasks'))
  byId('home-view-review').addEventListener('click', () => switchView('review'))
}
