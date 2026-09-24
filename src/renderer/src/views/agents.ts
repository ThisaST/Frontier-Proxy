// Agents — the provider registry (config) and usage (quota/spend) tabs.
import type { UsageDay } from '../../../shared/types'
import { byId, element, field, textArea, textInput } from '../ui/dom'
import { gaugeSeg, lamp, type Tone } from '../ui/components'
import { setIconLabel } from '../ui/icons'
import { reportError, showToast } from '../ui/feedback'
import { countdown, formatArguments, formatCost, formatNumber, listValues, splitArguments } from '../ui/format'
import { activeCooldown, providerCapacity, providerLimitReached, providerSessions, trackedTokens } from '../providers-view-model'
import { providerLampTone } from './home'
import { sessionResetAt, sessionStatusNote, sessionWindowElapsedPercent, sessionWindowLabel, sessionWindowPercent } from '../../../shared/sessions'
import { snapshot } from '../state'

export let agentsTab: 'registry' | 'usage' = 'registry'

function renderProviders(): void {
  const grid = byId('provider-grid')
  // Rebuilding the cards replaces their inputs. Snapshots arrive on every
  // streamed output chunk, so without this guard a task running in the
  // background would wipe out whatever the user is typing into a field.
  if (grid.childElementCount && grid.contains(document.activeElement)) return
  grid.replaceChildren(...snapshot.providers.map((provider) => {
    const card = element('article', 'provider-card')
    const header = element('div', 'provider-card-header')
    const identity = element('div', 'provider-name')
    const identityText = element('div')
    identityText.append(element('h3', undefined, provider.name), element('small', undefined, provider.kind.toUpperCase()))
    // "Ready" only ever meant the binary was found. Say what the login probe
    // found too, so a signed-out CLI is visible before a task dies on it.
    const auth = provider.runtime.auth
    if (auth && auth.state !== 'unknown') {
      const badge = element('span', `auth-chip ${auth.state}`, auth.state === 'logged-in' ? 'signed in' : 'signed out')
      badge.title = auth.detail ?? (auth.state === 'logged-out' ? 'This CLI is installed but not signed in.' : '')
      identityText.append(badge)
    }
    identity.append(lamp(providerLampTone(provider), providerCapacity(provider).label), identityText)
    const toggleLabel = document.createElement('label'); toggleLabel.className = 'switch'
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = provider.enabled
    toggleLabel.append(toggle, element('span', 'slider'))
    header.append(identity, toggleLabel)

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

    const cpCapable = ['claude', 'copilot', 'codex', 'codex-oss'].includes(provider.kind)
    let cpToggle: HTMLInputElement | undefined
    if (cpCapable) {
      cpToggle = document.createElement('input'); cpToggle.type = 'checkbox'; cpToggle.checked = provider.useControlPlane !== false
      const row = document.createElement('label'); row.className = 'checkbox-row wide'
      row.append(cpToggle, ' Apply shared Context & Tools profile')
      form.append(row)
    }

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
          enabled: toggle.checked,
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
    toggle.addEventListener('change', () => save.click())
    const buttons = element('div', 'header-actions')
    if (provider.kind === 'custom') {
      const remove = element('button', 'text-button', 'Remove')
      remove.addEventListener('click', async () => {
        try { await window.frontier.removeProvider(provider.id); showToast('Custom agent removed') }
        catch (error) { reportError('Could not remove agent', error) }
      })
      buttons.append(remove)
    }
    buttons.append(save)
    footer.append(health, buttons)
    card.append(header, form, footer)
    return card
  }))
}

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

export function renderUsage(): void {
  const grid = byId('usage-grid')
  grid.replaceChildren(...snapshot.providers.map((provider) => {
    const usage = provider.runtime.usage
    const hasActual = usage.inputTokens + usage.outputTokens > 0

    const capacity = providerCapacity(provider)
    const card = element('article', `panel usage-card ${capacity.tone === 'limited' ? 'limited' : ''}`)
    const header = element('div', 'usage-card-header')
    const identity = element('div', 'usage-card-identity')
    identity.append(lamp(providerLampTone(provider), capacity.label), element('h3', undefined, provider.name))
    header.append(identity, element('span', `capacity-badge ${capacity.tone}`, capacity.label))

    const stats = element('div', 'usage-stats')
    stats.append(
      // A CLI that never reports cost must not read as "this cost nothing".
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
      // This CLI may report the window without reporting how much of it is
      // spent; then the gauge shows elapsed time and says so, rather than
      // pretending zero usage.
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

    card.append(header, gauges, stats)
    const history = usageHistory(provider.runtime.history ?? [], usage)
    if (history) card.append(history)
    const models = usageModels(usage)
    if (models) card.append(models)
    card.append(footer)
    return card
  }))
}

export function renderAgentsTab(): void {
  document.querySelectorAll<HTMLElement>('#agents-segmented button').forEach((button) => button.classList.toggle('active', button.dataset.agentsTab === agentsTab))
  byId('agents-registry').classList.toggle('active', agentsTab === 'registry')
  byId('agents-usage').classList.toggle('active', agentsTab === 'usage')
  if (agentsTab === 'registry') renderProviders()
  else renderUsage()
}

export function initAgentsView(): void {
  document.querySelectorAll<HTMLElement>('#agents-segmented button').forEach((button) => button.addEventListener('click', () => {
    agentsTab = button.dataset.agentsTab === 'usage' ? 'usage' : 'registry'
    renderAgentsTab()
  }))
  byId('health-check').addEventListener('click', async () => {
    const button = byId<HTMLButtonElement>('health-check'); button.disabled = true; setIconLabel(button, undefined, 'Checking…')
    try { await window.frontier.checkProviders(); showToast('Agent health refreshed') }
    catch (error) { reportError('Agent check failed', error) }
    finally { button.disabled = false; setIconLabel(button, 'refresh', 'Check agents') }
  })
  byId('add-provider').addEventListener('click', async () => {
    try {
      agentsTab = 'registry'
      await window.frontier.addCustomProvider()
      showToast('Custom agent added — configure it below')
      requestAnimationFrame(() => document.querySelector('.provider-card:last-child')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
    } catch (error) { reportError('Could not add agent', error) }
  })
}
