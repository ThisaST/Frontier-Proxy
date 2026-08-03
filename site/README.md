# Frontier Proxy site

The marketing and documentation site at **https://frontier.thisara.me**, built with
[Astro](https://astro.build) and deployed to GitHub Pages by
[`.github/workflows/site.yml`](../.github/workflows/site.yml).

## Running it

`site/` is deliberately **outside** the pnpm workspace (`pnpm-workspace.yaml` lists only
`.`), so installing it never touches the desktop app's lockfile or its frozen-lockfile CI
install. Always pass `--ignore-workspace`:

```bash
pnpm --dir site install --ignore-workspace
pnpm --dir site dev        # http://localhost:4321
pnpm --dir site build      # → site/dist
pnpm --dir site preview
```

## Where the content comes from

Anything that would go stale is read at build time rather than copied:

| Content | Source |
| --- | --- |
| Download table, current version | GitHub releases API, falling back to the root `package.json` version |
| Changelog | GitHub releases API (`src/pages/changelog.astro`) |
| Architecture diagram | `docs/architecture.svg`, inlined |

`src/lib/repo.ts` reads repository files through `__REPO_ROOT__`, injected by
`astro.config.mjs` — inside the SSR bundle `import.meta.url` no longer points at a source
file, so it cannot be used for this.

Set `GITHUB_TOKEN` to raise the API rate limit (CI does). Set `SITE_OFFLINE=1` to skip the
API entirely and exercise the fallback path; the build still succeeds, the download table
shows expected asset names, and the changelog links out to GitHub instead.

## Theme

`src/styles/theme.css` carries the same design tokens as the desktop app
(`src/renderer/src/styles.css`) — background, surfaces, lines, the `#a9ef72` green, the
Georgia headings, the brand mark. **Keep the two in sync**: if the app's palette changes,
change it here too.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SITE_DOMAIN` | `frontier.thisara.me` | The served host. Sets the origin, serves from `/`, writes `dist/CNAME`. Set to `""` to build the `thisast.github.io/Frontier-Proxy` project-site variant. |
| `SITE_BASE` | `/Frontier-Proxy` | Base path, only when `SITE_DOMAIN=""`. |
| `SITE_URL` | `https://thisast.github.io` | Origin, only when `SITE_DOMAIN=""`. |
| `SITE_OFFLINE` | unset | Skip the releases API and use fallback data. |

## Enabling deployment

The workflow needs Pages turned on once, in the repository's
**Settings → Pages → Build and deployment → Source → GitHub Actions**.

## The custom domain

`frontier.thisara.me` is a constant (`DOMAIN`) in [`astro.config.mjs`](astro.config.mjs).
It is the single source for the origin, the base path, and the `CNAME` file written into
the build — a custom domain serves from the host root, not from a project-site path, so
those move together.

Two pieces of setup live outside this repository:

1. **DNS** — a `CNAME` record for `frontier` in the `thisara.me` zone pointing at
   `thisast.github.io` (the user's Pages host, *not* the repository).
2. **Pages** — the same domain entered under **Settings → Pages → Custom domain**, then
   **Enforce HTTPS** once the certificate is issued.

The repository constant and the Pages setting must agree, or Pages serves a 404. For an
apex domain instead, DNS would need `A` records to `185.199.108.153`, `185.199.109.153`,
`185.199.110.153`, `185.199.111.153` plus `AAAA` records `2606:50c0:8000::153` through
`2606:50c0:8003::153`.

Changing the domain means changing `DOMAIN` here, the Pages setting, the DNS record, and
the URLs in the root [`README.md`](../README.md) and [`CLAUDE.md`](../CLAUDE.md).
