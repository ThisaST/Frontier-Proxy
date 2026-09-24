import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AdvisorKeyManager, adviceFromResponse, advise, buildJevRequest, clearRepoFactsCache,
  heuristicAdvice, JevClient, repoFacts, trimForJev, type AdviceCandidate, type JevResponseBody
} from '../src/main/advisor'
import type { RoutingAdvisorSettings } from '../src/shared/types'

const execFileAsync = promisify(execFile)

function settings(overrides: Partial<RoutingAdvisorSettings> = {}): RoutingAdvisorSettings {
  return { mode: 'active', model: 'jev-latest', minConfidence: 0.5, shareRepoFacts: true, previewWhileTyping: false, ...overrides }
}

function candidates(): AdviceCandidate[] {
  return [
    { providerId: 'claude', model: 'claude-sonnet-5', description: 'Claude Code running claude-sonnet-5.' },
    { providerId: 'codex', model: 'gpt-5-codex', description: 'Codex running gpt-5-codex.' }
  ]
}

describe('buildJevRequest', () => {
  it('produces the exact body shape TypeSafe expects', () => {
    const request = buildJevRequest({ prompt: 'Fix the login bug' }, candidates(), settings())
    expect(request.model).toBe('jev-latest')
    expect(request.state.task).toBe('Fix the login bug')
    expect(request.questions.task_type.type).toBe('choice')
    expect(request.questions.complexity.type).toBe('score')
    expect(request.questions.edits_files.type).toBe('noul')
    expect(request.questions.long_context.type).toBe('noul')
    expect(request.questions.split_worthy.type).toBe('noul')
  })

  it('keys the target choice by "<providerId>::<model>" with a description', () => {
    const request = buildJevRequest({ prompt: 'Fix the login bug' }, candidates(), settings())
    expect(request.questions.target?.criteria).toEqual({
      'claude::claude-sonnet-5': 'Claude Code running claude-sonnet-5.',
      'codex::gpt-5-codex': 'Codex running gpt-5-codex.'
    })
  })

  it('omits the target question below two candidates', () => {
    const request = buildJevRequest({ prompt: 'Fix the login bug' }, candidates().slice(0, 1), settings())
    expect(request.questions.target).toBeUndefined()
  })

  it('includes attachment names and repo facts when provided, never file contents', () => {
    const request = buildJevRequest(
      { prompt: 'Fix the login bug', attachments: ['screenshot.png'] },
      candidates(),
      settings(),
      { languages: ['TypeScript'], fileCount: 42, manifests: ['package.json'], topLevelFolders: ['src'] }
    )
    expect(request.state.attachments).toEqual(['screenshot.png'])
    expect(request.state.repo).toEqual({ languages: ['TypeScript'], fileCount: 42, manifests: ['package.json'], topLevelFolders: ['src'] })
    expect(JSON.stringify(request)).not.toContain('function ')
  })

  it('trims a very long prompt to keep head and tail rather than sending it whole', () => {
    const long = `START${'x'.repeat(200_000)}END`
    const trimmed = trimForJev(long)
    expect(trimmed.length).toBeLessThan(long.length)
    expect(trimmed.startsWith('START')).toBe(true)
    expect(trimmed.endsWith('END')).toBe(true)
  })

  it('leaves a short prompt untouched', () => {
    expect(trimForJev('short prompt')).toBe('short prompt')
  })
})

function response(overrides: Partial<{ task_type: unknown; complexity: unknown; edits_files: unknown; long_context: unknown; split_worthy: unknown; target: unknown }> = {}): JevResponseBody {
  return {
    model: 'jev-1.13.0',
    usage: { input_tokens: 120, output_tokens: 0 },
    answers: {
      task_type: { type: 'choice', choice: 'coding', probabilities: { coding: 0.9, debugging: 0.1 }, confidence: 0.9 },
      complexity: { type: 'score', score: 1.6, probabilities: {}, confidence: 0.7 },
      edits_files: { type: 'noul', noul: 0.95 },
      long_context: { type: 'noul', noul: 0.2 },
      split_worthy: { type: 'noul', noul: 0.1 },
      ...overrides
    } as JevResponseBody['answers']
  }
}

