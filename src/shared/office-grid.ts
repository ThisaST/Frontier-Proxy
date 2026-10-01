// The office floor plan: a top-down tile grid (Gather.town style) generated from a desk count, plus the
// pure helpers the sim needs (walkability, BFS paths, stable slot assignment). Pure and DOM-free
// (compiled under tsconfig.node.json). Unit-tested in tests/office-grid.test.ts.
export type Tile = 'void' | 'wall' | 'floor' | 'carpet' | 'desk' | 'monitor' | 'chair' | 'table' | 'plant' | 'couch' | 'coffee' | 'papers' | 'door'
export type Facing = 'up' | 'down' | 'left' | 'right'
export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface Seat extends Point { facing: Facing }
// `monitor` equals `desk`: the tile is a `desk` and the renderer draws the monitor on it.
export interface DeskLayout { seat: Seat; monitor: Point; desk: Point }
export interface RoomLayout { rect: Rect; interior: Rect; seats: Seat[]; door: Point; waitSpots: Seat[]; label: Point }
export interface OfficeLayout {
  width: number; height: number; tiles: Tile[]
  desks: DeskLayout[]
  rooms: RoomLayout[]
  lounge: { area: Rect; seats: Seat[]; wander: Rect }
  away: { area: Rect; seats: Seat[]; label: Point }
  review: { desk: Point; papers: Point; stand: Seat; label: Point }
  entrance: Seat
}

export const TILE = 16
export const ROOM_COUNT = 3
export const ROOM_SEATS = 4
export const MIN_DESKS = 4

const WALKABLE: ReadonlySet<Tile> = new Set<Tile>(['floor', 'carpet', 'chair', 'door', 'couch'])
const ROOM_W = 8 // rect width incl. walls; neighbours share one wall column
const BAND_H = 7 // top band height incl. the bottom wall row
const HEIGHT = 18

export function pointKey(p: Point): string { return `${p.x},${p.y}` }
export function rectContains(r: Rect, p: Point): boolean { return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h }
export function tileAt(layout: OfficeLayout, p: Point): Tile { return p.x < 0 || p.y < 0 || p.x >= layout.width || p.y >= layout.height ? 'void' : layout.tiles[p.y * layout.width + p.x] }
export function walkable(layout: OfficeLayout, p: Point): boolean { return WALKABLE.has(tileAt(layout, p)) }
export function roomAt(layout: OfficeLayout, p: Point): number | undefined { const i = layout.rooms.findIndex((r) => rectContains(r.interior, p)); return i < 0 ? undefined : i }

