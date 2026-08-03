export const REPO = "ThisaST/Frontier-Proxy";
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const LATEST_URL = `${RELEASES_URL}/latest`;
export const ISSUES_URL = `${REPO_URL}/issues`;

export const SITE_NAME = "Frontier Proxy";
export const TAGLINE = "A local-first desktop router for Codex, Claude Code, Copilot CLI, and local models.";

/** Prefix an in-site path with Astro's configured base, always ending in a slash. */
export function url(path = "/"): string {
  const joined = `${import.meta.env.BASE_URL}/${path}`.replace(/\/{2,}/g, "/");
  return joined.endsWith("/") ? joined : `${joined}/`;
}

/** True when `href` is the current page (or one of its children). */
export function isCurrent(href: string, pathname: string): boolean {
  const a = href.replace(/\/$/, "");
  const b = pathname.replace(/\/$/, "");
  return a === b;
}
