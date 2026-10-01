// The office's actors: where each agent (and You) stands, how they walk there, and when they wander.
// Pure and DOM-free (compiled under tsconfig.node.json): time is always a `now`/`dtMs` parameter and
// randomness is a seeded mulberry32, so a fixed seed replays identically. Unit-tested in tests/office-sim.test.ts.
import { isAway } from './office-model'
import type { OfficeAgent, OfficeScene } from './office-model'
import { ROOM_COUNT, ROOM_SEATS, assignStable, findPath, roomAt, walkable } from './office-grid'
import type { Facing, OfficeLayout, Point, Seat } from './office-grid'

export type Zone = 'desk' | 'room' | 'wait' | 'lounge' | 'away' | 'none'
// `face` (not in the original sketch) is the facing to take on arrival at a seat; undefined for a wander stop.
export interface Actor { id: string; kind: 'agent' | 'you'; from: Point; to: Point; t: number; path: Point[]; facing: Facing; seated: boolean; stepAt: number; key: string; zone: Zone; face?: Facing }
export interface Sim {
  layout: OfficeLayout; actors: Map<string, Actor>; you: Actor
  deskOf: Map<string, number>; loungeOf: Map<string, number>; awayOf: Map<string, number>
  roomOf: Map<string, number>                 // workspaceId -> room index, stable while the workspace stays active
  roomSeatOf: Map<string, number>             // `${workspaceId}:${providerId}` -> seat index
  waitOf: Map<string, number>                 // `${workspaceId}:${providerId}` -> waitSpot index
  rng: number
  nextWanderAt: Map<string, number>
  youRoom?: number
}
export type SimEvent = { kind: 'arrived'; id: string } | { kind: 'entered-room'; room: number } | { kind: 'left-room'; room: number }

export const TILE_MS = 140

