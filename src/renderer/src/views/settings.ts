// Settings — a vertical tab list (ui-plan §6.3) over General (scheduler, notifications, memory),
// Appearance, Routing, Context & Tools, Skills and Verification. Every panel stays mounted and
// is only `hidden`: persistControlPlaneDraft() reads the Context & Tools inputs from the DOM.
// Routing, Context & Tools and Skills render on tab entry (as they did on screen entry), so a
// streamed snapshot never clobbers their drafts. Appearance is renderer-only (theme.ts) and
// never touches `snapshot.settings` or the main process.
import { byId } from '../ui/dom'
import { reportError, showToast } from '../ui/feedback'
import { textLines } from '../ui/format'
import { snapshot } from '../state'
import { SETTINGS_TABS, isSettingsTab, type SettingsTab } from '../nav'
import {
  currentAppearance, onAppearanceChange, setDensity, setDock, setDockLabels, setEffectsPreference, setFamily, setFontSize, setScheme,
  type Density, type DockLabels, type DockPosition, type Family, type FontSize, type Scheme
} from '../theme'
import { bindRadioGroup, segmentedOptions } from '../ui/segmented'
import { renderRouting } from './routing'
import { renderControlPlane } from './control'
import { renderSkills } from './skills'

// ---- Tabs ----

const TAB_KEY = 'fp-settings-tab'
function readTab(): SettingsTab | undefined { try { const tab = localStorage.getItem(TAB_KEY) ?? undefined; return isSettingsTab(tab) ? tab : undefined } catch { return undefined } }
function writeTab(tab: SettingsTab): void { try { localStorage.setItem(TAB_KEY, tab) } catch { /* private mode / disabled storage */ } }

export let currentSettingsTab: SettingsTab = readTab() ?? 'general'

const tabButton = (tab: SettingsTab): HTMLElement => document.querySelector<HTMLElement>(`[data-settings-tab="${tab}"]`)!

// Shows `tab` (the remembered one when omitted) and runs its entry render. Called on every entry
// to Settings and every tab change. The seam for P5: a new tab is a `data-settings-tab` button, a
// `data-settings-panel` section, an id in nav.ts's SETTINGS_TABS, and (optionally) a case below.
export function showSettingsTab(tab: SettingsTab = currentSettingsTab): void {
  currentSettingsTab = tab
  writeTab(tab)
  for (const id of SETTINGS_TABS) {
    const button = tabButton(id)
    button.setAttribute('aria-selected', String(id === tab))
    button.tabIndex = id === tab ? 0 : -1
    document.querySelector<HTMLElement>(`[data-settings-panel="${id}"]`)!.hidden = id !== tab
  }
  byId('settings-body').scrollTop = 0
  if (typeof snapshot === 'undefined') return
  if (tab === 'routing') renderRouting()
  if (tab === 'control') renderControlPlane()
  if (tab === 'skills') void renderSkills()
}

function initSettingsTabs(): void {
  const list = byId('settings-tabs')
  for (const tab of SETTINGS_TABS) tabButton(tab).addEventListener('click', () => { if (tab !== currentSettingsTab) showSettingsTab(tab) })
  // Vertical tablist: arrows move focus and selection (automatic activation), Home/End jump.
  list.addEventListener('keydown', (event) => {
    const index = SETTINGS_TABS.indexOf(currentSettingsTab)
    const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? SETTINGS_TABS.length - 1 : undefined
    if (next === undefined) return
    event.preventDefault()
    const tab = SETTINGS_TABS[(next + SETTINGS_TABS.length) % SETTINGS_TABS.length]
    showSettingsTab(tab)
    tabButton(tab).focus()
  })
}

// ---- Appearance: instant-apply controls, so reflecting stored state is always correct ----

let syncAppearance: Array<[string, () => string, (value: string) => void]> = []

function renderAppearance(): void {
  const appearance = currentAppearance()
  // A group the user is inside already shows what they picked; leave its focus and tabindex alone.
  for (const [id, value, sync] of syncAppearance) if (!byId(id).contains(document.activeElement)) sync(value())
  const scheme = document.documentElement.dataset.scheme ?? 'dark'
  document.querySelectorAll<HTMLElement>('.family-mock').forEach((mock) => { mock.dataset.scheme = scheme })
  const effects = byId<HTMLInputElement>('appearance-effects')
  const phosphor = appearance.family === 'phosphor'
  if (document.activeElement !== effects) effects.checked = appearance.effects === 'off'
  effects.disabled = !phosphor
  byId('appearance-effects-help').textContent = phosphor
    ? 'Turns off glow on readouts, the running pulse and other motion. Always off under your system’s reduced-motion setting.'
    : 'Only the Phosphor family has effects to reduce.'
}

