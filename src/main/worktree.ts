import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 5_000 })
    return stdout.trim() === 'true'
  } catch { return false }
}

// Create an isolated worktree off HEAD on a fresh branch, so a subtask can edit
// files without colliding with siblings. Returns the worktree directory.
export async function createWorktree(repoCwd: string, branch: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'frontier-wt-'))
  await run('git', ['worktree', 'add', '--force', '-b', branch, dir, 'HEAD'], { cwd: repoCwd, timeout: 30_000 })
  return dir
}

// Commit whatever the subtask changed so the work survives worktree removal.
// Returns true if a commit was made (false when there was nothing to commit).
export async function commitWorktree(dir: string, message: string): Promise<boolean> {
  try {
    await run('git', ['add', '-A'], { cwd: dir, timeout: 30_000 })
    await run('git', ['-c', 'user.name=Frontier Proxy', '-c', 'user.email=frontier@local', 'commit', '-m', message, '--no-verify'], { cwd: dir, timeout: 30_000 })
    return true
  } catch { return false }
}

export async function removeWorktree(repoCwd: string, dir: string): Promise<void> {
  try { await run('git', ['worktree', 'remove', '--force', dir], { cwd: repoCwd, timeout: 30_000 }) }
  catch { await rm(dir, { recursive: true, force: true }).catch(() => undefined) }
}

// Turn a subtask title into a git-safe branch segment.
export function branchSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'subtask'
}