export function nextRandom(sim: Sim): number {
  sim.rng = (sim.rng + 0x6d2b79f5) >>> 0
  let t = sim.rng
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

function newActor(id: string, kind: 'agent' | 'you', at: Seat, now: number): Actor {
  return { id, kind, from: { x: at.x, y: at.y }, to: { x: at.x, y: at.y }, t: 1, path: [], facing: at.facing, seated: false, stepAt: now, key: '', zone: 'none' }
}

export function createSim(layout: OfficeLayout, seed: number): Sim {
  return {
    layout, actors: new Map(), you: newActor('you', 'you', layout.entrance, 0),
    deskOf: new Map(), loungeOf: new Map(), awayOf: new Map(), roomOf: new Map(), roomSeatOf: new Map(), waitOf: new Map(),
    rng: seed >>> 0, nextWanderAt: new Map(),
  }
}

export function actorTile(a: Actor): Point { return a.t >= 1 ? a.to : a.from }
export function actorPixel(a: Actor): { x: number; y: number } {
  const t = Math.min(1, Math.max(0, a.t))
  return { x: a.from.x + (a.to.x - a.from.x) * t, y: a.from.y + (a.to.y - a.from.y) * t }
}

function replace<K, V>(m: Map<K, V>, next: ReadonlyMap<K, V>): void { m.clear(); for (const [k, v] of next) m.set(k, v) }
const wkey = (ws: string, pid: string): string => `${ws}:${pid}`

// A target that is fixed by the agent's state; undefined means "a lounge seat" (idle, or nowhere better to go).
function primaryTarget(sim: Sim, agent: OfficeAgent): { zone: Zone; seat: Seat; slot: number } | undefined {
  const { layout } = sim, id = agent.providerId, ws = agent.primary?.workspaceId
  if (isAway(agent.state)) { const s = sim.awayOf.get(id); return s === undefined ? undefined : { zone: 'away', seat: layout.away.seats[s]!, slot: s } }
  const room = ws === undefined ? undefined : sim.roomOf.get(ws), key = ws === undefined ? '' : wkey(ws, id)
  const turn = agent.primary?.kind === 'turn' && room !== undefined
  if (agent.state === 'meeting' && turn) {
    const s = sim.roomSeatOf.get(key)
    if (s !== undefined) return { zone: 'room', seat: layout.rooms[room!]!.seats[s]!, slot: room! * ROOM_SEATS + s }
  }
  if ((agent.state === 'meeting' || agent.state === 'waiting') && turn) {
    const s = sim.waitOf.get(key), spots = layout.rooms[room!]!.waitSpots
    return s === undefined ? undefined : { zone: 'wait', seat: spots[s]!, slot: room! * spots.length + s }
  }
  // working, waiting, or a meeting whose workspace has no room (a 4th active one): at its own desk.
  if (agent.state === 'working' || agent.state === 'waiting' || agent.state === 'meeting') { const s = sim.deskOf.get(id); return s === undefined ? undefined : { zone: 'desk', seat: layout.desks[s]!.seat, slot: s } }
  return undefined
}

export function targetFor(sim: Sim, agent: OfficeAgent): { zone: Zone; seat: Seat; slot: number } | undefined {
  const p = primaryTarget(sim, agent)
  if (p) return p
  const s = sim.loungeOf.get(agent.providerId)
  return s === undefined ? undefined : { zone: 'lounge', seat: sim.layout.lounge.seats[s]!, slot: s }
}

export function reconcile(sim: Sim, scene: OfficeScene, opts: { snap: boolean; now: number }): void {
  const { layout } = sim, ids = scene.agents.map((a) => a.providerId), present = new Set(ids)
  for (const id of [...sim.actors.keys()]) if (!present.has(id)) { sim.actors.delete(id); sim.nextWanderAt.delete(id) }

  replace(sim.roomOf, assignStable(scene.rooms.map((r) => r.workspaceId), ROOM_COUNT, sim.roomOf))
  const seatOf = new Map<string, number>(), waitOf = new Map<string, number>()
  for (const room of scene.rooms) {
    const ri = sim.roomOf.get(room.workspaceId)
    if (ri === undefined) continue
    const seated = room.seated.filter((p) => present.has(p)).map((p) => wkey(room.workspaceId, p))
    const seats = assignStable(seated, layout.rooms[ri]!.seats.length, sim.roomSeatOf)
    for (const [k, v] of seats) seatOf.set(k, v)
    const queue = [...seated.filter((k) => !seats.has(k)), ...room.waiting.filter((p) => present.has(p) && !room.seated.includes(p)).map((p) => wkey(room.workspaceId, p))]
    for (const [k, v] of assignStable(queue, layout.rooms[ri]!.waitSpots.length, sim.waitOf)) waitOf.set(k, v)
  }
  replace(sim.roomSeatOf, seatOf); replace(sim.waitOf, waitOf)
  replace(sim.deskOf, assignStable(ids, layout.desks.length, sim.deskOf))
  replace(sim.awayOf, assignStable(scene.agents.filter((a) => isAway(a.state)).map((a) => a.providerId), layout.away.seats.length, sim.awayOf))
  replace(sim.loungeOf, assignStable(scene.agents.filter((a) => !primaryTarget(sim, a)).map((a) => a.providerId), layout.lounge.seats.length, sim.loungeOf))

  for (const agent of scene.agents) {
    let actor = sim.actors.get(agent.providerId)
    if (!actor) { actor = newActor(agent.providerId, 'agent', layout.entrance, opts.now); sim.actors.set(agent.providerId, actor) }
    const tg = targetFor(sim, agent)
    const key = `${agent.state}|${tg ? tg.zone : 'none'}|${tg ? tg.slot : -1}`
    if (key === actor.key) continue
    actor.key = key; actor.zone = tg ? tg.zone : 'none'
    sim.nextWanderAt.delete(actor.id)
    if (!tg) { actor.seated = false; continue }
    const path = opts.snap ? undefined : findPath(layout, actor.to, tg.seat)
    actor.face = tg.seat.facing
    if (!path) { actor.from = { x: tg.seat.x, y: tg.seat.y }; actor.to = { ...actor.from }; actor.t = 1; actor.path = []; actor.facing = tg.seat.facing; actor.seated = true; continue }
    actor.path = path
    if (path.length === 0 && actor.t >= 1) { actor.facing = tg.seat.facing; actor.seated = true } else actor.seated = false
  }
}

function faceDelta(a: Actor, p: Point): void {
  const dx = p.x - a.to.x, dy = p.y - a.to.y
  if (dx !== 0) a.facing = dx > 0 ? 'right' : 'left'
  else if (dy !== 0) a.facing = dy > 0 ? 'down' : 'up'
}

// Advance one walker by `dtMs`; true when it finished walking during this call.
function step(a: Actor, dtMs: number, motion: boolean, now: number): boolean {
  if (a.path.length === 0 && a.t >= 1) return false
  if (!motion) {
    const end = a.path.length ? a.path[a.path.length - 1]! : a.to
    if (end !== a.to) faceDelta(a, end)
    a.from = { ...end }; a.to = { ...end }; a.t = 1; a.path = []
  } else {
    let budget = dtMs / TILE_MS
    for (;;) {
      if (a.t >= 1) {
        if (a.path.length === 0 || budget <= 0) break
        const next = a.path.shift()!
        faceDelta(a, next); a.from = a.to; a.to = next; a.t = 0; a.stepAt = now
      }
      const need = 1 - a.t
      if (budget >= need) { a.t = 1; budget -= need } else { a.t += budget; budget = 0; break }
    }
    if (a.path.length > 0 || a.t < 1) return false
  }
  if (a.face) a.facing = a.face
  a.seated = a.face !== undefined && a.zone !== 'none'
  return true
}

function wander(sim: Sim, a: Actor, now: number): void {
  const at = sim.nextWanderAt.get(a.id), schedule = (): void => { sim.nextWanderAt.set(a.id, now + 6000 + nextRandom(sim) * 8000) }
  if (at === undefined) { schedule(); return }
  if (now < at) return
  const { layout } = sim, slot = sim.loungeOf.get(a.id)
  const seat = slot === undefined ? undefined : layout.lounge.seats[slot]
  if (!seat) return
  schedule()
  if (!a.seated) { // out wandering: head home
    const path = findPath(layout, a.to, seat)
    if (path) { a.path = path; a.face = seat.facing }
    return
  }
  const w = layout.lounge.wander, spots: Point[] = []
  for (let y = w.y; y < w.y + w.h; y++) for (let x = w.x; x < w.x + w.w; x++) if (walkable(layout, { x, y }) && (x !== a.to.x || y !== a.to.y)) spots.push({ x, y })
  const spot = spots[Math.floor(nextRandom(sim) * spots.length)]
  const path = spot && findPath(layout, a.to, spot)
  if (path && path.length) { a.path = path; a.face = undefined; a.seated = false }
}

export function advance(sim: Sim, dtMs: number, opts: { motion: boolean; now: number }): SimEvent[] {
  const events: SimEvent[] = []
  for (const a of sim.actors.values()) {
    if (step(a, dtMs, opts.motion, opts.now)) events.push({ kind: 'arrived', id: a.id })
    if (opts.motion && a.zone === 'lounge' && a.path.length === 0 && a.t >= 1) wander(sim, a, opts.now)
  }
  step(sim.you, dtMs, opts.motion, opts.now)
  const room = roomAt(sim.layout, actorTile(sim.you))
  if (room !== sim.youRoom) {
    if (sim.youRoom !== undefined) events.push({ kind: 'left-room', room: sim.youRoom })
    if (room !== undefined) events.push({ kind: 'entered-room', room })
    sim.youRoom = room
  }
  return events
}

const DELTA: Record<Facing, Point> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }

export function moveYou(sim: Sim, dir: Facing): boolean {
  const y = sim.you
  if (y.t < 1) return false
  const next = { x: y.to.x + DELTA[dir].x, y: y.to.y + DELTA[dir].y }
  y.facing = dir
  if (!walkable(sim.layout, next)) return false
  y.from = y.to; y.to = next; y.t = 0
  return true
}

export function adjacentAgent(sim: Sim): string | undefined {
  const me = actorTile(sim.you)
  let best: string | undefined, bestD = 2
  for (const a of sim.actors.values()) {
    const p = actorTile(a), d = Math.abs(p.x - me.x) + Math.abs(p.y - me.y)
    if (d < bestD) { best = a.id; bestD = d }
  }
  return best
}

export function youRoom(sim: Sim): number | undefined { return roomAt(sim.layout, actorTile(sim.you)) }
