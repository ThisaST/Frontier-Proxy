import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ControlPlaneProfile, McpAuthStatus, McpServerConfig } from '../shared/types'

interface ProtectedResourceMetadata {
  resource?: string
  authorization_servers?: string[]
  scopes_supported?: string[]
}

interface AuthorizationServerMetadata {
  issuer?: string
  authorization_endpoint?: string
  token_endpoint?: string
  registration_endpoint?: string
  scopes_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
  code_challenge_methods_supported?: string[]
}

interface RegisteredClient {
  client_id: string
  client_secret?: string
  token_endpoint_auth_method?: string
}

interface OAuthTokenResponse {
  access_token: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
}

interface StoredTokenSet {
  accessToken: string
  refreshToken?: string
  tokenType: string
  expiresAt?: string
  scope?: string
  clientId: string
  clientSecret?: string
  tokenEndpoint: string
  tokenEndpointAuthMethod: string
  resource: string
}

interface StoredCredential {
  serverId: string
  serverUrl: string
  encrypted: string
}

interface CredentialFile {
  version: 1
  credentials: StoredCredential[]
}

export interface CredentialCipher {
  encrypt(value: string): string
  decrypt(value: string): string
}

export interface McpAuthManagerOptions {
  cipher: CredentialCipher
  openExternal: (url: string) => Promise<void>
  fetch?: typeof fetch
  callbackTimeoutMs?: number
  createCallback?: (state: string, timeoutMs: number) => Promise<OAuthCallback>
}

