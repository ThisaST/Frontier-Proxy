// The Office map renderer: paints the tile grid, monitors, review papers and every actor onto one
// canvas at a device-pixel-integer scale (so pixel art stays crisp), and answers "what is under this pointer".
// Drawing is a no-op when there is no 2d context (tests run under happy-dom); hit-testing still works.
import { TILE, rectContains, roomAt, tileAt } from '../../../shared/office-grid'
import type { OfficeLayout, Point, Tile } from '../../../shared/office-grid'
import { agentAppearance, isAway, type OfficeScene } from '../../../shared/office-model'
import { actorPixel, actorTile, adjacentAgent, type Actor, type Sim } from '../../../shared/office-sim'
import { readPalette } from './palette'
import { avatarSprite, monitorSprite, papersSprite, tileSprite } from './sprites'

export type Hit = { kind: 'agent'; id: string } | { kind: 'room'; index: number } | { kind: 'review' }
export interface OfficeRenderer {
  resize(layout: OfficeLayout): void
  draw(sim: Sim, scene: OfficeScene, now: number): void
  hitTest(clientX: number, clientY: number, sim: Sim): Hit | undefined
  tileToClient(p: Point, sim?: Sim): { x: number; y: number }
  scale(): number
  dispose(): void
}

const FURNITURE: ReadonlySet<Tile> = new Set<Tile>(['desk', 'papers', 'chair', 'table', 'plant', 'couch', 'coffee'])
const YOU_LOOK = { skin: 0, hair: 1, shirt: 0 }
const effectsOn = (): boolean => document.documentElement.dataset.effects !== 'off'

