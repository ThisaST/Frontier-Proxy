/**
 * Release data is pulled from the GitHub API at build time so the download table
 * and changelog never drift from what the release workflow actually published.
 * Every network failure degrades to the version in the desktop app's package.json
 * — an offline `astro build` still produces a correct, if less detailed, site.
 */
import { readRepoFile } from "./repo";
import { REPO, RELEASES_URL } from "./site";

export interface Download {
  platform: string;
  kind: string;
  file: string;
  href: string;
  size?: string;
}

export interface ReleaseEntry {
  tag: string;
  title: string;
  version: string;
  published: string;
  notes: string;
  href: string;
  prerelease: boolean;
}

interface GhAsset { name: string; browser_download_url: string; size: number }
interface GhRelease {
  tag_name: string; name: string | null; body: string | null; html_url: string;
  draft: boolean; prerelease: boolean; published_at: string | null; assets: GhAsset[];
}

function packageVersion(): string {
  try {
    return JSON.parse(readRepoFile("package.json")).version as string;
  } catch {
    return "0.0.0";
  }
}

async function fetchReleases(): Promise<GhRelease[]> {
  if (process.env.SITE_OFFLINE) throw new Error("SITE_OFFLINE is set");
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "frontier-proxy-site",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
    headers,
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
  const body = (await res.json()) as GhRelease[];
  return body.filter((r) => !r.draft);
}

function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Map a release asset filename onto the platform/kind shown in the download table. */
function describeAsset(name: string): Pick<Download, "platform" | "kind"> | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".dmg")) return { platform: "macOS", kind: "Disk image" };
  if (lower.endsWith("-mac.zip") || (lower.includes("mac") && lower.endsWith(".zip")))
    return { platform: "macOS", kind: "Zip archive" };
  if (lower.includes("setup") && lower.endsWith(".exe")) return { platform: "Windows", kind: "Installer" };
  if (lower.endsWith(".exe")) return { platform: "Windows", kind: "Portable" };
  if (lower.endsWith(".appimage")) return { platform: "Linux", kind: "AppImage" };
  if (lower.endsWith(".deb")) return { platform: "Linux", kind: "Debian / Ubuntu" };
  return null;
}

const ORDER = ["macOS", "Windows", "Linux"];

function fallbackDownloads(version: string): Download[] {
  const base = `https://github.com/${REPO}/releases/download/v${version}`;
  const files: Array<[string, string, string]> = [
    ["macOS", "Disk image", `Frontier.Proxy-${version}.dmg`],
    ["macOS", "Zip archive", `Frontier.Proxy-${version}-mac.zip`],
    ["Windows", "Installer", `Frontier.Proxy.Setup.${version}.exe`],
    ["Windows", "Portable", `Frontier.Proxy.${version}.exe`],
    ["Linux", "AppImage", `Frontier.Proxy-${version}.AppImage`],
    ["Linux", "Debian / Ubuntu", `frontier-proxy_${version}_amd64.deb`],
  ];
  return files.map(([platform, kind, file]) => ({ platform, kind, file, href: `${base}/${file}` }));
}

let releases: ReleaseEntry[] = [];
let downloads: Download[] = [];
let version = packageVersion();
let live = false;

try {
  const raw = await fetchReleases();
  const latest = raw.find((r) => !r.prerelease) ?? raw[0];

  releases = raw.map((r) => ({
    tag: r.tag_name,
    title: r.name?.trim() || r.tag_name,
    version: r.tag_name.replace(/^v/, ""),
    published: r.published_at ?? "",
    notes: r.body ?? "",
    href: r.html_url,
    prerelease: r.prerelease,
  }));

  if (latest) {
    version = latest.tag_name.replace(/^v/, "");
    downloads = latest.assets
      .map((asset) => {
        const described = describeAsset(asset.name);
        return described && {
          ...described,
          file: asset.name,
          href: asset.browser_download_url,
          size: formatSize(asset.size),
        };
      })
      .filter((d): d is Download => Boolean(d))
      .sort((a, b) => ORDER.indexOf(a.platform) - ORDER.indexOf(b.platform));
    live = true;
  }
} catch (error) {
  console.warn(
    `[site] Could not reach the GitHub releases API (${(error as Error).message}). ` +
      `Falling back to package.json v${version}; the changelog will link to ${RELEASES_URL}.`,
  );
}

if (downloads.length === 0) downloads = fallbackDownloads(version);

export { releases, downloads, version, live };
