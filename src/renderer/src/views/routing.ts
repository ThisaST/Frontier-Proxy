// Routing — the Jev advisor console: mode, credentials, the exact payload
// preview, the model catalog, routing policies, and shadow-mode insights.
// The whole view is built once here since index.html only ever gets an empty
// `#routing-view` section (P3a/P3b split — see CLAUDE.md).
import type { AdvisorMode, AdvisorPreviewResult, ModelTier, ProxyTask, RoutingMode } from '../../../shared/types'
import { describeCandidate, profileFor, tierFor } from '../../../shared/model-profiles'
import { byId, element, emptyState, field, textArea, textInput } from '../ui/dom'
import { chip, lamp, probabilityBar, type Tone } from '../ui/components'
import { confirmAction, errorMessage, reportError, showToast } from '../ui/feedback'
import { formatDuration, timeAgo } from '../ui/format'
import { highlightBlock } from '../syntax'
import { providerName } from '../providers-view-model'
import { snapshot } from '../state'

const MODE_COPY: Record<AdvisorMode, { title: string; body: string }> = {
  off: { title: 'Off', body: 'Frontier routes with its own rules. Nothing leaves this machine.' },
  shadow: { title: 'Shadow', body: "Jev is asked, and its pick is recorded next to the real route, but it changes nothing." },
  active: { title: 'Active', body: "Jev's answers become bounded, labelled factors in the route. It never overrides your picks or an agent's limits." }
}

const TIER_LABEL: Record<ModelTier, string> = { local: 'Local', fast: 'Fast', standard: 'Standard', frontier: 'Frontier' }
const TIER_TONE: Record<ModelTier, Tone> = { local: 'muted', fast: 'cyan', standard: 'phosphor', frontier: 'amber' }
const TIER_ORDER: ModelTier[] = ['local', 'fast', 'standard', 'frontier']

// Mirrors `desiredTier` in `src/main/router.ts` (kept local: the renderer
// never imports from src/main). Used only for the Routing/Route-tab display,
// never to decide anything — the real thresholds live with the router.
export function desiredTierForDisplay(complexity: number, mode: RoutingMode): ModelTier {
  const base: ModelTier = complexity < 0.75 ? 'fast' : complexity < 2.5 ? 'standard' : 'frontier'
  const shift = mode === 'saver' ? -1 : mode === 'quality' ? 1 : 0
  if (!shift) return base
  return TIER_ORDER[Math.max(0, Math.min(TIER_ORDER.length - 1, TIER_ORDER.indexOf(base) + shift))]
}

const EXAMPLE_PROMPT = 'Fix the flaky test in src/auth/session.test.ts and add a regression test for the race it hits.'

let sentCwdTouched = false
let previewResult: AdvisorPreviewResult | undefined
let previewUsedJev = false

function modeExplainRows(): HTMLElement {
  const list = element('div', 'routing-mode-explain')
  for (const key of ['off', 'shadow', 'active'] as AdvisorMode[]) {
    const row = element('div', `policy mode-${key}`)
    row.append(element('strong', undefined, MODE_COPY[key].title), element('span', undefined, MODE_COPY[key].body))
    list.append(row)
  }
  return list
}

function renderModeExplain(mode: AdvisorMode): void {
  document.querySelectorAll<HTMLElement>('.routing-mode-explain .policy').forEach((row) => {
    row.classList.toggle('active', row.classList.contains(`mode-${mode}`))
  })
}