export function createOfficeRenderer(canvas: HTMLCanvasElement, stage: HTMLElement): OfficeRenderer {
  let ctx: CanvasRenderingContext2D | null = null
  try { ctx = canvas.getContext('2d') } catch { ctx = null }
  let layout: OfficeLayout | undefined
  let scaleNow = 1
  let last: { sim: Sim; scene: OfficeScene; now: number } | undefined

  function fit(): void {
    if (!layout) return
    const w = layout.width * TILE, h = layout.height * TILE
    // Crisp means an integer scale in *device* pixels, not CSS pixels: on a 2× display a 1.5× CSS
    // scale is still 3 device pixels per art pixel. Rounding to CSS integers left most of the stage empty.
    // The floor is one device pixel per art pixel, so a small stage shows the whole map instead of clipping it.
    const dpr = window.devicePixelRatio || 1
    const fitScale = Math.min(stage.clientWidth / w, stage.clientHeight / h)
    scaleNow = Math.max(1 / dpr, Math.floor(fitScale * dpr) / dpr)
    canvas.style.width = `${w * scaleNow}px`; canvas.style.height = `${h * scaleNow}px`
    const pw = Math.round(w * scaleNow * dpr), ph = Math.round(h * scaleNow * dpr)
    if (canvas.width !== pw) canvas.width = pw
    if (canvas.height !== ph) canvas.height = ph
    ctx?.setTransform(scaleNow * dpr, 0, 0, scaleNow * dpr, 0, 0)
    if (ctx) ctx.imageSmoothingEnabled = false
  }

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { fit(); if (last) paint(last.sim, last.scene, last.now) }) : undefined
  observer?.observe(stage)

  function underlay(l: OfficeLayout, x: number, y: number): 'carpet' | 'floor' {
    const p = { x, y }
    return l.rooms.some((room) => rectContains(room.interior, p)) || rectContains(l.lounge.area, p) ? 'carpet' : 'floor'
  }

  function joins(l: OfficeLayout, x: number, y: number, family: ReadonlySet<Tile>): number {
    return (family.has(tileAt(l, { x: x - 1, y })) ? 1 : 0) | (family.has(tileAt(l, { x: x + 1, y })) ? 2 : 0)
  }

  function paintTiles(l: OfficeLayout): void {
    const p = readPalette(), c = ctx!
    const desks: ReadonlySet<Tile> = new Set<Tile>(['desk', 'papers']), tables: ReadonlySet<Tile> = new Set<Tile>(['table']), couches: ReadonlySet<Tile> = new Set<Tile>(['couch'])
    for (let y = 0; y < l.height; y += 1) for (let x = 0; x < l.width; x += 1) {
      const tile = tileAt(l, { x, y })
      if (tile === 'void') continue
      if (FURNITURE.has(tile)) { const under = tileSprite(underlay(l, x, y), (x + y) % 2, p); if (under) c.drawImage(under as CanvasImageSource, x * TILE, y * TILE) }
      let variant = (x + y) % 2
      if (tile === 'wall') { const above = tileAt(l, { x, y: y - 1 }), below = tileAt(l, { x, y: y + 1 }); variant = (above === 'wall' ? 1 : 0) | (below !== 'wall' && below !== 'void' ? 2 : 0) }
      else if (tile === 'desk' || tile === 'papers') variant = joins(l, x, y, desks)
      else if (tile === 'table') variant = joins(l, x, y, tables)
      else if (tile === 'couch') variant = joins(l, x, y, couches)
      else if (tile !== 'floor') variant = 0
      const sprite = tileSprite(tile === 'papers' ? 'desk' : tile, variant, p)
      if (sprite) c.drawImage(sprite as CanvasImageSource, x * TILE, y * TILE)
    }
  }

  function paintActor(actor: Actor, scene: OfficeScene, now: number, c: CanvasRenderingContext2D): void {
    const p = readPalette(), pos = actorPixel(actor), x = Math.round(pos.x * TILE), y = Math.round(pos.y * TILE)
    const agent = actor.kind === 'agent' ? scene.agents.find((candidate) => candidate.providerId === actor.id) : undefined
    if (actor.kind === 'agent' && !agent) return
    const moving = actor.t < 1 || actor.path.length > 0
    const frame = effectsOn() && moving ? (Math.floor(now / 140) % 2 as 0 | 1) : 0
    const look = agent ? agentAppearance(agent.providerId, agent.name) : YOU_LOOK
    if (actor.kind === 'you') { // a pixel ring on the floor so You is findable among the agents
      c.fillStyle = p.you
      c.fillRect(x + 3, y + 12, 10, 1); c.fillRect(x + 1, y + 13, 14, 2); c.fillRect(x + 3, y + 15, 10, 1)
    }
    const sprite = avatarSprite(look, actor.facing, frame, { seated: actor.seated, greyed: agent ? isAway(agent.state) : false, you: actor.kind === 'you' }, p)
    if (sprite) c.drawImage(sprite as CanvasImageSource, x, y + TILE - 24)
  }

  function paint(sim: Sim, scene: OfficeScene, now: number): void {
    last = { sim, scene, now }
    if (!ctx || !layout) return
    const c = ctx, l = layout, p = readPalette()
    c.clearRect(0, 0, l.width * TILE, l.height * TILE)
    paintTiles(l)
    const deskAgent = new Map<number, string>()
    for (const [id, index] of sim.deskOf) deskAgent.set(index, id)
    l.desks.forEach((desk, index) => {
      const id = deskAgent.get(index), agent = id === undefined ? undefined : scene.agents.find((candidate) => candidate.providerId === id)
      const sprite = monitorSprite(Boolean(agent?.work.some((item) => item.kind !== 'turn')), p)
      if (sprite) c.drawImage(sprite as CanvasImageSource, desk.monitor.x * TILE, desk.monitor.y * TILE)
    })
    const papers = papersSprite(Math.min(3, scene.reviewCount), p)
    if (papers) c.drawImage(papers as CanvasImageSource, l.review.papers.x * TILE, l.review.papers.y * TILE)
    const actors = [...sim.actors.values(), sim.you].sort((left, right) => actorPixel(left).y - actorPixel(right).y || (left.kind === 'you' ? 1 : 0) - (right.kind === 'you' ? 1 : 0))
    for (const actor of actors) paintActor(actor, scene, now, c)
    if (document.activeElement === canvas) {
      const adjacent = adjacentAgent(sim), actor = adjacent === undefined ? undefined : sim.actors.get(adjacent)
      if (actor) {
        const pos = actorPixel(actor), top = actor.seated ? 7 : 3
        c.fillStyle = p.focus
        const x = Math.round(pos.x * TILE) + 2, y = Math.round(pos.y * TILE) + TILE - 24 + top - 1, w = 12, h = 24 - top + 1
        c.fillRect(x, y, w, 1); c.fillRect(x, y + h - 1, w, 1); c.fillRect(x, y, 1, h); c.fillRect(x + w - 1, y, 1, h)
      }
    }
  }

  return {
    resize(next) { layout = next; fit(); if (last) paint(last.sim, last.scene, last.now) },
    draw: paint,
    hitTest(clientX, clientY, sim) {
      if (!layout) return undefined
      const box = canvas.getBoundingClientRect(), size = TILE * scaleNow
      const tile = { x: Math.floor((clientX - box.left) / size), y: Math.floor((clientY - box.top) / size) }
      if (tile.x < 0 || tile.y < 0 || tile.x >= layout.width || tile.y >= layout.height) return undefined
      const agents = [...sim.actors.values()]
      const body = agents.find((actor) => { const at = actorTile(actor); return at.x === tile.x && at.y === tile.y })
      const head = body ?? agents.find((actor) => { const at = actorTile(actor); return at.x === tile.x && at.y === tile.y + 1 })
      if (head) return { kind: 'agent', id: head.id }
      const room = roomAt(layout, tile)
      if (room !== undefined) return { kind: 'room', index: room }
      const { desk, papers, stand } = layout.review
      if ([desk, papers, stand].some((spot) => spot.x === tile.x && spot.y === tile.y)) return { kind: 'review' }
      return undefined
    },
    tileToClient(point) { const box = canvas.getBoundingClientRect(); return { x: box.left + point.x * TILE * scaleNow, y: box.top + point.y * TILE * scaleNow } },
    scale: () => scaleNow,
    dispose() { observer?.disconnect(); last = undefined }
  }
}
