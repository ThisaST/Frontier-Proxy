// Office — a top-down map of where every agent is right now. The scene model lives in
// src/shared/office-model.ts, the layout and walking simulation in office-grid.ts / office-sim.ts, the
// drawing in ../office/*; this file wires them to the view: the animation loop, pointer and keyboard
// input (You walk with the arrow keys), the agent popover, and the accessible roster that mirrors the map.
// Never reads a provider's kind; appearance and state come from the scene.
import { MIN_DESKS, TILE, buildOfficeLayout } from '../../../shared/office-grid'
import type { Facing } from '../../../shared/office-grid'
import type { OfficeAgent, OfficeAgentState, OfficeScene } from '../../../shared/office-model'
import { buildOfficeScene } from '../../../shared/office-model'
import { TILE_MS, actorPixel, actorTile, adjacentAgent, advance, createSim, moveYou, reconcile, type Sim } from '../../../shared/office-sim'
import { createOfficeRenderer, type OfficeRenderer } from '../office/canvas'
import { createOfficeOverlay, type OfficeOverlay } from '../office/overlay'
import { invalidatePalette } from '../office/palette'
import { clearSpriteCache } from '../office/sprites'
import { byId, element } from '../ui/dom'
import { status, tag, type StatusTone } from '../ui/components'
import { announce } from '../ui/announce'
import { countdown } from '../ui/format'
import { snapshot, currentView } from '../state'
import { currentProject, onProjectChange, setCurrentProject } from '../project'
import { onAppearanceChange } from '../theme'
import { switchView } from '../main'
import { openTask } from './tasks'
import { openAgentSheet } from './agents'
import { openWorkspace } from '../workspace'
import { onReviewChange, reviewPendingCount } from './review'

const STATUS: Record<OfficeAgentState, { tone: StatusTone; word: string }> = {
  meeting: { tone: 'running', word: 'In a meeting' },
  working: { tone: 'running', word: 'Working' },
  waiting: { tone: 'info', word: 'Waiting' },
  idle: { tone: 'neutral', word: 'Idle' },
  cooldown: { tone: 'warn', word: 'Cooling down' },
  limited: { tone: 'warn', word: 'Limit reached' },
  'logged-out': { tone: 'danger', word: 'Logged out' },
  offline: { tone: 'danger', word: 'Not detected' },
  disabled: { tone: 'neutral', word: 'Disabled' }
}

export function officeStatus(state: OfficeAgentState): { tone: StatusTone; word: string } { return STATUS[state] }

