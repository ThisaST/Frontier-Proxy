import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { branchFileDiff, deleteTaskBranch, isTaskBranch, listBranchInbox, listRepoBranches, mergeTaskBranch } from '../src/main/branches'

const run = promisify(execFile)
const AUTHOR = ['-c', 'user.name=Frontier Tests', '-c', 'user.email=tests@frontier.local']

// A repo with one Frontier task branch carrying a new file and an edit, exactly
// as an orchestrated subtask leaves it behind.
async function repoWithTaskBranch(): Promise<{ cwd: string; branch: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'frontier-branches-'))
  await run('git', ['init', '-b', 'main'], { cwd })
  await writeFile(join(cwd, 'app.js'), 'const a = 1\n')
  await run('git', ['add', '-A'], { cwd })
  await run('git', [...AUTHOR, 'commit', '-m', 'init'], { cwd })

  const branch = 'frontier/abc12345/1-add-docs'
  await run('git', ['checkout', '-b', branch], { cwd })
  await writeFile(join(cwd, 'DOCS.md'), '# Docs\nline two\n')
  await writeFile(join(cwd, 'app.js'), 'const a = 2\n')
  await run('git', ['add', '-A'], { cwd })
  await run('git', [...AUTHOR, 'commit', '-m', 'Frontier subtask: Add docs'], { cwd })
  await run('git', ['checkout', 'main'], { cwd })
  return { cwd, branch }
}

describe('task branch inbox', () => {
  it('lists Frontier branches with their commit, distance, and file changes', async () => {
    const { cwd, branch } = await repoWithTaskBranch()
    const repo = await listRepoBranches(cwd)

    expect(repo?.name).toBeTruthy()
    expect(repo?.currentBranch).toBe('main')
    expect(repo?.dirty).toBe(false)
    expect(repo?.branches).toHaveLength(1)
    const entry = repo!.branches[0]
    expect(entry.branch).toBe(branch)
    expect(entry.taskId).toBe('abc12345')
    expect(entry.subject).toBe('Frontier subtask: Add docs')
    expect(entry.ahead).toBe(1)
    expect(entry.merged).toBe(false)
    expect(entry.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'DOCS.md', action: 'create', additions: 2, deletions: 0 }),
      expect.objectContaining({ path: 'app.js', action: 'edit', additions: 1, deletions: 1 })
    ]))
  })

  it('ignores repositories with no Frontier branches and non-repositories', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'frontier-plain-'))
    expect(await listRepoBranches(plain)).toBeUndefined()
    const { cwd } = await repoWithTaskBranch()
    expect((await listBranchInbox([cwd, plain, cwd])).map((repo) => repo.cwd)).toEqual([cwd])
  })

  it('produces a unified diff for one file on the branch', async () => {
    const { cwd, branch } = await repoWithTaskBranch()
    const diff = await branchFileDiff(cwd, branch, 'DOCS.md')
    expect(diff).toContain('+++ b/DOCS.md')
    expect(diff).toContain('+# Docs')
  })

  it('merges a branch into the checkout and reports it merged afterwards', async () => {
    const { cwd, branch } = await repoWithTaskBranch()
    await mergeTaskBranch(cwd, branch)
    const repo = await listRepoBranches(cwd)
    expect(repo?.branches[0].merged).toBe(true)
    expect(repo?.branches[0].ahead).toBe(0)
  })

  // Merging rewrites the working tree, so uncommitted work must not be at risk.
  it('refuses to merge while the checkout has uncommitted changes', async () => {
    const { cwd, branch } = await repoWithTaskBranch()
    await writeFile(join(cwd, 'app.js'), 'const a = 99\n')
    await expect(mergeTaskBranch(cwd, branch)).rejects.toThrow('Commit or stash')
  })

  it('deletes a branch once it is no longer wanted', async () => {
    const { cwd, branch } = await repoWithTaskBranch()
    await deleteTaskBranch(cwd, branch)
    expect(await listRepoBranches(cwd)).toBeUndefined()
  })

  // The inbox must never be able to touch a branch the user made themselves.
  it('only ever acts on frontier/ branches', async () => {
    const { cwd } = await repoWithTaskBranch()
    expect(isTaskBranch('frontier/abc/1-x')).toBe(true)
    expect(isTaskBranch('main')).toBe(false)
    expect(isTaskBranch('feature/frontier/x')).toBe(false)
    await expect(mergeTaskBranch(cwd, 'main')).rejects.toThrow('Only Frontier task branches')
    await expect(deleteTaskBranch(cwd, 'main')).rejects.toThrow('Only Frontier task branches')
    await expect(branchFileDiff(cwd, '../evil', 'app.js')).rejects.toThrow('Only Frontier task branches')
  })
})
