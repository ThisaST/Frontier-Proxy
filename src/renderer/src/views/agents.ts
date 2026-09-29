// Agents — installed CLIs as a table on the Calm kit; a row opens a right-side sheet holding the
// agent's config form, plan windows and usage. Login state is read-only evidence from each CLI's own
// session (CLAUDE.md, Provider login state), so "Unknown" is never shown as "Logged out".
import type { ModelTier, UsageDay } from '../../../shared/types'
import { tierFor } from '../../../shared/model-profiles'
import { byId, element } from '../ui/dom'
import { dialogHandle, fieldLabel, meter, sectionTitle, status, tag, type MeterTone, type StatusTone } from '../ui/components'
import { setIconLabel } from '../ui/icons'
import { reportError, showToast } from '../ui/feedback'
import { countdown, formatArguments, formatCost, formatNumber, listValues, splitArguments } from '../ui/format'
import { activeCooldown, providerCapacity, providerLimitReached, providerQuota, providerSessions, trackedTokens, type SnapshotProvider } from '../providers-view-model'
import { sessionResetAt, sessionStatusNote, sessionWindowElapsedPercent, sessionWindowLabel, sessionWindowPercent } from '../../../shared/sessions'
import { loginState } from '../../../shared/review-agents'
import { snapshot } from '../state'
import { SKILL_CAPABLE_KINDS } from './skills'

const TIER_ORDER: ModelTier[] = ['frontier', 'standard', 'fast', 'local']

function providerModels(provider: SnapshotProvider): string[] {
  return [...new Set([...(provider.runtime.models ?? []), ...(provider.model ? [provider.model] : [])])]
}

// What the agent's own dot means: capacity right now, not login. `providerCapacity` is shared with the router's view.
function capacityStatus(provider: SnapshotProvider): { tone: StatusTone; label: string } {
  const capacity = providerCapacity(provider)
  const tone: StatusTone = capacity.tone === 'limited' ? 'danger' : capacity.tone === 'offline' ? 'warn' : capacity.tone === 'busy' ? 'running' : capacity.tone === 'muted' ? 'neutral' : 'ok'
  return { tone, label: capacity.label }
}

function windowTone(percent: number): MeterTone { return percent >= 90 ? 'danger' : percent >= 75 ? 'warn' : 'accent' }

function control<T extends HTMLElement>(node: T, className: string, id: string): T { node.className = className; node.id = id; return node }
function textField(value: string, id: string, type = 'text', mono = false): HTMLInputElement {
  const input = control(document.createElement('input'), `input${mono ? ' agents-mono' : ''}`, id)
  input.type = type; input.value = value
  return input
}
function labelled(label: string, input: HTMLElement, wide = false): HTMLElement {
  const wrap = element('div', `field${wide ? ' full' : ''}`)
  wrap.append(fieldLabel(label, input.id), input)
  return wrap
}
function checkRow(input: HTMLInputElement, text: string): HTMLElement {
  const row = element('label', 'agents-check full')
  input.type = 'checkbox'
  row.append(input, element('span', undefined, text))
  return row
}

// ---------- Sheet: the config form ----------

let drawerDirty = false

