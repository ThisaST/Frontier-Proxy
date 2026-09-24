// The project switcher: which repo (cwd) the Tasks list, Review inbox, and
// Workspaces list are scoped to, and the working directory Home's composer
// and the ⌘N dialog pre-fill. Unset ("All projects") behaves exactly as
// before this module existed. Every localStorage access is wrapped in
// try/catch (private mode, disabled storage).
import { byId, element } from './ui/dom'
import { icon } from './ui/icons'
import { baseName } from './ui/format'
import { snapshot } from './state'

const CURRENT_KEY = 'fp-current-project'
const RECENTS_KEY = 'fp-projects'
const MAX_RECENTS = 12

function readStorage(key: string): string | undefined {
  try { return localStorage.getItem(key) ?? undefined } catch { return undefined }
}
function writeStorage(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* private mode / disabled storage */ }
}
function removeStorage(key: string): void {
  try { localStorage.removeItem(key) } catch { /* private mode / disabled storage */ }
}

export let currentProject: string | undefined = readStorage(CURRENT_KEY)

function recentProjects(): string[] {
  try { const raw = readStorage(RECENTS_KEY); return raw ? (JSON.parse(raw) as string[]) : [] } catch { return [] }
}

function recordRecentProject(cwd: string): void {
  const next = [cwd, ...recentProjects().filter((item) => item !== cwd)].slice(0, MAX_RECENTS)
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)) } catch { /* private mode / disabled storage */ }
}

const listeners: Array<() => void> = []
export function onProjectChange(listener: () => void): void { listeners.push(listener) }

export function setCurrentProject(cwd: string | undefined): void {
  currentProject = cwd
  if (cwd) { writeStorage(CURRENT_KEY, cwd); recordRecentProject(cwd) }
  else removeStorage(CURRENT_KEY)
  listeners.forEach((listener) => listener())
}

// "All projects" (undefined) matches everything, matching pre-P3b behaviour.
export function projectMatches(cwd: string | undefined): boolean {
  return !currentProject || cwd === currentProject
}

export interface ProjectOption { cwd: string; name: string }

// Distinct cwds from live tasks/workspaces plus the recents list, most recent
// (by however they were last seen) first — recents lead since they are the
// explicit "I opened this before" signal.
export function knownProjects(): ProjectOption[] {
  const order: string[] = []
  const seen = new Set<string>()
  const push = (cwd: string | undefined): void => {
    if (!cwd || seen.has(cwd)) return
    seen.add(cwd); order.push(cwd)
  }
  recentProjects().forEach(push)
  ;(snapshot?.tasks ?? []).forEach((task) => push(task.cwd))
  ;(snapshot?.workspaces ?? []).forEach((workspace) => push(workspace.cwd))
  return order.map((cwd) => ({ cwd, name: baseName(cwd) }))
}

// A "Project: name ×" chip for the top of a scoped list. Returns undefined
// under "All projects" so callers can simply omit the row.
export function projectChip(): HTMLElement | undefined {
  if (!currentProject) return undefined
  const cwd = currentProject
  const chip = element('button', 'project-chip') as HTMLButtonElement
  chip.type = 'button'
  chip.title = `Clear project filter · ${cwd}`
  chip.append(element('span', undefined, `Project: ${baseName(cwd)}`), icon('close', 14))
  chip.addEventListener('click', () => setCurrentProject(undefined))
  return chip
}

export function renderProjectChipInto(containerId: string): void {
  const container = byId(containerId)
  const chip = projectChip()
  container.replaceChildren(...(chip ? [chip] : []))
}

// Bring the sidebar's project switcher forward — used by any other trigger
// (Home's composer project field) that wants "clicking it opens the
// switcher" without a second, independent menu implementation.
export function openProjectSwitcher(): void {
  byId<HTMLButtonElement>('project-switcher-trigger').click()
}

// ---- Sidebar switcher: trigger + menu, keyboard-accessible ----

let menuIndex = 0

type ProjectMenuOption = { cwd?: string; label: string; action?: 'add' }

