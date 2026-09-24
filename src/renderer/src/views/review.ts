// Review — the branch inbox: diff, merge, and delete branches left behind by
// split & delegate, bench, and workspace runs.
import type { BranchRepo, TaskBranch } from '../../../shared/types'
import { byId, element, emptyState, renderDiffInto } from '../ui/dom'
import { lamp } from '../ui/components'
import { confirmAction, errorMessage, reportError, showToast } from '../ui/feedback'
import { baseName, formatDuration, timeAgo } from '../ui/format'
import { verificationChip } from '../task-helpers'
import { renderHome } from './home'

export let reviewRepos: BranchRepo[] = []
export let reviewLoaded = false
export let reviewSelection: { cwd: string; branch: string } | undefined
export let reviewFilePath: string | undefined
let reviewDiffRequest = 0

export function setReviewSelection(selection: { cwd: string; branch: string } | undefined): void { reviewSelection = selection }
export function setReviewFilePath(path: string | undefined): void { reviewFilePath = path }

export async function loadReview(showToastOnError = false): Promise<void> {
  try {
    reviewRepos = await window.frontier.listBranchInbox()
    reviewLoaded = true
    if (reviewSelection && !reviewRepos.some((repo) => repo.branches.some((branch) => branch.cwd === reviewSelection!.cwd && branch.branch === reviewSelection!.branch))) {
      reviewSelection = undefined
      reviewFilePath = undefined
    }
    renderReview()
    renderHome()
  } catch (error) {
    reviewLoaded = true
    if (showToastOnError) reportError('Could not read task branches', error)
  }
}

function selectedBranch(): TaskBranch | undefined {
  if (!reviewSelection) return undefined
  return reviewRepos.flatMap((repo) => repo.branches).find((branch) => branch.cwd === reviewSelection!.cwd && branch.branch === reviewSelection!.branch)
}

function repoFor(branch: TaskBranch): BranchRepo | undefined {
  return reviewRepos.find((repo) => repo.cwd === branch.cwd)
}

async function loadReviewDiff(branch: TaskBranch, path: string): Promise<void> {
  const request = ++reviewDiffRequest
  const target = byId('review-diff')
  target.replaceChildren(element('div', 'detail-empty', 'Loading diff…'))
  try {
    const diff = await window.frontier.readBranchFile(branch.cwd, branch.branch, path)
    if (request !== reviewDiffRequest) return
    if (!diff.trim()) { target.replaceChildren(element('div', 'detail-empty', 'No textual diff for this file.')); return }
    renderDiffInto(target, diff, languageFor(path))
  } catch (error) {
    if (request !== reviewDiffRequest) return
    target.replaceChildren(element('div', 'detail-empty', errorMessage(error)))
  }
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json', md: 'markdown',
  css: 'css', scss: 'scss', html: 'xml', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  sh: 'bash', yml: 'yaml', yaml: 'yaml', sql: 'sql', toml: 'ini'
}