function buildAdvisorCard(): HTMLElement {
  const card = element('section', 'panel routing-card')
  const head = element('div', 'routing-card-head')
  const heading = element('div'); heading.append(element('p', 'eyebrow', 'JEV'), element('h2', undefined, 'Routing advisor'))
  const status = element('div', 'routing-status')
  status.id = 'routing-status'
  head.append(heading, status)
  card.append(head)

  const segmented = element('div', 'segmented', undefined) as HTMLElement
  segmented.id = 'routing-mode-segmented'
  segmented.setAttribute('role', 'tablist')
  segmented.setAttribute('aria-label', 'Advisor mode')
  for (const key of ['off', 'shadow', 'active'] as AdvisorMode[]) {
    const button = element('button', undefined, MODE_COPY[key].title) as HTMLButtonElement
    button.type = 'button'; button.dataset.advisorMode = key; button.setAttribute('role', 'tab')
    segmented.append(button)
  }
  card.append(segmented, modeExplainRows())

  const keyRow = element('div', 'routing-key-row')
  const keyInput = textInput('', 'password'); keyInput.id = 'routing-key-input'; keyInput.placeholder = 'TypeSafe API key'
  keyInput.autocomplete = 'off'
  const keySave = element('button', 'secondary-button', 'Save key') as HTMLButtonElement; keySave.id = 'routing-key-save'; keySave.type = 'button'
  const keyRemove = element('button', 'text-button', 'Remove key') as HTMLButtonElement; keyRemove.id = 'routing-key-remove'; keyRemove.type = 'button'
  const keyTest = element('button', 'secondary-button', 'Test connection') as HTMLButtonElement; keyTest.id = 'routing-key-test'; keyTest.type = 'button'
  keyRow.append(field('API key', keyInput, true), keySave, keyRemove, keyTest)
  const keyResult = element('p', 'field-help'); keyResult.id = 'routing-key-result'
  card.append(keyRow, keyResult)

  const configRow = element('div', 'routing-config-row')
  const modelInput = textInput('jev-latest'); modelInput.id = 'routing-model-input'
  const confidence = document.createElement('input'); confidence.type = 'range'; confidence.id = 'routing-confidence-range'
  confidence.min = '0.3'; confidence.max = '0.9'; confidence.step = '0.05'
  const confidenceField = field('Confidence threshold', confidence)
  const confidenceReadout = element('span', 'readout routing-confidence-readout'); confidenceReadout.id = 'routing-confidence-readout'
  confidenceField.append(confidenceReadout)
  configRow.append(field('Model', modelInput), confidenceField)
  const confidenceHelp = element('p', 'field-help', 'Below this, Frontier ignores that answer and uses its own rules.')
  card.append(configRow, confidenceHelp)

  const shareRow = document.createElement('label'); shareRow.className = 'checkbox-row wide'
  const shareInput = document.createElement('input'); shareInput.type = 'checkbox'; shareInput.id = 'routing-share-facts'
  shareRow.append(shareInput, ' Share repo facts (languages, file count, manifests, top-level folders — never file contents)')

  const typingRow = document.createElement('label'); typingRow.className = 'checkbox-row wide'
  const typingInput = document.createElement('input'); typingInput.type = 'checkbox'; typingInput.id = 'routing-preview-typing'
  typingRow.append(typingInput, ' Ask Jev while I type (sends drafts to TypeSafe)')
  const typingCaution = element('p', 'field-help caution', 'Every keystroke in the composer would be sent as a draft prompt while this is on.')

  const save = element('button', 'primary-button', 'Save advisor settings') as HTMLButtonElement; save.id = 'routing-advisor-save'; save.type = 'button'
  card.append(shareRow, typingRow, typingCaution, save)
  return card
}

function buildSentCard(): HTMLElement {
  const card = element('section', 'panel routing-card routing-card-wide')
  card.append(element('p', 'eyebrow', 'WHAT IS SENT'), element('h2', undefined, 'Payload preview'))
  card.append(element('p', 'field-help', 'Preview the exact request Jev would receive for a prompt and project, without creating a task.'))

  const form = element('div', 'routing-sent-form')
  const prompt = textArea(EXAMPLE_PROMPT, 3); prompt.id = 'routing-sent-prompt'
  const cwd = textInput(''); cwd.id = 'routing-sent-cwd'; cwd.placeholder = '/path/to/project'
  const chooseDir = element('button', 'secondary-button', 'Choose folder…') as HTMLButtonElement; chooseDir.id = 'routing-sent-choose-dir'; chooseDir.type = 'button'
  const cwdField = document.createElement('label'); cwdField.append('Project path')
  const pathControl = element('div', 'path-control'); pathControl.append(cwd, chooseDir)
  cwdField.append(pathControl)
  const preview = element('button', 'primary-button', 'Preview request') as HTMLButtonElement; preview.id = 'routing-sent-preview'; preview.type = 'button'
  form.append(field('Example prompt', prompt, true), cwdField, preview)
  card.append(form)

  const result = element('div', 'routing-sent-result'); result.id = 'routing-sent-result'
  result.append(element('p', 'detail-empty', 'Choose Preview request to see the exact payload, the resulting route, and whether it used Jev or Frontier’s own rules.'))
  card.append(result)
  return card
}

