// Review — the branch inbox: checks, files and diff, merge and delete, for branches left behind by
// split & delegate, bench, and workspace runs. The check results are information for the person
// deciding; merging is never blocked on them (CLAUDE.md, Verification lane).
import type { BranchRepo, TaskBranch } from '../../../shared/types'
import { byId, element } from '../ui/dom'
import { sectionTitle, status, tag } from '../ui/components'
import { icon } from '../ui/icons'
import { confirmAction, errorMessage, reportError, showToast } from '../ui/feedback'
import { baseName, formatDuration, timeAgo } from '../ui/format'
import { highlightSourceLine, parseUnifiedDiff } from '../syntax'
import { verificationChip } from '../task-helpers'
import { onProjectChange, projectMatches } from '../project'

export let reviewRepos: BranchRepo[] = []
export let reviewLoaded = false
export let reviewSelection: { cwd: string; branch: string } | undefined
export let reviewFilePath: string | undefined
let reviewDiffRequest = 0
// cwd, branch and file of the diff on screen, so an unrelated re-render does not refetch and flash it.
let renderedDiffKey: string | undefined

// Listeners run after every inbox load (the Office view shows the pending count).
const reviewListeners: Array<() => void> = []
export function onReviewChange(listener: () => void): void { reviewListeners.push(listener) }

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
    renderedDiffKey = undefined
    renderReview()
    renderReviewBadge()
  } catch (error) {
    reviewLoaded = true
    if (showToastOnError) reportError('Could not read task branches', error)
  }
  reviewListeners.forEach((listener) => listener())
}

function selectedBranch(): TaskBranch | undefined {
  if (!reviewSelection) return undefined
  return reviewRepos.flatMap((repo) => repo.branches).find((branch) => branch.cwd === reviewSelection!.cwd && branch.branch === reviewSelection!.branch)
}

function repoFor(branch: TaskBranch): BranchRepo | undefined {
  return reviewRepos.find((repo) => repo.cwd === branch.cwd)
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json', md: 'markdown',
  css: 'css', scss: 'scss', html: 'xml', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  sh: 'bash', yml: 'yaml', yaml: 'yaml', sql: 'sql', toml: 'ini'
}

function languageFor(path: string): string {
  return LANGUAGE_BY_EXTENSION[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'plaintext'
}

function note(text: string): HTMLElement { return element('p', 'review-note', text) }

function emptyBlock(title: string, detail: string): HTMLElement {
  const empty = element('div', 'empty')
  empty.append(element('p', 'review-empty-title', title), element('p', undefined, detail))
  return empty
}

// The unified diff on the kit's `.diff`: one mono line-number column (the new line, or the old one for a
// deletion), a visible +/− marker so a change never depends on colour alone, hunks as muted rows.
function renderDiff(target: HTMLElement, diff: string, language: string): void {
  const rows = element('div', 'diff-in')
  for (const line of parseUnifiedDiff(diff)) {
    if (line.kind === 'header') continue
    const row = element('div', `diff-row${line.kind === 'addition' ? ' add' : line.kind === 'deletion' ? ' del' : line.kind === 'hunk' ? ' hunk' : ''}`)
    const code = element('code', 'diff-code')
    if (line.kind === 'hunk') code.textContent = line.source
    // highlight.js escapes source text and emits only span markup for token classes.
    else code.innerHTML = `${line.marker}${highlightSourceLine(line.source, language)}`
    row.append(element('span', 'diff-ln', String((line.kind === 'deletion' ? line.oldNumber : line.newNumber) ?? '')), code)
    rows.append(row)
  }
  target.replaceChildren(rows)
}

async function loadReviewDiff(branch: TaskBranch, path: string): Promise<void> {
  const request = ++reviewDiffRequest
  const target = byId('review-diff')
  target.replaceChildren(note('Loading diff…'))
  try {
    const diff = await window.frontier.readBranchFile(branch.cwd, branch.branch, path)
    if (request !== reviewDiffRequest) return
    if (!diff.trim()) { target.replaceChildren(note('No textual diff for this file.')); return }
    renderDiff(target, diff, languageFor(path))
  } catch (error) {
    if (request !== reviewDiffRequest) return
    renderedDiffKey = undefined
    target.replaceChildren(note(errorMessage(error)))
  }
}

// The checks that ran against this branch's worktree. `ran === false` means nothing was detected, which
// is not a pass, and the section says so instead of showing a tick.
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
  head.append(sectionTitle('Checks'), verificationChip(verification) ?? element('span'))
  const nodes: HTMLElement[] = [head]
  if (!verification.ran || !verification.checks.length) {
    nodes.push(note('Frontier found no test, lint, or typecheck command in this project, so nothing was run. That is not a passing result. Add one in Settings → Verification to check future branches.'))
  } else {
    for (const check of verification.checks) {
      const summary = element(check.output ? 'summary' : 'div', 'review-check-row')
      summary.append(
        status(check.ok ? 'ok' : 'danger', '', { ariaLabel: check.ok ? 'Passed' : 'Failed' }),
        element('span', 'review-check-name', check.name),
        element('span', 'review-check-command', check.command),
        element('span', 'review-check-time', `${check.timedOut ? 'timed out · ' : !check.ok ? `exit ${check.exitCode ?? 1} · ` : ''}${formatDuration(check.durationMs)}`)
      )
      if (!check.output) { nodes.push(summary); continue }
      const row = element('details', 'review-check') as HTMLDetailsElement
      row.open = !check.ok // the failing output is what the reviewer came for
      row.append(summary, element('pre', 'code review-check-output', check.output))
      nodes.push(row)
    }
  }
  host.replaceChildren(...nodes)
}

