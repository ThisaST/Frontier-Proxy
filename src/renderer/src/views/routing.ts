// Settings → Routing: the Jev advisor (mode, key, model, confidence, what it may see), "What is
// sent" (the long-form disclosure: the exact request body, CLAUDE.md "Routing advisor"), the
// routing policies, the model catalog, and whether Jev would have agreed. Built once into the
// empty `#routing-view` panel; `renderRouting()` repaints it only while its tab is showing.
//
// Save model: the mode and the switches apply the moment they change; the model id and the
// confidence threshold share the tab's save bar. Each instant change sends the SAVED advisor
// settings with just that one field changed, so it can neither commit nor discard a model or
// confidence edit that is still pending under the bar.
import type { AdvisorMode, AdvisorPreviewResult, ModelTier, ProxyTask, RoutingAdvisorSettings, TaskStatus } from '../../../shared/types'
import { describeCandidate, profileFor, tierFor } from '../../../shared/model-profiles'
import { advisorCalibration, type CalibrationBucket } from '../../../shared/calibration'
import { byId, element, textArea, textInput } from '../ui/dom'
import { fieldLabel, meter, meterRow, sectionTitle, status, tag, type StatusTone } from '../ui/components'
import { initRadioGroup, syncRadioGroupTabIndex } from '../ui/segmented'
import { confirmAction, errorMessage, reportError, showToast } from '../ui/feedback'
import { formatDuration, timeAgo } from '../ui/format'
import { bindSaveBar, createDirtyGuard, type DirtyGuard } from '../ui/dirty'
import { highlightBlock } from '../syntax'
import { providerName } from '../providers-view-model'
import { currentView, setSnapshot, snapshot } from '../state'
import { emptyRow, kitButton, saveBar, settingsRow, settingsSection, settingsTable, switchControl, tableRow } from './settings-parts'

const MODE_COPY: Record<AdvisorMode, { title: string; body: string }> = {
  off: { title: 'Off', body: 'Frontier routes with its own rules. Nothing leaves this machine.' },
  shadow: { title: 'Shadow', body: "Jev is asked, and its pick is recorded next to the real route, but it changes nothing." },
  active: { title: 'Active', body: "Jev's answers become bounded, labelled factors in the route. It never overrides your picks or an agent's limits." }
}

const TIER_LABEL: Record<ModelTier, string> = { local: 'Local', fast: 'Fast', standard: 'Standard', frontier: 'Frontier' }
const TASK_STATUS: Record<TaskStatus, [StatusTone, string]> = { queued: ['neutral', 'Queued'], running: ['running', 'Running'], completed: ['ok', 'Completed'], failed: ['danger', 'Failed'], cancelled: ['neutral', 'Cancelled'] }
const POLICIES: Array<[string, string]> = [
  ['Balanced', 'Matches task type, spreads subscription usage, then considers local models.'],
  ['Quality first', 'Prefers Codex or Claude Code and only falls back when unavailable.'],
  ['Token saver', 'Strongly favors Ollama-backed agents to preserve hosted usage.']
]
const SPLIT_NOTE = "Split & delegate runs also send the planner's subtask titles and prompts, which can quote code the planner read."
const EXAMPLE_PROMPT = 'Fix the flaky test in src/auth/session.test.ts and add a regression test for the race it hits.'

let sentCwdTouched = false
let previewResult: AdvisorPreviewResult | undefined
let previewUsedJev = false

// Dirty tracking (CLAUDE.md, "Live snapshots must not clobber an unsaved form edit"): once the
// user edits the model or the confidence threshold, snapshots (a streaming task fires one about
// every 60ms) stop overwriting it until the edit is saved or discarded. Without this the value snaps
// back to the saved one and Save persists the OLD value. The guard is the shared ui/dirty.ts one;
// `advisorFormDirty()` / `clearAdvisorDirty()` keep their names. The switches get their own guard,
// held only while their instant save is in flight.
let advisorForm: DirtyGuard
let advisorSwitches: DirtyGuard
const advisorFormDirty = (): boolean => advisorForm.isDirty()
const clearAdvisorDirty = (): void => advisorForm.clear()

// ---------- Building the tab ----------

