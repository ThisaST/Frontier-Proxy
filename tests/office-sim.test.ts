import { describe, expect, it } from 'vitest'
import { ROOM_SEATS, buildOfficeLayout, rectContains, walkable } from '../src/shared/office-grid'
import type { Point } from '../src/shared/office-grid'
import type { OfficeAgent, OfficeAgentState, OfficeRoom, OfficeScene, OfficeWork } from '../src/shared/office-model'
import { TILE_MS, actorPixel, actorTile, adjacentAgent, advance, createSim, moveYou, reconcile, targetFor, youRoom } from '../src/shared/office-sim'
import type { Sim } from '../src/shared/office-sim'

const work = (o: Partial<OfficeWork> = {}): OfficeWork => ({ kind: 'task', status: 'running', cwd: '/r', inScope: true, title: 't', ...o })
const agent = (providerId: string, state: OfficeAgentState, primary?: OfficeWork): OfficeAgent => ({ providerId, name: providerId, state, work: primary ? [primary] : [], primary, running: 0, maxConcurrent: 1 })
const room = (workspaceId: string, seated: string[] = [], waiting: string[] = []): OfficeRoom => ({ workspaceId, name: workspaceId, cwd: '/r', seated, waiting })
const scene = (agents: OfficeAgent[], rooms: OfficeRoom[] = []): OfficeScene => ({ agents, rooms, reviewCount: 0, summary: '' })
const fresh = (n = 4, seed = 1): Sim => createSim(buildOfficeLayout(n), seed)
const at = (p: Point, q: Point): boolean => p.x === q.x && p.y === q.y

describe('reconcile', () => {
  it('sends a working agent to its desk with a path, or places it at once on snap', () => {
    const sim = fresh()
    reconcile(sim, scene([agent('a', 'working', work())]), { snap: false, now: 0 })
    const a = sim.actors.get('a')!, seat = sim.layout.desks[0]!.seat
    expect(a.zone).toBe('desk')
    expect(a.path.length).toBeGreaterThan(0)
    expect(at(a.path[a.path.length - 1]!, seat)).toBe(true)
    expect(a.seated).toBe(false)
    const snapped = fresh()
    reconcile(snapped, scene([agent('a', 'working', work())]), { snap: true, now: 0 })
    const b = snapped.actors.get('a')!
    expect(b.path).toEqual([]); expect(b.t).toBe(1); expect(at(actorTile(b), seat)).toBe(true); expect(b.seated).toBe(true); expect(b.facing).toBe('up')
  })

  it('walks a meeting agent into its room, a waiting turn to a wait spot, away to the away area, idle to the lounge', () => {
    const sim = fresh()
    const turn = (ws: string) => work({ kind: 'turn', workspaceId: ws })
    const agents = [
      agent('m', 'meeting', turn('w1')), agent('w', 'waiting', turn('w1')), agent('x', 'cooldown'), agent('i', 'idle'),
    ]
    reconcile(sim, scene(agents, [room('w1', ['m'], ['w'])]), { snap: true, now: 0 })
    const l = sim.layout
    expect(roomIdx(sim, 'm')).toBe(0)
    expect(sim.actors.get('m')!.zone).toBe('room')
    expect(rectContains(l.rooms[0]!.interior, actorTile(sim.actors.get('m')!))).toBe(true)
    expect(sim.actors.get('w')!.zone).toBe('wait')
    expect(l.rooms[0]!.waitSpots.some((s) => at(s, actorTile(sim.actors.get('w')!)))).toBe(true)
    expect(sim.actors.get('x')!.zone).toBe('away')
    expect(l.away.seats.some((s) => at(s, actorTile(sim.actors.get('x')!)))).toBe(true)
    expect(sim.actors.get('i')!.zone).toBe('lounge')
    expect(l.lounge.seats.some((s) => at(s, actorTile(sim.actors.get('i')!)))).toBe(true)
  })

  it('sends a waiting agent with non-turn work to its desk, and the overflow of a full room to a wait spot', () => {
    const sim = fresh(8)
    const turn = work({ kind: 'turn', workspaceId: 'w1' })
    const ids = ['a', 'b', 'c', 'd', 'e']
    reconcile(sim, scene([agent('q', 'waiting', work({ status: 'queued' })), ...ids.map((i) => agent(i, 'meeting', turn))], [room('w1', ids)]), { snap: true, now: 0 })
    expect(sim.actors.get('q')!.zone).toBe('desk')
    expect(ids.filter((i) => sim.actors.get(i)!.zone === 'room')).toHaveLength(ROOM_SEATS)
    expect(sim.actors.get('e')!.zone).toBe('wait')
  })

  it('keeps desks and rooms stable as the scene changes', () => {
    const sim = fresh()
    const w = (id: string) => agent(id, 'working', work())
    reconcile(sim, scene([w('a'), w('b'), w('c')]), { snap: true, now: 0 })
    expect([sim.deskOf.get('a'), sim.deskOf.get('b'), sim.deskOf.get('c')]).toEqual([0, 1, 2])
    reconcile(sim, scene([w('b'), w('c')]), { snap: true, now: 0 })
    expect(sim.actors.has('a')).toBe(false)
    expect([sim.deskOf.get('b'), sim.deskOf.get('c')]).toEqual([1, 2])
    reconcile(sim, scene([], [room('w1'), room('w2')]), { snap: true, now: 0 })
    reconcile(sim, scene([], [room('w2')]), { snap: true, now: 0 })
    expect(sim.roomOf.get('w2')).toBe(1)
  })

  it('keeps the path by reference when nothing changed, and re-paths when the state does', () => {
    const sim = fresh()
    const sc = scene([agent('a', 'working', work())])
    reconcile(sim, sc, { snap: false, now: 0 })
    const path = sim.actors.get('a')!.path
    reconcile(sim, sc, { snap: false, now: 10 })
    expect(sim.actors.get('a')!.path).toBe(path)
    reconcile(sim, scene([agent('a', 'idle')]), { snap: false, now: 20 })
    expect(sim.actors.get('a')!.path).not.toBe(path)
    expect(sim.actors.get('a')!.zone).toBe('lounge')
  })

  it('seats a fourth workspace\'s meeting agent at its own desk rather than a room or the lounge', () => {
    const sim = fresh()
    const turn = work({ kind: 'turn', workspaceId: 'w4' })
    reconcile(sim, scene([agent('a', 'meeting', turn)], [room('w1'), room('w2'), room('w3'), room('w4', ['a'])]), { snap: true, now: 0 })
    expect(sim.roomOf.has('w4')).toBe(false)
    expect(sim.actors.get('a')!.zone).toBe('desk')
  })

  it('spawns new agents at the entrance when not snapping', () => {
    const sim = fresh()
    reconcile(sim, scene([agent('a', 'working', work())]), { snap: false, now: 0 })
    expect(at(actorTile(sim.actors.get('a')!), sim.layout.entrance)).toBe(true)
  })

  it('targetFor reports the seat for the state', () => {
    const sim = fresh()
    const a = agent('a', 'working', work())
    reconcile(sim, scene([a]), { snap: true, now: 0 })
    expect(targetFor(sim, a)).toMatchObject({ zone: 'desk', slot: 0, seat: sim.layout.desks[0]!.seat })
  })
})