function providerFormSection(provider: SnapshotProvider): HTMLElement {
  const section = element('div', 'agents-form-section')

  // The CLI's own state, then its login. "CLI found" is a `--version` probe, not proof of a session.
  const state = element('div', 'agents-sheet-state')
  const auth = provider.runtime.auth
  const login = loginState(auth)
  state.append(
    status(provider.runtime.available ? 'ok' : provider.enabled ? 'warn' : 'neutral', provider.runtime.available ? `CLI found · ${provider.runtime.version ?? 'version unknown'}` : provider.enabled ? 'CLI not detected' : 'Disabled'),
    status(login.tone, login.label, { title: auth?.detail })
  )
  if (login.label !== 'Signed in') {
    state.append(element('p', 'agents-help', login.tone === 'danger'
      ? `${auth?.detail ? `${auth.detail}. ` : ''}Sign in with this CLI's own login, then choose Check agents.`
      : `Frontier could not verify this login from disk.${auth?.detail ? ` ${auth.detail}.` : ''} If tasks fail with an authentication error, sign in with the CLI's own login.`))
  }
  section.append(state)

  const form = element('div', 'agents-form')
  const displayName = textField(provider.name, 'agent-f-name')
  const executable = textField(provider.executable, 'agent-f-exe', 'text', true)
  const model = textField(provider.model ?? '', 'agent-f-model', 'text', true)
  const priority = textField(String(provider.priority), 'agent-f-priority', 'number', true); priority.min = '0'; priority.max = '100'
  const concurrency = textField(String(provider.maxConcurrent), 'agent-f-parallel', 'number', true); concurrency.min = '1'; concurrency.max = '8'
  const budget = textField(provider.dailyTokenBudget ? String(provider.dailyTokenBudget) : '', 'agent-f-budget', 'number', true); budget.min = '0'; budget.placeholder = 'Unlimited'
  const contextWindow = textField(provider.contextWindow ? String(provider.contextWindow) : '', 'agent-f-context', 'number', true); contextWindow.min = '0'; contextWindow.placeholder = 'Auto-detect'
  const args = textField(formatArguments(provider.args ?? []), 'agent-f-args', 'text', true)
  form.append(
    labelled('Display name', displayName), labelled('Executable', executable), labelled('Model (optional)', model), labelled('Routing priority', priority),
    labelled('Parallel tasks', concurrency), labelled('Tracked usage limit', budget), labelled('Context window (tokens)', contextWindow), element('div'),
    labelled('Extra arguments (quotes supported)', args, true)
  )

  let copilotToolsets: HTMLTextAreaElement | undefined
  let copilotTools: HTMLTextAreaElement | undefined
  let copilotAllTools: HTMLInputElement | undefined
  if (provider.kind === 'copilot') {
    copilotToolsets = control(document.createElement('textarea'), 'textarea agents-mono', 'agent-f-toolsets'); copilotToolsets.rows = 2
    copilotToolsets.value = (provider.copilotGithubMcpToolsets ?? []).join('\n'); copilotToolsets.placeholder = 'actions, code_security, discussions…'
    copilotTools = control(document.createElement('textarea'), 'textarea agents-mono', 'agent-f-tools'); copilotTools.rows = 2
    copilotTools.value = (provider.copilotGithubMcpTools ?? []).join('\n'); copilotTools.placeholder = 'Individual GitHub MCP tool names (optional)'
    copilotAllTools = document.createElement('input'); copilotAllTools.checked = Boolean(provider.copilotEnableAllGithubMcpTools)
    const syncCopilotFields = (): void => { copilotToolsets!.disabled = copilotAllTools!.checked; copilotTools!.disabled = copilotAllTools!.checked }
    copilotAllTools.addEventListener('change', syncCopilotFields)
    syncCopilotFields()
    form.append(
      labelled('GitHub MCP toolsets', copilotToolsets, true), labelled('Individual GitHub MCP tools', copilotTools, true),
      checkRow(copilotAllTools, 'Enable every built-in GitHub MCP tool'),
      element('p', 'agents-help full', 'Optional. Toolsets and tools extend Copilot’s default GitHub subset for each Frontier task. “Every tool” overrides both lists.')
    )
  }

  let cpToggle: HTMLInputElement | undefined
  if ((SKILL_CAPABLE_KINDS as readonly string[]).includes(provider.kind)) {
    cpToggle = document.createElement('input'); cpToggle.checked = provider.useControlPlane !== false
    form.append(checkRow(cpToggle, 'Apply shared Context & Tools profile'))
  }
  section.append(form)

  const actions = element('div', 'agents-form-actions')
  if (provider.kind === 'custom') {
    const remove = element('button', 'btn btn-danger', 'Remove agent') as HTMLButtonElement; remove.type = 'button'
    remove.addEventListener('click', async () => {
      try { await window.frontier.removeProvider(provider.id); showToast('Custom agent removed'); agentDrawer.close() }
      catch (error) { reportError('Could not remove agent', error) }
    })
    actions.append(remove)
  }
  const save = element('button', 'btn btn-primary', 'Save agent') as HTMLButtonElement; save.type = 'button'
  save.addEventListener('click', async () => {
    save.disabled = true
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
      drawerDirty = false
      showToast(`${provider.name} updated`)
    } catch (error) { reportError(`Could not update ${provider.name}`, error) } finally { save.disabled = false }
  })
  actions.append(save)
  section.append(actions)
  // An edit in progress is never overwritten by a streamed snapshot (see renderDrawer).
  section.addEventListener('input', () => { drawerDirty = true })
  section.addEventListener('change', () => { drawerDirty = true })
  return section
}