function modeSegmented(): HTMLElement {
  const segmented = element('div', 'segmented')
  segmented.id = 'routing-mode-segmented'
  segmented.setAttribute('role', 'radiogroup')
  segmented.setAttribute('aria-label', 'Advisor mode')
  for (const key of ['off', 'shadow', 'active'] as AdvisorMode[]) {
    const button = element('button', undefined, MODE_COPY[key].title) as HTMLButtonElement
    button.type = 'button'; button.dataset.advisorMode = key; button.setAttribute('role', 'radio'); button.setAttribute('aria-checked', 'false')
    segmented.append(button)
  }
  return segmented
}

function buildAdvisorSection(): HTMLElement {
  const section = settingsSection('Routing advisor', 'Jev is TypeSafe’s routing model. It advises; the router decides. It never writes code and never runs on your behalf.')

  const modeRow = element('div', 'routing-mode-row')
  const state = element('span', 'routing-status'); state.id = 'routing-status'
  modeRow.append(modeSegmented(), state)
  const modeDesc = element('p', 'settings-help'); modeDesc.id = 'routing-mode-desc'; modeDesc.setAttribute('aria-live', 'polite')

  const keyInput = textInput('', 'password'); keyInput.id = 'routing-key-input'; keyInput.className = 'input mono-text'
  keyInput.placeholder = 'TypeSafe API key'; keyInput.autocomplete = 'off'
  const keyLine = element('div', 'settings-inline')
  keyLine.append(keyInput, kitButton('secondary', 'Save key', 'routing-key-save'), kitButton('ghost', 'Remove key', 'routing-key-remove'), kitButton('secondary', 'Test connection', 'routing-key-test'))
  const keyField = element('div', 'settings-field')
  const keyResult = element('p', 'settings-help'); keyResult.id = 'routing-key-result'; keyResult.setAttribute('aria-live', 'polite')
  keyField.append(fieldLabel('API key', 'routing-key-input'), keyLine,
    element('p', 'settings-help', 'Encrypted with your operating system’s secure storage and kept in the main process. The interface only ever learns that a key exists.'), keyResult)

  const modelInput = textInput('jev-latest'); modelInput.id = 'routing-model-input'; modelInput.className = 'input mono-text'
  const modelField = element('div', 'settings-field'); modelField.append(fieldLabel('Model', 'routing-model-input'), modelInput)
  const confidence = document.createElement('input'); confidence.type = 'range'; confidence.className = 'range'; confidence.id = 'routing-confidence-range'
  confidence.min = '0.3'; confidence.max = '0.9'; confidence.step = '0.05'
  const confidenceLabel = fieldLabel('Confidence threshold', 'routing-confidence-range')
  const readout = element('span', 'readout'); readout.id = 'routing-confidence-readout'
  const confidenceHead = element('div', 'routing-confidence-head'); confidenceHead.append(confidenceLabel, readout)
  const confidenceHelp = element('p', 'settings-help', 'Below this, Frontier ignores that answer and uses its own rules.'); confidenceHelp.id = 'routing-confidence-help'
  confidence.setAttribute('aria-describedby', confidenceHelp.id)
  const confidenceField = element('div', 'settings-field'); confidenceField.append(confidenceHead, confidence, confidenceHelp)
  const columns = element('div', 'settings-columns'); columns.append(modelField, confidenceField)

  const share = switchControl('routing-share-facts')
  const typing = switchControl('routing-preview-typing')
  const caution = element('div', 'settings-row-help settings-warning', 'Every keystroke in the composer would be sent as a draft prompt while this is on.')
  section.append(modeRow, modeDesc, keyField, columns,
    settingsRow('Share repo facts', 'routing-share-facts', share.wrap, ['Languages, file count, manifests and top-level folders. Never file contents.', SPLIT_NOTE]),
    settingsRow('Ask Jev while I type (sends drafts to TypeSafe)', 'routing-preview-typing', typing.wrap, [caution]))
  return section
}

