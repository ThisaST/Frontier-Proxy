// Procedural pixel art for the Office map: every tile and avatar is a handful of `fillRect`s drawn once
// per palette version onto an offscreen canvas and memoized, so a frame is only `drawImage`s. Colours
// come from the palette (tokens.css), never from literals here. All sprites are 16px wide; avatars are
// 16x24 with their feet on the bottom row so they stand on the tile they occupy.
import type { Facing, Tile } from '../../../shared/office-grid'
import type { OfficeAppearance } from '../../../shared/office-model'
import { paletteVersion, type OfficePalette } from './palette'

export type Sprite = HTMLCanvasElement | OffscreenCanvas
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const cache = new Map<string, Sprite | null>()
export function clearSpriteCache(): void { cache.clear() }

function make(w: number, h: number): { canvas: Sprite; ctx: Ctx } | undefined {
  try {
    const canvas: Sprite = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h })
    const ctx = canvas.getContext('2d') as Ctx | null
    return ctx ? { canvas, ctx } : undefined
  } catch { return undefined } // happy-dom (tests) has no canvas
}

function memo(key: string, w: number, h: number, paint: (ctx: Ctx) => void): Sprite | undefined {
  const full = `${paletteVersion()}|${key}`
  const hit = cache.get(full)
  if (hit !== undefined) return hit ?? undefined
  const made = make(w, h)
  if (made) paint(made.ctx)
  cache.set(full, made?.canvas ?? null)
  return made?.canvas
}

const rect = (ctx: Ctx, color: string, x: number, y: number, w: number, h: number): void => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h) }
// 1px outline around (x, y, w, h), drawn as four strips so the inside stays untouched.
const frame = (ctx: Ctx, color: string, x: number, y: number, w: number, h: number): void => { rect(ctx, color, x, y, w, 1); rect(ctx, color, x, y + h - 1, w, 1); rect(ctx, color, x, y, 1, h); rect(ctx, color, x + w - 1, y, 1, h) }
// Furniture that is several tiles wide shares its seam: bit 0 = a neighbour on the left, bit 1 = on the right.
const LEFT = 1, RIGHT = 2

const paintFloor = (ctx: Ctx, p: OfficePalette, variant: number): void => rect(ctx, variant % 2 ? p.floorAlt : p.floor, 0, 0, 16, 16)

// The desk top starts low (row 6) so a monitor drawn above it leaves a strip of wood visible in front.
function paintDesk(ctx: Ctx, p: OfficePalette, joins: number): void {
  const x = joins & LEFT ? 0 : 1, w = 16 - x - (joins & RIGHT ? 0 : 1)
  const ix = x + (joins & LEFT ? 0 : 1), iw = w - (joins & LEFT ? 0 : 1) - (joins & RIGHT ? 0 : 1)
  rect(ctx, p.outline, x, 6, w, 10)
  rect(ctx, p.desk, ix, 7, iw, 5)
  rect(ctx, p.deskEdge, ix, 12, iw, 3)
}

function paintPlant(ctx: Ctx, p: OfficePalette): void {
  const blobs: Array<[number, number, number, number]> = [[3, 5, 5, 5], [8, 4, 5, 6], [5, 1, 6, 6]]
  rect(ctx, p.outline, 4, 9, 8, 6); rect(ctx, p.pot, 5, 10, 6, 4); rect(ctx, p.shade, 5, 13, 6, 1)
  for (const [x, y, w, h] of blobs) rect(ctx, p.outline, x - 1, y - 1, w + 2, h + 2)
  for (const [x, y, w, h] of blobs) { rect(ctx, p.plant, x, y, w, h); rect(ctx, p.shade, x, y + h - 1, w, 1) }
  rect(ctx, p.outline, 5, 8, 6, 1); rect(ctx, p.pot, 5, 9, 6, 1)
}

