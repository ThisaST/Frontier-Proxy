// Agents — installed CLIs as a dense table, with a detail drawer per row
// holding the full edit form and today's usage.
import type { ModelTier, UsageDay } from '../../../shared/types'
import { tierFor } from '../../../shared/model-profiles'
import { byId, element, field, textArea, textInput } from '../ui/dom'
import { chip, dataTable, dialogHandle, gaugeSeg, lamp, type Tone } from '../ui/components'
import { setIconLabel } from '../ui/icons'
import { reportError, showToast } from '../ui/feedback'
import { countdown, formatArguments, formatCost, formatNumber, listValues, splitArguments } from '../ui/format'
import { activeCooldown, providerCapacity, providerLimitReached, providerQuota, providerSessions, trackedTokens, type SnapshotProvider } from '../providers-view-model'
import { sessionResetAt, sessionStatusNote, sessionWindowElapsedPercent, sessionWindowLabel, sessionWindowPercent } from '../../../shared/sessions'
import { providerLampTone } from './home'
import { snapshot } from '../state'
import { SKILL_CAPABLE_KINDS } from './skills'

const TIER_LABEL: Record<ModelTier, string> = { local: 'Local', fast: 'Fast', standard: 'Standard', frontier: 'Frontier' }
const TIER_TONE: Record<ModelTier, Tone> = { local: 'muted', fast: 'cyan', standard: 'phosphor', frontier: 'amber' }

function providerModels(provider: SnapshotProvider): string[] {
  return [...new Set([...(provider.runtime.models ?? []), ...(provider.model ? [provider.model] : [])])]
}

// ---------- Drawer: the full edit form (unchanged behaviour from the old card) ----------