function base64Url(value: Buffer): string {
  return value.toString('base64url')
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} returned an invalid JSON document.`)
  return value as Record<string, unknown>
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

function authorizationHeader(headers: Record<string, string> | undefined): string | undefined {
  return Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1]
}

function safeUrl(value: string, label: string): URL {
  const url = new URL(value)
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`${label} must use HTTPS (or loopback HTTP).`)
  }
  return url
}

function protectedResourceFallback(serverUrl: URL): string {
  const metadata = new URL(`/.well-known/oauth-protected-resource${serverUrl.pathname === '/' ? '' : serverUrl.pathname}`, serverUrl.origin)
  metadata.search = serverUrl.search
  return metadata.toString()
}

function authorizationMetadataUrls(issuer: URL): string[] {
  const suffix = issuer.pathname === '/' ? '' : issuer.pathname.replace(/\/$/, '')
  return [
    new URL(`/.well-known/oauth-authorization-server${suffix}`, issuer.origin).toString(),
    new URL(`/.well-known/openid-configuration${suffix}`, issuer.origin).toString()
  ]
}

function resourceMetadataFromHeader(header: string | null): string | undefined {
  const match = header?.match(/resource_metadata\s*=\s*"((?:[^"\\]|\\.)*)"/i)
  return match?.[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

function requestedScopes(serverUrl: URL, resource: ProtectedResourceMetadata, authorization: AuthorizationServerMetadata): string[] {
  const resourceScopes = resource.scopes_supported ?? []
  const authorizationScopes = new Set(authorization.scopes_supported ?? resourceScopes)
  const readOnly = serverUrl.searchParams.get('read_only') === 'true'
  return resourceScopes.filter((scope) => authorizationScopes.has(scope) && !(readOnly && scope.endsWith(':write')))
}

async function responseJson(response: Response, label: string): Promise<Record<string, unknown>> {
  const body = await response.text()
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { parsed = undefined }
  if (!response.ok) {
    const detail = parsed && typeof parsed === 'object'
      ? String((parsed as Record<string, unknown>).error_description ?? (parsed as Record<string, unknown>).message ?? (parsed as Record<string, unknown>).error ?? body)
      : body
    throw new Error(`${label} failed (${response.status})${detail ? `: ${detail}` : '.'}`)
  }
  return jsonRecord(parsed, label)
}

function clientAuthorization(client: RegisteredClient, method: string, body: URLSearchParams, headers: Record<string, string>): void {
  if (method === 'client_secret_basic' && client.client_secret) {
    headers.Authorization = `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`
  } else {
    body.set('client_id', client.client_id)
    if (client.client_secret && method === 'client_secret_post') body.set('client_secret', client.client_secret)
  }
}

export interface OAuthCallback {
  redirectUri: string
  waitForCode: Promise<string>
  close(): Promise<void>
}

async function callbackListener(expectedState: string, timeoutMs: number): Promise<OAuthCallback> {
  let server: Server
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  let settled = false
  const waitForCode = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject })

  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/oauth/callback') { response.writeHead(404).end('Not found'); return }
    const state = url.searchParams.get('state')
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    if (state !== expectedState) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Authentication state did not match. Return to Frontier and try again.')
      if (!settled) { settled = true; rejectCode(new Error('OAuth callback state did not match.')) }
      return
    }
    if (error || !code) {
      const description = url.searchParams.get('error_description') ?? error ?? 'No authorization code was returned.'
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Authentication was not completed. You can close this window.')
      if (!settled) { settled = true; rejectCode(new Error(description)) }
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Frontier Proxy</title><style>body{font:16px system-ui;background:#0c0e0d;color:#e5e9e6;padding:40px}strong{color:#a9ef72}</style><strong>Authentication complete.</strong><p>You can close this window and return to Frontier Proxy.</p>')
    if (!settled) { settled = true; resolveCode(code) }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not open the local OAuth callback listener.')
  const timer = setTimeout(() => {
    if (!settled) { settled = true; rejectCode(new Error('OAuth authentication timed out.')) }
  }, timeoutMs)

  return {
    redirectUri: `http://127.0.0.1:${address.port}/oauth/callback`,
    waitForCode,
    close: async () => {
      clearTimeout(timer)
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

export class McpAuthManager {
  private readonly fetcher: typeof fetch
  private readonly callbackTimeoutMs: number
  private readonly credentials = new Map<string, StoredCredential>()
  private readonly runtimeStatus = new Map<string, McpAuthStatus>()
  private readonly refreshes = new Map<string, Promise<StoredTokenSet | undefined>>()

  constructor(private readonly filePath: string, private readonly options: McpAuthManagerOptions) {
    this.fetcher = options.fetch ?? fetch
    this.callbackTimeoutMs = options.callbackTimeoutMs ?? 5 * 60_000
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<CredentialFile>
      for (const credential of parsed.credentials ?? []) {
        if (credential?.serverId && credential.serverUrl && credential.encrypted) this.credentials.set(credential.serverId, credential)
      }
    } catch {
      // A missing credential file is the normal first-run state.
    }
  }

  statuses(profile: ControlPlaneProfile): McpAuthStatus[] {
    return profile.mcpServers.filter((server) => server.transport !== 'stdio').map((server) => {
      if (authorizationHeader(server.headers)) return { serverId: server.id, state: 'manual' }
      const runtime = this.runtimeStatus.get(server.id)
      if (runtime) return { ...runtime }
      const credential = this.credentials.get(server.id)
      if (!credential || credential.serverUrl !== server.url?.trim()) return { serverId: server.id, state: 'not-authenticated' }
      try {
        const token = this.decrypt(credential)
        const expired = token.expiresAt && Date.parse(token.expiresAt) <= Date.now() && !token.refreshToken
        return { serverId: server.id, state: expired ? 'not-authenticated' : 'authenticated', expiresAt: token.expiresAt }
      } catch (error) {
        return { serverId: server.id, state: 'error', error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  async reconcile(profile: ControlPlaneProfile): Promise<void> {
    const current = new Map(profile.mcpServers.map((server) => [server.id, {
      url: server.url?.trim(),
      manualAuthorization: Boolean(authorizationHeader(server.headers))
    }]))
    let changed = false
    for (const [id, credential] of this.credentials) {
      const configured = current.get(id)
      if (!configured || configured.url !== credential.serverUrl || configured.manualAuthorization) {
        this.credentials.delete(id)
        this.runtimeStatus.delete(id)
        changed = true
      }
    }
    if (changed) await this.save()
  }

  async authenticate(server: McpServerConfig): Promise<void> {
    const rawUrl = server.url?.trim()
    if (server.transport === 'stdio' || !rawUrl) throw new Error('OAuth authentication requires a remote MCP server URL.')
    this.runtimeStatus.set(server.id, { serverId: server.id, state: 'authenticating' })

    let callback: OAuthCallback | undefined
    try {
      const serverUrl = safeUrl(rawUrl, 'MCP server URL')
      const state = base64Url(randomBytes(24))
      const verifier = base64Url(randomBytes(48))
      const challenge = base64Url(createHash('sha256').update(verifier).digest())
      callback = await (this.options.createCallback ?? callbackListener)(state, this.callbackTimeoutMs)

      const discoveryResponse = await this.fetcher(serverUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
      const advertisedMetadata = resourceMetadataFromHeader(discoveryResponse.headers.get('www-authenticate'))
      const resourceMetadataUrl = safeUrl(advertisedMetadata ?? protectedResourceFallback(serverUrl), 'OAuth protected-resource metadata URL')
      const resourceDocument = await responseJson(await this.fetcher(resourceMetadataUrl, { signal: AbortSignal.timeout(15_000) }), 'OAuth protected-resource discovery')
      const resource: ProtectedResourceMetadata = {
        resource: typeof resourceDocument.resource === 'string' ? resourceDocument.resource : serverUrl.toString(),
        authorization_servers: strings(resourceDocument.authorization_servers),
        scopes_supported: strings(resourceDocument.scopes_supported)
      }
      const issuerValue = resource.authorization_servers?.[0]
      if (!issuerValue) throw new Error('The MCP server did not advertise an OAuth authorization server.')
      const issuer = safeUrl(issuerValue, 'OAuth authorization server')

      let authorizationDocument: Record<string, unknown> | undefined
      let lastDiscoveryError: unknown
      for (const metadataUrl of authorizationMetadataUrls(issuer)) {
        try {
          authorizationDocument = await responseJson(await this.fetcher(metadataUrl, { signal: AbortSignal.timeout(15_000) }), 'OAuth authorization-server discovery')
          break
        } catch (error) { lastDiscoveryError = error }
      }
      if (!authorizationDocument) throw lastDiscoveryError instanceof Error ? lastDiscoveryError : new Error('OAuth authorization-server discovery failed.')
      const authorization: AuthorizationServerMetadata = {
        issuer: typeof authorizationDocument.issuer === 'string' ? authorizationDocument.issuer : issuer.toString(),
        authorization_endpoint: typeof authorizationDocument.authorization_endpoint === 'string' ? authorizationDocument.authorization_endpoint : undefined,
        token_endpoint: typeof authorizationDocument.token_endpoint === 'string' ? authorizationDocument.token_endpoint : undefined,
        registration_endpoint: typeof authorizationDocument.registration_endpoint === 'string' ? authorizationDocument.registration_endpoint : undefined,
        scopes_supported: strings(authorizationDocument.scopes_supported),
        token_endpoint_auth_methods_supported: strings(authorizationDocument.token_endpoint_auth_methods_supported),
        code_challenge_methods_supported: strings(authorizationDocument.code_challenge_methods_supported)
      }
      if (!authorization.authorization_endpoint || !authorization.token_endpoint || !authorization.registration_endpoint) {
        throw new Error('The OAuth server does not advertise authorization, token, and dynamic registration endpoints.')
      }
      safeUrl(authorization.authorization_endpoint, 'OAuth authorization endpoint')
      safeUrl(authorization.token_endpoint, 'OAuth token endpoint')
      safeUrl(authorization.registration_endpoint, 'OAuth registration endpoint')
      if (authorization.code_challenge_methods_supported && !authorization.code_challenge_methods_supported.includes('S256')) {
        throw new Error('The OAuth server does not support PKCE with S256.')
      }

      const scopes = requestedScopes(serverUrl, resource, authorization)
      const supportedMethods = authorization.token_endpoint_auth_methods_supported ?? ['none']
      const requestedMethod = supportedMethods.includes('client_secret_basic') ? 'client_secret_basic'
        : supportedMethods.includes('client_secret_post') ? 'client_secret_post'
          : 'none'
      const registrationResponse = await this.fetcher(authorization.registration_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_name: 'Frontier Proxy',
          redirect_uris: [callback.redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: requestedMethod,
          ...(scopes.length ? { scope: scopes.join(' ') } : {})
        }),
        signal: AbortSignal.timeout(15_000)
      })
      const registrationDocument = await responseJson(registrationResponse, 'OAuth dynamic client registration')
      const client: RegisteredClient = {
        client_id: typeof registrationDocument.client_id === 'string' ? registrationDocument.client_id : '',
        client_secret: typeof registrationDocument.client_secret === 'string' ? registrationDocument.client_secret : undefined,
        token_endpoint_auth_method: typeof registrationDocument.token_endpoint_auth_method === 'string' ? registrationDocument.token_endpoint_auth_method : requestedMethod
      }
      if (!client.client_id) throw new Error('OAuth dynamic client registration did not return a client ID.')

      const authorizationUrl = new URL(authorization.authorization_endpoint)
      authorizationUrl.searchParams.set('response_type', 'code')
      authorizationUrl.searchParams.set('client_id', client.client_id)
      authorizationUrl.searchParams.set('redirect_uri', callback.redirectUri)
      authorizationUrl.searchParams.set('state', state)
      authorizationUrl.searchParams.set('code_challenge', challenge)
      authorizationUrl.searchParams.set('code_challenge_method', 'S256')
      authorizationUrl.searchParams.set('resource', resource.resource ?? serverUrl.toString())
      if (scopes.length) authorizationUrl.searchParams.set('scope', scopes.join(' '))
      await this.options.openExternal(authorizationUrl.toString())
      const code = await callback.waitForCode

      const tokenBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callback.redirectUri,
        code_verifier: verifier,
        resource: resource.resource ?? serverUrl.toString()
      })
      const tokenHeaders: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
      clientAuthorization(client, client.token_endpoint_auth_method ?? requestedMethod, tokenBody, tokenHeaders)
      const tokenDocument = await responseJson(await this.fetcher(authorization.token_endpoint, {
        method: 'POST', headers: tokenHeaders, body: tokenBody, signal: AbortSignal.timeout(15_000)
      }), 'OAuth token exchange')
      const token = this.tokenFromResponse(tokenDocument, {
        clientId: client.client_id,
        clientSecret: client.client_secret,
        tokenEndpoint: authorization.token_endpoint,
        tokenEndpointAuthMethod: client.token_endpoint_auth_method ?? requestedMethod,
        resource: resource.resource ?? serverUrl.toString()
      })
      await this.store(server, token)
      this.runtimeStatus.set(server.id, { serverId: server.id, state: 'authenticated', expiresAt: token.expiresAt })
    } catch (error) {
      this.runtimeStatus.set(server.id, { serverId: server.id, state: 'error', error: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      await callback?.close()
    }
  }

  async disconnect(serverId: string): Promise<void> {
    this.credentials.delete(serverId)
    this.runtimeStatus.set(serverId, { serverId, state: 'not-authenticated' })
    await this.save()
  }

  async profileWithAuth(profile: ControlPlaneProfile): Promise<ControlPlaneProfile> {
    const servers = await Promise.all(profile.mcpServers.map(async (server): Promise<McpServerConfig> => {
      if (server.transport === 'stdio' || authorizationHeader(server.headers)) return { ...server, headers: server.headers ? { ...server.headers } : undefined }
      const credential = this.credentials.get(server.id)
      if (!credential || credential.serverUrl !== server.url?.trim()) return { ...server, headers: server.headers ? { ...server.headers } : undefined }
      const token = await this.validToken(server, credential)
      if (!token) return { ...server, headers: server.headers ? { ...server.headers } : undefined }
      return { ...server, headers: { ...(server.headers ?? {}), Authorization: `${token.tokenType} ${token.accessToken}` } }
    }))
    return { ...profile, mcpServers: servers }
  }

  private tokenFromResponse(document: Record<string, unknown>, client: Pick<StoredTokenSet, 'clientId' | 'clientSecret' | 'tokenEndpoint' | 'tokenEndpointAuthMethod' | 'resource'>, previous?: StoredTokenSet): StoredTokenSet {
    if (typeof document.access_token !== 'string') throw new Error('OAuth token response did not include an access token.')
    const expiresIn = Number(document.expires_in)
    return {
      accessToken: document.access_token,
      refreshToken: typeof document.refresh_token === 'string' ? document.refresh_token : previous?.refreshToken,
      tokenType: typeof document.token_type === 'string' ? document.token_type : 'Bearer',
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
      scope: typeof document.scope === 'string' ? document.scope : previous?.scope,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      tokenEndpoint: client.tokenEndpoint,
      tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
      resource: client.resource
    }
  }

  private async validToken(server: McpServerConfig, credential: StoredCredential): Promise<StoredTokenSet | undefined> {
    try {
      const token = this.decrypt(credential)
      if (!token.expiresAt || Date.parse(token.expiresAt) > Date.now() + 60_000) return token
      if (!token.refreshToken) {
        this.runtimeStatus.set(server.id, { serverId: server.id, state: 'not-authenticated' })
        return undefined
      }
      const inFlight = this.refreshes.get(server.id)
      if (inFlight) return await inFlight
      const refresh = this.refresh(server, token).finally(() => this.refreshes.delete(server.id))
      this.refreshes.set(server.id, refresh)
      return await refresh
    } catch (error) {
      this.runtimeStatus.set(server.id, { serverId: server.id, state: 'error', error: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }

  private async refresh(server: McpServerConfig, token: StoredTokenSet): Promise<StoredTokenSet | undefined> {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refreshToken!, resource: token.resource })
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
    clientAuthorization({ client_id: token.clientId, client_secret: token.clientSecret }, token.tokenEndpointAuthMethod, body, headers)
    const document = await responseJson(await this.fetcher(token.tokenEndpoint, {
      method: 'POST', headers, body, signal: AbortSignal.timeout(15_000)
    }), 'OAuth token refresh')
    const refreshed = this.tokenFromResponse(document, token, token)
    await this.store(server, refreshed)
    this.runtimeStatus.set(server.id, { serverId: server.id, state: 'authenticated', expiresAt: refreshed.expiresAt })
    return refreshed
  }

  private decrypt(credential: StoredCredential): StoredTokenSet {
    return JSON.parse(this.options.cipher.decrypt(credential.encrypted)) as StoredTokenSet
  }

  private async store(server: McpServerConfig, token: StoredTokenSet): Promise<void> {
    const serverUrl = server.url?.trim()
    if (!serverUrl) throw new Error('Cannot store OAuth credentials without an MCP server URL.')
    this.credentials.set(server.id, {
      serverId: server.id,
      serverUrl,
      encrypted: this.options.cipher.encrypt(JSON.stringify(token))
    })
    await this.save()
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    const file: CredentialFile = { version: 1, credentials: [...this.credentials.values()] }
    await writeFile(temporary, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filePath)
  }
}