function branchRow(branch: TaskBranch): HTMLElement {
  const selected = reviewSelection?.branch === branch.branch && reviewSelection.cwd === branch.cwd
  const row = element('button', `row review-branch${selected ? ' is-selected' : ''}`) as HTMLButtonElement
  row.type = 'button'
  row.setAttribute('aria-current', String(selected))
  const main = element('div', 'row-main')
  const title = element('div', 'row-title', branch.subject); title.title = branch.subject
  const additions = branch.files.reduce((total, file) => total + file.additions, 0)
  const deletions = branch.files.reduce((total, file) => total + file.deletions, 0)
  main.append(title, element('div', 'row-meta review-meta', `${branch.files.length} file${branch.files.length === 1 ? '' : 's'} · +${additions} −${deletions} · ${timeAgo(branch.committedAt)}`))
  // A branch whose run predates verification has no report; say so rather than imply anything about it.
  main.append(verificationChip(branch.verification) ?? status('neutral', 'No checks recorded'))
  row.append(main)
  if (branch.merged) row.append(tag('merged'))
  row.addEventListener('click', () => { reviewSelection = { cwd: branch.cwd, branch: branch.branch }; reviewFilePath = undefined; renderReview() })
  return row
}

function renderList(): void {
  const list = byId('review-list')
  const scopedRepos = reviewRepos.filter((repo) => projectMatches(repo.cwd))
  if (!reviewLoaded) { list.replaceChildren(note('Looking for task branches…')); return }
  if (!scopedRepos.length) {
    list.replaceChildren(emptyBlock('No branches to review', 'Split & delegate and Compare runs commit their work to isolated branches. They will appear here.'))
    return
  }
  const nodes: HTMLElement[] = []
  for (const repo of scopedRepos) {
    const head = element('div', 'review-repo')
    head.append(element('strong', 'review-repo-name', repo.name), element('span', 'review-repo-branch', `on ${repo.currentBranch}`))
    if (repo.dirty) { const dirty = status('warn', 'uncommitted changes'); dirty.classList.add('review-repo-dirty'); head.append(dirty) }
    head.title = repo.cwd
    nodes.push(head)
    for (const branch of repo.branches) nodes.push(branchRow(branch))
  }
  list.replaceChildren(...nodes)
}

