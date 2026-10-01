// The Office canvas colours. A canvas cannot resolve CSS variables itself, so they are read once from the
// `--office-*` custom properties (the only place literal colours may live is tokens.css) and cached
// until the appearance changes. `paletteVersion` keys the sprite cache so a theme swap redraws them.
export interface OfficePalette {
  floor: string; floorAlt: string; wall: string; wallTop: string; carpet: string; desk: string; deskEdge: string
  monitorOff: string; monitorOn: string; table: string; chair: string; plant: string; pot: string; couch: string
  coffee: string; paper: string; outline: string; shade: string
  skin: string[]; hair: string[]; shirt: string[]; pants: string
  you: string; focus: string; fg: string
}

let cached: OfficePalette | undefined
let version = 0

export function invalidatePalette(): void { cached = undefined; version += 1 }
export function paletteVersion(): number { return version }

export function readPalette(): OfficePalette {
  if (cached) return cached
  const style = getComputedStyle(document.documentElement)
  const get = (name: string): string => style.getPropertyValue(name).trim()
  const list = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, index) => get(`--office-${prefix}-${index + 1}`))
  cached = {
    floor: get('--office-floor'), floorAlt: get('--office-floor-alt'), wall: get('--office-wall'), wallTop: get('--office-wall-top'),
    carpet: get('--office-carpet'), desk: get('--office-desk'), deskEdge: get('--office-desk-edge'),
    monitorOff: get('--office-monitor-off'), monitorOn: get('--office-monitor-on'), table: get('--office-table'), chair: get('--office-chair'),
    plant: get('--office-plant'), pot: get('--office-pot'), couch: get('--office-couch'), coffee: get('--office-coffee'),
    paper: get('--office-paper'), outline: get('--office-outline'), shade: get('--office-shade'),
    skin: list('skin', 3), hair: list('hair', 4), shirt: list('shirt', 6), pants: get('--office-pants'),
    you: get('--accent-fill'), focus: get('--focus'), fg: get('--fg')
  }
  return cached
}