// ---------- Sheet: usage, plan windows and sessions ----------

function stat(label: string, value: string, muted = false): HTMLElement {
  const node = element('div', 'agents-stat')
  node.append(fieldLabel(label), element('span', `agents-stat-value${muted ? ' muted' : ''}`, value))
  return node
}

// One window (or budget) as a card: name, mono readout, a meter, and one line of explanation.
function windowCard(label: string, readout: string, percent: number | undefined, tone: MeterTone | undefined, detail: string): HTMLElement {
  const card = element('div', 'card agents-window')
  const head = element('div', 'agents-window-head')
  head.append(element('span', 'agents-window-label', label), element('span', 'agents-mono', readout))
  card.append(head)
  if (percent !== undefined) card.append(meter(percent, tone, label))
  card.append(element('p', 'agents-help', detail))
  return card
}

// Fourteen days of tracked tokens as bars. A shape, not a table: the exact numbers live in the stats above it.
function usageHistory(history: UsageDay[], todayUsage: UsageDay): HTMLElement | undefined {
  const days = [...history, todayUsage].slice(-14)
  const totals = days.map((day) => (day.inputTokens + day.outputTokens) || (day.estimatedInputTokens + day.estimatedOutputTokens))
  const peak = Math.max(...totals)
  if (days.length < 2 || peak <= 0) return undefined
  const section = element('div', 'agents-history')
  section.append(fieldLabel(`Tracked tokens · last ${days.length} day${days.length === 1 ? '' : 's'}`))
  const chart = element('div', 'agents-bars')
  chart.setAttribute('role', 'img')
  chart.setAttribute('aria-label', `Tracked tokens per day, last ${days.length} days; today ${formatNumber(totals[totals.length - 1])}`)
  days.forEach((day, index) => {
    const bar = element('span', `agents-bar${index === days.length - 1 ? ' today' : ''}`)
    bar.style.height = `${Math.max(3, (totals[index] / peak) * 100)}%`
    bar.title = `${day.date} · ${formatNumber(totals[index])} tokens · ${day.tasks} run${day.tasks === 1 ? '' : 's'}`
    chart.append(bar)
  })
  section.append(chart)
  return section
}

// Which models consumed the day's tokens. A CLI can switch models mid-plan, so per-provider totals alone cannot say.
function usageModels(usage: UsageDay): HTMLElement | undefined {
  const entries = Object.entries(usage.models ?? {}).filter(([, value]) => value.inputTokens + value.outputTokens > 0)
  if (!entries.length) return undefined
  entries.sort((left, right) => (right[1].inputTokens + right[1].outputTokens) - (left[1].inputTokens + left[1].outputTokens))
  const section = element('div', 'agents-models')
  section.append(fieldLabel('By model today'))
  for (const [model, value] of entries.slice(0, 5)) {
    const row = element('div', 'agents-model-row')
    row.append(element('span', 'agents-mono agents-model-name', model), element('span', 'agents-mono muted', `${formatNumber(value.inputTokens + value.outputTokens)} tokens${value.costUsd > 0 ? ` · ${formatCost(value.costUsd)}` : ''}`))
    section.append(row)
  }
  return section
}

