// Shared roving-tabindex behaviour for every segmented control in the app —
// run mode, theme, advisor mode, participant kind, … One ARIA pattern
// (`role="radiogroup"` of `role="radio"`), applied consistently everywhere a
// segmented control appears, per the accessibility pass: arrow keys move
// both focus and selection between options, Home/End jump to the ends, and
// only the checked option sits in the tab order. Each view still owns
// rendering `.active`/`aria-checked` for its own state (`syncRadioGroup`
// keeps `tabindex` in step with whichever option that render marked checked);
// this module only wires the keyboard/click behaviour once per group.
function options(group: HTMLElement): HTMLElement[] {
  return [...group.querySelectorAll<HTMLElement>('[role="radio"]')]
}

// Call after any render that sets `aria-checked` — keeps the roving
// `tabindex` (and therefore Tab order) matching whichever option is checked.
export function syncRadioGroupTabIndex(group: HTMLElement): void {
  const list = options(group)
  const checked = list.find((el) => el.getAttribute('aria-checked') === 'true') ?? list[0]
  for (const el of list) el.tabIndex = el === checked ? 0 : -1
}

// `onSelect` is whatever the view already does on click (usually also the
// thing that re-renders `aria-checked`/`.active`) — this only adds arrow-key
// navigation on top of it and keeps the roving tabindex in sync.
export function initRadioGroup(group: HTMLElement, onSelect: (option: HTMLElement) => void): void {
  syncRadioGroupTabIndex(group)
  group.addEventListener('keydown', (event) => {
    const list = options(group)
    const current = list.indexOf(document.activeElement as HTMLElement)
    if (current < 0) return
    const move = (delta: number): void => {
      const next = list[(current + delta + list.length) % list.length]
      next.focus()
      onSelect(next)
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); move(1) }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
    else if (event.key === 'Home') { event.preventDefault(); list[0].focus(); onSelect(list[0]) }
    else if (event.key === 'End') { event.preventDefault(); list[list.length - 1].focus(); onSelect(list[list.length - 1]) }
  })
}
