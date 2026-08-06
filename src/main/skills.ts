// Read-only discovery of agent skills (SKILL.md folders) the installed CLIs
// already scan on their own. Frontier never writes here — see the read-only
// guarantee in CLAUDE.md. Only readdir/stat/readFile are imported; no write
// API, no child process.
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ProviderKind, ResolvedSkill, SkillCatalog, SkillDefinition, SkillRootStatus, SkillScope, SkillSettings, SkillSource } from '../shared/types'

const CACHE_TTL_MS = 10_000
const MAX_ENTRIES_PER_ROOT = 200
const MAX_SKILL_FILE_BYTES = 1_000_000
const MAX_FRONTMATTER_BYTES = 8_192
// `.agents/skills` walks from cwd toward the repo root; capped so a very deep
// or non-repo cwd can't turn this into an unbounded filesystem crawl.
const AGENTS_SKILLS_WALK_CAP = 10

interface RootSpec { root: string; scope: SkillScope; nativeFor: ProviderKind[] }

function personalRoots(home: string): RootSpec[] {
  const h = resolve(home)
  return [
    { root: join(h, '.claude', 'skills'), scope: 'personal', nativeFor: ['claude'] },
    { root: join(h, '.copilot', 'skills'), scope: 'personal', nativeFor: ['copilot'] },
    { root: join(h, '.agents', 'skills'), scope: 'personal', nativeFor: ['copilot', 'codex', 'codex-oss'] },
    { root: join(h, '.codex', 'skills'), scope: 'personal', nativeFor: ['codex', 'codex-oss'] }
  ]
}

// The project roots that live under one directory. `discoverSkills` applies
// this to every directory from the task cwd up to the repo root, so a skill at
// the repo root is still found when the task runs in a nested package.
function projectRoots(dir: string): RootSpec[] {
  const d = resolve(dir)
  return [
    { root: join(d, '.claude', 'skills'), scope: 'project', nativeFor: ['claude', 'copilot'] },
    { root: join(d, '.github', 'skills'), scope: 'project', nativeFor: ['copilot'] },
    { root: join(d, '.agents', 'skills'), scope: 'project', nativeFor: ['copilot', 'codex', 'codex-oss'] }
  ]
}

// The roots reachable from a single directory. `home` is a parameter (not
// `os.homedir()` inline) so tests never touch the real `~`. This is the
// one-level view; `discoverSkills` additionally walks project roots upward,
// which needs filesystem access to find the repo boundary.
export function skillRoots(cwd: string, home: string = homedir()): SkillRootStatus[] {
  return [...personalRoots(home), ...projectRoots(cwd)].map((entry) => ({ ...entry, exists: false }))
}

// Directories from cwd up to (and including) the first one containing `.git`,
// or the filesystem root, or the walk cap — whichever comes first. Each is a
// candidate for its own project roots, mirroring the CLIs' own upward search.
async function projectDirWalk(cwd: string): Promise<string[]> {
  const dirs: string[] = []
  let dir = resolve(cwd)
  for (let level = 0; level < AGENTS_SKILLS_WALK_CAP; level += 1) {
    dirs.push(dir)
    if (await isDirectory(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirs
}

function uniqueByRoot(specs: RootSpec[]): RootSpec[] {
  const seen = new Set<string>()
  return specs.filter((spec) => !seen.has(spec.root) && seen.add(spec.root))
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

// Only unindented top-level `key: value` lines count as frontmatter fields.
const FRONTMATTER_KEY = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/

function unquote(value: string): string {
  const first = value[0]
  const last = value[value.length - 1]
  if (value.length >= 2 && first === last && (first === '"' || first === "'")) return value.slice(1, -1)
  return value
}

// Hand-rolled because the only deps in this repo are `cross-spawn` and
// `highlight.js` — pulling in a yaml package for two fields isn't worth it.
// Deliberately narrow: only top-level, unindented keys are read, so a nested
// map like `metadata:\n  author: vercel` is skipped rather than misparsed as
// `metadata: ` followed by garbage keys. `#` is never treated as a comment
// marker — descriptions legitimately contain it.
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/)
  let index = 0
  while (index < lines.length && lines[index].trim() === '') index += 1
  if (lines[index]?.trim() !== '---') return {}

  const fields: Record<string, string> = {}
  for (index += 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '---') return { name: fields.name, description: fields.description }
    if (/^[ \t]/.test(line) || line.trimStart().startsWith('- ')) continue
    const match = FRONTMATTER_KEY.exec(line)
    if (!match) continue
    fields[match[1]] = unquote(match[2].trim())
  }
  return {} // opening fence never closed
}

async function readSkillFile(dir: string): Promise<string | undefined> {
  const path = join(dir, 'SKILL.md')
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_SKILL_FILE_BYTES) return undefined
    return await readFile(path, 'utf8')
  } catch { return undefined }
}