function initAppearance(): void {
  const segmented = <T extends string>(id: string, choices: ReadonlyArray<readonly [T, string]>, value: () => T, set: (value: T) => void): void => {
    syncAppearance.push([id, value, segmentedOptions(byId(id), choices, (picked) => set(picked as T))])
  }
  syncAppearance = [['appearance-family', () => currentAppearance().family, bindRadioGroup(byId('appearance-family'), (picked) => setFamily(picked as Family))]]
  segmented<Scheme>('appearance-scheme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], () => currentAppearance().scheme, setScheme)
  segmented<DockPosition>('appearance-dock', [['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right']], () => currentAppearance().dock, setDock)
  segmented<DockLabels>('appearance-dock-labels', [['hover', 'On hover'], ['always', 'Always']], () => currentAppearance().dockLabels, setDockLabels)
  segmented<Density>('appearance-density', [['comfortable', 'Comfortable'], ['compact', 'Compact']], () => currentAppearance().density, setDensity)
  segmented<FontSize>('appearance-font-size', [['default', 'Default'], ['large', 'Large']], () => currentAppearance().fontSize, setFontSize)
  byId<HTMLInputElement>('appearance-effects').addEventListener('change', (event) => setEffectsPreference((event.target as HTMLInputElement).checked ? 'off' : 'on'))
  onAppearanceChange(renderAppearance)
  renderAppearance()
}

// ---- General and Verification (restyled in P5) ----

export function renderSettings(): void {
  renderAppearance()
  byId<HTMLInputElement>('max-parallel').value = String(snapshot.settings.maxParallelTasks)
  byId<HTMLInputElement>('cooldown-minutes').value = String(snapshot.settings.quotaCooldownMinutes)
  const memory = byId<HTMLTextAreaElement>('memory-input')
  if (document.activeElement !== memory) memory.value = snapshot.settings.memory ?? ''
  const verification = snapshot.settings.verification
  byId<HTMLInputElement>('verify-enabled').checked = verification?.enabled ?? true
  const commands = byId<HTMLTextAreaElement>('verify-commands')
  if (document.activeElement !== commands) commands.value = (verification?.commands ?? []).join('\n')
  byId<HTMLInputElement>('verify-timeout').value = String(verification?.timeoutSeconds ?? 300)
  byId<HTMLInputElement>('notify-enabled').checked = snapshot.settings.notifications?.enabled ?? true
  byId<HTMLInputElement>('notify-unfocused').checked = snapshot.settings.notifications?.onlyWhenUnfocused ?? true
}

export function initSettingsView(): void {
  initSettingsTabs()
  initAppearance()
  byId('save-memory').addEventListener('click', async () => {
    const button = byId<HTMLButtonElement>('save-memory'); button.disabled = true
    try { await window.frontier.updateSettings({ memory: byId<HTMLTextAreaElement>('memory-input').value }); showToast('Memory saved') }
    catch (error) { reportError('Could not save memory', error) } finally { button.disabled = false }
  })
  byId('save-settings').addEventListener('click', async () => {
    try {
      await window.frontier.updateSettings({
        maxParallelTasks: Number(byId<HTMLInputElement>('max-parallel').value),
        quotaCooldownMinutes: Number(byId<HTMLInputElement>('cooldown-minutes').value)
      })
      showToast('Scheduler settings saved')
    } catch (error) { reportError('Could not save scheduler settings', error) }
  })

  byId('save-verification').addEventListener('click', async () => {
    const button = byId<HTMLButtonElement>('save-verification'); button.disabled = true
    try {
      await window.frontier.updateSettings({
        verification: {
          enabled: byId<HTMLInputElement>('verify-enabled').checked,
          commands: textLines(byId<HTMLTextAreaElement>('verify-commands').value),
          timeoutSeconds: Number(byId<HTMLInputElement>('verify-timeout').value) || 300
        }
      })
      showToast('Verification settings saved')
    } catch (error) { reportError('Could not save verification settings', error) } finally { button.disabled = false }
  })
  byId('save-feedback').addEventListener('click', async () => {
    const button = byId<HTMLButtonElement>('save-feedback'); button.disabled = true
    try {
      await window.frontier.updateSettings({
        notifications: {
          enabled: byId<HTMLInputElement>('notify-enabled').checked,
          onlyWhenUnfocused: byId<HTMLInputElement>('notify-unfocused').checked
        }
      })
      showToast('Preferences saved')
    } catch (error) { reportError('Could not save preferences', error) } finally { button.disabled = false }
  })
}
