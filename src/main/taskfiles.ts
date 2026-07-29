import { execFile } from 'node:child_process'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ChatContextItem, FileChange, TaskFileContent, TaskWorkspaceSnapshot, WorkspaceEntry } from '../shared/types'

const execFileAsync = promisify(execFile)
const MAX_FILE_BYTES = 1_000_000
const MAX_CONTEXT_ITEMS = 12
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const IGNORED_WORKSPACE_NAMES = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache'])
const IGNORED_TASK_TREE_NAMES = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'coverage', '.next', '.turbo', '.cache', 'out', 'release'])
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const LANGUAGES: Record<string, string> = {
  '.bash': 'bash', '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cs': 'csharp', '.css': 'css',
  '.go': 'go', '.h': 'cpp', '.hpp': 'cpp', '.html': 'xml', '.java': 'java', '.js': 'javascript',
  '.jsx': 'javascript', '.json': 'json', '.md': 'markdown', '.mjs': 'javascript', '.php': 'php',
  '.py': 'python', '.rb': 'ruby', '.rs': 'rust', '.scss': 'scss', '.sh': 'bash', '.sql': 'sql',
  '.swift': 'swift', '.toml': 'ini', '.ts': 'typescript', '.tsx': 'typescript', '.vue': 'xml',
  '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml', '.zsh': 'bash'
}

export function languageForPath(path: string): string {
  return LANGUAGES[extname(path).toLowerCase()] ?? 'plaintext'
}

async function collectWorkspaceEntries(cwd: string, query: string, ignoredNames: Set<string>, maxEntries: number): Promise<WorkspaceEntry[]> {
  const root = resolve(cwd)
  const rootInfo = await stat(root)
  if (!rootInfo.isDirectory()) throw new Error('Choose a valid working directory before referencing files.')
  const normalized = query.trim().toLowerCase().replace(/^@/, '')
  const entries: WorkspaceEntry[] = []
  const pending: Array<{ absolute: string; relative: string; depth: number }> = [{ absolute: root, relative: '', depth: 0 }]
  let visited = 0

  while (pending.length && visited < maxEntries) {
    const directory = pending.shift()!
    let children
    try { children = await readdir(directory.absolute, { withFileTypes: true }) } catch { continue }
    children.sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
    for (const child of children) {
      visited += 1
      if (visited >= maxEntries) break
      if (ignoredNames.has(child.name)) continue
      const path = directory.relative ? `${directory.relative}/${child.name}` : child.name
      const kind = child.isDirectory() ? 'folder' as const : 'file' as const
      if (!normalized || path.toLowerCase().includes(normalized)) entries.push({ kind, name: child.name, path })
      if (child.isDirectory()) pending.push({ absolute: resolve(directory.absolute, child.name), relative: path, depth: directory.depth + 1 })
    }
  }

  return entries
    .sort((left, right) => {
      const leftExact = left.path.toLowerCase().startsWith(normalized) ? 0 : 1
      const rightExact = right.path.toLowerCase().startsWith(normalized) ? 0 : 1
      return leftExact - rightExact || Number(right.kind === 'folder') - Number(left.kind === 'folder') || left.path.localeCompare(right.path)
    })
}

export async function listWorkspaceEntries(cwd: string, query: string): Promise<WorkspaceEntry[]> {
  return (await collectWorkspaceEntries(cwd, query, IGNORED_WORKSPACE_NAMES, 4_000)).slice(0, 40)
}

async function workingTreeChanges(cwd: string): Promise<FileChange[]> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      encoding: 'utf8', maxBuffer: 4_000_000
    })
    const records = stdout.split('\0')
    const changes: FileChange[] = []
    const at = new Date().toISOString()
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]
      if (!record || record.length < 4) continue
      const status = record.slice(0, 2)
      const path = record.slice(3).replaceAll('\\', '/')
      const action: FileChange['action'] = status === '??' || status.includes('A')
        ? 'create'
        : status.includes('D') ? 'delete' : 'edit'
      changes.push({ path, action, at })
      // Porcelain -z emits the source path as a second record for renames/copies.
      if (status.includes('R') || status.includes('C')) index += 1
    }
    return changes
  } catch { return [] }
}

export async function loadTaskWorkspace(cwd: string, recordedChanges: FileChange[]): Promise<TaskWorkspaceSnapshot> {
  const [entries, gitChanges] = await Promise.all([
    collectWorkspaceEntries(cwd, '', IGNORED_TASK_TREE_NAMES, 20_000),
    workingTreeChanges(cwd)
  ])
  const root = resolve(cwd)
  const changes = new Map<string, FileChange>()
  for (const change of recordedChanges) {
    const absolute = resolve(root, change.path)
    const workspacePath = relative(root, absolute)
    if (!workspacePath || workspacePath.startsWith('..') || isAbsolute(workspacePath)) continue
    changes.set(absolute, { ...change, path: workspacePath.replaceAll('\\', '/') })
  }
  for (const change of gitChanges) {
    const key = resolve(root, change.path)
    const recorded = changes.get(key)
    changes.set(key, recorded ? { ...change, at: recorded.at } : change)
  }
  return { entries, changes: [...changes.values()] }
}