function buildCatalogCard(): HTMLElement {
  const card = element('section', 'panel routing-card routing-card-wide')
  card.append(element('p', 'eyebrow', 'MODEL CATALOG'), element('h2', undefined, 'What each model is good at'))
  const wrap = element('div', 'routing-table-wrap')
  const table = document.createElement('table'); table.className = 'data-table'
  const thead = document.createElement('thead')
  thead.innerHTML = '<tr><th>Agent</th><th>Model</th><th>Tier</th><th>Strengths</th></tr>'
  const tbody = document.createElement('tbody'); tbody.id = 'routing-catalog-body'
  table.append(thead, tbody)
  wrap.append(table)
  card.append(wrap)
  return card
}

function buildPolicyCard(): HTMLElement {
  const card = element('section', 'panel routing-card')
  card.append(element('p', 'eyebrow', 'ROUTING POLICIES'), element('h2', undefined, 'How selection works'))
  const balanced = element('div', 'policy'); balanced.append(element('strong', undefined, 'Balanced'), element('span', undefined, 'Matches task type, spreads subscription usage, then considers local models.'))
  const quality = element('div', 'policy'); quality.append(element('strong', undefined, 'Quality first'), element('span', undefined, 'Prefers Codex or Claude Code and only falls back when unavailable.'))
  const saver = element('div', 'policy'); saver.append(element('strong', undefined, 'Token saver'), element('span', undefined, 'Strongly favors Ollama-backed agents to preserve hosted usage.'))
  card.append(balanced, quality, saver)
  card.append(element('p', 'field-help', 'Every task records the exact scores behind its decision — open its Route tab to see them.'))

  const learnRow = element('div', 'checkbox-row')
  const learnInput = document.createElement('input'); learnInput.type = 'checkbox'; learnInput.id = 'learn-outcomes'
  const learnLabel = document.createElement('label'); learnLabel.setAttribute('for', 'learn-outcomes'); learnLabel.textContent = 'Let recent outcomes influence routing'
  learnRow.append(learnInput, learnLabel)
  card.append(learnRow)
  card.append(element('p', 'field-help', "Outcome learning nudges the router with how each agent's recent runs of the same kind of work turned out — finished, passed the repo's checks, and above all whether you merged or discarded its branch. It is capped at ±14 points and always shown as a labelled factor on the task's Route tab."))
  const save = element('button', 'primary-button', 'Save policy') as HTMLButtonElement; save.id = 'routing-policy-save'; save.type = 'button'
  card.append(save)
  return card
}

function buildInsightsCard(): HTMLElement {
  const card = element('section', 'panel routing-card')
  card.append(element('p', 'eyebrow', 'SHADOW INSIGHTS'), element('h2', undefined, 'Would Jev have agreed?'))
  const summary = element('p', 'routing-shadow-summary'); summary.id = 'routing-shadow-summary'
  const list = element('div', 'routing-shadow-list'); list.id = 'routing-shadow-list'
  card.append(summary, list)
  return card
}

