// The ⌘K command palette: quick navigation, quick actions, and task search.
import { byId, element } from './ui/dom'
import { icon, type IconName } from './ui/icons'
import { restoreFocusOnClose } from './ui/components'
import { providerName } from './providers-view-model'
import { taskKindLabel } from './task-helpers'
import { chooseProjectInteractively } from './project'
import { snapshot } from './state'
import { switchView } from './main'
import { setDock, setFamily } from './theme'
import { openTask, toggleInspector, toggleTaskList } from './views/tasks'
import { enterCompose } from './views/compose'

const commandPalette = byId<HTMLDialogElement>('command-palette')
restoreFocusOnClose(commandPalette)
let commandPaletteIndex = 0

interface CommandPaletteEntry {
  icon: IconName
  label: string
  detail: string
  shortcut?: string
  keywords: string
  run(): void
}

function commandPaletteEntries(query: string): CommandPaletteEntry[] {
  const commands: CommandPaletteEntry[] = [
    // Both open Tasks' composer; there is one place to start work.
    { icon: 'plus', label: 'New task', detail: 'Send work to an agent', shortcut: '⌘N', keywords: 'create route agent run compose home', run: () => enterCompose() },
    { icon: 'compare', label: 'Compare agents', detail: 'Run one prompt on several agents at once', keywords: 'bench head to head compare', run: () => enterCompose('bench') },
    // Navigation goes through switchView, which resolves every id with nav.ts: Routing, Context &
    // Tools and Skills are Settings tabs now.
    { icon: 'tasks', label: 'Go to Tasks', detail: 'The work queue', keywords: 'navigate queue', run: () => switchView('tasks') },
    { icon: 'workspace', label: 'Go to Workspaces', detail: 'Long-lived, per-repo conversations', keywords: 'navigate collaborate participants', run: () => switchView('workspace') },
    { icon: 'review', label: 'Go to Review', detail: 'Branches waiting to be merged', keywords: 'navigate merge branches', run: () => switchView('review') },
    { icon: 'agents', label: 'Go to Agents', detail: 'Installed CLIs and their usage', keywords: 'navigate providers models usage', run: () => switchView('agents') },
    { icon: 'office', label: 'Go to Office', detail: 'Where every agent is right now', keywords: 'navigate office map avatars agents', run: () => switchView('office') },
    { icon: 'settings', label: 'Go to Settings', detail: 'Scheduling, notifications and memory', keywords: 'navigate preferences general', run: () => switchView('settings', 'general') },
    { icon: 'routing', label: 'Go to Routing', detail: 'Settings: routing policy, the Jev advisor, and insights', keywords: 'navigate advisor jev policy', run: () => switchView('routing') },
    { icon: 'control', label: 'Go to Context & Tools', detail: 'Settings: MCP, permissions, and shared context', keywords: 'navigate mcp control plane', run: () => switchView('control') },
    { icon: 'skills', label: 'Go to Skills', detail: 'Settings: enable or disable discovered agent skills', keywords: 'navigate skill.md skills capabilities', run: () => switchView('skills') },
    { icon: 'check', label: 'Go to Verification', detail: 'Settings: checks run on isolated branches', keywords: 'navigate verify checks tests', run: () => switchView('verification') },
    { icon: 'palette', label: 'Open Appearance settings', detail: 'Theme family, scheme, dock, density and text size', keywords: 'theme appearance dark light', run: () => switchView('appearance') },
    { icon: 'panel-bottom', label: 'Dock: bottom', detail: 'Move the dock to the bottom edge', keywords: 'appearance layout dock position', run: () => setDock('bottom') },
    { icon: 'panel-left', label: 'Dock: left', detail: 'Move the dock to the left edge', keywords: 'appearance layout dock position', run: () => setDock('left') },
    { icon: 'panel-right', label: 'Dock: right', detail: 'Move the dock to the right edge', keywords: 'appearance layout dock position', run: () => setDock('right') },
    { icon: 'palette', label: 'Theme: Neutral', detail: 'Cool grays and one calm indigo accent', keywords: 'appearance family colour color', run: () => setFamily('neutral') },
    { icon: 'palette', label: 'Theme: Mono', detail: 'Warm stone and ink', keywords: 'appearance family colour color', run: () => setFamily('mono') },
    { icon: 'palette', label: 'Theme: Phosphor', detail: 'Amber accent, glow on readouts', keywords: 'appearance family colour color console', run: () => setFamily('phosphor') },
    { icon: 'folder-open', label: 'Switch project…', detail: 'Scope Tasks, Review, and Workspaces to one repo', keywords: 'project repo switcher filter scope', run: () => void chooseProjectInteractively() },
    { icon: 'panel-right', label: 'Toggle task list', detail: 'Collapse or expand the Tasks work queue (also [)', keywords: 'tasks list collapse expand pane', run: () => { switchView('tasks'); toggleTaskList() } },
    { icon: 'panel-right', label: 'Toggle inspector', detail: 'Collapse or expand the Tasks route inspector (also ])', keywords: 'tasks inspector route files activity collapse expand pane', run: () => { switchView('tasks'); toggleInspector() } },
    { icon: 'refresh', label: 'Check agents', detail: 'Refresh CLI availability and models', keywords: 'health refresh status', run: () => byId<HTMLButtonElement>('health-check').click() },
    { icon: 'trash', label: 'Clear finished tasks', detail: 'Remove completed, failed, and cancelled tasks', keywords: 'clean history', run: () => byId<HTMLButtonElement>('clear-finished').click() }
  ]
  const normalized = query.trim().toLowerCase()
  const matchingCommands = commands.filter((entry) => !normalized || `${entry.label} ${entry.detail} ${entry.keywords}`.toLowerCase().includes(normalized))
  const matchingTasks = (snapshot?.tasks ?? [])
    .filter((task) => !normalized || `${task.prompt} ${task.type} ${task.status} ${providerName(task.selectedProviderId)}`.toLowerCase().includes(normalized))
    .slice(0, normalized ? 10 : 5)
    .map((task): CommandPaletteEntry => ({
      icon: task.status === 'running' ? 'loader' : task.status === 'completed' ? 'check' : 'notice',
      label: task.prompt,
      detail: `${taskKindLabel(task)} · ${task.status} · ${providerName(task.selectedProviderId)}`,
      keywords: 'task conversation workspace',
      run: () => openTask(task.id)
    }))
  return [...matchingCommands, ...matchingTasks]
}