export async function validateChatContext(cwd: string, items: ChatContextItem[] = []): Promise<ChatContextItem[]> {
  if (items.length > MAX_CONTEXT_ITEMS) throw new Error(`Attach no more than ${MAX_CONTEXT_ITEMS} items to one message.`)
  const root = resolve(cwd)
  const validated: ChatContextItem[] = []
  const ids = new Set<string>()

  for (const item of items) {
    if (!item?.id || ids.has(item.id)) continue
    ids.add(item.id)
    if (item.kind === 'image') {
      if (!isAbsolute(item.path) || !IMAGE_MIME_TYPES.has(item.mimeType ?? '')) throw new Error('Only PNG, JPEG, GIF, and WebP images can be attached.')
      const info = await stat(item.path)
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error('Attached images must be files smaller than 20 MB.')
      validated.push({ id: item.id, kind: 'image', name: item.name || item.path.split(/[\\/]/).pop() || 'image', path: item.path, mimeType: item.mimeType })
      continue
    }

    if (isAbsolute(item.path)) throw new Error('File and folder references must be inside the task workspace.')
    const absolute = resolve(root, item.path)
    const relativePath = relative(root, absolute)
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error('A referenced item is outside this task workspace.')
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(absolute)])
    const realRelative = relative(realRoot, realTarget)
    if (!realRelative || realRelative.startsWith('..') || isAbsolute(realRelative)) throw new Error('A referenced item resolves outside this task workspace.')
    const info = await stat(realTarget)
    if ((item.kind === 'folder') !== info.isDirectory()) throw new Error(`Referenced ${item.kind} no longer matches the workspace item.`)
    validated.push({ id: item.id, kind: item.kind, name: item.name || relativePath.split('/').pop() || relativePath, path: relativePath.replaceAll('\\', '/') })
  }
  return validated
}

export function contextPrompt(cwd: string, items: ChatContextItem[]): string {
  if (!items.length) return ''
  const images = items.filter((item) => item.kind === 'image')
  const references = items.filter((item) => item.kind !== 'image')
  const sections: string[] = []
  if (images.length) sections.push('[Attached images]', ...images.map((item) => `- ${item.name}: ${item.path}`))
  if (references.length) sections.push('[Referenced workspace items]', ...references.map((item) => `- ${item.kind}: @${item.path} (${resolve(cwd, item.path)})`))
  return sections.join('\n')
}

export function resolveRecordedTaskFile(cwd: string, changes: FileChange[], requestedPath: string): { absolutePath: string; relativePath: string; change: FileChange } {
  const root = resolve(cwd)
  const absolutePath = resolve(root, requestedPath)
  const relativePath = relative(root, absolutePath)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error('The requested file is outside this task workspace.')

  const change = changes.find((item) => resolve(root, item.path) === absolutePath)
  if (!change) throw new Error('This file was not recorded as part of the task.')
  return { absolutePath, relativePath, change }
}

async function workingTreeDiff(cwd: string, path: string): Promise<string> {
  const options = { encoding: 'utf8' as const, maxBuffer: 2_000_000 }
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'diff', '--no-ext-diff', '--unified=4', 'HEAD', '--', path], options)
    return stdout
  } catch {
    try {
      const { stdout } = await execFileAsync('git', ['-C', cwd, 'diff', '--no-ext-diff', '--unified=4', '--', path], options)
      return stdout
    } catch { return '' }
  }
}

function createdFileDiff(path: string, content: string): string {
  if (!content) return ''
  const lines = content.replace(/\n$/, '').split('\n')
  return `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`
}

export async function loadTaskFile(cwd: string, changes: FileChange[], requestedPath: string): Promise<TaskFileContent> {
  const root = resolve(cwd)
  const absolutePath = resolve(root, requestedPath)
  const relativePath = relative(root, absolutePath)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error('The requested file is outside this task workspace.')
  const change = changes.find((item) => resolve(root, item.path) === absolutePath)
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(cwd), realpath(absolutePath)])
    const realRelative = relative(realRoot, realTarget)
    if (!realRelative || realRelative.startsWith('..') || isAbsolute(realRelative)) throw new Error('The requested file resolves outside this task workspace.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let content = ''
  let exists = true
  let binary = false
  let truncated = false
  try {
    const handle = await open(absolutePath, 'r')
    try {
      const info = await handle.stat()
      const bytes = Buffer.alloc(Math.min(info.size, MAX_FILE_BYTES))
      await handle.read(bytes, 0, bytes.length, 0)
      binary = bytes.subarray(0, Math.min(bytes.length, 8_192)).includes(0)
      truncated = info.size > MAX_FILE_BYTES
      if (!binary) content = bytes.toString('utf8')
    } finally { await handle.close() }
  } catch {
    if (!change) throw new Error('This workspace file no longer exists.')
    exists = false
  }

  let diff = change ? await workingTreeDiff(cwd, relativePath) : ''
  if (!diff && change?.action === 'create' && exists && !binary) diff = createdFileDiff(relativePath, content)
  return {
    path: requestedPath,
    relativePath,
    language: languageForPath(relativePath),
    content,
    diff,
    exists,
    binary,
    truncated
  }
}