// Lists the immediate child directories of a root, following symlinked
// entries (skill managers commonly symlink skills in from elsewhere). Missing
// root -> undefined so the caller can report `exists: false` instead of
// throwing; a root that exists but is empty is `[]`.
async function scanRootChildren(root: string): Promise<string[] | undefined> {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return undefined }
  const children: string[] = []
  for (const entry of entries.slice(0, MAX_ENTRIES_PER_ROOT)) {
    const path = join(root, entry.name)
    if (entry.isDirectory() || (entry.isSymbolicLink() && await isDirectory(path))) children.push(path)
  }
  return children
}

const cache = new Map<string, { at: number; catalog: SkillCatalog }>()

export async function discoverSkills(cwd: string, options: { refresh?: boolean; home?: string } = {}): Promise<SkillCatalog> {
  const resolvedCwd = resolve(cwd)
  const cached = cache.get(resolvedCwd)
  if (!options.refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.catalog

  const home = options.home ?? homedir()
  // Project roots are collected for every directory up to the repo root, not
  // just the task cwd — a task running in a nested package must still see the
  // repo's own `.claude/skills` / `.github/skills` / `.agents/skills`.
  // De-duped by path, first spec winning: a non-git cwd under $HOME walks up
  // to `~` and would otherwise re-add `~/.agents/skills` — already listed as a
  // personal root — scanning it twice and relabelling it project scope.
  const projectDirs = await projectDirWalk(resolvedCwd)
  const roots = uniqueByRoot([...personalRoots(home), ...projectDirs.flatMap(projectRoots)])

  const rootStatuses: SkillRootStatus[] = []
  // Merge by normalized name across every root; a project-scope hit's text
  // wins display over a personal one found earlier, since scan order alone
  // doesn't reflect that priority.
  const byName = new Map<string, { definition: SkillDefinition; scopeRank: number }>()
  const scopeRank = (scope: SkillScope): number => (scope === 'project' ? 1 : 0)

  for (const spec of roots) {
    const children = await scanRootChildren(spec.root)
    rootStatuses.push({ root: spec.root, scope: spec.scope, nativeFor: spec.nativeFor, exists: children !== undefined })
    if (!children) continue

    for (const dir of children) {
      const text = await readSkillFile(dir)
      if (text === undefined) continue
      const front = parseSkillFrontmatter(text.slice(0, MAX_FRONTMATTER_BYTES))
      const folderName = dir.split(/[\\/]/).pop() ?? dir
      const name = front.name?.trim() || folderName
      const description = front.description?.trim() ?? ''
      const key = name.trim().toLowerCase()
      const source: SkillSource = { root: spec.root, path: join(dir, 'SKILL.md'), scope: spec.scope, nativeFor: spec.nativeFor }

      const existing = byName.get(key)
      if (!existing) {
        byName.set(key, { definition: { id: key, name, description, sources: [source] }, scopeRank: scopeRank(spec.scope) })
        continue
      }
      existing.definition.sources.push(source)
      const rank = scopeRank(spec.scope)
      if (rank > existing.scopeRank) {
        existing.definition.name = name
        existing.definition.description = description
        existing.scopeRank = rank
      }
    }
  }

  const catalog: SkillCatalog = {
    cwd: resolvedCwd,
    scannedAt: new Date().toISOString(),
    roots: rootStatuses,
    skills: [...byName.values()].map((entry) => entry.definition).sort((left, right) => left.name.localeCompare(right.name))
  }
  cache.set(resolvedCwd, { at: Date.now(), catalog })
  return catalog
}

// A skill new to the catalog is on by default; `disabledIds` is the only
// override. `taskSkillIds`, when present, replaces that default outright
// (undefined means "inherit", not "none") — see CLAUDE.md's per-task model
// override for the same undefined-means-inherit shape.
export function resolveSkills(catalog: SkillCatalog, settings: SkillSettings, taskSkillIds?: string[]): ResolvedSkill[] {
  return catalog.skills.map((skill) => ({
    ...skill,
    enabled: taskSkillIds ? taskSkillIds.includes(skill.id) : !settings.disabledIds.includes(skill.id)
  }))
}

export function invalidateSkillCatalog(cwd?: string): void {
  if (cwd) cache.delete(resolve(cwd))
  else cache.clear()
}
