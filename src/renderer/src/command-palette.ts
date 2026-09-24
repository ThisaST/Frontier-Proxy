// The ⌘K command palette: quick navigation, quick actions, and task search.
import { byId, element } from './ui/dom'
import { icon, type IconName } from './ui/icons'
import { providerName } from './providers-view-model'
import { taskKindLabel } from './task-helpers'
import { openProjectSwitcher } from './project'
import { snapshot } from './state'
import { switchView } from './main'
import { openTask } from './views/tasks'
import { openTaskDialog, taskDialog } from './dialogs/new-task'

const commandPalette = byId<HTMLDialogElement>('command-palette')
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
    { icon: 'plus', label: 'New task', detail: 'Send work to an agent', shortcut: '⌘N', keywords: 'create route agent run', run: () => openTaskDialog() },
    { icon: 'compare', label: 'Compare agents', detail: 'Run one prompt on several agents at once', keywords: 'bench head to head compare', run: () => openTaskDialog('bench') },
    { icon: 'home', label: 'Go to Home', detail: 'Start work and see what is running', keywords: 'navigate mission control composer', run: () => switchView('home') },
    { icon: 'tasks', label: 'Go to Tasks', detail: 'The work queue', keywords: 'navigate queue', run: () => switchView('tasks') },
    { icon: 'workspace', label: 'Go to Workspaces', detail: 'Long-lived, per-repo conversations', keywords: 'navigate collaborate participants', run: () => switchView('workspace') },
    { icon: 'review', label: 'Go to Review', detail: 'Branches waiting to be merged', keywords: 'navigate merge branches', run: () => switchView('review') },
    { icon: 'agents', label: 'Go to Agents', detail: 'Installed CLIs and their usage', keywords: 'navigate providers models usage', run: () => switchView('agents') },
    { icon: 'routing', label: 'Go to Routing', detail: 'Routing policy, the Jev advisor, and insights', keywords: 'navigate advisor jev policy', run: () => switchView('routing') },
    { icon: 'control', label: 'Go to Context & Tools', detail: 'MCP, permissions, and shared context', keywords: 'navigate mcp control plane', run: () => switchView('control') },
    { icon: 'skills', label: 'Go to Skills', detail: 'Enable or disable discovered agent skills', keywords: 'navigate skill.md skills capabilities', run: () => switchView('skills') },
    { icon: 'settings', label: 'Go to Settings', detail: 'Scheduling and memory', keywords: 'navigate preferences', run: () => switchView('settings') },
    { icon: 'folder-open', label: 'Switch project…', detail: 'Scope Tasks, Review, and Workspaces to one repo', keywords: 'project repo switcher filter scope', run: () => openProjectSwitcher() },
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

  // Keyboard shortcuts: ⌘/Ctrl+K opens the command palette, ⌘/Ctrl+N a new task.
  window.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey)) return
    if (event.key.toLowerCase() === 'k') {
      event.preventDefault()
      if (commandPalette.open) commandPalette.close()
      else if (!taskDialog.open) openCommandPalette()
    } else if (event.key.toLowerCase() === 'n') {
      event.preventDefault()
      if (commandPalette.open) commandPalette.close()
      openTaskDialog()
    }
  })
}
