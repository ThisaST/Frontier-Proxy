import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { contextPrompt, entriesFromPaths, languageForPath, listWorkspaceEntries, loadTaskFile, loadTaskWorkspace, resolveRecordedTaskFile, validateChatContext } from '../src/main/taskfiles'

const run = promisify(execFile)

describe('task file inspection', () => {
  it('loads a recorded workspace file and builds a creation diff', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-task-file-'))
    await writeFile(join(directory, 'example.ts'), 'const answer: number = 42\n', 'utf8')
    const file = await loadTaskFile(directory, [{ path: 'example.ts', action: 'create', at: new Date().toISOString() }], 'example.ts')
    expect(file.language).toBe('typescript')
    expect(file.content).toContain('const answer')
    expect(file.diff).toContain('+++ b/example.ts')
    expect(file.diff).toContain('+const answer: number = 42')
  })

  it('loads ordinary project files for source browsing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-project-file-'))
    await writeFile(join(directory, 'README.md'), '# Project\n', 'utf8')
    const file = await loadTaskFile(directory, [], 'README.md')
    expect(file.content).toBe('# Project\n')
    expect(file.diff).toBe('')
  })

  it('lists the project tree and discovers current Git changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-project-tree-'))
    await run('git', ['init', '-b', 'main'], { cwd: directory })
    await writeFile(join(directory, 'tracked.ts'), 'export const value = 1\n', 'utf8')
    await run('git', ['add', 'tracked.ts'], { cwd: directory })
    await run('git', ['-c', 'user.name=Frontier Tests', '-c', 'user.email=tests@frontier.local', 'commit', '-m', 'initial'], { cwd: directory })
    await writeFile(join(directory, 'tracked.ts'), 'export const value = 2\n', 'utf8')
    await writeFile(join(directory, 'new.ts'), 'export {}\n', 'utf8')

    const workspace = await loadTaskWorkspace(directory, [])
    expect(workspace.entries).toEqual(expect.arrayContaining([
      { kind: 'file', name: 'tracked.ts', path: 'tracked.ts' },
      { kind: 'file', name: 'new.ts', path: 'new.ts' }
    ]))
    expect(workspace.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tracked.ts', action: 'edit' }),
      expect.objectContaining({ path: 'new.ts', action: 'create' })
    ]))
  })

  it('builds every parent folder from file paths and drops generated trees', () => {
    expect(entriesFromPaths(['src/main/engine.ts', 'src/main/router.ts', 'README.md'])).toEqual([
      { kind: 'file', name: 'README.md', path: 'README.md' },
      { kind: 'folder', name: 'src', path: 'src' },
      { kind: 'folder', name: 'main', path: 'src/main' },
      { kind: 'file', name: 'engine.ts', path: 'src/main/engine.ts' },
      { kind: 'file', name: 'router.ts', path: 'src/main/router.ts' }
    ])
    const ignored = entriesFromPaths(['.pnpm-store/v11/files/05/abc', 'node_modules/pkg/index.js', '../outside.ts', '/etc/passwd'])
    expect(ignored).toEqual([])
  })

  // A repo's own .gitignore is the only reliable answer to "which files does the
  // user actually work on" — walking the directory showed .pnpm-store and friends.
  it('takes the project tree from Git so ignored files stay out of it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-git-tree-'))
    await run('git', ['init', '-b', 'main'], { cwd: directory })
    await writeFile(join(directory, '.gitignore'), 'ignored-output/\n', 'utf8')
    await mkdir(join(directory, 'src'), { recursive: true })
    await mkdir(join(directory, 'ignored-output'), { recursive: true })
    await writeFile(join(directory, 'src', 'app.ts'), 'export {}\n', 'utf8')
    await writeFile(join(directory, 'ignored-output', 'bundle.js'), '', 'utf8')

    const workspace = await loadTaskWorkspace(directory, [])
    expect(workspace.entries).toEqual(expect.arrayContaining([
      { kind: 'folder', name: 'src', path: 'src' },
      { kind: 'file', name: 'app.ts', path: 'src/app.ts' }
    ]))
    expect(workspace.entries.some((entry) => entry.path.startsWith('ignored-output'))).toBe(false)
  })

  // Observed live on macOS: the task cwd came from mkdtemp (/var/folders/…) while
  // the CLI reported the canonical path it actually edited (/private/var/folders/…).
  // A purely lexical containment check read that as an escape, so the change was
  // dropped from the workspace and opening the file failed outright.
  it('accepts recorded paths that reach the workspace through a symlinked root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'frontier-symlink-'))
    const real = join(parent, 'real-workspace')
    const link = join(parent, 'linked-workspace')
    await mkdir(real)
    await writeFile(join(real, 'app.js'), 'module.exports = 1\n', 'utf8')
    try { await symlink(real, link, 'dir') } catch { return } // symlinks may be unprivileged-blocked (Windows)

    // The task cwd is the symlink; the CLI reports the canonical path it edited.
    const reported = join(await realpath(link), 'app.js')
    const workspace = await loadTaskWorkspace(link, [{ path: reported, action: 'edit', at: new Date().toISOString() }])
    expect(workspace.changes).toEqual([expect.objectContaining({ path: 'app.js', action: 'edit' })])

    const file = await loadTaskFile(link, workspace.changes, reported)
    expect(file.relativePath).toBe('app.js')
    expect(file.content).toBe('module.exports = 1\n')
  })

  it('still rejects a recorded path that escapes the workspace entirely', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'frontier-escape-'))
    const workspaceDir = join(parent, 'workspace')
    await mkdir(workspaceDir)
    await writeFile(join(parent, 'secret.txt'), 'private\n', 'utf8')
    const outside = join(parent, 'secret.txt')

    const workspace = await loadTaskWorkspace(workspaceDir, [{ path: outside, action: 'edit', at: new Date().toISOString() }])
    expect(workspace.changes).toEqual([])
    await expect(loadTaskFile(workspaceDir, [], outside)).rejects.toThrow('outside this task workspace')
    await expect(loadTaskFile(workspaceDir, [], '../secret.txt')).rejects.toThrow('outside this task workspace')
  })

  it('rejects traversal and files that were not recorded by the task', () => {
    const change = { path: 'src/app.ts', action: 'edit' as const, at: new Date().toISOString() }
    expect(() => resolveRecordedTaskFile('/workspace', [change], '../secret.txt')).toThrow('outside')
    expect(() => resolveRecordedTaskFile('/workspace', [change], 'src/other.ts')).toThrow('not recorded')
  })

  it('maps common source extensions to syntax languages', () => {
    expect(languageForPath('src/view.tsx')).toBe('typescript')
    expect(languageForPath('schema.sql')).toBe('sql')
    expect(languageForPath('unknown.data')).toBe('plaintext')
  })

  it('searches project files and folders while skipping generated dependency trees', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-workspace-list-'))
    await mkdir(join(directory, 'src', 'components'), { recursive: true })
    await mkdir(join(directory, 'node_modules', 'hidden-package'), { recursive: true })
    await writeFile(join(directory, 'src', 'components', 'Chat.tsx'), 'export {}', 'utf8')
    await writeFile(join(directory, 'node_modules', 'hidden-package', 'index.js'), '', 'utf8')
    const entries = await listWorkspaceEntries(directory, 'chat')
    expect(entries).toContainEqual({ kind: 'file', name: 'Chat.tsx', path: 'src/components/Chat.tsx' })
    expect(entries.some((entry) => entry.path.includes('node_modules'))).toBe(false)
  })

  it('validates workspace references and formats provider-visible context', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-context-'))
    await mkdir(join(directory, 'src'))
    await writeFile(join(directory, 'src', 'app.ts'), 'export {}', 'utf8')
    const items = await validateChatContext(directory, [
      { id: 'file-1', kind: 'file', name: 'app.ts', path: 'src/app.ts' },
      { id: 'folder-1', kind: 'folder', name: 'src', path: 'src' }
    ])
    expect(items).toHaveLength(2)
    expect(contextPrompt(directory, items)).toContain('file: @src/app.ts')
    await expect(validateChatContext(directory, [{ id: 'bad', kind: 'file', name: 'secret', path: '../secret' }])).rejects.toThrow('outside')
  })
})
