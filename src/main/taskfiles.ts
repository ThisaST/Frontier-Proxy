import { execFile } from 'node:child_process'
import { open, realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { FileChange, TaskFileContent } from '../shared/types'

const execFileAsync = promisify(execFile)
const MAX_FILE_BYTES = 1_000_000

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
  const { absolutePath, relativePath, change } = resolveRecordedTaskFile(cwd, changes, requestedPath)
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
    exists = false
  }

  let diff = await workingTreeDiff(cwd, relativePath)
  if (!diff && change.action === 'create' && exists && !binary) diff = createdFileDiff(relativePath, content)
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