describe('adviceFromResponse', () => {
  it('parses a well-formed response into RoutingAdvice', () => {
    const advice = adviceFromResponse(response(), 'general', 0.5)
    expect(advice.source).toBe('jev')
    expect(advice.taskType).toBe('coding')
    expect(advice.heuristicTaskType).toBe('general')
    expect(advice.complexity).toBe(1.6)
    expect(advice.complexityConfidence).toBe(0.7)
    expect(advice.editsFiles).toBe(0.95)
    expect(advice.inputTokens).toBe(120)
  })

  it('falls back to the heuristic task type when confidence is below the threshold', () => {
    const low = response({ task_type: { type: 'choice', choice: 'coding', probabilities: { coding: 0.4 }, confidence: 0.4 } })
    const advice = adviceFromResponse(low, 'review', 0.5)
    expect(advice.taskType).toBe('review')
    expect(advice.taskTypeConfidence).toBe(0.4)
  })

  it('parses the target answer when present', () => {
    const withTarget = response({ target: { type: 'choice', choice: 'claude::claude-sonnet-5', probabilities: { 'claude::claude-sonnet-5': 0.7, 'codex::gpt-5-codex': 0.3 }, confidence: 0.8 } })
    const advice = adviceFromResponse(withTarget, 'general', 0.5)
    expect(advice.target).toEqual({ choice: 'claude::claude-sonnet-5', probabilities: { 'claude::claude-sonnet-5': 0.7, 'codex::gpt-5-codex': 0.3 }, confidence: 0.8 })
  })

  it('omits target when the response did not ask it', () => {
    const advice = adviceFromResponse(response(), 'general', 0.5)
    expect(advice.target).toBeUndefined()
  })

  it('throws on a malformed response instead of guessing', () => {
    expect(() => adviceFromResponse({ answers: {} }, 'general', 0.5)).toThrow()
    expect(() => adviceFromResponse(null, 'general', 0.5)).toThrow()
    expect(() => adviceFromResponse(response({ task_type: { type: 'choice', choice: 'not-a-real-type', probabilities: {}, confidence: 0.9 } }), 'general', 0.5)).toThrow()
    expect(() => adviceFromResponse(response({ complexity: { type: 'score' } }), 'general', 0.5)).toThrow()
  })
})

describe('heuristicAdvice', () => {
  it('wraps classifyTask in the same shape a Jev answer would take', () => {
    const advice = heuristicAdvice('Fix the crash on login')
    expect(advice.source).toBe('heuristic')
    expect(advice.taskType).toBe('debugging')
    expect(advice.heuristicTaskType).toBe('debugging')
    expect(advice.target).toBeUndefined()
  })
})

function fakeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
    json: async () => body
  } as unknown as Response
}

describe('JevClient', () => {
  it('sends the bearer token and returns latency + parsed json on success', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => fakeResponse(200, response()))
    const client = new JevClient({ fetch: fetchMock as unknown as typeof fetch })
    const { json, latencyMs } = await client.request('secret-key', buildJevRequest({ prompt: 'hi' }, [], settings()))
    expect(json.model).toBe('jev-1.13.0')
    expect(latencyMs).toBeGreaterThanOrEqual(0)
    const [, init] = fetchMock.mock.calls[0]
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret-key' })
  })

  it('maps 401 to a clear, redacted error', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(401, { error: 'invalid key' }))
    const client = new JevClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.request('super-secret', buildJevRequest({ prompt: 'hi' }, [], settings()))).rejects.toThrow('Jev rejected the API key.')
  })

  it('includes the validation detail on 422', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(422, { detail: 'questions.target.criteria: too many options' }))
    const client = new JevClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.request('key', buildJevRequest({ prompt: 'hi' }, [], settings()))).rejects.toThrow(/too many options/)
  })

  it('retries once on 429 honouring Retry-After, capped at the configured max', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls += 1
      if (calls === 1) return fakeResponse(429, { error: 'slow down' }, { 'retry-after': '10' })
      return fakeResponse(200, response())
    })
    const client = new JevClient({ fetch: fetchMock as unknown as typeof fetch, retryDelayCapMs: 5 })
    const started = Date.now()
    const { json } = await client.request('key', buildJevRequest({ prompt: 'hi' }, [], settings()))
    expect(json.model).toBe('jev-1.13.0')
    expect(calls).toBe(2)
    // Retry-After said 10s but the cap is 5ms — the wait must never reach the
    // uncapped duration.
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('retries once on 529 and still fails over to the heuristic if the retry also fails', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => { calls += 1; return fakeResponse(529, { error: 'overloaded' }) })
    const client = new JevClient({ fetch: fetchMock as unknown as typeof fetch, retryDelayCapMs: 5 })
    await expect(client.request('key', buildJevRequest({ prompt: 'hi' }, [], settings()))).rejects.toThrow('overloaded')
    expect(calls).toBe(2)
  })

  it('maps a timeout (abort) to a plain sentence, not a raw AbortError', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }))
    const client = new JevClient({ fetch: fetchMock as unknown as typeof fetch, timeoutMs: 10 })
    await expect(client.request('key', buildJevRequest({ prompt: 'hi' }, [], settings()))).rejects.toThrow('Jev did not respond in time.')
  })

  it('never leaks the API key into an error message', async () => {
    const key = 'sk-super-secret-value'
    const fetchMock = vi.fn(async () => fakeResponse(422, { detail: `bad request from ${key}` }))
    const client = new JevClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.request(key, buildJevRequest({ prompt: 'hi' }, [], settings()))).rejects.not.toThrow(new RegExp(key))
    try {
      await client.request(key, buildJevRequest({ prompt: 'hi' }, [], settings()))
    } catch (error) {
      expect(String(error)).not.toContain(key)
      expect(String(error)).toContain('[redacted]')
    }
  })

  it('test() reports ok + model + latency on success and a plain error on failure', async () => {
    const okFetch = vi.fn(async () => fakeResponse(200, response()))
    const ok = await new JevClient({ fetch: okFetch as unknown as typeof fetch }).test('sk-test-token')
    expect(ok.ok).toBe(true)
    expect(ok.model).toBe('jev-1.13.0')

    const badFetch = vi.fn(async () => fakeResponse(401, {}))
    const bad = await new JevClient({ fetch: badFetch as unknown as typeof fetch }).test('sk-test-token')
    expect(bad.ok).toBe(false)
    expect(bad.error).toBe('Jev rejected the API key.')
  })
})