function providerUsageSection(provider: SnapshotProvider): HTMLElement {
  const section = element('div', 'agents-usage-section')
  section.append(sectionTitle('Usage and limits'))
  const usage = provider.runtime.usage
  const hasActual = usage.inputTokens + usage.outputTokens > 0
  const capacity = providerCapacity(provider)
  const limited = capacity.tone === 'limited'

  const windows = element('div', 'agents-windows')
  const sessions = providerSessions(provider)
  for (const session of sessions) {
    const percent = sessionWindowPercent(session)
    const resetAt = sessionResetAt(session)
    const note = sessionStatusNote(session)
    const reset = resetAt ? `Resets in ${countdown(resetAt)}` : 'No reset time reported by the CLI'
    const extras = [session.usingOverage ? 'overage in use' : undefined, note].filter(Boolean)
    if (percent !== undefined) {
      windows.append(windowCard(`${sessionWindowLabel(session)} limit used`, `${Math.round(percent)}%`, percent, windowTone(percent), [reset, ...extras].join(' · ')))
    } else {
      // Claude reports the window and its reset, but no utilization: the bar is elapsed time, and says so.
      const elapsed = sessionWindowElapsedPercent(session)
      windows.append(windowCard(`${sessionWindowLabel(session)} window elapsed`, elapsed === undefined ? '—' : `${Math.round(elapsed)}% of the time`, elapsed, undefined, [reset, ...extras, 'this CLI reports no usage percentage'].join(' · ')))
    }
  }
  if (provider.dailyTokenBudget) {
    const tracked = Math.min(100, (trackedTokens(provider) / provider.dailyTokenBudget) * 100)
    windows.append(windowCard('Tracked daily budget', `${Math.round(tracked)}%`, tracked, tracked >= 90 ? (limited ? 'danger' : 'warn') : 'accent', `${formatNumber(trackedTokens(provider))} / ${formatNumber(provider.dailyTokenBudget)} tracked tokens`))
  } else if (!sessions.length) {
    const cooldown = activeCooldown(provider)
    windows.append(cooldown
      ? windowCard('Automatic fallback', '100%', 100, 'danger', `Limit reached · retries in ${countdown(provider.runtime.cooldownUntil)}`)
      : windowCard('Plan window', 'Not reported', undefined, undefined, `No plan limit reported · ${formatNumber(trackedTokens(provider))} tracked tokens`))
  }

  const stats = element('div', 'agents-stats')
  stats.append(
    stat('Cost today', usage.costReported ? formatCost(usage.costUsd) : 'not reported', !usage.costReported),
    stat(hasActual ? 'Input tokens' : 'Input (estimated)', formatNumber(hasActual ? usage.inputTokens : usage.estimatedInputTokens)),
    stat(hasActual ? 'Output tokens' : 'Output (estimated)', formatNumber(hasActual ? usage.outputTokens : usage.estimatedOutputTokens)),
    stat('Tasks', String(usage.tasks))
  )
  section.append(windows, stats)
  const history = usageHistory(provider.runtime.history ?? [], usage)
  if (history) section.append(history)
  const models = usageModels(usage)
  if (models) section.append(models)

  const attention = sessions.map(sessionStatusNote).find(Boolean)
  const overage = sessions.find((session) => session.overageStatus && session.overageStatus !== 'allowed')
  section.append(element('p', 'agents-help', providerLimitReached(provider)
    ? `Frontier will skip ${provider.name} while this limit is active and route work elsewhere.`
    : attention
      ? `Plan status: ${attention}`
      : sessions.length
        ? `${sessions.length} usage window${sessions.length === 1 ? '' : 's'} in force${overage ? ` · overage ${overage.overageStatus?.replaceAll('_', ' ')}` : ''}.`
        : 'No plan window has been reported in this app session.'))
  return section
}

// ---------- Sheet shell ----------

const agentDrawer = dialogHandle(byId<HTMLDialogElement>('agent-drawer'))
let openProviderId: string | undefined

function renderDrawer(fallback?: SnapshotProvider): void {
  if (!openProviderId) return
  const provider = snapshot.providers.find((item) => item.id === openProviderId) ?? (fallback?.id === openProviderId ? fallback : undefined)
  if (!provider) { agentDrawer.close(); return }
  byId('agent-drawer-kind').textContent = provider.kind
  byId('agent-drawer-title').textContent = provider.name
  const body = byId('agent-drawer-body')
  const formSection = body.querySelector('.agents-form-section')
  // Rebuilding the form wipes whatever is being typed, so while it is dirty or focused only the usage
  // section (which the user cannot edit) follows the snapshot.
  if (formSection && body.dataset.providerId === provider.id && (drawerDirty || formSection.contains(document.activeElement))) {
    body.querySelector('.agents-usage-section')?.replaceWith(providerUsageSection(provider))
    return
  }
  body.dataset.providerId = provider.id
  drawerDirty = false
  body.replaceChildren(providerFormSection(provider), providerUsageSection(provider))
}