function buildSentSection(): HTMLElement {
  const section = settingsSection('What is sent', 'Preview the exact request Jev would receive for a prompt and project, without creating a task.', SPLIT_NOTE)
  const prompt = textArea(EXAMPLE_PROMPT, 3); prompt.id = 'routing-sent-prompt'; prompt.className = 'textarea'
  const promptField = element('div', 'settings-field'); promptField.append(fieldLabel('Example prompt', 'routing-sent-prompt'), prompt)
  const cwd = textInput(''); cwd.id = 'routing-sent-cwd'; cwd.className = 'input mono-text'; cwd.placeholder = '/path/to/project'
  const pathLine = element('div', 'settings-inline'); pathLine.append(cwd, kitButton('secondary', 'Choose folder…', 'routing-sent-choose-dir'), kitButton('secondary', 'Preview request', 'routing-sent-preview'))
  const pathField = element('div', 'settings-field'); pathField.append(fieldLabel('Project path', 'routing-sent-cwd'), pathLine)
  const stack = element('div', 'settings-stack'); stack.append(promptField, pathField)
  const result = element('div', 'routing-sent-result'); result.id = 'routing-sent-result'; result.setAttribute('aria-live', 'polite')
  result.append(element('p', 'settings-help', 'Choose Preview request to see the exact payload, the resulting route, and whether it used Jev or Frontier’s own rules.'))
  section.append(stack, result)
  return section
}

function buildPolicySection(): HTMLElement {
  const section = settingsSection('Routing policies', 'Every task records the exact scores behind its decision. Open its Route section to see them.')
  const { box, body } = settingsTable([{ label: 'Policy', className: 'routing-policy-col' }, 'How selection works'])
  body.append(...POLICIES.map(([name, text]) => tableRow([{ content: name, className: 'cell-strong' }, { content: text, className: 'cell-muted' }])))
  const learn = switchControl('learn-outcomes')
  section.append(box, settingsRow('Let recent outcomes influence routing', 'learn-outcomes', learn.wrap, [
    "Nudges the router with how each agent's recent runs of the same kind of work turned out: finished, passed the repo's checks, and above all whether you merged or discarded its branch. Capped at ±14 points and always shown as a labelled factor on the task's Route section."
  ]))
  return section
}

function buildCatalogSection(): HTMLElement {
  const section = settingsSection('Model catalog', 'What each model is good at. Jev chooses between these when it suggests a model.')
  section.append(settingsTable(['Agent', 'Model', 'Tier', 'Strengths'], 'routing-catalog-body').box)
  return section
}

function buildInsightsSection(): HTMLElement {
  const section = settingsSection('Would Jev have agreed?', 'Finished tasks Jev advised on, grouped by how confident it was in its best-fit answer.')
  section.append(settingsTable(['Confidence', { label: 'Tasks', className: 'num' }, 'Completed', 'Checks passed', 'Agreed with route'], 'routing-calibration-body').box)
  const summary = element('p', 'settings-help routing-shadow-summary'); summary.id = 'routing-shadow-summary'
  const list = element('div', 'routing-shadow-list'); list.id = 'routing-shadow-list'
  section.append(summary, list)
  return section
}

// ---------- Wiring ----------

async function saveAdvisor(changes: Partial<RoutingAdvisorSettings>): Promise<void> {
  setSnapshot(await window.frontier.updateSettings({ advisor: { ...snapshot.settings.advisor, ...changes } }))
}