const roomIdx = (sim: Sim, id: string): number | undefined => { for (const [k, v] of sim.roomSeatOf) if (k.endsWith(`:${id}`)) return sim.roomOf.get(k.slice(0, k.length - id.length - 1)); return undefined }

describe('advance', () => {
  it('moves one tile per TILE_MS and emits arrived once the path is done', () => {
    const sim = fresh()
    reconcile(sim, scene([agent('a', 'working', work())]), { snap: false, now: 0 })
    const a = sim.actors.get('a')!, total = a.path.length
    expect(total).toBeGreaterThan(2)
    advance(sim, TILE_MS, { motion: true, now: 0 })
    expect(a.path).toHaveLength(total - 1)
    expect(at(actorTile(a), sim.layout.entrance)).toBe(false)
    const mid = actorPixel(a)
    advance(sim, TILE_MS / 2, { motion: true, now: 0 })
    const later = actorPixel(a)
    expect(Math.abs(later.x - mid.x) + Math.abs(later.y - mid.y)).toBeGreaterThan(0)
    const events = []
    for (let i = 0; i < total + 2; i++) events.push(...advance(sim, TILE_MS, { motion: true, now: 0 }))
    expect(events.filter((e) => e.kind === 'arrived' && e.id === 'a')).toHaveLength(1)
    expect(at(actorTile(a), sim.layout.desks[0]!.seat)).toBe(true)
    expect(a.seated).toBe(true); expect(a.facing).toBe('up')
  })

  it('snaps to the end and never wanders when motion is off', () => {
    const sim = fresh()
    reconcile(sim, scene([agent('a', 'working', work()), agent('i', 'idle')]), { snap: false, now: 0 })
    const events = advance(sim, 1, { motion: false, now: 0 })
    expect(events.filter((e) => e.kind === 'arrived').map((e) => (e as { id: string }).id).sort()).toEqual(['a', 'i'])
    expect(at(actorTile(sim.actors.get('a')!), sim.layout.desks[0]!.seat)).toBe(true)
    const home = { ...actorTile(sim.actors.get('i')!) }
    advance(sim, 1, { motion: false, now: 100000 })
    advance(sim, 1, { motion: false, now: 200000 })
    expect(sim.actors.get('i')!.path).toEqual([]); expect(actorTile(sim.actors.get('i')!)).toEqual(home)
    expect(sim.nextWanderAt.size).toBe(0)
  })

  it('wanders reproducibly from a fixed seed, inside the lounge, then returns to its seat', () => {
    const trace = (seed: number): Point[] => {
      const sim = fresh(4, seed)
      reconcile(sim, scene([agent('i', 'idle')]), { snap: true, now: 0 })
      const seat = actorTile(sim.actors.get('i')!), seen: Point[] = []
      for (let now = 0; now < 60000; now += TILE_MS) {
        advance(sim, TILE_MS, { motion: true, now })
        const p = actorTile(sim.actors.get('i')!)
        expect(walkable(sim.layout, p)).toBe(true)
        expect(rectContains(sim.layout.lounge.wander, p)).toBe(true)
        seen.push({ ...p })
      }
      const out = seen.findIndex((p) => !at(p, seat))
      expect(out).toBeGreaterThan(-1)
      expect(seen.slice(out).some((p) => at(p, seat))).toBe(true)
      return seen
    }
    expect(trace(7)).toEqual(trace(7))
    const sim = fresh(4, 3)
    reconcile(sim, scene([agent('i', 'idle')]), { snap: true, now: 0 })
    advance(sim, TILE_MS, { motion: true, now: 0 })
    const first = sim.nextWanderAt.get('i')!
    expect(first).toBeGreaterThanOrEqual(6000); expect(first).toBeLessThan(14000)
    advance(sim, TILE_MS, { motion: true, now: first - 1 })
    expect(sim.actors.get('i')!.path).toEqual([])
    advance(sim, TILE_MS, { motion: true, now: first })
    expect(sim.actors.get('i')!.path.length).toBeGreaterThan(0)
  })
})