export function buildOfficeLayout(deskCount: number): OfficeLayout {
  const D = Math.max(MIN_DESKS, Math.floor(deskCount) || 0)
  const W = 2 * D + 16, H = HEIGHT, n = Math.max(4, D)
  const tiles: Tile[] = new Array<Tile>(W * H).fill('void')
  const set = (x: number, y: number, t: Tile): void => { tiles[y * W + x] = t }
  for (let y = BAND_H - 1; y < H; y++) for (let x = 0; x < W; x++) set(x, y, y === BAND_H - 1 || y === H - 1 || x === 0 || x === W - 1 ? 'wall' : 'floor')

  // meeting rooms: top band, centred, sharing walls; table in the middle with four chairs round it
  const ox = Math.floor((W - (ROOM_COUNT * (ROOM_W - 1) + 1)) / 2)
  const rooms: RoomLayout[] = []
  for (let i = 0; i < ROOM_COUNT; i++) {
    const rx = ox + i * (ROOM_W - 1)
    for (let y = 0; y < BAND_H; y++) for (let x = rx; x < rx + ROOM_W; x++) set(x, y, x === rx || x === rx + ROOM_W - 1 || y === 0 || y === BAND_H - 1 ? 'wall' : 'carpet')
    const ty = 3
    set(rx + 3, ty, 'table'); set(rx + 4, ty, 'table'); set(rx + ROOM_W - 2, 1, 'plant')
    const seats: Seat[] = [{ x: rx + 3, y: ty - 1, facing: 'down' }, { x: rx + 4, y: ty - 1, facing: 'down' }, { x: rx + 3, y: ty + 1, facing: 'up' }, { x: rx + 4, y: ty + 1, facing: 'up' }]
    for (const s of seats) set(s.x, s.y, 'chair')
    const door = { x: rx + 2, y: BAND_H - 1 }
    set(door.x, door.y, 'door')
    rooms.push({ rect: { x: rx, y: 0, w: ROOM_W, h: BAND_H }, interior: { x: rx + 1, y: 1, w: ROOM_W - 2, h: BAND_H - 2 }, seats, door, waitSpots: [{ x: rx + 1, y: BAND_H, facing: 'up' }, { x: rx + 3, y: BAND_H, facing: 'up' }], label: { x: rx + 1, y: 1 } })
  }

  // desk row: a desk (monitor on it) with a chair directly below, two tiles apart
  const dx0 = Math.floor((W - (2 * D - 1)) / 2)
  const desks: DeskLayout[] = []
  for (let i = 0; i < D; i++) {
    const desk = { x: dx0 + 2 * i, y: 10 }
    set(desk.x, desk.y, 'desk'); set(desk.x, desk.y + 1, 'chair')
    desks.push({ desk, monitor: { ...desk }, seat: { x: desk.x, y: desk.y + 1, facing: 'up' } })
  }

  // lower zone: lounge left, entrance + review desk in the middle, away right
  const lw = (W - 8) / 2, ly = 13, lh = 4
  const lx = 1, ax = W - 1 - lw
  const rect = (x: number): Rect => ({ x, y: ly, w: lw, h: lh })
  for (let y = ly; y < ly + lh; y++) for (let x = lx; x < lx + lw; x++) set(x, y, 'carpet')
  const couch: Seat[] = [{ x: lx + 1, y: ly + 1, facing: 'down' }, { x: lx + 2, y: ly + 1, facing: 'down' }]
  for (const c of couch) set(c.x, c.y, 'couch')
  set(lx, ly, 'plant'); set(lx + lw - 1, ly, 'plant'); set(lx, ly + lh - 1, 'plant')
  const carpetSeats: Seat[] = []
  for (const y of [ly + 3, ly + 2]) for (let x = lx + 1; x < lx + lw; x++) carpetSeats.push({ x, y, facing: 'down' })
  const loungeSeats = [...couch, ...carpetSeats].slice(0, n)

  set(W - 2, ly, 'coffee')
  const awaySeats: Seat[] = []
  for (let x = ax + 1; x < ax + lw && awaySeats.length < n; x++) awaySeats.push({ x, y: ly + 2, facing: 'down' })

  const ex = lw + 3
  const entrance: Seat = { x: ex, y: H - 2, facing: 'up' }
  set(ex, H - 1, 'door')
  const rdesk = { x: ex + 2, y: H - 3 }, papers = { x: ex + 3, y: H - 3 }
  set(rdesk.x, rdesk.y, 'desk'); set(papers.x, papers.y, 'papers')

  return {
    width: W, height: H, tiles, desks, rooms,
    lounge: { area: rect(lx), seats: loungeSeats, wander: rect(lx) },
    away: { area: rect(ax), seats: awaySeats, label: { x: ax, y: ly } },
    review: { desk: rdesk, papers, stand: { x: rdesk.x, y: rdesk.y + 1, facing: 'up' }, label: { x: rdesk.x, y: rdesk.y - 1 } },
    entrance,
  }
}

const DIRS: readonly Point[] = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }]

// 4-neighbour BFS. Excludes `from`, includes `to`; [] when equal; undefined when `to` is not walkable or unreachable.
export function findPath(layout: OfficeLayout, from: Point, to: Point): Point[] | undefined {
  if (!walkable(layout, to)) return undefined
  if (from.x === to.x && from.y === to.y) return []
  const W = layout.width, start = from.y * W + from.x, goal = to.y * W + to.x
  if (from.x < 0 || from.y < 0 || from.x >= W || from.y >= layout.height) return undefined
  const prev = new Map<number, number>([[start, -1]])
  const queue = [start]
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!
    if (cur === goal) break
    const cx = cur % W, cy = (cur - cx) / W
    for (const d of DIRS) {
      const p = { x: cx + d.x, y: cy + d.y }
      if (!walkable(layout, p)) continue
      const k = p.y * W + p.x
      if (prev.has(k)) continue
      prev.set(k, cur); queue.push(k)
    }
  }
  if (!prev.has(goal)) return undefined
  const path: Point[] = []
  for (let k = goal; k !== start; k = prev.get(k)!) path.push({ x: k % W, y: Math.floor(k / W) })
  return path.reverse()
}

// Slot assignment that does not shuffle: an id keeps its previous slot while it is still present and not
// already taken by an earlier id; everyone else gets the lowest free slot. Ids beyond `slotCount` get none.
export function assignStable<T>(ids: readonly T[], slotCount: number, previous: ReadonlyMap<T, number>): Map<T, number> {
  const out = new Map<T, number>(), taken = new Set<number>()
  for (const id of ids) { const s = previous.get(id); if (s !== undefined && s >= 0 && s < slotCount && !taken.has(s) && !out.has(id)) { out.set(id, s); taken.add(s) } }
  let free = 0
  for (const id of ids) {
    if (out.has(id)) continue
    while (free < slotCount && taken.has(free)) free++
    if (free >= slotCount) break
    out.set(id, free); taken.add(free)
  }
  return out
}