function providerFormSection(provider: SnapshotProvider): HTMLElement {
  const section = element('div', 'drawer-section')
  const form = element('div', 'provider-form')
  const displayName = textInput(provider.name)
  const executable = textInput(provider.executable)
  const model = textInput(provider.model ?? '')
  const priority = textInput(String(provider.priority), 'number'); priority.min = '0'; priority.max = '100'
  const budget = textInput(provider.dailyTokenBudget ? String(provider.dailyTokenBudget) : '', 'number'); budget.min = '0'; budget.placeholder = 'Unlimited'
  const contextWindow = textInput(provider.contextWindow ? String(provider.contextWindow) : '', 'number'); contextWindow.min = '0'; contextWindow.placeholder = 'Auto-detect'
  const args = textInput(formatArguments(provider.args ?? []))
  const concurrency = textInput(String(provider.maxConcurrent), 'number'); concurrency.min = '1'; concurrency.max = '8'
  form.append(
    field('Display name', displayName), field('Executable', executable), field('Model (optional)', model),
    field('Routing priority', priority), field('Parallel tasks', concurrency), field('Tracked usage limit', budget),
    field('Context window (tokens)', contextWindow), field('Extra arguments (quotes supported)', args, true)
  )

  let copilotToolsets: HTMLTextAreaElement | undefined
  let copilotTools: HTMLTextAreaElement | undefined
  let copilotAllTools: HTMLInputElement | undefined
  if (provider.kind === 'copilot') {
    copilotToolsets = textArea((provider.copilotGithubMcpToolsets ?? []).join('\n'), 2)
    copilotToolsets.placeholder = 'actions, code_security, discussions…'
    copilotTools = textArea((provider.copilotGithubMcpTools ?? []).join('\n'), 2)
    copilotTools.placeholder = 'Individual GitHub MCP tool names (optional)'
    copilotAllTools = document.createElement('input')
    copilotAllTools.type = 'checkbox'
    copilotAllTools.checked = Boolean(provider.copilotEnableAllGithubMcpTools)
    const allToolsRow = document.createElement('label'); allToolsRow.className = 'checkbox-row wide'
    allToolsRow.append(copilotAllTools, ' Enable every built-in GitHub MCP tool')
    const help = element('p', 'field-help wide', 'Optional. Toolsets and tools extend Copilot’s default GitHub subset for each Frontier task. “Every tool” overrides both lists.')
    const syncCopilotFields = (): void => {
      copilotToolsets!.disabled = copilotAllTools!.checked
      copilotTools!.disabled = copilotAllTools!.checked
    }
    copilotAllTools.addEventListener('change', syncCopilotFields)
    syncCopilotFields()
    form.append(field('GitHub MCP toolsets', copilotToolsets, true), field('Individual GitHub MCP tools', copilotTools, true), allToolsRow, help)
  }

  const cpCapable = (SKILL_CAPABLE_KINDS as readonly string[]).includes(provider.kind)
  let cpToggle: HTMLInputElement | undefined
  if (cpCapable) {
    cpToggle = document.createElement('input'); cpToggle.type = 'checkbox'; cpToggle.checked = provider.useControlPlane !== false
    const row = document.createElement('label'); row.className = 'checkbox-row wide'
    row.append(cpToggle, ' Apply shared Context & Tools profile')
    form.append(row)
  }
  section.append(form)

  const footer = element('div', 'provider-card-footer')
  const health = element('span', 'health-label')
  health.append(
    lamp(provider.runtime.available ? 'phosphor' : 'muted', provider.runtime.available ? 'Ready' : 'Not ready'),
    document.createTextNode(provider.runtime.available ? `Ready · ${provider.runtime.version ?? 'detected'}` : provider.enabled ? 'Not detected' : 'Disabled')
  )
  const save = element('button', 'secondary-button', 'Save agent') as HTMLButtonElement
  save.addEventListener('click', async () => {
    save.setAttribute('disabled', '')
    try {
      await window.frontier.updateProvider({ id: provider.id, changes: {
        name: displayName.value.trim() || provider.name,
        executable: executable.value.trim(),
        model: model.value.trim() || undefined,
        priority: Number(priority.value) || 0,
        maxConcurrent: Math.max(1, Math.min(8, Number(concurrency.value) || 1)),
        dailyTokenBudget: Number(budget.value) > 0 ? Number(budget.value) : undefined,
        contextWindow: Number(contextWindow.value) > 0 ? Number(contextWindow.value) : undefined,
        args: args.value.trim() ? splitArguments(args.value) : undefined,
        ...(cpToggle ? { useControlPlane: cpToggle.checked } : {}),
        ...(provider.kind === 'copilot' ? {
          copilotGithubMcpToolsets: listValues(copilotToolsets?.value ?? ''),
          copilotGithubMcpTools: listValues(copilotTools?.value ?? ''),
          copilotEnableAllGithubMcpTools: Boolean(copilotAllTools?.checked)
        } : {})
      } })
      showToast(`${provider.name} updated`)
    } catch (error) { reportError(`Could not update ${provider.name}`, error) } finally { save.removeAttribute('disabled') }
  })
  const buttons = element('div', 'header-actions')
  if (provider.kind === 'custom') {
    const remove = element('button', 'text-button', 'Remove')
    remove.addEventListener('click', async () => {
      try { await window.frontier.removeProvider(provider.id); showToast('Custom agent removed'); agentDrawer.close() }
      catch (error) { reportError('Could not remove agent', error) }
    })
    buttons.append(remove)
  }
  buttons.append(save)
  footer.append(health, buttons)
  section.append(footer)
  return section
}

// ---------- Drawer: usage (the old Usage tab's per-card body) ----------

function usageStat(label: string, value: string): HTMLElement {
  const stat = element('div', 'usage-stat')
  stat.append(element('span', 'usage-stat-label', label), element('strong', undefined, value))
  return stat
}

function usageGauge(label: string, percent: number | undefined, detail: string, tone: Tone = 'phosphor'): HTMLElement {
  const node = element('div', 'usage-gauge')
  const head = element('div', 'usage-gauge-head')
  head.append(element('span', undefined, label), element('strong', 'readout', percent === undefined ? '—' : `${Math.round(percent)}%`))
  node.append(head, gaugeSeg(percent, tone, label), element('div', 'usage-budget-label', detail))
  return node
}

