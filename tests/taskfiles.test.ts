import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { contextPrompt, languageForPath, listWorkspaceEntries, loadTaskFile, loadTaskWorkspace, resolveRecordedTaskFile, validateChatContext } from '../src/main/taskfiles'

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