describe('You', () => {
  it('starts at the entrance; moving into a wall returns false and stays put', () => {
    const sim = fresh()
    expect(at(actorTile(sim.you), sim.layout.entrance)).toBe(true)
    sim.you.from = { x: 1, y: 8 }; sim.you.to = { x: 1, y: 8 }
    expect(moveYou(sim, 'left')).toBe(false)
    expect(sim.you.facing).toBe('left')
    expect(actorTile(sim.you)).toEqual({ x: 1, y: 8 })
    expect(moveYou(sim, 'right')).toBe(true)
    expect(moveYou(sim, 'right')).toBe(false) // mid-step
    advance(sim, TILE_MS, { motion: true, now: 0 })
    expect(actorTile(sim.you)).toEqual({ x: 2, y: 8 })
  })

  it('snaps a step when motion is off', () => {
    const sim = fresh()
    moveYou(sim, 'up')
    advance(sim, 1, { motion: false, now: 0 })
    expect(actorTile(sim.you).y).toBe(sim.layout.entrance.y - 1)
    expect(moveYou(sim, 'up')).toBe(true)
  })

  it('finds the nearest adjacent agent, ignoring distant ones', () => {
    const sim = fresh()
    reconcile(sim, scene([agent('far', 'working', work()), agent('near', 'idle')]), { snap: true, now: 0 })
    expect(adjacentAgent(sim)).toBeUndefined()
    const t = actorTile(sim.actors.get('near')!)
    sim.you.from = { x: t.x, y: t.y - 1 }; sim.you.to = { x: t.x, y: t.y - 1 }; sim.you.t = 1
    expect(adjacentAgent(sim)).toBe('near')
    sim.you.to = { ...t }; sim.you.from = { ...t }
    expect(adjacentAgent(sim)).toBe('near')
  })

  it('fires entered-room then left-room exactly once each walking through a door', () => {
    const sim = fresh()
    const door = sim.layout.rooms[0]!.door
    sim.you.from = { x: door.x, y: door.y + 1 }; sim.you.to = { ...sim.you.from }
    const events: string[] = []
    const go = (dir: 'up' | 'down'): void => { moveYou(sim, dir); for (const e of advance(sim, TILE_MS, { motion: true, now: 0 })) if (e.kind !== 'arrived') events.push(`${e.kind}:${e.room}`) }
    go('up') // door
    expect(youRoom(sim)).toBeUndefined()
    go('up') // interior
    expect(youRoom(sim)).toBe(0)
    go('up')
    go('down'); go('down'); go('down') // back out through the door
    go('down')
    expect(youRoom(sim)).toBeUndefined()
    expect(events).toEqual(['entered-room:0', 'left-room:0'])
  })
})