export function initRoutingView(): void {
  const view = byId('routing-view')
  const grid = element('div', 'routing-grid')
  grid.append(buildAdvisorCard(), buildSentCard(), buildCatalogCard(), buildPolicyCard(), buildInsightsCard())
  view.replaceChildren(grid)

  byId('routing-mode-segmented').querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.addEventListener('click', async () => {
      const mode = (button.dataset.advisorMode as AdvisorMode) ?? 'off'
      renderModeSegmented(mode); renderModeExplain(mode)
      try { await window.frontier.updateSettings({ advisor: { ...snapshot.settings.advisor, mode } }); showToast(`Advisor set to ${MODE_COPY[mode].title}`) }
      catch (error) { reportError('Could not change advisor mode', error); renderRouting() }
    })
  })

  byId('routing-key-save').addEventListener('click', async () => {
    const input = byId<HTMLInputElement>('routing-key-input')
    const key = input.value.trim()
    if (!key) { reportError('Could not save the API key', new Error('Enter a key first.')); return }
    const button = byId<HTMLButtonElement>('routing-key-save'); button.disabled = true
    try { await window.frontier.setAdvisorKey(key); input.value = ''; showToast('API key saved') }
    catch (error) { reportError('Could not save the API key', error) } finally { button.disabled = false; renderRouting() }
  })
  byId('routing-key-remove').addEventListener('click', async () => {
    const confirmed = await confirmAction('Remove the stored API key?', 'Jev will stop working until a new key is saved. The advisor mode stays as configured.', 'Remove')
    if (!confirmed) return
    try { await window.frontier.clearAdvisorKey(); showToast('API key removed') }
    catch (error) { reportError('Could not remove the API key', error) } finally { renderRouting() }
  })
  byId('routing-key-test').addEventListener('click', async () => {
    const button = byId<HTMLButtonElement>('routing-key-test'); button.disabled = true; button.textContent = 'Testing…'
    const result = byId('routing-key-result')
    try {
      const test = await window.frontier.testAdvisor()
      result.textContent = test.ok ? `Connected · ${test.model ?? snapshot.settings.advisor.model} · ${formatDuration(test.latencyMs ?? 0)}` : (test.error ?? 'Test failed.')
      result.classList.toggle('caution', !test.ok)
    } catch (error) { result.textContent = errorMessage(error); result.classList.add('caution') }
    finally { button.disabled = false; button.textContent = 'Test connection'; renderRouting() }
  })

  byId('routing-advisor-save').addEventListener('click', async () => {
    const button = byId<HTMLButtonElement>('routing-advisor-save'); button.disabled = true
    try {
      await window.frontier.updateSettings({
        advisor: {
          mode: currentSegmentedMode(),
          model: byId<HTMLInputElement>('routing-model-input').value.trim() || 'jev-latest',
          minConfidence: Number(byId<HTMLInputElement>('routing-confidence-range').value) || 0.5,
          shareRepoFacts: byId<HTMLInputElement>('routing-share-facts').checked,
          previewWhileTyping: byId<HTMLInputElement>('routing-preview-typing').checked
        }
      })
      showToast('Advisor settings saved')
    } catch (error) { reportError('Could not save advisor settings', error) } finally { button.disabled = false }
  })
  byId<HTMLInputElement>('routing-confidence-range').addEventListener('input', (event) => {
    byId('routing-confidence-readout').textContent = Number((event.target as HTMLInputElement).value).toFixed(2)
  })

  byId<HTMLInputElement>('routing-sent-cwd').addEventListener('input', () => { sentCwdTouched = true })
  byId('routing-sent-choose-dir').addEventListener('click', async () => {
    const button = byId<HTMLButtonElement>('routing-sent-choose-dir'); button.disabled = true
    try {
      const input = byId<HTMLInputElement>('routing-sent-cwd')
      const directory = await window.frontier.chooseDirectory(input.value)
      if (directory) { input.value = directory; sentCwdTouched = true }
    } catch (error) { reportError('Folder picker failed', error) } finally { button.disabled = false }
  })
  byId('routing-sent-preview').addEventListener('click', () => void runPreview())

  byId('routing-policy-save').addEventListener('click', async () => {
    const button = byId<HTMLButtonElement>('routing-policy-save'); button.disabled = true
    try { await window.frontier.updateSettings({ learnFromOutcomes: byId<HTMLInputElement>('learn-outcomes').checked }); showToast('Routing policy saved') }
    catch (error) { reportError('Could not save routing policy', error) } finally { button.disabled = false }
  })
}

function currentSegmentedMode(): AdvisorMode {
  return (byId('routing-mode-segmented').querySelector<HTMLButtonElement>('button.active')?.dataset.advisorMode as AdvisorMode) ?? 'off'
}

function renderModeSegmented(mode: AdvisorMode): void {
  byId('routing-mode-segmented').querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    const active = button.dataset.advisorMode === mode
    button.classList.toggle('active', active)
    button.setAttribute('aria-selected', String(active))
  })
}

function renderStatus(): void {
  const status = byId('routing-status')
  const advisor = snapshot.advisor
  if (!advisor.hasKey) { status.replaceChildren(lamp('muted', 'No key'), element('span', undefined, 'No key')); return }
  if (advisor.lastError) { status.replaceChildren(lamp('caution', 'Advisor error'), element('span', undefined, advisor.lastError)); return }
  const checked = advisor.lastCheckedAt ? `Ready · checked ${timeAgo(advisor.lastCheckedAt)}` : 'Ready'
  status.replaceChildren(lamp('phosphor', 'Ready'), element('span', undefined, checked))
}