export function initRoutingView(): void {
  const view = byId('routing-view')
  view.replaceChildren(buildAdvisorSection(), buildSentSection(), buildPolicySection(), buildCatalogSection(), buildInsightsSection(),
    saveBar('routing-advisor-save-bar', 'routing-advisor-save', 'routing-advisor-discard', 'routing-advisor-dirty-hint'))
  advisorForm = createDirtyGuard(['routing-model-input', 'routing-confidence-range'])
  advisorSwitches = createDirtyGuard(['routing-share-facts', 'routing-preview-typing', 'learn-outcomes'])

  const selectAdvisorMode = async (button: HTMLElement): Promise<void> => {
    const mode = (button.dataset.advisorMode as AdvisorMode) ?? 'off'
    if (mode === snapshot.settings.advisor.mode) return
    renderModeSegmented(mode)
    try { await saveAdvisor({ mode }); showToast(`Advisor set to ${MODE_COPY[mode].title}`) }
    catch (error) { reportError('Could not change advisor mode', error) }
    finally { renderRouting() }
  }
  byId('routing-mode-segmented').querySelectorAll<HTMLButtonElement>('button').forEach((button) => button.addEventListener('click', () => void selectAdvisorMode(button)))
  initRadioGroup(byId('routing-mode-segmented'), (option) => void selectAdvisorMode(option))

  byId('routing-key-save').addEventListener('click', async () => {
    const input = byId<HTMLInputElement>('routing-key-input')
    const key = input.value.trim()
    if (!key) { reportError('Could not save the API key', new Error('Enter a key first.')); return }
    const button = byId<HTMLButtonElement>('routing-key-save'); button.disabled = true
    try { setSnapshot(await window.frontier.setAdvisorKey(key)); input.value = ''; showToast('API key saved') }
    catch (error) { reportError('Could not save the API key', error) } finally { button.disabled = false; renderRouting() }
  })
  byId('routing-key-remove').addEventListener('click', async () => {
    const confirmed = await confirmAction('Remove the stored API key?', 'Jev will stop working until a new key is saved. The advisor mode stays as configured.', 'Remove')
    if (!confirmed) return
    try { setSnapshot(await window.frontier.clearAdvisorKey()); showToast('API key removed') }
    catch (error) { reportError('Could not remove the API key', error) } finally { renderRouting() }
  })
  byId('routing-key-test').addEventListener('click', async () => {
    const button = byId<HTMLButtonElement>('routing-key-test'); button.disabled = true; button.textContent = 'Testing…'
    const result = byId('routing-key-result')
    try {
      const test = await window.frontier.testAdvisor()
      result.replaceChildren(test.ok ? status('ok', `Connected · ${test.model ?? snapshot.settings.advisor.model} · ${formatDuration(test.latencyMs ?? 0)}`) : status('warn', test.error ?? 'Test failed.'))
    } catch (error) { result.replaceChildren(status('warn', errorMessage(error))) }
    finally { button.disabled = false; button.textContent = 'Test connection'; renderRouting() }
  })

  bindSaveBar(byId('routing-advisor-save-bar'), advisorForm, {
    save: async () => {
      try {
        await saveAdvisor({
          model: byId<HTMLInputElement>('routing-model-input').value.trim() || 'jev-latest',
          minConfidence: Number(byId<HTMLInputElement>('routing-confidence-range').value) || 0.5
        })
        clearAdvisorDirty(); renderRouting()
        showToast('Advisor settings saved')
      } catch (error) { reportError('Could not save advisor settings', error) }
    },
    discard: () => renderRouting()
  })
  byId<HTMLInputElement>('routing-confidence-range').addEventListener('input', syncConfidence)

  const instantSwitch = (id: string, save: (on: boolean) => Promise<void>, failure: string): void => {
    byId<HTMLInputElement>(id).addEventListener('change', async (event) => {
      const input = event.target as HTMLInputElement
      input.disabled = true
      try { await save(input.checked); showToast('Routing settings saved') }
      catch (error) { reportError(failure, error) }
      finally { input.disabled = false; advisorSwitches.clear(id); renderRouting() }
    })
  }
  instantSwitch('routing-share-facts', (on) => saveAdvisor({ shareRepoFacts: on }), 'Could not save advisor settings')
  instantSwitch('routing-preview-typing', (on) => saveAdvisor({ previewWhileTyping: on }), 'Could not save advisor settings')
  instantSwitch('learn-outcomes', async (on) => { setSnapshot(await window.frontier.updateSettings({ learnFromOutcomes: on })) }, 'Could not save routing policy')

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
}

// The range's fill (a 4px track, like the kit meter) and its readout follow the control itself,
// dirty or not, so they always show what Save would store.
function syncConfidence(): void {
  const input = byId<HTMLInputElement>('routing-confidence-range')
  const value = Number(input.value), min = Number(input.min), max = Number(input.max)
  input.style.setProperty('--value', `${((value - min) / (max - min)) * 100}%`)
  byId('routing-confidence-readout').textContent = value.toFixed(2)
}

function renderModeSegmented(mode: AdvisorMode): void {
  byId('routing-mode-segmented').querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    const active = button.dataset.advisorMode === mode
    button.classList.toggle('active', active)
    button.setAttribute('aria-checked', String(active))
  })
  syncRadioGroupTabIndex(byId('routing-mode-segmented'))
  byId('routing-mode-desc').textContent = MODE_COPY[mode].body
}

