// Phosphor Console component factories (design spec §4, §6): lamps, the
// segmented gauge, the radar sweep, and probability bars. Panels/dialogs get
// their bezel + corner-tick motif from CSS alone (`.panel`, `dialog`) since no
// markup change is needed for those.
import { element, emptyState } from './dom'
import { icon } from './icons'

export type Tone = 'amber' | 'cyan' | 'phosphor' | 'caution' | 'alarm' | 'muted'

// Small pill label (design spec §6) — tier badges, the advisor source badge,
// and anywhere else a one-word status needs a colour without a full lamp.
export function chip(tone: Tone, label: string): HTMLElement {
  return element('span', `chip tone-${tone}`, label)
}

// Round LED. `blink` is for "needs you" only, and is neutralised in CSS under
// `data-effects="off"` / `prefers-reduced-motion`.
export function lamp(tone: Tone, label: string, blink = false): HTMLElement {
  const node = element('span', `lamp lamp-${tone}${blink ? ' blink' : ''}`)
  node.setAttribute('role', 'img')
  node.setAttribute('aria-label', label)
  node.title = label
  return node
}

// Ten discrete segments by default. Replaces every continuous meter (plan
// windows, context occupancy, tracked budget). A `meter`/`progressbar` role
// requires `aria-valuenow` (axe: aria-required-attr) — when the value is
// genuinely unknown ("No plan limit reported") this renders as a plain
// labelled image instead of a value-less meter.
export function gaugeSeg(percent: number | undefined, tone: Tone = 'phosphor', label?: string, segments = 10): HTMLElement {
  const node = element('div', `gauge-seg tone-${tone}`)
  if (percent === undefined) {
    node.setAttribute('role', 'img')
    node.setAttribute('aria-label', label ? `${label} — no data reported` : 'No data reported')
    for (let index = 0; index < segments; index += 1) node.append(element('span', 'seg'))
    return node
  }
  const clamped = Math.min(100, Math.max(0, percent))
  const lit = Math.round((clamped / 100) * segments)
  node.setAttribute('role', 'meter')
  node.setAttribute('aria-valuemin', '0')
  node.setAttribute('aria-valuemax', '100')
  node.setAttribute('aria-valuenow', String(Math.round(clamped)))
  node.setAttribute('aria-valuetext', `${Math.round(clamped)}%${label ? ` — ${label}` : ''}`)
  if (label) node.setAttribute('aria-label', label)
  for (let index = 0; index < segments; index += 1) node.append(element('span', index < lit ? 'seg lit' : 'seg'))
  return node
}

// A 16–40px circular scope with a rotating sweep, shown while a task is
// queued for routing. Effects off / reduced motion: the sweep stops and the
// centre dot pulses gently instead (still governed by the global
// reduced-motion kill-switch in base.css).
export function radar(size: 16 | 24 | 32 = 16, label = 'Queued for routing'): HTMLElement {
  const node = element('span', 'radar')
  node.style.setProperty('--radar-size', `${size}px`)
  node.setAttribute('role', 'img')
  node.setAttribute('aria-label', label)
  node.title = label
  return node
}

// One routing factor as a horizontal segmented bar plus its numeric readout —
// the Tasks inspector's Route section factor rows (also used on the Routing
// screen's payload preview). `maxAbs` bounds the scale the bar is drawn
// against (router factors are bounded, see CLAUDE.md's routing sections).
export function probabilityBar(label: string, points: number, maxAbs = 20): HTMLElement {
  const row = element('div', `probability-bar ${points < 0 ? 'negative' : 'positive'}`)
  row.append(element('span', 'probability-bar-label', label))
  const track = element('div', 'probability-bar-track')
  const fillPercent = Math.min(100, (Math.abs(points) / maxAbs) * 100)
  const fill = element('div', 'probability-bar-fill')
  fill.style.width = `${fillPercent}%`
  track.append(fill)
  row.append(track, element('span', 'probability-bar-value readout', `${points > 0 ? '+' : ''}${Math.round(points)}`))
  return row
}

// A probability distribution (0..1 shares) as a stack of bars with a percent
// readout — Jev's task-type probabilities and its `target` (provider · model)
// choice in the Route section's advisor panel.
export function probabilityBars(entries: Array<{ label: string; value: number }>, tone: Tone = 'cyan'): HTMLElement {
  const wrap = element('div', 'probability-bars')
  for (const { label, value } of entries) {
    const row = element('div', `probability-bar tone-${tone}`)
    row.append(element('span', 'probability-bar-label', label))
    const track = element('div', 'probability-bar-track')
    const fill = element('div', 'probability-bar-fill')
    fill.style.width = `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`
    track.append(fill)
    row.append(track, element('span', 'probability-bar-value readout', `${Math.round(value * 100)}%`))
    wrap.append(row)
  }
  return wrap
}

