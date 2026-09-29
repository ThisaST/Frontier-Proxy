// Settings — a vertical tab list (ui-plan §6.3) over General (scheduler, notifications, memory),
// Appearance, Routing, Context & Tools, Skills and Verification. Every panel stays mounted and
// is only `hidden`: persistControlPlaneDraft() reads the Context & Tools inputs from the DOM.
// Routing, Context & Tools and Skills render on tab entry (as they did on screen entry), so a
// streamed snapshot never clobbers their drafts. Appearance is renderer-only (theme.ts) and
// never touches `snapshot.settings` or the main process.
import type { AppSettings, VerificationSettings } from '../../../shared/types'
import { byId } from '../ui/dom'
import { reportError, showToast } from '../ui/feedback'
import { textLines } from '../ui/format'
import { bindSaveBar, createDirtyGuard, type DirtyGuard } from '../ui/dirty'
import { snapshot, setSnapshot } from '../state'
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

// ---- General and Verification ----
// One save model per control: the switches apply the moment they change, the text fields share their
// tab's save bar. Both go through a dirty guard (ui/dirty.ts): `renderSettings()` runs on every
// snapshot, and without the guard it would overwrite an unsaved number or note with the saved one
// the instant any task streamed a token. A switch is guarded only until its own save resolves.

type SettingsChanges = Partial<Pick<AppSettings, 'maxParallelTasks' | 'quotaCooldownMinutes' | 'memory' | 'verification' | 'notifications'>>

const GENERAL_TEXT = ['max-parallel', 'cooldown-minutes', 'memory-input'] as const
const GENERAL_SWITCHES = ['notify-enabled', 'notify-unfocused'] as const
const VERIFY_TEXT = ['verify-commands', 'verify-timeout'] as const
let generalText: DirtyGuard | undefined, generalSwitches: DirtyGuard, verifyText: DirtyGuard, verifySwitch: DirtyGuard

const checked = (id: string): boolean => byId<HTMLInputElement>(id).checked
const savedVerification = (): VerificationSettings => snapshot.settings.verification ?? { enabled: true, commands: [], timeoutSeconds: 300 }

export function renderSettings(): void {
  renderAppearance()
  if (!generalText || typeof snapshot === 'undefined') return
  const { settings } = snapshot
  generalText.reflect('max-parallel', settings.maxParallelTasks)
  generalText.reflect('cooldown-minutes', settings.quotaCooldownMinutes)
  generalText.reflect('memory-input', settings.memory ?? '')
  generalSwitches.reflect('notify-enabled', settings.notifications?.enabled ?? true)
  generalSwitches.reflect('notify-unfocused', settings.notifications?.onlyWhenUnfocused ?? true)
  const verification = savedVerification()
  verifySwitch.reflect('verify-enabled', verification.enabled)
  verifyText.reflect('verify-commands', verification.commands.join('\n'))
  verifyText.reflect('verify-timeout', verification.timeoutSeconds)
}

// Applies one instant change and takes the snapshot it returns, so the control is reflected from
// the saved value rather than from a snapshot still in flight. On failure it snaps back.
async function applyInstantly(guard: DirtyGuard, id: string, changes: SettingsChanges, failure: string): Promise<void> {
  const input = byId<HTMLInputElement>(id); input.disabled = true
  try { setSnapshot(await window.frontier.updateSettings(changes)) }
  catch (error) { reportError(failure, error) }
  finally { input.disabled = false; guard.clear(id); renderSettings() }
}

// A save bar's Save: persists the tab's text fields, then reflects what the main process kept
// (it clamps the numbers). A failure leaves the edit dirty so nothing typed is lost.
async function saveText(guard: DirtyGuard, changes: () => SettingsChanges, saved: string, failure: string): Promise<void> {
  try { setSnapshot(await window.frontier.updateSettings(changes())); guard.clear(); renderSettings(); showToast(saved) }
  catch (error) { reportError(failure, error) }
}

const numberField = (id: string, fallback: number): number => Number(byId<HTMLInputElement>(id).value) || fallback

function initGeneralAndVerification(): void {
  const general = createDirtyGuard(GENERAL_TEXT)
  generalSwitches = createDirtyGuard(GENERAL_SWITCHES)
  verifyText = createDirtyGuard(VERIFY_TEXT)
  verifySwitch = createDirtyGuard(['verify-enabled'])
  generalText = general

  bindSaveBar(byId('general-save-bar'), general, {
    save: () => saveText(general, () => ({
      maxParallelTasks: numberField('max-parallel', snapshot.settings.maxParallelTasks),
      quotaCooldownMinutes: numberField('cooldown-minutes', snapshot.settings.quotaCooldownMinutes),
      memory: byId<HTMLTextAreaElement>('memory-input').value
    }), 'Settings saved', 'Could not save settings'),
    discard: renderSettings
  })
  for (const id of GENERAL_SWITCHES) byId(id).addEventListener('change', () => void applyInstantly(generalSwitches, id, {
    notifications: { enabled: checked('notify-enabled'), onlyWhenUnfocused: checked('notify-unfocused') }
  }, 'Could not save notification preferences'))

  // The switch sends the saved commands and timeout, never the ones being edited: those stay
  // pending under the save bar. Save, in turn, sends the switch as it stands (already saved).
  byId('verify-enabled').addEventListener('change', () => void applyInstantly(verifySwitch, 'verify-enabled', {
    verification: { ...savedVerification(), enabled: checked('verify-enabled') }
  }, 'Could not save verification settings'))
  bindSaveBar(byId('verification-save-bar'), verifyText, {
    save: () => saveText(verifyText, () => ({
      verification: { enabled: checked('verify-enabled'), commands: textLines(byId<HTMLTextAreaElement>('verify-commands').value), timeoutSeconds: numberField('verify-timeout', 300) }
    }), 'Verification settings saved', 'Could not save verification settings'),
    discard: renderSettings
  })
}

export function initSettingsView(): void {
  initSettingsTabs()
  initAppearance()
  initGeneralAndVerification()
}
