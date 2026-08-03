import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Injected by astro.config.mjs — the repository root, resolved from the config file. */
declare const __REPO_ROOT__: string;

export const repoRoot = __REPO_ROOT__;

/** Read a file from the repository at build time, so the site cannot drift from the source of truth. */
export function readRepoFile(relative: string): string {
  return readFileSync(join(repoRoot, relative), "utf8");
}