const KEYS: Record<string, Facing> = { arrowup: 'up', w: 'up', arrowdown: 'down', s: 'down', arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right' }
const keyName = (key: string): string => key.toLowerCase()
const effectsOn = (): boolean => document.documentElement.dataset.effects !== 'off'

let sim: Sim | undefined
let renderer: OfficeRenderer | undefined
let overlay: OfficeOverlay | undefined
let scene: OfficeScene | undefined
let raf = 0
let tick: ReturnType<typeof setInterval> | undefined
let lastFrame = 0
let deskCount = 0
// True until the next render: the first one after entering the view snaps everyone to their place instead
// of walking them in from the door. switchView renders before it starts the loop, so leaving the view
// (stopOfficeLoop) is what re-arms it.
let entered = true
let dirty = true
let wasActive = false
let rosterKey = ''
let popoverId: string | undefined
let popoverKey = ''
let popoverOpener: HTMLElement | undefined
let visibilityBound = false
const pressed = new Set<string>()
let pressedAt = 0
let lastPressed = ''
// A tap that lands mid-step is kept for the next tile instead of being dropped (one deep).
let queued: Facing | undefined

const markDirty = (): void => { dirty = true }
const canvasEl = (): HTMLCanvasElement => byId<HTMLCanvasElement>('office-canvas')
const popoverEl = (): HTMLElement => byId('office-popover')

function ensureSim(count: number): Sim {
  const desks = Math.max(MIN_DESKS, count)
  if (!sim || deskCount !== desks) {
    deskCount = desks
    sim = createSim(buildOfficeLayout(desks), 0x0ff1ce)
    entered = true
    renderer?.resize(sim.layout)
  }
  return sim
}

function ensureRenderer(): void {
  if (renderer) return
  renderer = createOfficeRenderer(canvasEl(), byId('office-stage'))
  overlay = createOfficeOverlay(byId('office-overlay'))
  if (sim) renderer.resize(sim.layout)
  // The renderer refits first (registered first); the overlay then re-places its labels at the new scale.
  if (typeof ResizeObserver === 'function') new ResizeObserver(markDirty).observe(byId('office-stage'))
}

function renderRoster(agents: OfficeAgent[]): void {
  const key = JSON.stringify(agents.map((agent) => [agent.providerId, agent.name, agent.state, agent.badge, agent.primary?.title ?? agent.primary?.activity ?? agent.reason]))
  if (key === rosterKey) return // a streamed run re-renders constantly; rebuilding would drop focus from a roster button
  rosterKey = key
  byId('office-roster').replaceChildren(...agents.map((agent) => {
    const item = element('li')
    const button = element('button', 'office-roster-item') as HTMLButtonElement
    button.type = 'button'
    button.dataset.providerId = agent.providerId
    const { tone, word } = officeStatus(agent.state)
    button.append(status(tone, word), element('span', 'office-roster-name', agent.name))
    if (agent.badge) button.append(element('span', 'office-roster-badge', `${agent.badge.handle} · ${agent.badge.role}`))
    const detail = agent.primary?.title ?? agent.primary?.activity ?? agent.reason
    if (detail) button.append(element('span', 'office-roster-detail', detail))
    button.addEventListener('click', () => openPopover(agent.providerId, button.getBoundingClientRect(), button))
    item.append(button)
    return item
  }))
}

export function renderOfficeView(): void {
  if (typeof snapshot === 'undefined') return
  scene = buildOfficeScene(snapshot, { now: Date.now(), projectCwd: currentProject, reviewCount: reviewPendingCount() })
  const current = ensureSim(snapshot.providers.length)
  reconcile(current, scene, { snap: entered || !effectsOn(), now: performance.now() })
  entered = false
  byId('office-canvas').setAttribute('aria-label', scene.summary)
  renderRoster(scene.agents)
  announce('office', scene.summary)
  refreshPopover()
  markDirty()
}

// ---- Popover ----

function rectOf(x: number, y: number, w: number, h: number): DOMRect { return new DOMRect(x, y, w, h) }
function tileRect(id: string): DOMRect | undefined {
  const actor = sim?.actors.get(id)
  if (!actor || !renderer) return undefined
  const pos = actorPixel(actor), at = renderer.tileToClient(pos, sim), size = TILE * renderer.scale()
  return rectOf(at.x, at.y - size / 2, size, size * 1.5)
}

function closePopover(returnFocus = true): void {
  const pop = popoverEl()
  if (pop.hidden) return
  const id = popoverId, opener = popoverOpener
  pop.hidden = true
  popoverId = undefined; popoverKey = ''; popoverOpener = undefined
  if (!returnFocus) return
  // The roster rebuilds only on change, but the opener can still be gone; fall back to its agent's button, then the canvas.
  const target = opener?.isConnected ? opener : [...byId('office-roster').querySelectorAll<HTMLElement>('button')].find((button) => button.dataset.providerId === id) ?? canvasEl()
  target.focus()
}

// Keeps an open popover in step with the scene (same agent, same position); closes it if the agent vanished.
function refreshPopover(): void {
  const pop = popoverEl()
  if (pop.hidden || popoverId === undefined) return
  const agent = scene?.agents.find((candidate) => candidate.providerId === popoverId)
  if (!agent) { closePopover(false); return }
  const key = JSON.stringify([agent, agent.until ? countdown(agent.until) : ''])
  if (key === popoverKey) return // rebuilding on every streamed snapshot would drop focus from its buttons
  popoverKey = key
  const buttons = [...pop.querySelectorAll('button')], focused = buttons.indexOf(document.activeElement as HTMLButtonElement)
  pop.replaceChildren(...popoverContent(agent))
  if (focused >= 0) pop.querySelectorAll('button')[focused]?.focus()
}

function popoverContent(agent: OfficeAgent): HTMLElement[] {
  const heading = element('h3', undefined, agent.name)
  heading.id = 'office-popover-title'
  const { tone, word } = officeStatus(agent.state)
  const parts: HTMLElement[] = [heading, status(tone, word)]
  if (agent.badge) parts.push(element('p', 'office-popover-badge', `${agent.badge.handle} · ${agent.badge.role}`))
  if (agent.reason) parts.push(element('p', 'office-popover-reason', agent.reason + (agent.until ? ` · ${countdown(agent.until)}` : '')))
  if (agent.work.length) {
    const list = element('ul', 'office-work')
    for (const work of agent.work) {
      const row = element('li')
      const head = element('span', 'office-work-title', work.title)
      if (!work.inScope) head.append(' ', tag('other project'))
      row.append(head)
      if (work.activity) row.append(element('span', 'office-activity', work.activity))
      const target = work.kind === 'turn' ? work.workspaceId : work.taskId
      if (target) {
        const open = element('button', 'btn btn-secondary btn-sm', work.kind === 'turn' ? 'Open workspace' : 'Open task') as HTMLButtonElement
        open.type = 'button'
        open.addEventListener('click', () => {
          closePopover(false)
          if (!work.inScope) setCurrentProject(work.cwd)
          if (work.kind === 'turn') openWorkspace(target); else openTask(target)
        })
        row.append(open)
      }
      list.append(row)
    }
    parts.push(list)
  }
  const actions = element('div', 'office-actions')
  const openAgent = element('button', 'btn btn-ghost btn-sm', 'Open agent') as HTMLButtonElement
  openAgent.type = 'button'
  openAgent.addEventListener('click', () => { closePopover(false); switchView('agents'); openAgentSheet(agent.providerId) })
  actions.append(openAgent)
  parts.push(actions)
  return parts
}

function openPopover(providerId: string, anchor: DOMRect, opener: HTMLElement = canvasEl()): void {
  const agent = scene?.agents.find((candidate) => candidate.providerId === providerId)
  if (!agent) return
  const pop = popoverEl(), stage = byId('office-stage')
  pop.replaceChildren(...popoverContent(agent))
  popoverId = providerId; popoverOpener = opener
  popoverKey = JSON.stringify([agent, agent.until ? countdown(agent.until) : ''])
  pop.hidden = false
  const box = stage.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight
  let left = anchor.right + 8 - box.left
  if (left + w > box.width - 8) left = anchor.left - w - 8 - box.left
  left = Math.max(8, Math.min(left, box.width - w - 8))
  const top = Math.max(8, Math.min(anchor.top - box.top, box.height - h - 8))
  pop.style.left = `${Math.round(left)}px`; pop.style.top = `${Math.round(top)}px`
  pop.querySelector<HTMLElement>('button')?.focus()
}

// ---- Loop ----

function animating(current: Sim): boolean {
  const busy = (actor: { t: number; path: unknown[] }): boolean => actor.t < 1 || actor.path.length > 0
  return busy(current.you) || [...current.actors.values()].some(busy)
}

function updatePrompt(current: Sim, active: OfficeScene): void {
  const prompt = byId('office-prompt'), focused = document.activeElement === canvasEl()
  const near = adjacentAgent(current), me = actorTile(current.you), stand = current.layout.review.stand
  const text = !focused ? '' : near ? `Enter: talk to ${active.agents.find((agent) => agent.providerId === near)?.name ?? 'agent'}` : me.x === stand.x && me.y === stand.y ? 'Enter: open Review' : ''
  if (prompt.textContent !== text) prompt.textContent = text
  prompt.hidden = !text
}

function frame(now: number): void {
  raf = requestAnimationFrame(frame)
  const dt = Math.min(50, now - lastFrame)
  lastFrame = now
  const current = sim, active = scene
  if (!current || !active || !renderer || !overlay) return
  const events = advance(current, dt, { motion: effectsOn(), now })
  if (queued && current.you.t >= 1) { moveYou(current, queued); queued = undefined; pressedAt = now }
  else if (pressed.size && now - pressedAt >= TILE_MS && KEYS[lastPressed] && moveYou(current, KEYS[lastPressed]!)) pressedAt = now
  for (const event of events) {
    if (event.kind !== 'entered-room') continue
    const entry = [...current.roomOf].find(([, index]) => index === event.room)
    if (entry) { openWorkspace(entry[0]); return } // switchView stops the loop
  }
  const busy = animating(current)
  if (dirty || busy || wasActive) {
    dirty = false
    renderer.draw(current, active, now)
    overlay.update(current, active, renderer, { now, youAdjacent: document.activeElement === canvasEl() ? adjacentAgent(current) : undefined })
    updatePrompt(current, active)
  }
  wasActive = busy
}

export function startOfficeLoop(): void {
  ensureRenderer()
  markDirty()
  if (!raf) { lastFrame = performance.now(); raf = requestAnimationFrame(frame) }
  if (tick === undefined) tick = setInterval(renderOfficeView, 1000) // countdowns, and a cooldown that has just ended
  if (!visibilityBound) {
    visibilityBound = true
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { cancelAnimationFrame(raf); raf = 0; return }
      if (currentView === 'office' && !raf) { lastFrame = performance.now(); markDirty(); raf = requestAnimationFrame(frame) }
    })
  }
}