function branchActions(branch: TaskBranch, repo: BranchRepo | undefined): HTMLElement {
  const controls = element('div', 'review-actions')
  const remove = element('button', 'btn btn-danger') as HTMLButtonElement
  remove.type = 'button'
  remove.append(icon('trash', 16), 'Delete branch')
  remove.addEventListener('click', async () => {
    const confirmed = await confirmAction('Delete this branch?', `${branch.branch} and its commits will be deleted from ${branch.cwd}. This cannot be undone.`, 'Delete')
    if (!confirmed) return
    try {
      reviewRepos = await window.frontier.deleteBranch(branch.cwd, branch.branch)
      reviewSelection = undefined; reviewFilePath = undefined
      showToast('Branch deleted'); renderReview(); renderReviewBadge()
    } catch (error) { reportError('Could not delete branch', error) }
  })
  controls.append(remove)
  if (branch.merged) { controls.append(tag('already merged')); return controls }
  const merge = element('button', 'btn btn-primary') as HTMLButtonElement
  merge.type = 'button'
  merge.append(icon('merge', 16), `Merge into ${repo?.currentBranch ?? 'HEAD'}`)
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
    try { reviewRepos = await window.frontier.mergeBranch(branch.cwd, branch.branch); showToast(`Merged ${branch.branch}`); renderReview(); renderReviewBadge() }
    catch (error) { reportError('Merge failed', error); merge.disabled = false }
  })
  controls.append(merge)
  return controls
}

function fileRow(file: TaskBranch['files'][number]): HTMLElement {
  const selected = file.path === reviewFilePath
  const row = element('button', `row review-file${selected ? ' is-selected' : ''}`) as HTMLButtonElement
  row.type = 'button'
  row.setAttribute('aria-current', String(selected))
  const top = element('span', 'review-file-top')
  top.append(tag(file.action === 'create' ? 'new' : file.action === 'delete' ? 'deleted' : 'edit'), element('span', 'review-file-name', baseName(file.path)), element('span', 'review-file-stat', `+${file.additions} −${file.deletions}`))
  const path = element('span', 'review-file-path', file.path); path.title = file.path
  row.append(top, path)
  row.addEventListener('click', () => { reviewFilePath = file.path; renderReview() })
  return row
}

export function renderReview(): void {
  renderList()

  const branch = selectedBranch()
  const title = byId('review-branch-title')
  const subtitle = byId('review-branch-subtitle')
  const actions = byId('review-branch-actions')
  const files = byId('review-files')
  const diff = byId('review-diff')
  diff.parentElement?.classList.toggle('is-empty', !branch)

  if (!branch) {
    title.textContent = 'Select a branch'
    subtitle.textContent = ''
    actions.replaceChildren(); files.replaceChildren()
    byId('review-checks').hidden = true
    diff.replaceChildren(emptyBlock('Nothing selected', 'Choose a branch to see its checks, changed files and diff.'))
    renderedDiffKey = undefined
    return
  }
  const repo = repoFor(branch)
  title.textContent = branch.subject
  subtitle.textContent = `${branch.branch} · ${repo?.name ?? ''}`
  subtitle.title = branch.cwd
  actions.replaceChildren(branchActions(branch, repo))
  renderReviewChecks(branch)

  if (!branch.files.length) {
    files.replaceChildren(note('This branch changes no files.'))
    diff.replaceChildren()
    renderedDiffKey = undefined
    return
  }
  if (!reviewFilePath || !branch.files.some((file) => file.path === reviewFilePath)) reviewFilePath = branch.files[0].path
  files.replaceChildren(...branch.files.map((file) => fileRow(file)))
  diff.setAttribute('aria-label', `Diff for ${reviewFilePath}`)
  const key = `${branch.cwd}\n${branch.branch}\n${reviewFilePath}`
  if (key !== renderedDiffKey) { renderedDiffKey = key; void loadReviewDiff(branch, reviewFilePath) }
}

// The dock's Review badge: unmerged branches in the current project, hidden at zero. Its own
// writer (it used to be a side effect of renderHome), called from loadReview and every render.
// Unmerged branches in the current project scope.
export function reviewPendingCount(): number {
  return reviewRepos.filter((repo) => projectMatches(repo.cwd)).reduce((sum, repo) => sum + repo.branches.filter((branch) => !branch.merged).length, 0)
}

export function renderReviewBadge(): void {
  const count = reviewPendingCount()
  const badge = byId('nav-review-count')
  badge.hidden = count === 0
  badge.textContent = String(count)
  const item = badge.closest<HTMLElement>('.nav-item')
  item?.setAttribute('aria-label', count ? `Review, ${count} branch${count === 1 ? '' : 'es'} waiting` : 'Review')
}

export function initReviewView(): void {
  onProjectChange(() => { renderReview(); renderReviewBadge() })
  byId('review-refresh').addEventListener('click', () => void loadReview(true))
}
