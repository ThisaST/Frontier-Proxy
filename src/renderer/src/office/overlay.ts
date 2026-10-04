// The Office DOM overlay: name tags, state badges, speech bubbles and room labels float above the canvas
// as real text (crisp at any scale, readable by tools). Nodes are reused by key and only touched when
// their text or position changed, because this runs on every animation frame while anyone is walking.
import { TILE } from '../../../shared/office-grid'
import { isAway } from '../../../shared/office-model'
import type { OfficeAgent, OfficeScene } from '../../../shared/office-model'
import { actorPixel, type Sim } from '../../../shared/office-sim'
import { element } from '../ui/dom'
import { baseName, countdown } from '../ui/format'
import type { OfficeRenderer } from './canvas'

export interface OfficeOverlay {
  update(sim: Sim, scene: OfficeScene, renderer: OfficeRenderer, opts: { now: number; youAdjacent?: string }): void
  clear(): void
  invalidateSizes(): void   // label metrics are cached; drop them when fonts or the theme change
}

const GAP = 2

function bubbleText(agent: OfficeAgent): string | undefined {
  if (isAway(agent.state)) return (agent.reason ?? '') + (agent.until ? ` · ${countdown(agent.until)}` : '') || undefined
  const { primary, state } = agent
  return primary?.activity ?? (state === 'working' && primary && !primary.inScope ? `Busy in ${baseName(primary.cwd)}` : state === 'waiting' ? 'Waiting for a slot' : state === 'working' ? 'Working…' : undefined)
}

interface Box { l: number; t: number; w: number; h: number }
interface Placed { el: HTMLElement; cx: number; y: number; w: number; h: number; up: boolean; follower?: Placed }

