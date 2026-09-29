// The Calm kit's component factories (styles/kit.css, docs/ui-calm/spec.md section 4): status,
// tag, meter, avatar and labels, plus the inspector section and dialog helpers.
import { element } from './dom'
import { icon } from './icons'

export type StatusTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'running'
export type MeterTone = 'ok' | 'warn' | 'danger' | 'accent'

const STATUS_NAMES: Record<StatusTone, string> = { ok: 'OK', warn: 'Warning', danger: 'Error', info: 'Info', neutral: 'Idle', running: 'Running' }

// A dot and a word. With no text it is a dot-only status (queue rows), so the dot itself
// carries the accessible name: `opts.ariaLabel`, else the tone's plain word.
export function status(tone: StatusTone, label: string, opts: { ariaLabel?: string; title?: string } = {}): HTMLElement {
  const node = element('span', `status ${tone}`, label)
  if (!label) { node.setAttribute('role', 'img'); node.setAttribute('aria-label', opts.ariaLabel ?? STATUS_NAMES[tone]) }
  if (opts.title) node.title = opts.title
  return node
}

// Small neutral text tag (kinds, tiers, file actions). Text is shown as given, never uppercased.
export function tag(label: string): HTMLElement { return element('span', 'tag', label) }

// A 4px meter. `--value` is set through the CSSOM (`style.setProperty`), never an inline
// `style` attribute, because the CSP is `style-src 'self'`. A `meter` role
// needs `aria-valuenow`, so an unknown value renders as a labelled image instead.
export function meter(percent: number | undefined, tone?: MeterTone, label?: string): HTMLElement {
  const node = element('div', `meter${tone ? ` ${tone}` : ''}`)
  const track = element('div', 'meter-track'), fill = element('div', 'meter-fill')
  track.append(fill); node.append(track)
  if (percent === undefined || !Number.isFinite(percent)) {
    node.setAttribute('role', 'img')
    node.setAttribute('aria-label', label ? `${label}: not reported` : 'Not reported')
    return node
  }
  const clamped = Math.min(100, Math.max(0, percent)), rounded = Math.round(clamped)
  node.style.setProperty('--value', `${clamped}%`)
  node.setAttribute('role', 'meter')
  node.setAttribute('aria-valuemin', '0'); node.setAttribute('aria-valuemax', '100'); node.setAttribute('aria-valuenow', String(rounded))
  node.setAttribute('aria-valuetext', `${rounded}%${label ? `: ${label}` : ''}`)
  if (label) node.setAttribute('aria-label', label)
  return node
}

// Label + meter + mono readout on one row (routing factors, advisor best fit, plan windows).
export function meterRow(label: string, percent: number | undefined, readoutText: string, tone?: MeterTone): HTMLElement {
  const row = element('div', 'meter-row')
  row.append(element('span', 'meter-label', label), meter(percent, tone, label), element('span', 'meter-readout', readoutText))
  return row
}

// Two-letter initials in a neutral circle. Decorative unless a `name` is given.
export function avatar(initials: string, name?: string): HTMLElement {
  const node = element('span', 'avatar', initials.trim().slice(0, 2).toUpperCase())
  if (name) { node.setAttribute('role', 'img'); node.setAttribute('aria-label', name) } else node.setAttribute('aria-hidden', 'true')
  return node
}

export function sectionTitle(text: string, tagName: 'h2' | 'h3' | 'h4' | 'div' = 'h3'): HTMLElement { return element(tagName, 'section-title', text) }

// A `label` when it names a control (`forId`), otherwise a plain span.
export function fieldLabel(text: string, forId?: string): HTMLElement {
  const node = element(forId ? 'label' : 'span', 'field-label', text)
  if (forId) node.setAttribute('for', forId)
  return node
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
