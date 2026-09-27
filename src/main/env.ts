import { spawn } from 'node:child_process'
import { delimiter } from 'node:path'

// GUI launches (Finder/Dock) inherit a minimal PATH that omits Homebrew, nvm,
// and other version-manager shims, so CLIs installed there look "Not detected".
// Rebuild PATH from the user's login shell plus common install locations.
//
// This is called at startup AND before every provider health check, because a
// CLI can be installed or a version manager initialized after launch — without
// re-hydrating, such a provider would stay undetected for the whole session even
// after the user clicks "Check providers".

export interface HydrateOptions {
  shell?: string
  args?: string[]
  timeoutMs?: number
}

// Runs the login-shell probe with a *hard* deadline. `execFile`'s own `timeout`
// only sends SIGTERM, which an interactive shell (`-i`) ignores by design —
// verified hanging well past its timeout on this machine — so a shell stuck on
// a slow .zshrc step (network call, compinit/oh-my-zsh lock, a stray `read`)
// wedged every provider check and app startup behind it. Instead we: give the
// shell no stdin (a `read` sees EOF immediately, rather than blocking forever
// on an open pipe), run it in its own process group, and on the deadline
// SIGKILL that whole group so any grandchild still holding the stdout pipe
// open dies too — then resolve from whatever PATH already arrived (never
// waiting for the pipe to close) rather than throwing it away for the bare
// fallback.
function runShell(options: HydrateOptions): Promise<string> {
  const shell = options.shell ?? process.env.SHELL ?? '/bin/zsh'
  const args = options.args ?? ['-ilc', 'printf %s "$PATH"']
  const timeoutMs = options.timeoutMs ?? 5_000
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const child = spawn(shell, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    const killGroup = (): void => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    const finish = (value: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
      resolve(value)
    }
    const timer = setTimeout(() => { killGroup(); finish(stdout) }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.on('error', () => finish(''))
    child.on('close', () => finish(stdout))
    // The shell exiting is the real completion signal; `close` additionally
    // needs the stdout pipe itself to close, which a lingering grandchild (a
    // background job left running by .zshrc) can hold open indefinitely.
    // Give a short grace period for any trailing data, then kill the group
    // and resolve — a straggling grandchild then costs ~100ms, not the full
    // deadline.
    child.on('exit', () => {
      graceTimer = setTimeout(() => { killGroup(); finish(stdout) }, 100)
      graceTimer.unref?.()
    })
  })
}

export async function hydrateExecutablePath(options: HydrateOptions = {}): Promise<void> {
  if (process.platform === 'win32') return
  const paths = new Set((process.env.PATH ?? '').split(delimiter).filter(Boolean))
  for (const common of ['/usr/local/bin', '/opt/homebrew/bin', '/Applications/ChatGPT.app/Contents/Resources']) paths.add(common)
  const stdout = await runShell(options)
  for (const entry of stdout.split(delimiter).filter(Boolean)) paths.add(entry)
  process.env.PATH = [...paths].join(delimiter)
}
