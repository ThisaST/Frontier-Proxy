import { url } from "./site";

export interface NavLink { label: string; href: string; blurb?: string }
export interface NavGroup { title: string; links: NavLink[] }

export const docsNav: NavGroup[] = [
  {
    title: "Start here",
    links: [
      { label: "Overview", href: url("docs"), blurb: "What Frontier Proxy is and how a task flows through it." },
      { label: "Install", href: url("docs/install"), blurb: "Download a build or compile from source." },
      { label: "Provider setup", href: url("docs/providers"), blurb: "Register and sign in to Codex, Claude Code, Copilot, and Ollama." },
    ],
  },
  {
    title: "Using it",
    links: [
      { label: "Routing & failover", href: url("docs/routing"), blurb: "How a provider is chosen and when work reroutes." },
      { label: "Context & Tools", href: url("docs/context-tools"), blurb: "One MCP and tool profile translated into every CLI's flags." },
      { label: "Orchestration & bench", href: url("docs/orchestration"), blurb: "Split work across agents, or race them head to head." },
      { label: "Workspaces & participants", href: url("docs/collaboration"), blurb: "One thread per repo with named agents you address by @handle." },
      { label: "Task workspace", href: url("docs/workspace"), blurb: "Conversations, file changes, context meter, and usage." },
    ],
  },
  {
    title: "Reference",
    links: [
      { label: "Security & data", href: url("docs/security"), blurb: "What runs where, and what never leaves your machine." },
      { label: "Troubleshooting", href: url("docs/troubleshooting"), blurb: "Fixes for the failures people actually hit." },
    ],
  },
];

export const docsOrder: NavLink[] = docsNav.flatMap((group) => group.links);

export const mainNav: NavLink[] = [
  { label: "Features", href: `${url("/")}#features` },
  { label: "Docs", href: url("docs") },
  { label: "Changelog", href: url("changelog") },
  { label: "Download", href: `${url("/")}#download` },
];

/** Previous/next page links for the docs footer. */
export function siblings(href: string): { prev?: NavLink; next?: NavLink } {
  const i = docsOrder.findIndex((link) => link.href.replace(/\/$/, "") === href.replace(/\/$/, ""));
  if (i === -1) return {};
  return { prev: docsOrder[i - 1], next: docsOrder[i + 1] };
}