// Fourteen days of tracked tokens as bars. Deliberately unlabelled per bar: this
// is a shape, not a table — the exact numbers live in the stats above it.
function usageHistory(history: UsageDay[], todayUsage: UsageDay): HTMLElement | undefined {
  const days = [...history, todayUsage].slice(-14)
  const totals = days.map((day) => (day.inputTokens + day.outputTokens) || (day.estimatedInputTokens + day.estimatedOutputTokens))
  const peak = Math.max(...totals)
  if (days.length < 2 || peak <= 0) return undefined
  const section = element('div', 'usage-history')
  section.append(element('div', 'usage-section-label', `Tracked tokens · last ${days.length} day${days.length === 1 ? '' : 's'}`))
  const chart = element('div', 'usage-history-chart screen')
  days.forEach((day, index) => {
    const column = element('div', `usage-history-bar${index === days.length - 1 ? ' today' : ''}`)
    const fill = element('div', 'usage-history-fill')
    fill.style.height = `${Math.max(2, (totals[index] / peak) * 100)}%`
    column.append(fill)
    column.title = `${day.date} · ${formatNumber(totals[index])} tokens · ${day.tasks} run${day.tasks === 1 ? '' : 's'}`
    chart.append(column)
  })
  section.append(chart)
  return section
}

// Which models actually consumed the day's tokens. A CLI can switch models
// mid-plan, so per-provider totals alone cannot answer "what is costing me this".
function usageModels(usage: UsageDay): HTMLElement | undefined {
  const entries = Object.entries(usage.models ?? {}).filter(([, value]) => value.inputTokens + value.outputTokens > 0)
  if (!entries.length) return undefined
  entries.sort((left, right) => (right[1].inputTokens + right[1].outputTokens) - (left[1].inputTokens + left[1].outputTokens))
  const section = element('div', 'usage-models')
  section.append(element('div', 'usage-section-label', 'By model today'))
  for (const [model, value] of entries.slice(0, 5)) {
    const row = element('div', 'usage-model-row')
    row.append(
      element('span', 'usage-model-name', model),
      element('span', 'usage-model-tokens', `${formatNumber(value.inputTokens + value.outputTokens)} tokens${value.costUsd > 0 ? ` · ${formatCost(value.costUsd)}` : ''}`)
    )
    section.append(row)
  }
  return section
}

function providerUsageSection(provider: SnapshotProvider): HTMLElement {
  const section = element('div', 'drawer-section')
  section.append(element('p', 'eyebrow', 'USAGE & LIMITS'))
  const usage = provider.runtime.usage
  const hasActual = usage.inputTokens + usage.outputTokens > 0
  const capacity = providerCapacity(provider)

  const stats = element('div', 'usage-stats')
  stats.append(
    usageStat('Cost today', usage.costReported ? formatCost(usage.costUsd) : 'not reported'),
    usageStat(hasActual ? 'Input tokens' : 'Input (est.)', formatNumber(hasActual ? usage.inputTokens : usage.estimatedInputTokens)),
    usageStat(hasActual ? 'Output tokens' : 'Output (est.)', formatNumber(hasActual ? usage.outputTokens : usage.estimatedOutputTokens)),
    usageStat('Tasks', String(usage.tasks))
  )

  const sessions = providerSessions(provider)
  const gauges = element('div', 'usage-gauges')
  for (const session of sessions) {
    const percent = sessionWindowPercent(session)
    const resetAt = sessionResetAt(session)
    const note = sessionStatusNote(session)
    const detail = [
      resetAt ? `Resets in ${countdown(resetAt)}` : 'No reset time reported by the CLI',
      session.usingOverage ? 'overage in use' : undefined,
      note
    ].filter(Boolean).join(' · ')
    const elapsed = percent === undefined ? sessionWindowElapsedPercent(session) : undefined
    gauges.append(usageGauge(
      percent === undefined ? `${sessionWindowLabel(session)} window elapsed` : `${sessionWindowLabel(session)} limit used`,
      percent ?? elapsed,
      percent === undefined ? `${detail} · this CLI reports no usage percentage` : detail,
      percent === undefined ? 'muted' : percent >= 90 ? (capacity.tone === 'limited' ? 'alarm' : 'caution') : 'phosphor'
    ))
  }
  if (provider.dailyTokenBudget) {
    const trackedPct = Math.min(100, (trackedTokens(provider) / provider.dailyTokenBudget) * 100)
    gauges.append(usageGauge('Tracked daily budget', trackedPct, `${formatNumber(trackedTokens(provider))} / ${formatNumber(provider.dailyTokenBudget)} tracked tokens`, trackedPct >= 90 ? (capacity.tone === 'limited' ? 'alarm' : 'caution') : 'phosphor'))
  } else if (!sessions.length) {
    const cooldown = activeCooldown(provider)
    gauges.append(usageGauge('Session usage', cooldown ? 100 : undefined,
      cooldown ? `Automatic fallback active · retries in ${countdown(provider.runtime.cooldownUntil)}` : `${formatNumber(trackedTokens(provider))} tracked tokens · no plan limit reported`,
      cooldown ? 'alarm' : 'phosphor'))
  }

  const footer = element('div', 'usage-card-footer')
  const attention = sessions.map(sessionStatusNote).find(Boolean)
  const overage = sessions.find((session) => session.overageStatus && session.overageStatus !== 'allowed')
  footer.append(element('span', 'usage-session', providerLimitReached(provider)
    ? `Frontier will skip ${provider.name} while this limit is active and route work elsewhere.`
    : attention
      ? `Plan status: ${attention}`
      : sessions.length
        ? `${sessions.length} usage window${sessions.length === 1 ? '' : 's'} in force${overage ? ` · overage ${overage.overageStatus?.replaceAll('_', ' ')}` : ''}.`
        : 'No plan window has been reported in this app session.'))

  section.append(gauges, stats)
  const history = usageHistory(provider.runtime.history ?? [], usage)
  if (history) section.append(history)
  const models = usageModels(usage)
  if (models) section.append(models)
  section.append(footer)
  return section
}

