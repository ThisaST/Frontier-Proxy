// Settings — scheduling, memory, verification, notification, and appearance
// preferences. Appearance is renderer-only (theme.ts) — it never touches
// `snapshot.settings` or the main process.
import { byId } from '../ui/dom'
import { reportError, showToast } from '../ui/feedback'
import { textLines } from '../ui/format'
import { snapshot } from '../state'
import { effectsPreference, setEffectsPreference, setThemePreference, themePreference } from '../theme'
import { initRadioGroup, syncRadioGroupTabIndex } from '../ui/segmented'

function renderAppearance(): void {
  const theme = themePreference()
  document.querySelectorAll<HTMLButtonElement>('#appearance-theme button').forEach((button) => {
    const active = button.dataset.themeChoice === theme
    button.classList.toggle('active', active)
    button.setAttribute('aria-checked', String(active))
  })
  syncRadioGroupTabIndex(byId('appearance-theme'))
  byId<HTMLInputElement>('appearance-effects').checked = effectsPreference() === 'off'
}

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
  document.querySelectorAll<HTMLButtonElement>('#appearance-theme button').forEach((button) => button.addEventListener('click', () => {
    setThemePreference((button.dataset.themeChoice as 'system' | 'console' | 'daylight') ?? 'system')
    renderAppearance()
  }))
  initRadioGroup(byId('appearance-theme'), (option) => {
    setThemePreference((option.dataset.themeChoice as 'system' | 'console' | 'daylight') ?? 'system')
    renderAppearance()
  })
  byId<HTMLInputElement>('appearance-effects').addEventListener('change', (event) => {
    setEffectsPreference((event.target as HTMLInputElement).checked ? 'off' : 'on')
  })
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