function paintCouch(ctx: Ctx, p: OfficePalette, joins: number): void {
  const l = joins & LEFT ? 0 : 1, r = joins & RIGHT ? 0 : 1
  rect(ctx, p.outline, 0, 1, 16, 14)
  rect(ctx, p.couch, l, 2, 16 - l - r, 12)
  rect(ctx, p.shade, l, 2, 16 - l - r, 4) // the back
  rect(ctx, p.outline, l, 6, 16 - l - r, 1)
  if (l) rect(ctx, p.shade, 1, 7, 2, 7)
  if (r) rect(ctx, p.shade, 13, 7, 2, 7)
  rect(ctx, p.shade, l + (l ? 2 : 0), 13, 16 - l - r - (l ? 2 : 0) - (r ? 2 : 0), 1)
}

function paintTile(ctx: Ctx, p: OfficePalette, tile: Tile, variant: number): void {
  switch (tile) {
    case 'floor': paintFloor(ctx, p, variant); break
    case 'carpet': rect(ctx, p.carpet, 0, 0, 16, 16); ctx.globalAlpha = 0.5; rect(ctx, p.shade, 3, 3, 2, 2); rect(ctx, p.shade, 11, 11, 2, 2); ctx.globalAlpha = 1; break
    case 'wall': { // variant bit 0: another wall above (no top face); bit 1: open space below (a baseboard shadow)
      rect(ctx, p.wall, 0, 0, 16, 16)
      if (!(variant & 1)) rect(ctx, p.wallTop, 0, 0, 16, 3)
      if (variant & 2) { rect(ctx, p.shade, 0, 14, 16, 2) }
      break
    }
    case 'desk': case 'papers': paintDesk(ctx, p, variant); break
    case 'chair':
      rect(ctx, p.outline, 3, 2, 10, 12); rect(ctx, p.chair, 4, 3, 8, 3); rect(ctx, p.shade, 4, 5, 8, 1); rect(ctx, p.chair, 4, 6, 8, 6); rect(ctx, p.shade, 4, 11, 8, 1); break
    case 'table': {
      const x = variant & LEFT ? 0 : 1, w = 16 - x - (variant & RIGHT ? 0 : 1)
      rect(ctx, p.outline, x, 2, w, 13)
      const ix = x + (variant & LEFT ? 0 : 1), iw = w - (variant & LEFT ? 0 : 1) - (variant & RIGHT ? 0 : 1)
      rect(ctx, p.table, ix, 3, iw, 9); rect(ctx, p.shade, ix, 11, iw, 3)
      break
    }
    case 'plant': paintPlant(ctx, p); break
    case 'couch': paintCouch(ctx, p, variant); break
    case 'coffee':
      rect(ctx, p.outline, 1, 7, 14, 8); rect(ctx, p.table, 2, 8, 12, 4); rect(ctx, p.deskEdge, 2, 12, 12, 2)
      rect(ctx, p.outline, 5, 2, 6, 6); rect(ctx, p.paper, 6, 3, 4, 4); rect(ctx, p.coffee, 6, 3, 4, 1); rect(ctx, p.outline, 11, 4, 2, 2); rect(ctx, p.shade, 7, 1, 1, 1); break
    case 'door':
      paintFloor(ctx, p, 1); rect(ctx, p.wallTop, 0, 0, 2, 16); rect(ctx, p.wallTop, 14, 0, 2, 16); rect(ctx, p.outline, 2, 0, 1, 16); rect(ctx, p.outline, 13, 0, 1, 16); break
    case 'monitor': case 'void': break
  }
}

export function tileSprite(tile: Tile, variant: number, palette: OfficePalette): Sprite | undefined {
  if (tile === 'void') return undefined
  return memo(`t:${tile}:${variant}`, 16, 16, (ctx) => paintTile(ctx, palette, tile, variant))
}

// A 10x7 screen on a stand, sitting on the upper part of a desk tile; lit while the agent has real work.
export function monitorSprite(on: boolean, palette: OfficePalette): Sprite | undefined {
  return memo(`m:${on}`, 16, 16, (ctx) => {
    rect(ctx, palette.outline, 2, 0, 12, 9); rect(ctx, on ? palette.monitorOn : palette.monitorOff, 3, 1, 10, 7)
    if (on) { rect(ctx, palette.paper, 4, 2, 6, 1); rect(ctx, palette.paper, 4, 4, 4, 1); rect(ctx, palette.paper, 4, 6, 7, 1) }
    else rect(ctx, palette.shade, 10, 1, 3, 3)
    rect(ctx, palette.outline, 7, 9, 2, 1); rect(ctx, palette.outline, 5, 10, 6, 1)
  })
}