function renderStatus(): void {
  const advisor = snapshot.advisor
  const node = !advisor.hasKey ? status('neutral', 'No key stored')
    : advisor.lastError ? status('warn', advisor.lastError)
      : status('ok', advisor.lastCheckedAt ? `Ready · checked ${timeAgo(advisor.lastCheckedAt)}` : 'Ready')
  byId('routing-status').replaceChildren(node)
  byId<HTMLButtonElement>('routing-key-remove').disabled = !advisor.hasKey
  byId<HTMLButtonElement>('routing-key-test').disabled = !advisor.hasKey
  byId<HTMLInputElement>('routing-key-input').placeholder = advisor.hasKey ? 'Key stored · paste a new one to replace it' : 'TypeSafe API key'
}

// ---------- What is sent ----------

async function runPreview(): Promise<void> {
  const button = byId<HTMLButtonElement>('routing-sent-preview')
  const result = byId('routing-sent-result')
  const prompt = byId<HTMLTextAreaElement>('routing-sent-prompt').value
  const cwd = byId<HTMLInputElement>('routing-sent-cwd').value.trim()
  if (!cwd) { result.replaceChildren(element('p', 'settings-help', 'Choose a project path first.')); return }
  button.disabled = true; button.textContent = 'Previewing…'
  const settings = snapshot.settings.advisor
  previewUsedJev = settings.mode !== 'off' && settings.previewWhileTyping && snapshot.advisor.hasKey
  try {
    previewResult = await window.frontier.previewAdvisor({ prompt, cwd })
    renderSentResult()
  } catch (error) {
    result.replaceChildren(status('warn', errorMessage(error)))
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
  if (!previewResult) return
  const result = byId('routing-sent-result')
  const body = JSON.stringify(previewResult.request, null, 2)
  const banner = status(previewUsedJev ? 'info' : 'neutral', previewUsedJev ? 'This preview called Jev.' : localRulesReason())

  const well = element('div', 'routing-request')
  const copy = kitButton('ghost', 'Copy', undefined, true)
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(body).then(
      () => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy' }, 1200) },
      () => { copy.textContent = 'Copy failed' }
    )
  })
  const head = element('div', 'routing-request-head'); head.append(fieldLabel('Request body'), copy)
  const pre = document.createElement('pre'); pre.className = 'code routing-request-body'
  const code = document.createElement('code'); code.innerHTML = highlightBlock(body, 'json')
  pre.append(code); well.append(head, pre)

  const chosenId = previewResult.decision.chosenProviderId
  const route = element('div', 'routing-sent-route')
  route.append(element('p', 'routing-sent-route-title', chosenId ? `Route: ${providerName(chosenId)}${previewResult.model ? ` · ${previewResult.model}` : ''}` : 'No eligible agent for this preview.'))
  const winner = previewResult.decision.candidates.find((candidate) => candidate.providerId === chosenId)
  const factors = [...(winner?.factors ?? [])].sort((left, right) => Math.abs(right.points) - Math.abs(left.points)).slice(0, 6)
  for (const factor of factors) route.append(meterRow(factor.label, Math.min(100, (Math.abs(factor.points) / 20) * 100), `${factor.points > 0 ? '+' : ''}${Math.round(factor.points)}`, factor.points < 0 ? 'warn' : 'accent'))

  result.replaceChildren(banner, well,
    element('p', 'settings-help', 'Sent to https://api.typesafe.ai/v1/systemone · the API key travels only in the Authorization header and is never shown here.'), route)
}

// ---------- Catalog and insights ----------

function renderCatalog(): void {
  const rows: HTMLTableRowElement[] = []
  for (const provider of snapshot.providers.filter((item) => item.enabled)) {
    const models = new Set([...(provider.runtime.models ?? []), ...(provider.model ? [provider.model] : [])])
    for (const model of models) {
      const tier = tierFor(model, provider.kind)
      rows.push(tableRow([provider.name, { content: model, className: 'cell-mono' }, tag(TIER_LABEL[tier]), { content: profileFor(model)?.strengths ?? describeCandidate(provider, model), className: 'cell-muted' }]))
    }
  }
  byId('routing-catalog-body').replaceChildren(...(rows.length ? rows : [emptyRow(4, 'No models discovered yet', 'Enable an agent and choose Check agents from the Agents view.')]))
}