export function refreshAgentDrawer(): void {
  if (openProviderId && agentDrawer.el.open) renderDrawer()
}

function openAgentDrawer(provider: SnapshotProvider, trigger?: HTMLElement): void {
  openProviderId = provider.id
  drawerDirty = false
  delete byId('agent-drawer-body').dataset.providerId
  renderDrawer(provider)
  agentDrawer.open(trigger)
}

// ---------- Table ----------

interface Column { label: string; className?: string; render(provider: SnapshotProvider): Node | string }

function modelsCell(provider: SnapshotProvider): HTMLElement {
  const models = providerModels(provider)
  const wrap = element('div', 'agents-models-cell')
  if (!models.length) { wrap.append(element('span', 'agents-muted', 'None discovered')); return wrap }
  const tiers = TIER_ORDER.filter((tier) => models.some((model) => tierFor(model, provider.kind) === tier))
  wrap.append(element('span', 'agents-muted', `${models.length} model${models.length === 1 ? '' : 's'}`))
  for (const tier of tiers.slice(0, 3)) wrap.append(tag(tier))
  wrap.title = models.join('\n')
  return wrap
}

// The plan window column, in the order the CLIs report it: a real percentage, else a muted bar of elapsed
// time (labelled as such — Claude reports no utilization), else the reset alone, else nothing.
function planWindowCell(provider: SnapshotProvider): HTMLElement {
  const quota = providerQuota(provider)
  const wrap = element('div', 'agents-plan-cell')
  const resets = quota.reset ? `resets in ${countdown(quota.reset)}` : undefined
  if (quota.percent !== undefined) {
    wrap.append(meter(quota.percent, windowTone(quota.percent), quota.text), element('span', 'agents-mono muted', `${Math.round(quota.percent)}%${resets ? ` · ${resets}` : ' used'}`))
    wrap.title = quota.text
  } else if (quota.timePercent !== undefined) {
    wrap.append(meter(quota.timePercent, undefined, 'Time elapsed in the plan window'), element('span', 'agents-mono muted', `time elapsed${resets ? ` · ${resets}` : ''}`))
    wrap.title = `${quota.text}. This CLI reports no usage percentage; the bar shows time elapsed in the window.`
  } else if (resets) {
    wrap.append(element('span', 'agents-mono muted', resets)); wrap.title = quota.text
  } else wrap.append(element('span', 'agents-muted', quota.text))
  return wrap
}

function enabledSwitch(provider: SnapshotProvider): HTMLElement {
  const label = element('label', 'switch small')
  const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = provider.enabled
  toggle.setAttribute('aria-label', `Enable ${provider.name}`)
  label.append(toggle, element('span', 'slider'))
  label.addEventListener('click', (event) => event.stopPropagation())
  label.addEventListener('keydown', (event) => event.stopPropagation())
  toggle.addEventListener('change', async () => {
    toggle.disabled = true
    try { await window.frontier.updateProvider({ id: provider.id, changes: { enabled: toggle.checked } }) }
    catch (error) { toggle.checked = !toggle.checked; reportError(`Could not update ${provider.name}`, error) }
    finally { toggle.disabled = false }
  })
  return label
}

const COLUMNS: Column[] = [
  { label: 'Agent', render: (provider) => {
    const capacity = capacityStatus(provider)
    const cell = element('div', 'agents-name-cell')
    cell.append(status(capacity.tone, '', { ariaLabel: capacity.label, title: capacity.label }), element('span', 'agents-name', provider.name))
    return cell
  } },
  { label: 'Kind', render: (provider) => tag(provider.kind) },
  { label: 'Login', render: (provider) => { const login = loginState(provider.runtime.auth); return status(login.tone, login.label, { title: provider.runtime.auth?.detail }) } },
  { label: 'Version', className: 'agents-mono', render: (provider) => provider.runtime.version ?? '—' },
  { label: 'Models', render: modelsCell },
  { label: 'Today’s tokens', className: 'num', render: (provider) => formatNumber(trackedTokens(provider)) },
  { label: 'Plan window', render: planWindowCell },
  { label: 'Enabled', className: 'agents-enabled', render: enabledSwitch }
]

