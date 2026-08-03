import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverSkills, invalidateSkillCatalog, parseSkillFrontmatter, resolveSkills, skillRoots } from '../src/main/skills'
import type { SkillCatalog, SkillDefinition } from '../src/shared/types'

async function writeSkill(root: string, folder: string, name: string, description: string, extraBody = ''): Promise<void> {
  await mkdir(join(root, folder), { recursive: true })
  await writeFile(join(root, folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${extraBody || 'Body.'}\n`, 'utf8')
}

function definition(id: string, extra: Partial<SkillDefinition> = {}): SkillDefinition {
  return { id, name: id, description: '', sources: [], ...extra }
}

describe('parseSkillFrontmatter', () => {
  // The real case on disk: web-design-guidelines/SKILL.md has a `metadata:`
  // map with indented children, plus a description containing both `:` and
  // quoted phrases. A naive line-splitter misreads the indented keys as more
  // top-level fields.
  it('skips a nested map with indented children instead of misparsing it', () => {
    const text = [
      '---',
      'name: web-design-guidelines',
      'description: Review UI code. Use when asked to "review my UI", "check accessibility".',
      'metadata:',
      '  author: vercel',
      '  version: "1.0.0"',
      '  argument-hint: <file-or-pattern>',
      '---',
      '# Body'
    ].join('\n')
    expect(parseSkillFrontmatter(text)).toEqual({
      name: 'web-design-guidelines',
      description: 'Review UI code. Use when asked to "review my UI", "check accessibility".'
    })
  })

  it('strips one pair of surrounding quotes', () => {
    const text = '---\nname: "docker-deployment"\ndescription: \'Containerize and deploy\'\n---\n'
    expect(parseSkillFrontmatter(text)).toEqual({ name: 'docker-deployment', description: 'Containerize and deploy' })
  })

  it('preserves a description containing both `:` and `#`', () => {
    const text = '---\nname: sample\ndescription: Runs `foo: bar` and handles #123 issues\n---\n'
    expect(parseSkillFrontmatter(text).description).toBe('Runs `foo: bar` and handles #123 issues')
  })

  it('handles CRLF line endings', () => {
    const text = '---\r\nname: crlf-skill\r\ndescription: works with CRLF\r\n---\r\n'
    expect(parseSkillFrontmatter(text)).toEqual({ name: 'crlf-skill', description: 'works with CRLF' })
  })

  it('returns nothing when the file has no frontmatter fence', () => {
    expect(parseSkillFrontmatter('# Just a heading\nname: nope\n')).toEqual({})
  })

  it('returns nothing when the opening fence is never closed', () => {
    expect(parseSkillFrontmatter('---\nname: only\ndescription: unterminated\n')).toEqual({})
  })

  it('ignores a `name:` line that appears after the closing fence', () => {
    const text = '---\nname: real\n---\nname: after\ndescription: also after\n'
    expect(parseSkillFrontmatter(text)).toEqual({ name: 'real', description: undefined })
  })

  it('skips `- ` list items at top level', () => {
    const text = '---\nname: sample\ntags:\n- one\n- two\ndescription: after a list\n---\n'
    expect(parseSkillFrontmatter(text)).toEqual({ name: 'sample', description: 'after a list' })
  })
})

describe('skillRoots', () => {
  it('builds the fixed personal and project roots from an injected home', () => {
    const roots = skillRoots('/repo', '/home/user')
    expect(roots.map((root) => root.root)).toEqual([
      '/home/user/.claude/skills',
      '/home/user/.copilot/skills',
      '/home/user/.agents/skills',
      '/home/user/.codex/skills',
      '/repo/.claude/skills',
      '/repo/.github/skills'
    ])
    expect(roots.find((root) => root.root === '/home/user/.claude/skills')).toMatchObject({ scope: 'personal', nativeFor: ['claude'] })
    expect(roots.find((root) => root.root === '/repo/.claude/skills')).toMatchObject({ scope: 'project', nativeFor: ['claude', 'copilot'] })
    // Every entry starts unresolved; discoverSkills is the one that stats them.
    expect(roots.every((root) => root.exists === false)).toBe(true)
  })
})

