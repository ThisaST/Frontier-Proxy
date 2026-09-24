// Phosphor Console component factories (design spec §4, §6): lamps, the
// segmented gauge, the radar sweep, and probability bars. Panels/dialogs get
// their bezel + corner-tick motif from CSS alone (`.panel`, `dialog`) since no
// markup change is needed for those.
import { element } from './dom'

export type Tone = 'amber' | 'cyan' | 'phosphor' | 'caution' | 'alarm' | 'muted'

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
// windows, context occupancy, tracked budget). `aria-valuenow` carries the
// real number even though the visual is stepped.
export function gaugeSeg(percent: number | undefined, tone: Tone = 'phosphor', label?: string, segments = 10): HTMLElement {
  const clamped = Math.min(100, Math.max(0, percent ?? 0))
  const lit = Math.round((clamped / 100) * segments)
  const node = element('div', `gauge-seg tone-${tone}`)
  node.setAttribute('role', 'meter')
  node.setAttribute('aria-valuemin', '0')
  node.setAttribute('aria-valuemax', '100')
  if (percent !== undefined) node.setAttribute('aria-valuenow', String(Math.round(clamped)))
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
// the Route tab's factor rows. `maxAbs` bounds the scale the bar is drawn
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
