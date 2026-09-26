// Lucide icons, rendered to a static SVG string at build time — the site's
// equivalent of src/renderer/src/ui/icons.ts, which builds the same node data
// into DOM elements at runtime. Only the icons the docs rail actually uses are
// imported by name, so the bundle only carries those (no CDN, per CLAUDE.md).
import { BookOpen, Cable, Cpu, Download, GitBranch, LifeBuoy, Lock, Radar, Users2 } from "lucide";

const ICONS = {
  overview: BookOpen,
  install: Download,
  providers: Cpu,
  routing: Radar,
  "context-tools": Cable,
  orchestration: GitBranch,
  collaboration: Users2,
  workspace: BookOpen,
  security: Lock,
  troubleshooting: LifeBuoy,
} as const;

export type DocsIconName = keyof typeof ICONS;

type LucideNode = readonly [string, Record<string, string>, (readonly LucideNode[])?];

function renderNode([tag, attrs, children]: LucideNode): string {
  const attrString = Object.entries(attrs)
    .map(([name, value]) => `${name}="${value}"`)
    .join(" ");
  const inner = (children ?? []).map(renderNode).join("");
  return `<${tag} ${attrString}>${inner}</${tag}>`;
}

/** Static SVG markup for a docs-rail icon — stroke 1.5, currentColor, matching ui/icons.ts. */
export function docsIcon(name: DocsIconName, size: 14 | 16 | 20 = 16): string {
  const shapes = (ICONS[name] as readonly LucideNode[]).map(renderNode).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon">${shapes}</svg>`;
}