function languageFor(path: string): string {
  return LANGUAGE_BY_EXTENSION[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'plaintext'
}

// The checks that ran against this branch's worktree, and why the merge button
// should or should not be trusted. Merging is never blocked on them: the checks
// are information for the person deciding, not a gate Frontier enforces.
function renderReviewChecks(branch: TaskBranch): void {
  const host = byId('review-checks')
  const verification = branch.verification
  if (!verification) {
    host.replaceChildren()
    host.hidden = true
    return
  }
  host.hidden = false
  const head = element('div', 'review-checks-head')
  head.append(
    element('strong', undefined, 'Checks on this branch'),
    verificationChip(verification) ?? element('span')
  )
  const nodes: HTMLElement[] = [head]
  if (!verification.ran) {
    nodes.push(element('div', 'review-checks-empty', 'Frontier found no test, lint, or typecheck command in this project, so nothing was run. Add one in Settings → Verification to check future branches.'))
  } else {
    for (const check of verification.checks) {
      const row = element('details', `review-check ${check.ok ? 'pass' : 'fail'}`)
      const summary = element('summary')
      summary.append(
        lamp(check.ok ? 'phosphor' : 'alarm', check.ok ? 'Passed' : 'Failed'),
        element('strong', undefined, check.name),
        element('code', undefined, check.command),
        element('span', 'review-check-meta', `${check.timedOut ? 'timed out' : check.ok ? 'passed' : `exit ${check.exitCode ?? 1}`} · ${formatDuration(check.durationMs)}`)
      )
      row.append(summary)
      if (check.output) row.append(element('pre', 'review-check-output', check.output))
      nodes.push(row)
    }
  }
  host.replaceChildren(...nodes)
}

export function renderReview(): void {
  const list = byId('review-list')
  if (!reviewLoaded) {
    list.replaceChildren(element('div', 'detail-empty', 'Looking for task branches…'))
  } else if (!reviewRepos.length) {
    list.replaceChildren(emptyState('No branches to review', 'Split & delegate and Compare runs commit their work to isolated branches. They will appear here.'))
  } else {
    const nodes: HTMLElement[] = []
    for (const repo of reviewRepos) {
      const head = element('div', 'review-repo')
      head.append(element('strong', undefined, repo.name), element('small', undefined, `on ${repo.currentBranch}${repo.dirty ? ' · uncommitted changes' : ''}`))
      head.title = repo.cwd
      nodes.push(head)
      for (const branch of repo.branches) {
        const row = element('button', `review-branch${branch.merged ? ' merged' : ''}${reviewSelection?.branch === branch.branch && reviewSelection.cwd === branch.cwd ? ' active' : ''}`)
        const body = element('div', 'review-branch-body')
        body.append(element('strong', undefined, branch.subject))
        const additions = branch.files.reduce((total, file) => total + file.additions, 0)
        const deletions = branch.files.reduce((total, file) => total + file.deletions, 0)
        body.append(element('small', undefined, `${branch.files.length} file${branch.files.length === 1 ? '' : 's'} · +${additions} −${deletions} · ${timeAgo(branch.committedAt)}`))
        const rowChip = verificationChip(branch.verification)
        if (rowChip) body.append(rowChip)
        row.append(body)
        if (branch.merged) row.append(element('span', 'review-merged-chip', 'merged'))
        row.addEventListener('click', () => { reviewSelection = { cwd: branch.cwd, branch: branch.branch }; reviewFilePath = undefined; renderReview() })
        nodes.push(row)
      }
    }
    list.replaceChildren(...nodes)
  }

  const branch = selectedBranch()
  const title = byId('review-branch-title')
  const subtitle = byId('review-branch-subtitle')
  const actions = byId('review-branch-actions')
  const files = byId('review-files')
  const diff = byId('review-diff')

  if (!branch) {
    title.textContent = 'Select a branch'
    subtitle.textContent = ''
    actions.replaceChildren(); files.replaceChildren(); diff.replaceChildren()
    return
  }
  const repo = repoFor(branch)
  title.textContent = branch.subject
  subtitle.textContent = `${branch.branch} · ${repo?.name ?? ''}`
  subtitle.title = branch.cwd

  const controls = element('div', 'output-actions-inner')
  if (branch.merged) {
    controls.append(element('span', 'review-merged-chip', 'already merged'))
  } else {
    const merge = element('button', 'primary-button', `Merge into ${repo?.currentBranch ?? 'HEAD'}`) as HTMLButtonElement
    merge.disabled = Boolean(repo?.dirty)
    merge.title = repo?.dirty ? 'Commit or stash your changes first' : `Merge ${branch.branch}`
    merge.addEventListener('click', async () => {
      const confirmed = await confirmAction(
        'Merge this branch?',
        `${branch.branch} will be merged into ${repo?.currentBranch ?? 'HEAD'} in ${branch.cwd}. This changes files in your repository.`,
        'Merge'
      )
      if (!confirmed) return
      merge.disabled = true
      try { reviewRepos = await window.frontier.mergeBranch(branch.cwd, branch.branch); showToast(`Merged ${branch.branch}`); renderReview(); renderHome() }
      catch (error) { reportError('Merge failed', error); merge.disabled = false }
    })
    controls.append(merge)
  }
  const remove = element('button', 'text-button', 'Delete branch')
  remove.addEventListener('click', async () => {
    const confirmed = await confirmAction('Delete this branch?', `${branch.branch} and its commits will be deleted from ${branch.cwd}. This cannot be undone.`, 'Delete')
    if (!confirmed) return
    try {
      reviewRepos = await window.frontier.deleteBranch(branch.cwd, branch.branch)
      reviewSelection = undefined; reviewFilePath = undefined
      showToast('Branch deleted'); renderReview(); renderHome()
    } catch (error) { reportError('Could not delete branch', error) }
  })
  controls.append(remove)
  actions.replaceChildren(controls)

  renderReviewChecks(branch)

  if (!branch.files.length) {
    files.replaceChildren(element('div', 'detail-empty', 'This branch changes no files.'))
    diff.replaceChildren()
    return
  }
  if (!reviewFilePath || !branch.files.some((file) => file.path === reviewFilePath)) reviewFilePath = branch.files[0].path
  files.replaceChildren(...branch.files.map((file) => {
    const row = element('button', `review-file${file.path === reviewFilePath ? ' active' : ''}`)
    row.append(
      element('span', `file-badge ${file.action}`, file.action === 'create' ? 'NEW' : file.action === 'delete' ? 'DEL' : 'EDIT'),
      (() => { const body = element('span', 'review-file-body'); body.append(element('strong', undefined, baseName(file.path)), element('small', undefined, file.path)); return body })(),
      element('span', 'review-file-stat', `+${file.additions} −${file.deletions}`)
    )
    row.addEventListener('click', () => { reviewFilePath = file.path; renderReview() })
    return row
  }))
  void loadReviewDiff(branch, reviewFilePath)
}

export function initReviewView(): void {
  byId('review-refresh').addEventListener('click', () => void loadReview(true))
}