function renderCommandPalette(): void {
  const input = byId<HTMLInputElement>('command-palette-input')
  const entries = commandPaletteEntries(input.value)
  commandPaletteIndex = Math.max(0, Math.min(commandPaletteIndex, Math.max(0, entries.length - 1)))
  const results = byId('command-palette-results')
  if (!entries.length) {
    results.replaceChildren(element('div', 'command-palette-empty', 'No matching commands or tasks.'))
    return
  }
  results.replaceChildren(...entries.map((entry, index) => {
    const button = element('button', `command-palette-item${index === commandPaletteIndex ? ' selected' : ''}`) as HTMLButtonElement
    button.type = 'button'; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === commandPaletteIndex))
    const copy = element('span', 'command-palette-item-copy')
    copy.append(element('strong', undefined, entry.label), element('small', undefined, entry.detail))
    const iconSlot = element('span', 'command-palette-item-icon'); iconSlot.append(icon(entry.icon, 16))
    button.append(iconSlot, copy, element('span', 'command-palette-item-key', entry.shortcut ?? ''))
    button.addEventListener('click', () => { commandPalette.close(); entry.run() })
    return button
  }))
}

export function openCommandPalette(): void {
  const input = byId<HTMLInputElement>('command-palette-input')
  input.value = ''
  commandPaletteIndex = 0
  renderCommandPalette()
  commandPalette.showModal()
  requestAnimationFrame(() => input.focus())
}

export function initCommandPalette(): void {
  byId<HTMLInputElement>('command-palette-input').addEventListener('input', () => { commandPaletteIndex = 0; renderCommandPalette() })
  byId<HTMLInputElement>('command-palette-input').addEventListener('keydown', (event) => {
    const entries = commandPaletteEntries((event.currentTarget as HTMLInputElement).value)
    if (event.key === 'ArrowDown') { event.preventDefault(); commandPaletteIndex = Math.min(entries.length - 1, commandPaletteIndex + 1); renderCommandPalette() }
    else if (event.key === 'ArrowUp') { event.preventDefault(); commandPaletteIndex = Math.max(0, commandPaletteIndex - 1); renderCommandPalette() }
    else if (event.key === 'Enter' && entries[commandPaletteIndex]) { event.preventDefault(); commandPalette.close(); entries[commandPaletteIndex].run() }
  })
  commandPalette.addEventListener('click', (event) => { if (event.target === commandPalette) commandPalette.close() })

  // Keyboard shortcuts: ⌘/Ctrl+K opens the command palette, ⌘/Ctrl+N the composer.
  window.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey)) return
    if (event.key.toLowerCase() === 'k') {
      event.preventDefault()
      if (commandPalette.open) commandPalette.close()
      else openCommandPalette()
    } else if (event.key.toLowerCase() === 'n') {
      event.preventDefault()
      if (commandPalette.open) commandPalette.close()
      enterCompose()
    }
  })
}