async function runPreview(): Promise<void> {
  const button = byId<HTMLButtonElement>('routing-sent-preview')
  const result = byId('routing-sent-result')
  const prompt = byId<HTMLTextAreaElement>('routing-sent-prompt').value
  const cwd = byId<HTMLInputElement>('routing-sent-cwd').value.trim()
  if (!cwd) { result.replaceChildren(element('p', 'detail-empty', 'Choose a project path first.')); return }
  button.disabled = true; button.textContent = 'Previewing…'
  const settings = snapshot.settings.advisor
  previewUsedJev = settings.mode !== 'off' && settings.previewWhileTyping && snapshot.advisor.hasKey
  try {
    previewResult = await window.frontier.previewAdvisor({ prompt, cwd })
    renderSentResult()
  } catch (error) {
    result.replaceChildren(element('p', 'detail-empty', errorMessage(error)))
  } finally { button.disabled = false; button.textContent = 'Preview request' }
}

function localRulesReason(): string {
  const settings = snapshot.settings.advisor
  if (settings.mode === 'off') return 'The advisor is Off, so this preview used Frontier’s own rules.'
  if (!snapshot.advisor.hasKey) return 'No API key is stored, so this preview used Frontier’s own rules.'
  if (!settings.previewWhileTyping) return '“Ask Jev while I type” is off, so this preview used Frontier’s own rules without spending a request. Turn it on to send this exact prompt to Jev.'
  return 'This preview used Frontier’s own rules.'
}

function renderSentResult(): void {
  const result = byId('routing-sent-result')
  if (!previewResult) return
  const nodes: HTMLElement[] = []

  nodes.push(element('p', `routing-sent-banner ${previewUsedJev ? 'jev' : 'local'}`, previewUsedJev ? 'This preview called Jev.' : localRulesReason()))

  const requestWell = element('div', 'routing-sent-request screen')
  const pre = document.createElement('pre'); pre.className = 'cp-preview'
  const code = document.createElement('code')
  code.innerHTML = highlightBlock(JSON.stringify(previewResult.request, null, 2), 'json')
  pre.append(code)
  const copy = element('button', 'md-copy', 'Copy') as HTMLButtonElement
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(JSON.stringify(previewResult!.request, null, 2)).then(
      () => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy' }, 1200) },
      () => { copy.textContent = 'Copy failed' }
    )
  })
  const requestHead = element('div', 'routing-sent-request-head'); requestHead.append(element('span', undefined, 'REQUEST BODY'), copy)
  requestWell.append(requestHead, pre)
  nodes.push(requestWell)

  nodes.push(element('p', 'field-help', 'Sent to https://api.typesafe.ai/v1/systemone · the API key travels only in the Authorization header and is never shown here.'))

  const chosenId = previewResult.decision.chosenProviderId
  const route = element('div', 'routing-sent-route')
  route.append(element('p', undefined, chosenId
    ? `Route: ${providerName(chosenId)}${previewResult.model ? ` · ${previewResult.model}` : ''}`
    : 'No eligible agent for this preview.'))
  const winner = previewResult.decision.candidates.find((candidate) => candidate.providerId === chosenId)
  if (winner?.factors?.length) {
    const topFactors = [...winner.factors].sort((left, right) => Math.abs(right.points) - Math.abs(left.points)).slice(0, 6)
    for (const factor of topFactors) route.append(probabilityBar(factor.label, factor.points))
  }
  nodes.push(route)

  result.replaceChildren(...nodes)
}

