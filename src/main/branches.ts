import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type { BranchFileChange, BranchRepo, TaskBranch } from '../shared/types'

const run = promisify(execFile)
const OPTIONS = { encoding: 'utf8' as const, timeout: 30_000, maxBuffer: 8_000_000 }

// Orchestration commits every subtask onto a `frontier/<task>/<n>-<slug>` branch.
// Only those branches are ever listed, merged, or deleted here — a branch the
// user created themselves is never a candidate for destructive actions.
const BRANCH_PREFIX = 'frontier/'

export function isTaskBranch(branch: string): boolean {
  return branch.startsWith(BRANCH_PREFIX) && !branch.includes('..') && !branch.includes(' ')
}

function assertTaskBranch(branch: string): void {
  if (!isTaskBranch(branch)) throw new Error('Only Frontier task branches can be modified from here.')
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], OPTIONS)
  return stdout
}

async function gitOrEmpty(cwd: string, args: string[]): Promise<string> {
  try { return await git(cwd, args) } catch { return '' }
}

// Files a branch would bring in, measured from its merge base with HEAD so an
// unrelated commit on the main branch is not reported as part of the subtask.
async function branchFiles(cwd: string, branch: string): Promise<BranchFileChange[]> {
  const [names, counts] = await Promise.all([
    gitOrEmpty(cwd, ['diff', '--name-status', '-z', `HEAD...${branch}`]),
    gitOrEmpty(cwd, ['diff', '--numstat', '-z', `HEAD...${branch}`])
  ])
  const sizes = new Map<string, { additions: number; deletions: number }>()
  const numstat = counts.split('\0').filter(Boolean)
  for (let index = 0; index < numstat.length; index += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(numstat[index])
    if (!match) continue
    // A rename emits its two paths as the following records.
    const path = match[3] || numstat[index += 2] || ''
    if (path) sizes.set(path, { additions: Number(match[1]) || 0, deletions: Number(match[2]) || 0 })
  }

  const records = names.split('\0').filter(Boolean)
  const files: BranchFileChange[] = []
  for (let index = 0; index < records.length; index += 1) {
    const status = records[index]
    if (!/^[A-Z]/.test(status)) continue
    const path = status.startsWith('R') || status.startsWith('C') ? records[index += 2] : records[++index]
    if (!path) continue
    const action: BranchFileChange['action'] = status.startsWith('A') ? 'create' : status.startsWith('D') ? 'delete' : 'edit'
    files.push({ path, action, ...(sizes.get(path) ?? { additions: 0, deletions: 0 }) })
  }
  return files
}

export async function listRepoBranches(cwd: string): Promise<BranchRepo | undefined> {
  const inside = (await gitOrEmpty(cwd, ['rev-parse', '--is-inside-work-tree'])).trim()
  if (inside !== 'true') return undefined

  const listed = await gitOrEmpty(cwd, ['for-each-ref', '--format=%(refname:short)%09%(committerdate:iso-strict)%09%(contents:subject)', `refs/heads/${BRANCH_PREFIX}`])
  const rows = listed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!rows.length) return undefined

  const [currentBranch, status, mergedList] = await Promise.all([
    gitOrEmpty(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitOrEmpty(cwd, ['status', '--porcelain']),
    gitOrEmpty(cwd, ['branch', '--merged', 'HEAD', '--list', `${BRANCH_PREFIX}*`])
  ])
  const merged = new Set(mergedList.split(/\r?\n/).map((line) => line.replace(/^[*+]?\s*/, '').trim()).filter(Boolean))

  const branches: TaskBranch[] = []
  for (const row of rows) {
    const [branch, committedAt, ...rest] = row.split('\t')
    if (!isTaskBranch(branch)) continue
    const ahead = Number((await gitOrEmpty(cwd, ['rev-list', '--count', `HEAD..${branch}`])).trim()) || 0
    branches.push({
      cwd,
      branch,
      taskId: branch.split('/')[1],
      subject: rest.join('\t') || branch,
      committedAt: committedAt || new Date().toISOString(),
      ahead,
      merged: merged.has(branch),
      files: await branchFiles(cwd, branch)
    })
  }
  branches.sort((left, right) => right.committedAt.localeCompare(left.committedAt))
  return { cwd, name: basename(cwd) || cwd, currentBranch: currentBranch.trim() || 'HEAD', dirty: Boolean(status.trim()), branches }
}

export async function listBranchInbox(cwds: string[]): Promise<BranchRepo[]> {
  const unique = [...new Set(cwds)]
  const repos = await Promise.all(unique.map((cwd) => listRepoBranches(cwd).catch(() => undefined)))
  return repos.filter((repo): repo is BranchRepo => Boolean(repo))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export async function branchFileDiff(cwd: string, branch: string, path: string): Promise<string> {
  assertTaskBranch(branch)
  return await gitOrEmpty(cwd, ['diff', '--no-ext-diff', '--unified=4', `HEAD...${branch}`, '--', path])
}

// Merging rewrites the user's checkout, so refuse on a dirty tree rather than
// risk mixing their uncommitted work into a merge or a conflict.
export async function mergeTaskBranch(cwd: string, branch: string): Promise<{ merged: boolean; message: string }> {
  assertTaskBranch(branch)
  const status = await gitOrEmpty(cwd, ['status', '--porcelain'])
  if (status.trim()) throw new Error('Commit or stash your current changes before merging this branch.')
  try {
    await git(cwd, ['merge', '--no-ff', '-m', `Merge Frontier subtask ${branch}`, branch])
    return { merged: true, message: `Merged ${branch}` }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (/conflict/i.test(detail)) {
      await gitOrEmpty(cwd, ['merge', '--abort'])
      throw new Error(`${branch} conflicts with your current branch. The merge was aborted; resolve it in your terminal.`)
    }
    throw new Error(detail)
  }
}

export async function deleteTaskBranch(cwd: string, branch: string): Promise<void> {
  assertTaskBranch(branch)
  await git(cwd, ['branch', '-D', branch])
}