describe('discoverSkills', () => {
  it('collapses the same skill name found under two roots into one entry with unioned nativeFor', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'frontier-skills-cwd-'))
    const home = await mkdtemp(join(tmpdir(), 'frontier-skills-home-'))
    await writeSkill(join(cwd, '.claude', 'skills'), 'shared', 'Shared', 'from project claude skills')
    await writeSkill(join(home, '.agents', 'skills'), 'shared', 'shared', 'from personal agents skills')

    const catalog = await discoverSkills(cwd, { home })
    const shared = catalog.skills.find((skill) => skill.id === 'shared')
    expect(shared).toBeDefined()
    expect(shared!.sources).toHaveLength(2)
    const nativeFor = new Set(shared!.sources.flatMap((source) => source.nativeFor))
    expect(nativeFor).toEqual(new Set(['claude', 'copilot', 'codex', 'codex-oss']))
  })

  it('skips a folder that has no SKILL.md', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'frontier-skills-nofile-'))
    await mkdir(join(cwd, '.claude', 'skills', 'empty-folder'), { recursive: true })
    const catalog = await discoverSkills(cwd, { home: cwd, refresh: true })
    expect(catalog.skills).toEqual([])
  })

  it('reports a missing root as exists: false instead of throwing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'frontier-skills-missing-'))
    const catalog = await discoverSkills(cwd, { home: cwd })
    const copilotRoot = catalog.roots.find((root) => root.root === join(cwd, '.copilot', 'skills'))
    expect(copilotRoot).toMatchObject({ exists: false, scope: 'personal', nativeFor: ['copilot'] })
  })

  it('walks up from a nested cwd to find .agents/skills but stops at the .git boundary', async () => {
    // Isolate both "inside" and "above" the repo boundary under one temp dir,
    // rather than writing into the real system tmp root.
    const outside = await mkdtemp(join(tmpdir(), 'frontier-skills-outer-'))
    const repo = join(outside, 'repo')
    await mkdir(join(repo, '.git'), { recursive: true })
    await writeSkill(join(repo, '.agents', 'skills'), 'repo-skill', 'repo-skill', 'found by walking up')
    // A skill above the repo boundary must never be picked up.
    await writeSkill(join(outside, '.agents', 'skills'), 'outside-skill', 'outside-skill', 'above the repo root')

    const nestedCwd = join(repo, 'packages', 'app')
    await mkdir(nestedCwd, { recursive: true })
    const catalog = await discoverSkills(nestedCwd, { home: repo })

    expect(catalog.skills.some((skill) => skill.id === 'repo-skill')).toBe(true)
    expect(catalog.skills.some((skill) => skill.id === 'outside-skill')).toBe(false)
  })

  // A non-git cwd under $HOME makes the upward walk reach `~`, whose
  // `.agents/skills` is already a personal root. Scanning it twice would
  // duplicate every skill's source and relabel the root as project scope.
  it('does not scan ~/.agents/skills twice when a non-git cwd sits under home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'frontier-skills-home-walk-'))
    await writeSkill(join(home, '.agents', 'skills'), 'shared', 'shared', 'personal agents skill')
    const cwd = join(home, 'scratch')
    await mkdir(cwd, { recursive: true })

    const catalog = await discoverSkills(cwd, { home })
    const agentsRoot = join(home, '.agents', 'skills')
    expect(catalog.roots.filter((root) => root.root === agentsRoot)).toHaveLength(1)
    expect(catalog.roots.find((root) => root.root === agentsRoot)?.scope).toBe('personal')
    expect(catalog.skills.find((skill) => skill.id === 'shared')?.sources).toHaveLength(1)
  })

  it('prefers project-scope text over personal when the same skill is defined in both', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'frontier-skills-priority-cwd-'))
    const home = await mkdtemp(join(tmpdir(), 'frontier-skills-priority-home-'))
    await writeSkill(join(home, '.claude', 'skills'), 'dup', 'dup', 'personal description')
    await writeSkill(join(cwd, '.claude', 'skills'), 'dup', 'dup', 'project description')

    const catalog = await discoverSkills(cwd, { home })
    const dup = catalog.skills.find((skill) => skill.id === 'dup')
    expect(dup?.description).toBe('project description')
  })
})

describe('resolveSkills', () => {
  const catalog: SkillCatalog = {
    cwd: '/repo',
    scannedAt: new Date().toISOString(),
    roots: [],
    skills: [definition('a'), definition('b'), definition('c')]
  }

  it('enables everything not in the global disabled set by default', () => {
    const resolved = resolveSkills(catalog, { disabledIds: ['b'] })
    expect(resolved.map((skill) => [skill.id, skill.enabled])).toEqual([['a', true], ['b', false], ['c', true]])
  })

  it('lets a task-scoped selection override the global default in both directions', () => {
    // Globally disabled 'a' is turned back on for this task; globally enabled
    // 'c' is left out.
    const resolved = resolveSkills(catalog, { disabledIds: ['a'] }, ['a', 'b'])
    expect(resolved.map((skill) => [skill.id, skill.enabled])).toEqual([['a', true], ['b', true], ['c', false]])
  })

  it('ignores ids the catalog does not recognize', () => {
    const resolved = resolveSkills(catalog, { disabledIds: [] }, ['a', 'unknown-id'])
    expect(resolved.map((skill) => [skill.id, skill.enabled])).toEqual([['a', true], ['b', false], ['c', false]])
  })
})

describe('invalidateSkillCatalog', () => {
  it('forces a rescan instead of returning the cached catalog', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'frontier-skills-cache-'))
    await writeSkill(join(cwd, '.claude', 'skills'), 'first', 'first', 'present from the start')
    const initial = await discoverSkills(cwd, { home: cwd })
    expect(initial.skills.map((skill) => skill.id)).toEqual(['first'])

    await writeSkill(join(cwd, '.claude', 'skills'), 'second', 'second', 'added after the first scan')
    const stillCached = await discoverSkills(cwd, { home: cwd })
    expect(stillCached.skills.map((skill) => skill.id)).toEqual(['first'])

    invalidateSkillCatalog(cwd)
    const rescanned = await discoverSkills(cwd, { home: cwd })
    expect(rescanned.skills.map((skill) => skill.id).sort()).toEqual(['first', 'second'])
  })
})