function renderCatalog(): void {
  const body = byId('routing-catalog-body')
  const rows: HTMLElement[] = []
  for (const provider of snapshot.providers.filter((item) => item.enabled)) {
    const models = new Set([...(provider.runtime.models ?? []), ...(provider.model ? [provider.model] : [])])
    for (const model of models) {
      const tier = tierFor(model, provider.kind)
      const row = document.createElement('tr')
      const agentCell = document.createElement('td'); agentCell.textContent = provider.name
      const modelCell = document.createElement('td'); modelCell.className = 'mono'; modelCell.textContent = model
      const tierCell = document.createElement('td'); tierCell.append(chip(TIER_TONE[tier], TIER_LABEL[tier]))
      const strengthsCell = document.createElement('td'); strengthsCell.textContent = profileFor(model)?.strengths ?? describeCandidate(provider, model)
      row.append(agentCell, modelCell, tierCell, strengthsCell)
      rows.push(row)
    }
  }
  if (!rows.length) {
    const empty = document.createElement('tr')
    const cell = document.createElement('td'); cell.colSpan = 4
    cell.append(emptyState('No models discovered yet', 'Enable an agent and choose Check agents from the Agents view.'))
    empty.append(cell)
    body.replaceChildren(empty)
    return
  }
  body.replaceChildren(...rows)
}

function taskAdvisorAgreement(task: ProxyTask): boolean | undefined {
  const advisor = task.routing?.advisor
  if (!advisor?.wouldChooseProviderId) return undefined
  return advisor.wouldChooseProviderId === task.routing?.chosenProviderId
}

function renderInsights(): void {
  const summary = byId('routing-shadow-summary')
  const list = byId('routing-shadow-list')
  const withShadow = snapshot.tasks.filter((task) => taskAdvisorAgreement(task) !== undefined)
  if (!withShadow.length) {
    summary.textContent = ''
    list.replaceChildren(emptyState('No shadow-mode data yet', 'Switch the advisor to Shadow and route a few tasks to see how often Jev would agree.'))
    return
  }
  const agreed = withShadow.filter((task) => taskAdvisorAgreement(task) === true).length
  summary.textContent = `Agreement: ${agreed} of ${withShadow.length} recent routed tasks.`
  const disagreements = withShadow.filter((task) => taskAdvisorAgreement(task) === false).slice(0, 8)
  if (!disagreements.length) { list.replaceChildren(element('p', 'detail-empty', 'Jev agreed with every recent routed task.')); return }
  list.replaceChildren(...disagreements.map((task) => {
    const row = element('div', 'routing-shadow-row')
    const excerpt = task.prompt.length > 90 ? `${task.prompt.slice(0, 90)}…` : task.prompt
    row.append(element('p', 'routing-shadow-prompt', excerpt))
    const meta = element('div', 'routing-shadow-meta')
    meta.append(
      element('span', undefined, `Ran: ${providerName(task.routing?.chosenProviderId)}${task.model ? ` · ${task.model}` : ''}`),
      element('span', 'cyan-text', `Jev would pick: ${providerName(task.routing?.advisor?.wouldChooseProviderId)}${task.routing?.advisor?.wouldChooseModel ? ` · ${task.routing.advisor.wouldChooseModel}` : ''}`),
      element('span', `status-pill ${task.status}`, task.status)
    )
    row.append(meta)
    return row
  }))
}

export function renderRouting(): void {
  const settings = snapshot.settings.advisor
  renderModeSegmented(settings.mode)
  renderModeExplain(settings.mode)
  renderStatus()

  const modelInput = byId<HTMLInputElement>('routing-model-input')
  if (document.activeElement !== modelInput) modelInput.value = settings.model
  const confidence = byId<HTMLInputElement>('routing-confidence-range')
  if (document.activeElement !== confidence) confidence.value = String(settings.minConfidence)
  byId('routing-confidence-readout').textContent = settings.minConfidence.toFixed(2)
  const shareInput = byId<HTMLInputElement>('routing-share-facts')
  if (document.activeElement !== shareInput) shareInput.checked = settings.shareRepoFacts
  const typingInput = byId<HTMLInputElement>('routing-preview-typing')
  if (document.activeElement !== typingInput) typingInput.checked = settings.previewWhileTyping

  const cwd = byId<HTMLInputElement>('routing-sent-cwd')
  if (!sentCwdTouched && !cwd.value && snapshot.tasks[0]?.cwd) cwd.value = snapshot.tasks[0].cwd

  const learnInput = byId<HTMLInputElement>('learn-outcomes')
  if (document.activeElement !== learnInput) learnInput.checked = snapshot.settings.learnFromOutcomes !== false

  renderCatalog()
  renderInsights()
  if (previewResult) renderSentResult()
}
