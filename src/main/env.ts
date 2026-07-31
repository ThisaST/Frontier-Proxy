import { execFile } from 'node:child_process'
import { delimiter } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// GUI launches (Finder/Dock) inherit a minimal PATH that omits Homebrew, nvm,
// and other version-manager shims, so CLIs installed there look "Not detected".
// Rebuild PATH from the user's login shell plus common install locations.
//
// This is called at startup AND before every provider health check, because a
// CLI can be installed or a version manager initialized after launch — without
// re-hydrating, such a provider would stay undetected for the whole session even
// after the user clicks "Check providers".
export async function hydrateExecutablePath(): Promise<void> {
  if (process.platform === 'win32') return
  const paths = new Set((process.env.PATH ?? '').split(delimiter).filter(Boolean))
  for (const common of ['/usr/local/bin', '/opt/homebrew/bin', '/Applications/ChatGPT.app/Contents/Resources']) paths.add(common)
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const { stdout } = await execFileAsync(shell, ['-ilc', 'printf %s "$PATH"'], { timeout: 5_000, encoding: 'utf8' })
    for (const entry of stdout.split(delimiter).filter(Boolean)) paths.add(entry)
  } catch {
    // Common locations above still make packaged GUI launches useful when shell startup fails.
  }
  process.env.PATH = [...paths].join(delimiter)
}
