// Builders for the Settings tabs that are made in TS (Routing, Context & Tools rows, Skills), so they
// match the static markup of General and Verification in index.html: a section is a 13px/600
// `.section-title` with `.settings-help` under it, a setting is a `.settings-row` (text left,
// control right), a table is the kit `.table` inside a bordered `.settings-box`. Kit classes only.
import { element, emptyState } from '../ui/dom'
import { sectionTitle } from '../ui/components'

export function settingsSection(title: string, ...help: string[]): HTMLElement {
  const node = element('section', 'settings-section')
  node.append(sectionTitle(title, 'h2'), ...help.map((text) => element('p', 'settings-help', text)))
  return node
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export function kitButton(variant: ButtonVariant, text: string, id?: string, small = false): HTMLButtonElement {
  const button = element('button', `btn btn-${variant}${small ? ' btn-sm' : ''}`, text) as HTMLButtonElement
  button.type = 'button'
  if (id) button.id = id
  return button
}

// The kit switch the app ships: `<label class="switch"><input type="checkbox"><span class="slider">`.
export function switchControl(id: string | undefined, checked = false, ariaLabel?: string): { wrap: HTMLLabelElement; input: HTMLInputElement } {
  const wrap = document.createElement('label'); wrap.className = 'switch'
  const input = document.createElement('input'); input.type = 'checkbox'; input.checked = checked
  if (id) input.id = id
  if (ariaLabel) input.setAttribute('aria-label', ariaLabel)
  wrap.append(input, element('span', 'slider'))
  return { wrap, input }
}

// Label and help on the left, the control on the right. `help` nodes are appended as given (a
// warning line keeps its own class); strings become `.settings-row-help` lines. The first help line
// describes the control when `forId` names one.
export function settingsRow(label: string, forId: string | undefined, control: HTMLElement, help: Array<string | HTMLElement> = []): HTMLElement {
  const row = element('div', 'settings-row')
  const text = element('div', 'settings-row-text')
  const name = element(forId ? 'label' : 'div', 'settings-row-label', label)
  if (forId) name.setAttribute('for', forId)
  const lines = help.map((line) => (typeof line === 'string' ? element('div', 'settings-row-help', line) : line))
  text.append(name, ...lines)
  if (forId && lines.length) {
    lines[0].id ||= `${forId}-help`
    const input = control.id === forId ? control : control.querySelector(`[id="${forId}"]`)
    input?.setAttribute('aria-describedby', lines[0].id)
  }
  row.append(text, control)
  return row
}

export interface Column { label: string; className?: string }
const column = (spec: string | Column): Column => (typeof spec === 'string' ? { label: spec } : spec)

// A kit table in a bordered box. Returns the body for the caller to fill (and re-fill on render).
export function settingsTable(columns: ReadonlyArray<string | Column>, bodyId?: string): { box: HTMLElement; body: HTMLTableSectionElement } {
  const box = element('div', 'settings-box')
  const table = document.createElement('table'); table.className = 'table'
  const head = document.createElement('thead'); const headRow = document.createElement('tr')
  for (const spec of columns.map(column)) { const th = document.createElement('th'); th.textContent = spec.label; if (spec.className) th.className = spec.className; headRow.append(th) }
  head.append(headRow)
  const body = document.createElement('tbody'); if (bodyId) body.id = bodyId
  table.append(head, body); box.append(table)
  return { box, body }
}

export type Cell = Node | string | { content: Node | string; className: string }
export function tableRow(cells: Cell[]): HTMLTableRowElement {
  const row = document.createElement('tr')
  for (const cell of cells) {
    const td = document.createElement('td')
    const content = typeof cell === 'string' || cell instanceof Node ? cell : (td.className = cell.className, cell.content)
    if (typeof content === 'string') td.textContent = content; else td.append(content)
    row.append(td)
  }
  return row
}

export function emptyRow(colSpan: number, title: string, detail: string): HTMLTableRowElement {
  const row = document.createElement('tr'); row.className = 'table-empty'
  const cell = document.createElement('td'); cell.colSpan = colSpan; cell.append(emptyState(title, detail))
  row.append(cell)
  return row
}

// The same save bar index.html declares for General and Verification (ui/dirty.ts binds it).
export function saveBar(id: string, saveId: string, discardId: string, hintId: string): HTMLElement {
  const bar = element('div', 'save-bar'); bar.id = id
  const hint = element('span', 'save-bar-hint', 'Unsaved changes'); hint.id = hintId; hint.dataset.saveHint = ''; hint.hidden = true
  const actions = element('span', 'save-bar-actions')
  const discard = kitButton('ghost', 'Discard', discardId); discard.dataset.saveDiscard = ''; discard.hidden = true
  const save = kitButton('primary', 'Save', saveId); save.dataset.save = ''
  actions.append(discard, save)
  bar.append(hint, actions)
  return bar
}