export function stopOfficeLoop(): void {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  if (tick !== undefined) clearInterval(tick)
  tick = undefined
  pressed.clear(); queued = undefined
  entered = true
  if (typeof document !== 'undefined' && document.getElementById('office-popover')) closePopover(false)
}

// ---- Input ----

function onKeyDown(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const key = keyName(event.key), dir = KEYS[key]
  if (dir) {
    event.preventDefault()
    if (!sim || event.repeat || pressed.has(key)) return
    pressed.add(key); lastPressed = key; pressedAt = performance.now()
    if (!moveYou(sim, dir) && sim.you.t < 1) queued = dir
    markDirty()
    return
  }
  if (event.key === 'Escape') { if (!popoverEl().hidden) { event.preventDefault(); closePopover() } return }
  if (event.key !== 'Enter' || !sim) return
  const near = adjacentAgent(sim), me = actorTile(sim.you), stand = sim.layout.review.stand
  if (near) { event.preventDefault(); const anchor = tileRect(near); if (anchor) openPopover(near, anchor) }
  else if (me.x === stand.x && me.y === stand.y) { event.preventDefault(); switchView('review') }
}

function onKeyUp(event: KeyboardEvent): void {
  const key = keyName(event.key)
  if (!pressed.delete(key)) return
  if (lastPressed === key) lastPressed = [...pressed].at(-1) ?? ''
}