function agentsTable(rows: SnapshotProvider[]): HTMLElement {
  if (!rows.length) {
    const empty = element('div', 'empty')
    empty.append(element('p', undefined, 'No agents configured. Choose Add CLI to configure one.'))
    return empty
  }
  const wrap = element('div', 'agents-table-wrap')
  const table = document.createElement('table'); table.className = 'table agents-table'
  const head = document.createElement('tr')
  for (const column of COLUMNS) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = column.label; if (column.className === 'num' || column.className === 'agents-enabled') th.className = column.className; head.append(th) }
  const thead = document.createElement('thead'); thead.append(head)
  const tbody = document.createElement('tbody')
  for (const provider of rows) {
    const tr = document.createElement('tr')
    tr.className = 'agents-row'; tr.tabIndex = 0; tr.dataset.providerId = provider.id
    tr.setAttribute('aria-label', `Open ${provider.name} configuration`)
    tr.addEventListener('click', () => openAgentDrawer(provider, tr))
    tr.addEventListener('keydown', (event) => { if (event.key === 'Enter' && event.target === tr) { event.preventDefault(); openAgentDrawer(provider, tr) } })
    for (const column of COLUMNS) {
      const td = document.createElement('td')
      if (column.className) td.className = column.className
      const rendered = column.render(provider)
      if (typeof rendered === 'string') td.textContent = rendered; else td.append(rendered)
      tr.append(td)
    }
    tbody.append(tr)
  }
  table.append(thead, tbody)
  wrap.append(table)
  return wrap
}

// ---------- Getting-started notice ----------

const SETUP_DISMISS_KEY = 'fp-agents-setup-dismissed'

function applySetupGuideState(): void {
  const dismissed = (() => { try { return localStorage.getItem(SETUP_DISMISS_KEY) === 'true' } catch { return false } })()
  byId('agents-setup-guide').hidden = dismissed
}

export function renderAgentsView(): void {
  byId('agents-table').replaceChildren(agentsTable(snapshot.providers))
  refreshAgentDrawer()
}

export function initAgentsView(): void {
  applySetupGuideState()
  byId('agents-setup-dismiss').addEventListener('click', () => {
    try { localStorage.setItem(SETUP_DISMISS_KEY, 'true') } catch { /* private mode / disabled storage */ }
    applySetupGuideState()
  })
  byId('agent-drawer-close').addEventListener('click', () => agentDrawer.close())
  byId<HTMLDialogElement>('agent-drawer').addEventListener('close', () => {
    // The table is rebuilt on every snapshot, so the row that opened the sheet may be gone by now.
    const closedId = openProviderId
    openProviderId = undefined; drawerDirty = false
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active && active !== document.body && !agentDrawer.el.contains(active)) return // focus already landed somewhere real
      document.querySelector<HTMLElement>(`#agents-table tr[data-provider-id="${closedId}"]`)?.focus()
    })
  })

  byId('health-check').addEventListener('click', async () => {
    const button = byId<HTMLButtonElement>('health-check'); button.disabled = true; setIconLabel(button, undefined, 'Checking…')
    try { await window.frontier.checkProviders(); showToast('Agent health refreshed') }
    catch (error) { reportError('Agent check failed', error) }
    finally { button.disabled = false; setIconLabel(button, 'refresh', 'Check agents') }
  })
  // Adds a blank custom agent immediately (no dialog) and opens its sheet so it can be configured.
  byId('add-provider').addEventListener('click', async () => {
    const known = new Set(snapshot.providers.map((provider) => provider.id))
    try {
      const next = await window.frontier.addCustomProvider()
      showToast('Custom agent added — configure it in the sheet')
      const created = next.providers.find((provider) => !known.has(provider.id))
      if (created) openAgentDrawer(created, byId('add-provider'))
    } catch (error) { reportError('Could not add agent', error) }
  })
}