// ---------- Drawer shell ----------

const agentDrawer = dialogHandle(byId<HTMLDialogElement>('agent-drawer'))
let openProviderId: string | undefined

function renderDrawer(): void {
  if (!openProviderId) return
  const provider = snapshot.providers.find((item) => item.id === openProviderId)
  if (!provider) { agentDrawer.close(); return }
  // Rebuilding wipes whatever the user is typing, so leave an in-focus form alone.
  if (agentDrawer.el.contains(document.activeElement) && document.activeElement !== agentDrawer.el) return
  byId('agent-drawer-kind').textContent = provider.kind.toUpperCase()
  byId('agent-drawer-title').textContent = provider.name
  byId('agent-drawer-body').replaceChildren(providerFormSection(provider), providerUsageSection(provider))
}

export function refreshAgentDrawer(): void {
  if (openProviderId && agentDrawer.el.open) renderDrawer()
}

function openAgentDrawer(provider: SnapshotProvider, trigger?: HTMLElement): void {
  openProviderId = provider.id
  renderDrawer()
  agentDrawer.open(trigger)
}

// ---------- Table ----------

function loginChip(provider: SnapshotProvider): HTMLElement {
  const auth = provider.runtime.auth
  if (!auth || auth.state === 'unknown') return chip('muted', 'unknown')
  const el = chip(auth.state === 'logged-in' ? 'phosphor' : 'alarm', auth.state === 'logged-in' ? 'signed in' : 'signed out')
  if (auth.detail) el.title = auth.detail
  return el
}

function modelsSummary(provider: SnapshotProvider): HTMLElement {
  const models = providerModels(provider)
  const wrap = element('div', 'agents-models-cell')
  if (!models.length) { wrap.append(element('span', 'detail-empty', 'none discovered')); return wrap }
  const tiers = [...new Set(models.map((model) => tierFor(model, provider.kind)))]
  wrap.append(element('span', 'agents-models-count', `${models.length} model${models.length === 1 ? '' : 's'}`))
  const chips = element('span', 'agents-tier-chips')
  for (const tier of tiers) chips.append(chip(TIER_TONE[tier], TIER_LABEL[tier]))
  wrap.append(chips)
  return wrap
}

