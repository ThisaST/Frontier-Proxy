import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkProviderAuth, copilotAuthFromConfig, openCodeAuthFromFile } from '../src/main/providers'
import type { ProviderConfig, ProviderKind } from '../src/shared/types'

function provider(kind: ProviderKind): ProviderConfig {
  return { id: kind, name: kind, kind, enabled: true, executable: kind, priority: 80, maxConcurrent: 1, capabilities: ['general'] }
}

async function home(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'frontier-home-'))
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, contents)
  }
  return dir
}

describe('copilot login state', () => {
  it('reads a signed-in session from loggedInUsers', () => {
    expect(copilotAuthFromConfig(JSON.stringify({ loggedInUsers: ['octocat'] })))
      .toEqual({ state: 'logged-in', detail: 'Signed in as octocat' })
  })

  // The documented failure: the CLI is installed, `--version` succeeds, and every
  // headless run dies with "No authentication information found."
  it('reports signed out when the session has expired', () => {
    const probe = copilotAuthFromConfig(JSON.stringify({ loggedInUsers: [], lastLoggedInUser: 'octocat' }))
    expect(probe.state).toBe('logged-out')
    expect(probe.detail).toContain('copilot login')
  })

  it('stays unknown rather than accusing a CLI whose config it cannot parse', () => {
    expect(copilotAuthFromConfig('not json').state).toBe('unknown')
    expect(copilotAuthFromConfig(JSON.stringify({})).state).toBe('unknown')
  })
})

describe('provider auth probes', () => {
  it('finds Claude through its credentials file', async () => {
    const dir = await home({ '.claude/.credentials.json': '{}' })
    expect((await checkProviderAuth(provider('claude'), dir))?.state).toBe('logged-in')
  })

  it('finds Claude through the account record when credentials live in the keychain', async () => {
    const dir = await home({ '.claude.json': JSON.stringify({ oauthAccount: { emailAddress: 'dev@example.com' } }) })
    const status = await checkProviderAuth(provider('claude'), dir)
    expect(status).toMatchObject({ state: 'logged-in', detail: 'Signed in as dev@example.com' })
  })

  it('finds Codex through its auth file', async () => {
    const dir = await home({ '.codex/auth.json': '{}' })
    expect((await checkProviderAuth(provider('codex'), dir))?.state).toBe('logged-in')
  })

  // A missing file is not proof of being signed out — a future CLI could store
  // its session elsewhere — so the probe must not claim more than it knows.
  it('reports unknown, never logged-out, when there is nothing to read', async () => {
    const dir = await home({})
    expect((await checkProviderAuth(provider('claude'), dir))?.state).toBe('unknown')
    expect((await checkProviderAuth(provider('codex'), dir))?.state).toBe('unknown')
    expect((await checkProviderAuth(provider('copilot'), dir))?.state).toBe('unknown')
  })

  it('has no opinion about CLIs with no account to sign in to', async () => {
    const dir = await home({})
    expect(await checkProviderAuth(provider('ollama'), dir)).toBeUndefined()
    expect(await checkProviderAuth(provider('codex-oss'), dir)).toBeUndefined()
    expect(await checkProviderAuth(provider('custom'), dir)).toBeUndefined()
  })
})

describe('opencode login state', () => {
  it('reports the providers OpenCode holds credentials for', async () => {
    const dir = await home({ '.local/share/opencode/auth.json': JSON.stringify({ 'opencode-go': { type: 'api' }, anthropic: { type: 'oauth' } }) })
    expect(await checkProviderAuth(provider('opencode'), dir)).toMatchObject({ state: 'logged-in', detail: 'Credentials for opencode-go, anthropic' })
  })

  // OpenCode serves free models with no credentials, so an empty or missing
  // store is never evidence of being signed out.
  it('stays unknown without stored credentials', async () => {
    expect((await checkProviderAuth(provider('opencode'), await home({})))?.state).toBe('unknown')
    expect((await checkProviderAuth(provider('opencode'), await home({ '.local/share/opencode/auth.json': '{}' })))?.state).toBe('unknown')
    expect(openCodeAuthFromFile('not json').state).toBe('unknown')
  })
})
