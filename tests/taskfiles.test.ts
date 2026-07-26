import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { languageForPath, loadTaskFile, resolveRecordedTaskFile } from '../src/main/taskfiles'

describe('task file inspection', () => {
  it('loads only a recorded workspace file and builds a creation diff', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-task-file-'))
    await writeFile(join(directory, 'example.ts'), 'const answer: number = 42\n', 'utf8')
    const file = await loadTaskFile(directory, [{ path: 'example.ts', action: 'create', at: new Date().toISOString() }], 'example.ts')
    expect(file.language).toBe('typescript')
    expect(file.content).toContain('const answer')
    expect(file.diff).toContain('+++ b/example.ts')
    expect(file.diff).toContain('+const answer: number = 42')
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
})
