// A single shared JS tooltip, appended to `<body>` — replaces per-element CSS
// `::after` tooltips (design spec, collapsed sidebar) which get clipped by any
// ancestor's `overflow: hidden/auto` (the sidebar itself, once it scrolls).
// Also the one path for icon-only controls that used to rely on `title` alone
// (capacity lamps, etc.): `title` gives no on-screen affordance under our own
// theme and shows on mouse hover only, never on keyboard focus.
//
// Usage: `bindTooltip(el, () => text)` once per element. The element must
// already carry its accessible name via `aria-label` — this only adds a
// visible, positioned description; `aria-describedby` wires it to the
// tooltip text for assistive tech while it is shown.
import { element } from './dom'

let tooltipEl: HTMLElement | undefined
let hideTimer: number | undefined
let currentTarget: HTMLElement | undefined

const TOOLTIP_ID = 'fp-tooltip'

function ensureTooltip(): HTMLElement {
  if (tooltipEl) return tooltipEl
  tooltipEl = element('div', 'ui-tooltip')
  tooltipEl.id = TOOLTIP_ID
  tooltipEl.setAttribute('role', 'tooltip')
  tooltipEl.hidden = true
  document.body.append(tooltipEl)
  return tooltipEl
}

function positionTooltip(target: HTMLElement): void {
  const tip = ensureTooltip()
  const rect = target.getBoundingClientRect()
  tip.style.top = ''; tip.style.bottom = ''; tip.style.left = ''; tip.style.right = ''
  // Prefer the side with more room — the collapsed sidebar sits at the left
  // edge, so its items open to the right; most other icon-only controls have
  // room below.
  const spaceRight = window.innerWidth - rect.right
  if (rect.left < 120 && spaceRight > 140) {
    tip.style.left = `${Math.round(rect.right + 10)}px`
    tip.style.top = `${Math.round(rect.top + rect.height / 2)}px`
    tip.classList.add('ui-tooltip-right')
    tip.classList.remove('ui-tooltip-below')
  } else {
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - 8)
    tip.style.left = `${Math.round(left)}px`
    tip.style.top = `${Math.round(rect.bottom + 8)}px`
    tip.classList.add('ui-tooltip-below')
    tip.classList.remove('ui-tooltip-right')
  }
}

function showTooltip(target: HTMLElement, text: string): void {
  if (!text) return
  window.clearTimeout(hideTimer)
  const tip = ensureTooltip()
  tip.textContent = text
  tip.hidden = false
  positionTooltip(target)
  currentTarget = target
  target.setAttribute('aria-describedby', TOOLTIP_ID)
}

function hideTooltip(): void {
  const tip = ensureTooltip()
  window.clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => { tip.hidden = true }, 60)
  if (currentTarget) currentTarget.removeAttribute('aria-describedby')
  currentTarget = undefined
}

document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideTooltip() })

// Binds hover + keyboard-focus tooltip behaviour to `target`. `text()` is
// read fresh on every show, so the label can depend on live state (capacity,
// collapsed-nav data-label, …). Returns an unbind function.
export function bindTooltip(target: HTMLElement, text: () => string): () => void {
  const onShow = (): void => { const value = text(); if (value) showTooltip(target, value) }
  const onHide = (): void => hideTooltip()
  target.addEventListener('mouseenter', onShow)
  target.addEventListener('mouseleave', onHide)
  target.addEventListener('focus', onShow)
  target.addEventListener('blur', onHide)
  return () => {
    target.removeEventListener('mouseenter', onShow)
    target.removeEventListener('mouseleave', onHide)
    target.removeEventListener('focus', onShow)
    target.removeEventListener('blur', onHide)
  }
}

// Convenience for a static string — the common case (a label that never
// changes after the element is built).
export function tooltip(target: HTMLElement, text: string): void {
  bindTooltip(target, () => text)
}