// A collapsible header + body — the Tasks inspector's Route/Files/Activity/
// Context/Attempts sections (design spec §6). Open state is left to the
// caller (`onToggle`) so it can be persisted or reset per task as needed.
export interface InspectorSectionOptions {
  open?: boolean
  badge?: HTMLElement
  onToggle?(open: boolean): void
}

export function inspectorSection(id: string, title: string, body: HTMLElement | HTMLElement[], options: InspectorSectionOptions = {}): HTMLElement {
  const section = element('section', 'inspector-section')
  section.dataset.section = id
  const header = element('button', 'inspector-section-head') as HTMLButtonElement
  header.type = 'button'
  const caret = element('span', 'inspector-section-caret'); caret.append(icon('chevron-right', 14))
  header.append(caret, element('span', 'inspector-section-title', title))
  if (options.badge) header.append(options.badge)
  const content = element('div', 'inspector-section-body')
  content.append(...(Array.isArray(body) ? body : [body]))
  const open = options.open !== false
  section.classList.toggle('open', open)
  header.setAttribute('aria-expanded', String(open))
  header.addEventListener('click', () => {
    const next = !section.classList.contains('open')
    section.classList.toggle('open', next)
    header.setAttribute('aria-expanded', String(next))
    options.onToggle?.(next)
  })
  section.append(header, content)
  return section
}

// ---------- Data table (spec §6) — Agents grid, Routing's model catalog ----------
export interface DataTableColumn<T> {
  label: string
  render(row: T): Node | string
  className?: string
}

export interface DataTableOptions<T> {
  onRowClick?(row: T, index: number, rowElement: HTMLTableRowElement): void
  rowClassName?(row: T): string
  emptyTitle?: string
  emptyDetail?: string
}

export function dataTable<T>(columns: Array<DataTableColumn<T>>, rows: T[], options: DataTableOptions<T> = {}): HTMLElement {
  const wrap = element('div', 'table-wrap')
  const table = document.createElement('table'); table.className = 'data-table'
  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const column of columns) { const th = document.createElement('th'); th.textContent = column.label; headRow.append(th) }
  thead.append(headRow)
  const tbody = document.createElement('tbody')
  if (!rows.length) {
    const tr = document.createElement('tr')
    const td = document.createElement('td'); td.colSpan = columns.length
    td.append(emptyState(options.emptyTitle ?? 'Nothing here', options.emptyDetail ?? 'Nothing to show yet.'))
    tr.append(td); tbody.append(tr)
  } else {
    rows.forEach((row, index) => {
      const tr = document.createElement('tr')
      if (options.rowClassName) tr.className = options.rowClassName(row)
      if (options.onRowClick) {
        tr.classList.add('clickable')
        tr.tabIndex = 0
        tr.addEventListener('click', () => options.onRowClick!(row, index, tr))
        tr.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); options.onRowClick!(row, index, tr) } })
      }
      for (const column of columns) {
        const td = document.createElement('td')
        if (column.className) td.className = column.className
        const rendered = column.render(row)
        if (typeof rendered === 'string') td.textContent = rendered; else td.append(rendered)
        tr.append(td)
      }
      tbody.append(tr)
    })
  }
  table.append(thead, tbody)
  wrap.append(table)
  return wrap
}

// ---------- Drawer / overlay dialogs (spec §6) ----------
// Thin wiring around a `<dialog>` already declared in index.html: native
// `showModal()` gives focus containment and Esc for free; this only adds
// "return focus to whatever opened it", which browsers do not guarantee.
export interface DialogHandle {
  el: HTMLDialogElement
  open(returnFocusTo?: HTMLElement): void
  close(): void
}

// For the dialogs that still call the native `showModal()` directly (command
// palette, confirm, participants, …) rather than going through `dialogHandle`
// — patches that one instance's `showModal` so whatever had focus when it
// opened gets it back on close, without touching any call site. Idempotent:
// safe to call once per dialog even if more than one module reaches the same
// shared element (e.g. `#confirm-dialog`).
export function restoreFocusOnClose(el: HTMLDialogElement): void {
  if (el.dataset.focusReturnBound) return
  el.dataset.focusReturnBound = 'true'
  let returnFocusTo: HTMLElement | undefined
  const original = el.showModal.bind(el)
  el.showModal = () => { returnFocusTo = document.activeElement as HTMLElement | null ?? undefined; original() }
  el.addEventListener('close', () => returnFocusTo?.focus())
}

export function dialogHandle(el: HTMLDialogElement): DialogHandle {
  let returnFocusTo: HTMLElement | undefined
  el.addEventListener('click', (event) => { if (event.target === el) el.close() })
  el.addEventListener('close', () => returnFocusTo?.focus())
  return {
    el,
    open(target) { returnFocusTo = target; if (!el.open) el.showModal() },
    close() { if (el.open) el.close() }
  }
}