function onClick(event: MouseEvent): void {
  if (!sim || !scene || !renderer) return
  const hit = renderer.hitTest(event.clientX, event.clientY, sim)
  if (!hit) { closePopover(false); return }
  if (hit.kind === 'agent') { const anchor = tileRect(hit.id); if (anchor) openPopover(hit.id, anchor) }
  else if (hit.kind === 'room') { const entry = [...sim.roomOf].find(([, index]) => index === hit.index); if (entry) openWorkspace(entry[0]) }
  else switchView('review')
}

export function initOfficeView(): void {
  const refresh = (): void => { if (currentView === 'office') renderOfficeView() }
  onProjectChange(refresh)
  onReviewChange(refresh)
  onAppearanceChange(() => { invalidatePalette(); clearSpriteCache(); overlay?.invalidateSizes(); markDirty() })
  document.fonts?.ready.then(() => { overlay?.invalidateSizes(); markDirty() }, () => undefined) // label metrics change once the bundled fonts load
  const canvas = canvasEl(), pop = popoverEl()
  canvas.addEventListener('keydown', onKeyDown)
  canvas.addEventListener('keyup', onKeyUp)
  canvas.addEventListener('click', onClick)
  canvas.addEventListener('focus', markDirty)
  canvas.addEventListener('blur', () => { pressed.clear(); queued = undefined; markDirty() })
  canvas.addEventListener('pointermove', (event) => { canvas.style.cursor = sim && scene && renderer?.hitTest(event.clientX, event.clientY, sim) ? 'pointer' : '' })
  pop.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); closePopover() } })
  pop.addEventListener('focusout', (event) => { if (event.relatedTarget instanceof Node && !pop.contains(event.relatedTarget)) closePopover(false) })
  document.addEventListener('pointerdown', (event) => { if (!pop.hidden && event.target instanceof Node && !pop.contains(event.target)) closePopover(false) })
  window.addEventListener('blur', () => pressed.clear())
}
