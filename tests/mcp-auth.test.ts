import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { McpAuthManager } from '../src/main/mcp-auth'
import type { ControlPlaneProfile, McpServerConfig } from '../src/shared/types'

const server: McpServerConfig = {
  id: 'supabase', name: 'supabase', enabled: true, transport: 'http',
  url: 'https://mcp.example/mcp?project_ref=demo&read_only=true'
}

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function profile(mcpServer: McpServerConfig = server): ControlPlaneProfile {
  return { systemPrompt: '', addDirs: [], allowedTools: [], disallowedTools: [], strictMcp: false, mcpServers: [mcpServer] }
}

describe('MCP OAuth authentication', () => {
  it('discovers OAuth, uses PKCE, encrypts tokens, refreshes them, and injects only the bearer header', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-mcp-auth-'))
    const path = join(directory, 'credentials.json')
    let authorizationUrl: URL | undefined
    let registrationBody: Record<string, unknown> | undefined
    let refreshes = 0

    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.startsWith('https://mcp.example/mcp')) {
        return json({ message: 'Unauthorized' }, 401, {
          'WWW-Authenticate': 'Bearer error="invalid_request", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp?project_ref=demo&read_only=true"'
        })
      }
      if (url.startsWith('https://mcp.example/.well-known/oauth-protected-resource')) {
        return json({
          resource: server.url,
          authorization_servers: ['https://auth.example'],
          scopes_supported: ['projects:read', 'database:read', 'database:write']
        })
      }
      if (url === 'https://auth.example/.well-known/oauth-authorization-server') {
        return json({
          issuer: 'https://auth.example',
          authorization_endpoint: 'https://auth.example/authorize',
          token_endpoint: 'https://auth.example/token',
          registration_endpoint: 'https://auth.example/register',
          scopes_supported: ['projects:read', 'database:read', 'database:write'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
          code_challenge_methods_supported: ['S256']
        })
      }
      if (url === 'https://auth.example/register') {
        registrationBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return json({ client_id: 'frontier-client', client_secret: 'client-secret', token_endpoint_auth_method: 'client_secret_basic' })
      }
      if (url === 'https://auth.example/token') {
        const body = init?.body as URLSearchParams
        expect(init?.headers).toMatchObject({ Authorization: expect.stringMatching(/^Basic /) })
        if (body.get('grant_type') === 'refresh_token') {
          refreshes += 1
          return json({ access_token: 'refreshed-access-token', refresh_token: 'rotated-refresh-token', token_type: 'Bearer', expires_in: 3600 })
        }
        expect(body.get('code')).toBe('authorization-code')
        expect(body.get('code_verifier')).toBeTruthy()
        return json({ access_token: 'initial-access-token', refresh_token: 'refresh-token', token_type: 'Bearer', expires_in: 1 })
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    const manager = new McpAuthManager(path, {
      cipher: {
        encrypt: (value) => Buffer.from(value).toString('base64'),
        decrypt: (value) => Buffer.from(value, 'base64').toString('utf8')
      },
      fetch: fetcher as typeof fetch,
      createCallback: async () => ({
        redirectUri: 'http://127.0.0.1:45678/oauth/callback',
        waitForCode: Promise.resolve('authorization-code'),
        close: async () => undefined
      }),
      openExternal: async (url) => {
        authorizationUrl = new URL(url)
      },
      callbackTimeoutMs: 5_000
    })
    await manager.initialize()
    await manager.authenticate(server)

    expect(authorizationUrl?.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizationUrl?.searchParams.get('scope')).toBe('projects:read database:read')
    expect(registrationBody?.scope).toBe('projects:read database:read')
    expect(manager.statuses(profile())[0].state).toBe('authenticated')
    expect(await readFile(path, 'utf8')).not.toContain('initial-access-token')

    const authenticated = await manager.profileWithAuth(profile())
    expect(authenticated.mcpServers[0].headers?.Authorization).toBe('Bearer refreshed-access-token')
    expect(refreshes).toBe(1)
  })

  it('does not replace a manually configured authorization header', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-mcp-manual-'))
    const path = join(directory, 'credentials.json')
    await writeFile(path, JSON.stringify({
      version: 1,
      credentials: [{
        serverId: server.id,
        serverUrl: server.url,
        encrypted: JSON.stringify({
          accessToken: 'old-oauth-token', tokenType: 'Bearer', clientId: 'client',
          tokenEndpoint: 'https://auth.example/token', tokenEndpointAuthMethod: 'none', resource: server.url
        })
      }]
    }))
    const manager = new McpAuthManager(path, {
      cipher: { encrypt: (value) => value, decrypt: (value) => value },
      openExternal: async () => undefined
    })
    await manager.initialize()
    const manual = { ...server, headers: { authorization: 'Bearer manual-token' } }
    expect(manager.statuses(profile(manual))[0].state).toBe('manual')
    expect((await manager.profileWithAuth(profile(manual))).mcpServers[0].headers?.authorization).toBe('Bearer manual-token')
    await manager.reconcile(profile(manual))
    expect(JSON.parse(await readFile(path, 'utf8')).credentials).toEqual([])
  })
})