describe('advise (end-to-end helper)', () => {
  it('returns Jev-sourced advice on success', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(200, response()))
    const client = new JevClient({ fetch: fetchMock as unknown as typeof fetch })
    const advice = await advise(client, 'key', { prompt: 'Implement a feature' }, candidates(), settings())
    expect(advice.source).toBe('jev')
    expect(advice.error).toBeUndefined()
  })

  it('falls back to heuristic advice with the error attached on any failure', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(401, {}))
    const client = new JevClient({ fetch: fetchMock as unknown as typeof fetch })
    const advice = await advise(client, 'sk-test-token', { prompt: 'Fix the crash' }, candidates(), settings())
    expect(advice.source).toBe('heuristic')
    expect(advice.taskType).toBe('debugging')
    expect(advice.error).toBe('Jev rejected the API key.')
  })
})

describe('repoFacts', () => {
  afterEach(() => clearRepoFactsCache())

  it('summarizes language mix, file count, manifests, and top-level folders from a real git repo', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-advisor-repo-'))
    await execFileAsync('git', ['init', '-q', directory])
    await execFileAsync('git', ['-C', directory, 'config', 'user.email', 'test@example.com'])
    await execFileAsync('git', ['-C', directory, 'config', 'user.name', 'Test'])
    await writeFile(join(directory, 'package.json'), '{}')
    await writeFile(join(directory, 'index.ts'), 'export {}')
    await writeFile(join(directory, 'src.py'), 'pass')
    await execFileAsync('git', ['-C', directory, 'add', '.'])
    await execFileAsync('git', ['-C', directory, 'commit', '-q', '-m', 'init'])

    const facts = await repoFacts(directory)
    expect(facts?.fileCount).toBe(3)
    expect(facts?.manifests).toContain('package.json')
    expect(facts?.languages).toEqual(expect.arrayContaining(['TypeScript', 'Python']))
  })

  it('returns undefined for a non-git directory instead of throwing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-advisor-nogit-'))
    await expect(repoFacts(directory)).resolves.toBeUndefined()
  })

  it('caches per cwd rather than shelling out on every call', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-advisor-cache-'))
    await execFileAsync('git', ['init', '-q', directory])
    await execFileAsync('git', ['-C', directory, 'config', 'user.email', 'test@example.com'])
    await execFileAsync('git', ['-C', directory, 'config', 'user.name', 'Test'])
    await writeFile(join(directory, 'a.ts'), '')
    await execFileAsync('git', ['-C', directory, 'add', '.'])
    await execFileAsync('git', ['-C', directory, 'commit', '-q', '-m', 'init'])

    const first = await repoFacts(directory)
    await writeFile(join(directory, 'b.ts'), '')
    await execFileAsync('git', ['-C', directory, 'add', '.'])
    await execFileAsync('git', ['-C', directory, 'commit', '-q', '-m', 'second'])
    const second = await repoFacts(directory)
    expect(second?.fileCount).toBe(first?.fileCount)
  })
})

describe('AdvisorKeyManager', () => {
  function cipher() {
    return { encrypt: (value: string) => Buffer.from(value).toString('base64'), decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8') }
  }

  it('has no key until one is set, and round-trips it through the cipher', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-advisor-key-'))
    const manager = new AdvisorKeyManager(join(directory, 'advisor.json'), cipher())
    await manager.initialize()
    expect(manager.hasKey()).toBe(false)

    await manager.setKey('sk-test-key')
    expect(manager.hasKey()).toBe(true)
    expect(manager.getKey()).toBe('sk-test-key')
  })

  it('persists across a reload and clears on request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-advisor-key-reload-'))
    const path = join(directory, 'advisor.json')
    const first = new AdvisorKeyManager(path, cipher())
    await first.initialize()
    await first.setKey('sk-reloaded')

    const second = new AdvisorKeyManager(path, cipher())
    await second.initialize()
    expect(second.hasKey()).toBe(true)
    expect(second.getKey()).toBe('sk-reloaded')

    await second.clearKey()
    expect(second.hasKey()).toBe(false)
    const third = new AdvisorKeyManager(path, cipher())
    await third.initialize()
    expect(third.hasKey()).toBe(false)
  })

  it('rejects an empty key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontier-advisor-key-empty-'))
    const manager = new AdvisorKeyManager(join(directory, 'advisor.json'), cipher())
    await expect(manager.setKey('   ')).rejects.toThrow()
  })
})
