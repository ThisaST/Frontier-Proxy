// Lucide icons — tree-shaken ESM, stroke 1.5, currentColor. Replaces every
// Unicode glyph icon in the app (see docs/design-phosphor-console.md §5).
// Only the icons actually used are imported by name so the bundle only carries
// those.
import {
  AlertTriangle as TriangleAlert, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Circle, Clock,
  Command, Cpu, Eye, FileText, Folder, FolderOpen, GitBranch, House, ListChecks, LoaderCircle, Maximize2,
  Merge, Minimize2, MessagesSquare, MoreHorizontal, Paperclip, Plug, Plus, Radar, RefreshCw, Scale,
  Settings, Sparkle, Terminal, Trash2, Users, UserPlus, Wrench, X
} from 'lucide'

const ICONS = {
  home: House,
  tasks: ListChecks,
  workspace: MessagesSquare,
  review: GitBranch,
  agents: Cpu,
  control: Plug,
  skills: Sparkle,
  routing: Radar,
  settings: Settings,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  'chevron-up': ChevronUp,
  'folder-open': FolderOpen,
  refresh: RefreshCw,
  plus: Plus,
  close: X,
  expand: Maximize2,
  collapse: Minimize2,
  attach: Paperclip,
  folder: Folder,
  file: FileText,
  tool: Wrench,
  thinking: Sparkle,
  notice: Circle,
  loader: LoaderCircle,
  check: Check,
  compare: Scale,
  trash: Trash2,
  'cap-read': Eye,
  'cap-run': Terminal,
  'cap-edit': GitBranch,
  branch: GitBranch,
  merge: Merge,
  waiting: Clock,
  alert: TriangleAlert,
  more: MoreHorizontal,
  command: Command,
  'user-plus': UserPlus,
  users: Users
} as const

export type IconName = keyof typeof ICONS

const NS = 'http://www.w3.org/2000/svg'

// Builds an SVG element from a lucide icon node ([tag, attrs, children][]) —
// equivalent to lucide's own `createElement`, written by hand so only the icon
// data (not the whole createElement/defaultAttributes module) needs importing.
function buildNode([tag, attrs, children]: readonly [string, Record<string, string>, unknown?]): SVGElement {
  const node = document.createElementNS(NS, tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
  for (const child of (children as (readonly [string, Record<string, string>, unknown?])[] | undefined) ?? []) node.append(buildNode(child))
  return node
}

export function icon(name: IconName, size: 14 | 16 | 20 = 16): SVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('xmlns', NS)
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('icon')
  for (const shape of ICONS[name] as readonly (readonly [string, Record<string, string>, unknown?])[]) svg.append(buildNode(shape))
  return svg
}

// Replaces a button/label's content with an icon plus a text label, for
// controls whose text changes at runtime (health-check's "Checking…", etc.) —
// setting `textContent` on those used to wipe out a declaratively-placed icon.
export function setIconLabel(target: HTMLElement, name: IconName | undefined, label: string, size: 14 | 16 | 20 = 14): void {
  target.replaceChildren(...(name ? [icon(name, size)] : []), document.createTextNode(label))
}

// Fills every element in `root` (default: the whole document) carrying a
// `data-icon` attribute with the matching icon — the declarative path for
// icons that never change at runtime (nav, static dialog chrome, …).
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    const name = el.dataset.icon as IconName | undefined
    if (!name || !(name in ICONS)) return
    const size = Number(el.dataset.iconSize) as 14 | 16 | 20
    el.replaceChildren(icon(name, size === 14 || size === 20 ? size : 16))
  })
}