// 0..3 sheets staggered on a desk top.
export function papersSprite(stack: number, palette: OfficePalette): Sprite | undefined {
  const n = Math.max(0, Math.min(3, Math.floor(stack)))
  if (!n) return undefined
  return memo(`p:${n}`, 16, 16, (ctx) => {
    for (let i = 0; i < n; i += 1) {
      const x = 3 + (i % 2) * 2, y = 7 - i * 2
      rect(ctx, palette.outline, x, y, 10, 5); rect(ctx, palette.paper, x + 1, y + 1, 8, 3)
      rect(ctx, palette.shade, x + 2, y + 2, 5, 1)
    }
  })
}

export interface AvatarOptions { seated?: boolean; greyed?: boolean; you?: boolean }

// A chibi in a 16x24 cell, feet on the bottom row. Head 8x7 under a hair cap, torso 8x7, two legs; the
// facing decides the hair and the eyes. A seated avatar sinks 4px into its chair and hides its legs.
function paintAvatar(ctx: Ctx, p: OfficePalette, look: OfficeAppearance, facing: Facing, frame1: boolean, opts: AvatarOptions): void {
  const skin = p.skin[look.skin % p.skin.length]!, hair = p.hair[look.hair % p.hair.length]!, shirt = opts.you ? p.you : p.shirt[look.shirt % p.shirt.length]!
  const top = opts.seated ? 7 : 3 // row of the head's top outline
  const r = (color: string, x: number, y: number, w: number, h: number): void => rect(ctx, color, x, top + y, w, h)
  if (opts.greyed) ctx.globalAlpha = 0.45
  // legs first so the torso outline overlaps their top edge
  if (!opts.seated) {
    const sideways = facing === 'left' || facing === 'right', lift = frame1 && !sideways ? 1 : 0, spread = frame1 && sideways ? 1 : 0
    const leg = (x: number, rows: number): void => { r(p.outline, x, 17, 4, rows + 1); r(p.pants, x + 1, 17, 2, rows) ; r(p.outline, x, 17 + rows, 4, 1) }
    leg(4 - spread, 3 - lift); leg(8 + spread, 3)
  }
  // torso
  r(p.outline, 3, 9, 10, 8)
  r(shirt, 4, 9, 8, 7); r(p.shade, 4, 14, 8, 2)
  // head: outline with trimmed corners, hair cap, face
  r(p.outline, 4, 0, 8, 1); r(p.outline, 3, 1, 10, 8)
  r(skin, 4, 1, 8, 7)
  r(hair, 4, 1, 8, 2)
  if (facing === 'down') {
    r(hair, 4, 3, 2, 1); r(hair, 10, 3, 2, 1)
    r(p.outline, 6, 5, 1, 1); r(p.outline, 9, 5, 1, 1)
  } else if (facing === 'up') {
    r(hair, 4, 3, 8, 4); r(hair, 4, 7, 2, 1); r(hair, 10, 7, 2, 1)
  } else {
    const back = facing === 'left' ? 9 : 4
    r(hair, back, 3, 3, 4)
    r(p.outline, facing === 'left' ? 5 : 10, 5, 1, 1)
  }
  r(p.shade, 4, 7, 8, 1)
  if (opts.greyed) { ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-atop'; rect(ctx, p.shade, 0, 0, 16, 24); ctx.globalCompositeOperation = 'source-over' }
}

export function avatarSprite(look: OfficeAppearance, facing: Facing, frame1: 0 | 1, opts: AvatarOptions, palette: OfficePalette): Sprite | undefined {
  const o = opts
  return memo(`a:${look.skin}.${look.hair}.${look.shirt}:${facing}:${frame1}:${o.seated ? 's' : ''}${o.greyed ? 'g' : ''}${o.you ? 'y' : ''}`, 16, 24, (ctx) => paintAvatar(ctx, palette, look, facing, frame1 === 1, o))
}