export function createOfficeOverlay(root: HTMLElement): OfficeOverlay {
  const nodes = new Map<string, HTMLElement>()
  let sizes = new WeakMap<HTMLElement, { w: number; h: number }>()

  function node(key: string, className: string): HTMLElement {
    let el = nodes.get(key)
    if (!el) { el = element('div', className); nodes.set(key, el); root.append(el) }
    return el
  }
  function setText(el: HTMLElement, text: string): void { if (el.textContent !== text) { el.textContent = text; sizes.delete(el) } }
  function size(el: HTMLElement): { w: number; h: number } {
    let known = sizes.get(el)
    if (!known) { known = { w: el.offsetWidth, h: el.offsetHeight }; sizes.set(el, known) }
    return known
  }
  function put(el: HTMLElement, left: number, top: number): void {
    const l = `${Math.round(left)}px`, t = `${Math.round(top)}px`
    if (el.style.left !== l) el.style.left = l
    if (el.style.top !== t) el.style.top = t
  }
  const overlaps = (a: Box, b: Box): boolean => a.l < b.l + b.w && b.l < a.l + a.w && a.t < b.t + b.h && b.t < a.t + a.h

  // Neighbours at adjacent seats would print over each other, so each label that collides with an earlier
  // one steps away from its agent (tags down, bubbles up) until it is clear.
  function settle(items: Placed[], width: number, step: 1 | -1, obstacles: Box[]): void {
    const taken: Box[] = [...obstacles]
    for (const item of items) {
      const total = item.h + (item.follower ? item.follower.h + 1 : 0)
      const cx = Math.min(Math.max(item.cx, item.w / 2 + 1), Math.max(item.w / 2 + 1, width - item.w / 2 - 1))
      let top = item.up ? item.y - total : item.y
      const box = (): Box => ({ l: cx - Math.max(item.w, item.follower?.w ?? 0) / 2, t: top, w: Math.max(item.w, item.follower?.w ?? 0), h: total })
      for (let guard = 0; guard < 12 && taken.some((other) => overlaps(box(), other)); guard += 1) top += step * (total + 1)
      taken.push(box())
      put(item.el, cx, item.up ? top + total : top)
      if (item.follower) put(item.follower.el, cx, top + item.h + 1)
    }
  }

  return {
    update(sim, scene, renderer, opts) {
      const box = root.getBoundingClientRect(), s = renderer.scale(), seen = new Set<string>()
      const at = (x: number, y: number): { x: number; y: number } => { const p = renderer.tileToClient({ x, y }, sim); return { x: p.x - box.left, y: p.y - box.top } }
      const fixed: Box[] = []
      const label = (key: string, text: string | undefined, tile: { x: number; y: number }, maxTiles?: number): void => {
        if (!text) return
        const el = node(key, 'office-room-label'); seen.add(key)
        setText(el, text)
        const p = at(tile.x, tile.y)
        put(el, p.x + 2 * s, p.y + 2 * s)
        const max = maxTiles === undefined ? '' : `${Math.round(maxTiles * TILE * s - 4 * s)}px`
        if (el.style.maxWidth !== max) { el.style.maxWidth = max; sizes.delete(el) }
        const { w, h } = size(el)
        fixed.push({ l: p.x + 2 * s, t: p.y + 2 * s, w, h })
      }
      for (const [workspaceId, index] of sim.roomOf) {
        const room = scene.rooms.find((candidate) => candidate.workspaceId === workspaceId), layout = sim.layout.rooms[index]
        if (room && layout) label(`room:${workspaceId}`, `${room.name} · ${room.seated.length} in${room.waiting.length ? ` · ${room.waiting.length} waiting` : ''}`, { x: layout.rect.x, y: layout.label.y - 1 }, layout.rect.w - 1)
      }
      const n = scene.reviewCount
      label('review', n > 0 ? `${n} branch${n === 1 ? '' : 'es'} to review` : undefined, sim.layout.review.label)
      label('away', scene.agents.some((agent) => isAway(agent.state)) ? 'Away' : undefined, sim.layout.away.label)

      const tags: Placed[] = [], bubbles: Placed[] = []
      const actors = [...sim.actors.values()].sort((a, b) => { const pa = actorPixel(a), pb = actorPixel(b); return pa.y - pb.y || pa.x - pb.x || (a.id < b.id ? -1 : 1) })
      for (const actor of actors) {
        const agent = scene.agents.find((candidate) => candidate.providerId === actor.id)
        if (!agent) continue
        const pos = actorPixel(actor), foot = at(pos.x + 0.5, pos.y + 1), away = isAway(agent.state)
        const tag = node(`tag:${agent.providerId}`, 'office-tag'); seen.add(`tag:${agent.providerId}`)
        setText(tag, agent.name)
        tag.classList.toggle('is-away', away); tag.classList.toggle('is-near', opts.youAdjacent === agent.providerId)
        const placed: Placed = { el: tag, cx: foot.x, y: foot.y + GAP, ...size(tag), up: false }
        if (agent.badge) {
          const badge = node(`badge:${agent.providerId}`, 'office-badge'); seen.add(`badge:${agent.providerId}`)
          setText(badge, `${agent.badge.handle} · ${agent.badge.role}`)
          placed.follower = { el: badge, cx: foot.x, y: 0, ...size(badge), up: false }
        }
        tags.push(placed)
        const text = bubbleText(agent)
        if (text) {
          const bubble = node(`bubble:${agent.providerId}`, 'office-bubble'); seen.add(`bubble:${agent.providerId}`)
          setText(bubble, text); bubble.classList.toggle('is-away', away)
          const head = at(pos.x + 0.5, pos.y + ((actor.seated ? 7 : 3) - 8) / TILE)
          bubbles.push({ el: bubble, cx: head.x, y: head.y - GAP * 2, ...size(bubble), up: true })
        }
      }
      const you = sim.you, youPos = actorPixel(you), youFoot = at(youPos.x + 0.5, youPos.y + 1), youTag = node('tag:you', 'office-tag is-you'); seen.add('tag:you')
      setText(youTag, 'You'); tags.push({ el: youTag, cx: youFoot.x, y: youFoot.y + GAP, ...size(youTag), up: false })
      settle(tags, box.width, 1, fixed); settle(bubbles, box.width, -1, fixed)

      for (const [key, el] of nodes) if (!seen.has(key)) { el.remove(); nodes.delete(key) }
    },
    clear() { for (const el of nodes.values()) el.remove(); nodes.clear() },
    invalidateSizes() { sizes = new WeakMap() }
  }
}