// A share of a whole as a small meter and a percent, honest about having nothing to show yet
// rather than reading as 0%.
function calibrationShare(count: number, of: number, label: string): HTMLElement {
  if (!of) return element('span', 'cell-faint', '—')
  const percent = Math.round((count / of) * 100)
  const cell = element('div', 'routing-share'); cell.append(meter(percent, 'accent', `${label}: ${percent}%`), element('span', 'readout', `${percent}%`))
  return cell
}

function calibrationRow(bucket: CalibrationBucket): HTMLTableRowElement {
  const checked = bucket.verified + bucket.verifyFailed
  return tableRow([bucket.label, { content: String(bucket.tasks), className: 'num' },
    calibrationShare(bucket.completed, bucket.tasks, 'Completed'), calibrationShare(bucket.verified, checked, 'Checks passed'), calibrationShare(bucket.agreedWithRoute, bucket.tasks, 'Agreed with route')])
}

function renderCalibration(): void {
  const { buckets } = advisorCalibration(snapshot.tasks)
  byId('routing-calibration-body').replaceChildren(...(buckets.some((bucket) => bucket.tasks)
    ? buckets.map(calibrationRow)
    : [emptyRow(5, 'No calibration data yet', 'Once Jev-advised tasks finish, this breaks down how often it was right by how confident it was.')]))
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
    summary.textContent = 'No shadow-mode data yet. Switch the advisor to Shadow and route a few tasks to see how often Jev would agree.'
    list.replaceChildren()
    return
  }
  const agreed = withShadow.filter((task) => taskAdvisorAgreement(task) === true).length
  const disagreements = withShadow.filter((task) => taskAdvisorAgreement(task) === false).slice(0, 8)
  summary.textContent = `In shadow mode Jev agreed with the route Frontier took in ${agreed} of ${withShadow.length} recent tasks.${disagreements.length ? '' : ' It agreed with every one.'}`
  if (!disagreements.length) { list.replaceChildren(); return }
  const box = element('div', 'settings-box routing-shadow-box')
  box.append(...disagreements.map((task) => {
    const row = element('div', 'routing-shadow-row')
    const excerpt = task.prompt.length > 90 ? `${task.prompt.slice(0, 90)}…` : task.prompt
    const meta = element('div', 'routing-shadow-meta')
    const [tone, word] = TASK_STATUS[task.status] ?? ['neutral', task.status]
    meta.append(
      element('span', undefined, `Ran ${providerName(task.routing?.chosenProviderId)}${task.model ? ` · ${task.model}` : ''}`),
      element('span', undefined, `Jev would pick ${providerName(task.routing?.advisor?.wouldChooseProviderId)}${task.routing?.advisor?.wouldChooseModel ? ` · ${task.routing.advisor.wouldChooseModel}` : ''}`),
      status(tone, word)
    )
    row.append(element('p', 'routing-shadow-prompt', excerpt), meta)
    return row
  }))
  list.replaceChildren(sectionTitle('Recent disagreements', 'h3'), box)
}

// Runs on entry to the tab (showSettingsTab) and on each snapshot while the tab is showing; a
// hidden tab is skipped, and repainted in full the next time it is entered.
export function renderRouting(): void {
  if (typeof snapshot === 'undefined' || currentView !== 'settings' || byId('routing-view').hidden) return
  const settings = snapshot.settings.advisor
  renderModeSegmented(settings.mode)
  renderStatus()

  // A dirty field is left entirely alone (see `advisorForm` above); a focused one too.
  if (!advisorFormDirty()) {
    advisorForm.reflect('routing-model-input', settings.model)
    advisorForm.reflect('routing-confidence-range', settings.minConfidence)
  }
  syncConfidence()
  advisorSwitches.reflect('routing-share-facts', settings.shareRepoFacts)
  advisorSwitches.reflect('routing-preview-typing', settings.previewWhileTyping)
  advisorSwitches.reflect('learn-outcomes', snapshot.settings.learnFromOutcomes !== false)

  const cwd = byId<HTMLInputElement>('routing-sent-cwd')
  if (!sentCwdTouched && !cwd.value && snapshot.tasks[0]?.cwd) cwd.value = snapshot.tasks[0].cwd

  renderCatalog()
  renderInsights()
  renderCalibration()
  // The preview result is painted when a preview runs, not per snapshot: it describes that run, and
  // repainting it every 60ms would drop a text selection in the request body.
}
