import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { delimiter } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hydrateExecutablePath } from '../src/main/env'

// A script that is dead within `ms` of `process.kill(pid, 0)` throwing (ESRCH).
async function assertDead(pid: number, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return // ESRCH: no such process — it's gone.
    }
    if (Date.now() > deadline) throw new Error(`pid ${pid} is still alive`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const originalPath = process.env.PATH

describe('hydrateExecutablePath', () => {
  afterEach(() => { process.env.PATH = originalPath })

  it('is hard-bounded by the deadline even against a shell that ignores SIGTERM and a grandchild holding stdout open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frontier-env-'))
    const pidFile = join(dir, 'pids.json')
    // Mimics an interactive zsh stuck in a slow .zshrc: ignores SIGTERM, and
    // spawns a long-lived grandchild that inherits its stdout pipe, so the
    // pipe alone would never close on its own.
    const fakeShell = `
      const { spawn } = require('node:child_process')
      const fs = require('node:fs')
      process.on('SIGTERM', () => {})
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'] })
      fs.writeFileSync(process.argv[1], JSON.stringify({ shell: process.pid, grandchild: grandchild.pid }))
      setInterval(() => {}, 1000)
    `
    const started = Date.now()
    await hydrateExecutablePath({ shell: process.execPath, args: ['-e', fakeShell, pidFile], timeoutMs: 300 })
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(2_000) // well under a 5s/30s hang; generous for CI jitter

    const { shell, grandchild } = JSON.parse(await readFile(pidFile, 'utf8')) as { shell: number; grandchild: number }
    await assertDead(shell)
    await assertDead(grandchild) // the whole process group was killed, not just the shell
  })

  it('merges a shell-reported PATH with the existing one, keeping entries unique', async () => {
    process.env.PATH = ['/existing/bin', '/usr/local/bin'].join(delimiter)
    const fakeShell = `process.stdout.write(['/existing/bin', '/shell/only/bin'].join(${JSON.stringify(delimiter)}))`
    await hydrateExecutablePath({ shell: process.execPath, args: ['-e', fakeShell], timeoutMs: 2_000 })
    const entries = (process.env.PATH ?? '').split(delimiter)
    expect(entries).toContain('/existing/bin')
    expect(entries).toContain('/shell/only/bin')
    expect(entries).toContain('/usr/local/bin') // common location, always added
    expect(entries.filter((entry) => entry === '/existing/bin')).toHaveLength(1)
  })

  it('returns immediately on win32 without touching PATH', async () => {
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      process.env.PATH = '/only/this'
      await hydrateExecutablePath({ shell: process.execPath, args: ['-e', 'throw new Error("must not run")'], timeoutMs: 2_000 })
      expect(process.env.PATH).toBe('/only/this')
    } finally {
      Object.defineProperty(process, 'platform', { value: platform })
    }
  })
})
