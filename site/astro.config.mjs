import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";

// Resolved here, where import.meta.url still points at a real source file — inside
// the SSR bundle it does not, so build-time reads of repository files need this.
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

// The custom domain the site is served from. It must match Settings → Pages → Custom
// domain, and everything else follows from it: origin, base path, and the CNAME file.
// SITE_DOMAIN overrides it; SITE_DOMAIN="" builds the thisast.github.io/Frontier-Proxy
// project-site variant instead.
const DOMAIN = "frontier.thisara.me";
const domain = (process.env.SITE_DOMAIN ?? DOMAIN).trim().replace(/^https?:\/\//, "").replace(/\/$/, "");

const site = domain ? `https://${domain}` : (process.env.SITE_URL ?? "https://thisast.github.io");
const base = domain ? "/" : (process.env.SITE_BASE ?? "/Frontier-Proxy");

/** GitHub Pages reads the apex/subdomain to serve from a CNAME file in the artifact. */
const writeCname = () => ({
  name: "write-cname",
  hooks: {
    "astro:build:done": ({ dir }) => {
      if (domain) writeFileSync(new URL("CNAME", dir), `${domain}\n`);
    },
  },
});

export default defineConfig({
  site,
  base,
  trailingSlash: "ignore",
  // Prose wraps across source lines around inline <strong>/<code>/<a>; the HTML
  // minifier drops those line breaks entirely and glues the words together.
  compressHTML: false,
  build: { format: "directory" },
  devToolbar: { enabled: false },
  integrations: [writeCname()],
  vite: { define: { __REPO_ROOT__: JSON.stringify(repoRoot) } },
});