function projectMenuOptions(): ProjectMenuOption[] {
  return [
    { label: 'All projects' },
    ...knownProjects().map((project): ProjectMenuOption => ({ cwd: project.cwd, label: project.name })),
    { label: 'Add project…', action: 'add' }
  ]
}

function optionId(index: number): string { return `project-switcher-item-${index}` }

function optionSelected(option: ProjectMenuOption): boolean {
  return option.action !== 'add' && option.cwd === currentProject
}

export function renderProjectSwitcherLabel(): void {
  const label = currentProject ? baseName(currentProject) : 'All projects'
  byId('project-switcher-label').textContent = label
  const trigger = byId<HTMLButtonElement>('project-switcher-trigger')
  trigger.title = currentProject ?? 'All projects'
  trigger.setAttribute('aria-label', `Project: ${label}`)
}

function renderProjectMenu(): void {
  const menu = byId('project-switcher-menu')
  const options = projectMenuOptions()
  menuIndex = Math.max(0, Math.min(menuIndex, options.length - 1))
  menu.replaceChildren(...options.map((option, index) => {
    const selected = optionSelected(option)
    const row = element('div', `project-switcher-item${index === menuIndex ? ' active' : ''}${selected ? ' selected' : ''}`)
    row.id = optionId(index)
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(selected))
    if (option.action === 'add') row.append(icon('plus', 14), document.createTextNode(option.label))
    else {
      const body = element('span', 'project-switcher-item-copy')
      body.append(element('strong', undefined, option.label))
      if (option.cwd) body.append(element('small', undefined, option.cwd))
      row.append(body)
    }
    if (option.cwd) row.title = option.cwd
    row.addEventListener('mousedown', (event) => { event.preventDefault(); void chooseProjectOption(option) })
    return row
  }))
  if (!menu.hidden) byId('project-switcher-trigger').setAttribute('aria-activedescendant', optionId(menuIndex))
}

async function chooseProjectOption(option: ProjectMenuOption): Promise<void> {
  if (option.action === 'add') {
    closeProjectMenu()
    try {
      const directory = await window.frontier.chooseDirectory(currentProject)
      if (directory) setCurrentProject(directory)
    } catch { /* the folder picker surfaces its own failures elsewhere */ }
    return
  }
  setCurrentProject(option.cwd)
  closeProjectMenu()
}

function closeProjectMenu(returnFocus = true): void {
  const menu = byId('project-switcher-menu')
  if (menu.hidden) return
  menu.hidden = true
  const trigger = byId<HTMLButtonElement>('project-switcher-trigger')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.removeAttribute('aria-activedescendant')
  if (returnFocus) trigger.focus()
}

function openProjectMenu(): void {
  menuIndex = Math.max(0, projectMenuOptions().findIndex((option) => optionSelected(option)))
  const menu = byId('project-switcher-menu')
  menu.hidden = false
  byId('project-switcher-trigger').setAttribute('aria-expanded', 'true')
  renderProjectMenu()
}

export function initProjectSwitcher(): void {
  const trigger = byId<HTMLButtonElement>('project-switcher-trigger')
  const menu = byId('project-switcher-menu')
  trigger.addEventListener('click', () => { if (menu.hidden) openProjectMenu(); else closeProjectMenu(false) })
  trigger.addEventListener('keydown', (event) => {
    if (!menu.hidden) {
      const options = projectMenuOptions()
      if (event.key === 'ArrowDown') { event.preventDefault(); menuIndex = Math.min(options.length - 1, menuIndex + 1); renderProjectMenu(); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); menuIndex = Math.max(0, menuIndex - 1); renderProjectMenu(); return }
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void chooseProjectOption(options[menuIndex]); return }
      if (event.key === 'Escape') { event.preventDefault(); closeProjectMenu(); return }
      if (event.key === 'Tab') { closeProjectMenu(false); return }
    } else if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); openProjectMenu()
    }
  })
  document.addEventListener('click', (event) => {
    if (menu.hidden) return
    if (event.target instanceof Node && (menu.contains(event.target) || trigger.contains(event.target))) return
    closeProjectMenu(false)
  })
  onProjectChange(renderProjectSwitcherLabel)
  renderProjectSwitcherLabel()
}
