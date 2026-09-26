import { url } from "./site";
import type { DocsIconName } from "./icon";

export interface NavLink { label: string; href: string; blurb?: string; icon: DocsIconName }
export interface NavGroup { title: string; links: NavLink[] }

export const docsNav: NavGroup[] = [
  {
    title: "Get started",
    links: [
      { label: "Overview", href: url("docs"), blurb: "What Frontier Proxy is and how a task flows through it.", icon: "overview" },
      { label: "Install", href: url("docs/install"), blurb: "Download a build or compile from source.", icon: "install" },
      { label: "Provider setup", href: url("docs/providers"), blurb: "Register and sign in to Codex, Claude Code, Copilot, OpenCode, and Ollama.", icon: "providers" },
    ],
  },
  {
    title: "Concepts",
    links: [
      { label: "Routing & failover", href: url("docs/routing"), blurb: "How a provider is chosen and when work reroutes.", icon: "routing" },
      { label: "Context & Tools", href: url("docs/context-tools"), blurb: "One MCP and tool profile translated into every CLI's flags.", icon: "context-tools" },
      { label: "Orchestration & bench", href: url("docs/orchestration"), blurb: "Split work across agents, or race them head to head.", icon: "orchestration" },
      { label: "Workspaces & participants", href: url("docs/collaboration"), blurb: "One thread per repo with named agents you address by @handle.", icon: "collaboration" },
      { label: "Task workspace", href: url("docs/workspace"), blurb: "Conversations, file changes, context meter, and usage.", icon: "workspace" },
    ],
  },
  {
    title: "Reference",
    links: [
      { label: "Security & data", href: url("docs/security"), blurb: "What runs where, and what never leaves your machine.", icon: "security" },
      { label: "Troubleshooting", href: url("docs/troubleshooting"), blurb: "Fixes for the failures people actually hit.", icon: "troubleshooting" },
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
