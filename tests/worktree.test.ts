import { afterAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchSlug, commitWorktree, createWorktree, isGitRepo, removeWorktree } from '../src/main/worktree'

const run = promisify(execFile)
const cleanup: string[] = []

afterAll(async () => { for (const dir of cleanup) await rm(dir, { recursive: true, force: true }).catch(() => undefined) })

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'frontier-repo-'))
  cleanup.push(dir)
  await run('git', ['init', '-b', 'main'], { cwd: dir })
  await run('git', ['config', 'user.email', 't@t'], { cwd: dir })
  await run('git', ['config', 'user.name', 'T'], { cwd: dir })
  await writeFile(join(dir, 'seed.txt'), 'seed')
  await run('git', ['add', '-A'], { cwd: dir })
  await run('git', ['commit', '-m', 'init'], { cwd: dir })
  return dir
}

describe('worktree isolation', () => {
  it('slugs titles into git-safe branch segments', () => {
    expect(branchSlug('Fix the Login Page!')).toBe('fix-the-login-page')
    expect(branchSlug('   ')).toBe('subtask')
  })

  it('detects git vs non-git directories', async () => {
    const repo = await makeRepo()
    const plain = await mkdtemp(join(tmpdir(), 'frontier-plain-')); cleanup.push(plain)
    expect(await isGitRepo(repo)).toBe(true)
    expect(await isGitRepo(plain)).toBe(false)
  })

  it('creates an isolated worktree, commits changes, and tears it down leaving the branch', async () => {
    const repo = await makeRepo()
    const dir = await createWorktree(repo, 'frontier/test/1-feature')
    expect((await stat(dir)).isDirectory()).toBe(true)

    // Edit inside the worktree — the main tree is untouched.
    await writeFile(join(dir, 'new-file.txt'), 'from subtask')
    expect(await commitWorktree(dir, 'subtask work')).toBe(true)

    await removeWorktree(repo, dir)
    await expect(stat(dir)).rejects.toThrow() // worktree dir gone

    // The branch still holds the commit.
    const { stdout } = await run('git', ['log', '--oneline', 'frontier/test/1-feature'], { cwd: repo })
    expect(stdout).toContain('subtask work')
    // The main working tree never received the file.
    await expect(stat(join(repo, 'new-file.txt'))).rejects.toThrow()
  })

  it('reports no commit when the worktree has no changes', async () => {
    const repo = await makeRepo()
    const dir = await createWorktree(repo, 'frontier/test/2-noop')
    expect(await commitWorktree(dir, 'nothing')).toBe(false)
    await removeWorktree(repo, dir)
  })
})