function planWindowCell(provider: SnapshotProvider): HTMLElement {
  const quota = providerQuota(provider)
  const wrap = element('div', 'agents-plan-cell')
  wrap.append(gaugeSeg(quota.percent ?? quota.timePercent, quota.percent === undefined ? 'muted' : quota.percent >= 90 ? 'caution' : 'amber', quota.text))
  wrap.append(element('small', undefined, quota.reset ? `resets in ${countdown(quota.reset)}` : quota.text))
  wrap.title = quota.text
  return wrap
}

function renderProvidersTable(): void {
  const host = byId('agents-table')
  host.replaceChildren(dataTable(
    [
      { label: 'Agent', render: (provider: SnapshotProvider) => {
        const cell = element('div', 'agents-name-cell')
        cell.append(lamp(providerLampTone(provider), providerCapacity(provider).label), element('strong', undefined, provider.name))
        return cell
      } },
      { label: 'Kind', render: (provider: SnapshotProvider) => provider.kind.toUpperCase() },
      { label: 'Login', render: (provider: SnapshotProvider) => loginChip(provider) },
      { label: 'Version', className: 'mono', render: (provider: SnapshotProvider) => provider.runtime.version ?? '—' },
      { label: 'Models', render: (provider: SnapshotProvider) => modelsSummary(provider) },
      { label: "Today's tokens", className: 'mono', render: (provider: SnapshotProvider) => formatNumber(trackedTokens(provider)) },
      { label: 'Plan window', render: (provider: SnapshotProvider) => planWindowCell(provider) },
      { label: 'Enabled', render: (provider: SnapshotProvider) => {
        const toggleLabel = document.createElement('label'); toggleLabel.className = 'switch small'
        const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = provider.enabled
        toggle.setAttribute('aria-label', `Enable ${provider.name}`)
        toggleLabel.append(toggle, element('span', 'slider'))
        toggleLabel.addEventListener('click', (event) => event.stopPropagation())
        toggle.addEventListener('change', async () => {
          toggle.disabled = true
          try { await window.frontier.updateProvider({ id: provider.id, changes: { enabled: toggle.checked } }) }
          catch (error) { toggle.checked = !toggle.checked; reportError(`Could not update ${provider.name}`, error) }
          finally { toggle.disabled = false }
        })
        return toggleLabel
      } }
    ],
    snapshot.providers,
    {
      onRowClick: (provider, _index, rowElement) => openAgentDrawer(provider, rowElement),
      emptyTitle: 'No agents configured',
      emptyDetail: 'Choose Add CLI to configure one.'
    }
  ))
}

// ---------- Getting-started callout ----------

const SETUP_DISMISS_KEY = 'fp-agents-setup-dismissed'

function applySetupGuideState(): void {
  const dismissed = (() => { try { return localStorage.getItem(SETUP_DISMISS_KEY) === 'true' } catch { return false } })()
  byId('agents-setup-guide').hidden = dismissed
}

export function renderAgentsView(): void {
  renderProvidersTable()
  refreshAgentDrawer()
}

export function initAgentsView(): void {
  applySetupGuideState()
  byId('agents-setup-dismiss').addEventListener('click', () => {
    try { localStorage.setItem(SETUP_DISMISS_KEY, 'true') } catch { /* private mode / disabled storage */ }
    applySetupGuideState()
  })
  byId('agent-drawer-close').addEventListener('click', () => agentDrawer.close())
  byId<HTMLDialogElement>('agent-drawer').addEventListener('close', () => { openProviderId = undefined })

  byId('health-check').addEventListener('click', async () => {
    const button = byId<HTMLButtonElement>('health-check'); button.disabled = true; setIconLabel(button, undefined, 'Checking…')
    try { await window.frontier.checkProviders(); showToast('Agent health refreshed') }
    catch (error) { reportError('Agent check failed', error) }
    finally { button.disabled = false; setIconLabel(button, 'refresh', 'Check agents') }
  })
  byId('add-provider').addEventListener('click', async () => {
    try {
      await window.frontier.addCustomProvider()
      showToast('Custom agent added — configure it below')
      requestAnimationFrame(() => document.querySelector('#agents-table tbody tr:last-child')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
    } catch (error) { reportError('Could not add agent', error) }
  })
}
