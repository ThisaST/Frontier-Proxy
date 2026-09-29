import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Much of this suite drives real child processes — git worktrees, branch
    // merges, and fake CLIs spawned through cross-spawn. Vitest's 5s default is
    // enough on an idle machine but times out under normal desktop load, which
    // reads as a failure when nothing is actually wrong.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Agent worktrees under .claude/ carry their own copy of tests/; collecting them
    // triples the run and reports failures from branches that are not this one.
    exclude: ['**/node_modules/**', '.claude/**', 'site/**', 'release/**', 'out/**']
  }
})
