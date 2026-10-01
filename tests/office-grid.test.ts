import { describe, expect, it } from 'vitest'
import { MIN_DESKS, ROOM_COUNT, ROOM_SEATS, assignStable, buildOfficeLayout, findPath, pointKey, rectContains, roomAt, tileAt, walkable } from '../src/shared/office-grid'
import type { OfficeLayout, Point } from '../src/shared/office-grid'

const keyPoints = (l: OfficeLayout): Point[] => [
  l.entrance, ...l.desks.map((d) => d.seat), ...l.rooms.flatMap((r) => [...r.seats, r.door, ...r.waitSpots]),
  ...l.lounge.seats, ...l.away.seats, l.review.stand,
]

describe('buildOfficeLayout', () => {
  for (const n of [4, 8]) {
    const l = buildOfficeLayout(n)
    it(`lays out ${n} desks, ${ROOM_COUNT} rooms and the shared zones`, () => {
      expect(l.desks).toHaveLength(n)
      expect(l.rooms).toHaveLength(ROOM_COUNT)
      for (const r of l.rooms) { expect(r.seats).toHaveLength(ROOM_SEATS); expect(r.waitSpots.length).toBeGreaterThanOrEqual(2) }
      expect(l.away.seats.length).toBeGreaterThanOrEqual(Math.max(4, n))
      expect(l.lounge.seats.length).toBeGreaterThanOrEqual(Math.max(4, n))
      expect(l.tiles).toHaveLength(l.width * l.height)
    })
    it(`keeps every seat, door, wait spot, stand and the entrance walkable and reachable (${n})`, () => {
      for (const p of keyPoints(l)) { expect(walkable(l, p), pointKey(p)).toBe(true); expect(findPath(l, l.entrance, p), pointKey(p)).toBeDefined() }
    })
    it(`puts each seat next to its furniture (${n})`, () => {
      for (const d of l.desks) { expect(tileAt(l, d.desk)).toBe('desk'); expect(d.monitor).toEqual(d.desk); expect(d.seat).toMatchObject({ x: d.desk.x, y: d.desk.y + 1, facing: 'up' }) }
      for (const r of l.rooms) for (const s of r.seats) expect(tileAt(l, s)).toBe('chair')
      expect(tileAt(l, l.review.desk)).toBe('desk'); expect(tileAt(l, l.review.papers)).toBe('papers')
      expect(l.review.stand.y).toBe(l.review.desk.y + 1)
      for (const r of l.rooms) expect(tileAt(l, r.door)).toBe('door')
    })
    it(`wander tiles contain walkable ground (${n})`, () => {
      const w = l.lounge.wander
      let free = 0
      for (let y = w.y; y < w.y + w.h; y++) for (let x = w.x; x < w.x + w.w; x++) if (walkable(l, { x, y })) free++
      expect(free).toBeGreaterThan(4)
    })
  }

  it('grows the desk row with the desk count and never below the minimum', () => {
    expect(buildOfficeLayout(8).width).toBeGreaterThan(buildOfficeLayout(4).width)
    expect(buildOfficeLayout(1).desks).toHaveLength(MIN_DESKS)
    expect(buildOfficeLayout(0).width).toBe(buildOfficeLayout(MIN_DESKS).width)
    expect(buildOfficeLayout(20).desks).toHaveLength(20)
  })
})

describe('findPath', () => {
  const l = buildOfficeLayout(6)
  it('is [] to the same tile', () => { expect(findPath(l, l.entrance, l.entrance)).toEqual([]) })
  it('walks only walkable tiles, one 4-neighbour step at a time, excluding from and including to', () => {
    for (const r of l.rooms) {
      const to = r.seats[0]!, path = findPath(l, l.entrance, to)!
      expect(path.length).toBeGreaterThan(0)
      expect(path[path.length - 1]).toMatchObject({ x: to.x, y: to.y })
      let prev: Point = l.entrance
      for (const p of path) { expect(walkable(l, p)).toBe(true); expect(Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y)).toBe(1); prev = p }
      expect(path.some((p) => p.x === l.entrance.x && p.y === l.entrance.y)).toBe(false)
    }
  })
  it('is undefined for non-walkable or walled-off targets', () => {
    expect(findPath(l, l.entrance, l.desks[0]!.desk)).toBeUndefined()
    expect(findPath(l, l.entrance, { x: -1, y: 3 })).toBeUndefined()
    const sealed = { ...l, tiles: [...l.tiles] }
    const door = l.rooms[0]!.door
    sealed.tiles[door.y * l.width + door.x] = 'wall'
    expect(findPath(sealed, l.entrance, l.rooms[0]!.seats[0]!)).toBeUndefined()
    expect(findPath(sealed, l.entrance, l.rooms[1]!.seats[0]!)).toBeDefined()
  })
})

describe('roomAt', () => {
  const l = buildOfficeLayout(4)
  it('distinguishes interior, wall and corridor', () => {
    const r = l.rooms[1]!
    expect(roomAt(l, r.seats[0]!)).toBe(1)
    expect(roomAt(l, { x: r.rect.x, y: 2 })).toBeUndefined()
    expect(roomAt(l, r.door)).toBeUndefined()
    expect(roomAt(l, r.waitSpots[0]!)).toBeUndefined()
    expect(rectContains(r.interior, { x: r.interior.x, y: r.interior.y })).toBe(true)
    expect(rectContains(r.interior, { x: r.interior.x + r.interior.w, y: r.interior.y })).toBe(false)
  })
})

describe('assignStable', () => {
  it('keeps prior slots and fills the lowest free one', () => {
    const prev = new Map([['b', 0], ['c', 2]])
    const out = assignStable(['a', 'b', 'c', 'd'], 4, prev)
    expect(out.get('b')).toBe(0); expect(out.get('c')).toBe(2)
    expect(out.get('a')).toBe(1); expect(out.get('d')).toBe(3)
  })
  it('hands out lowest slots from nothing and drops ids beyond the slot count', () => {
    const out = assignStable(['a', 'b', 'c'], 2, new Map())
    expect([...out]).toEqual([['a', 0], ['b', 1]])
  })
  it('does not give one slot twice and ignores out-of-range or departed history', () => {
    const out = assignStable(['a', 'b'], 2, new Map([['a', 1], ['b', 1], ['gone', 0]]))
    expect(new Set(out.values()).size).toBe(2)
    expect(out.get('a')).toBe(1); expect(out.get('b')).toBe(0)
    expect(assignStable(['a'], 2, new Map([['a', 5]])).get('a')).toBe(0)
  })
})
