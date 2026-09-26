(() => {
const CWD = '/Users/Shared/demo/todo-api'
const now = Date.now(), iso = (m) => new Date(now - m * 60e3).toISOString(), soon = (m) => new Date(now + m * 60e3).toISOString()
const usage = (tasks, inT, outT, cost) => ({ date: new Date().toISOString().slice(0, 10), tasks, estimatedInputTokens: tasks * 1400, estimatedOutputTokens: tasks * 900, inputTokens: inT, outputTokens: outT, costUsd: cost, elapsedMs: tasks * 140000, costReported: cost > 0 })
const hist = (n, f) => Array.from({ length: n }, (_, i) => ({ ...usage(f(i), f(i) * 38000, f(i) * 7000, 0), date: new Date(now - (n - i) * 864e5).toISOString().slice(0, 10) }))
const cap = ['coding', 'debugging', 'review', 'planning', 'documentation', 'general']
const providers = [
  { id: 'claude', name: 'Claude Code', kind: 'claude', enabled: true, executable: 'claude', priority: 80, maxConcurrent: 1, capabilities: cap,
    runtime: { available: true, running: 0, version: '2.1.4', auth: { state: 'logged-in', checkedAt: iso(3) }, models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'], usage: usage(6, 246000, 51000, 2.84), history: hist(12, (i) => 3 + (i * 7) % 6), sessions: [{ limitType: 'five_hour', windowMinutes: 300, resetsAt: soon(118), status: 'allowed' }] } },
  { id: 'codex', name: 'Codex', kind: 'codex', enabled: true, executable: 'codex', priority: 80, maxConcurrent: 1, contextWindow: 400000, capabilities: cap,
    runtime: { available: true, running: 0, version: '0.44.0', auth: { state: 'logged-in', checkedAt: iso(3) }, models: ['gpt-5-codex', 'gpt-5', 'gpt-5-mini'], usage: usage(4, 188000, 36000, 0), history: hist(12, (i) => 2 + (i * 5) % 4), sessions: [{ limitType: 'primary', windowMinutes: 300, utilizationPercent: 38, resetsAt: soon(160) }] } },
  { id: 'copilot', name: 'GitHub Copilot', kind: 'copilot', enabled: true, executable: 'copilot', priority: 76, maxConcurrent: 1, capabilities: cap,
    runtime: { available: true, running: 0, version: '1.0.73', auth: { state: 'logged-in', checkedAt: iso(3) }, models: ['claude-sonnet-4.5', 'gpt-5', 'gpt-5-mini'], usage: usage(2, 0, 0, 0), history: hist(12, (i) => (i * 3) % 3) } },
  { id: 'opencode', name: 'OpenCode', kind: 'opencode', enabled: true, executable: 'opencode', priority: 70, maxConcurrent: 1, model: 'ollama/qwen3-coder', capabilities: cap,
    runtime: { available: true, running: 0, version: '0.14.2', models: ['ollama/qwen3-coder', 'anthropic/claude-sonnet-4-5', 'openai/gpt-5-mini'], usage: usage(1, 0, 0, 0) } },
  { id: 'ollama', name: 'Ollama', kind: 'ollama', enabled: true, executable: 'ollama', model: 'qwen3-coder', priority: 55, maxConcurrent: 1, capabilities: ['review', 'planning', 'documentation', 'general'],
    runtime: { available: true, running: 0, version: '0.12.3', models: ['qwen3-coder', 'llama3.2'], usage: usage(0, 0, 0, 0) } }
]
const f = (label, points) => ({ label, points })
const route = (chosen, type, mode, extra = {}) => ({ at: iso(8), taskType: type, mode, chosenProviderId: chosen, candidates: [
  { providerId: 'claude', providerName: 'Claude Code', eligible: true, score: 131, factors: [f('Configured priority', 80), f(`${type} affinity`, 14), f('Jev: complexity 2.1 → standard tier', 20), f('Jev best fit (67%)', 6), f('Recent coding outcomes on claude-sonnet-5 (9 runs)', 11)] },
  { providerId: 'codex', providerName: 'Codex', eligible: true, score: 109, factors: [f('Configured priority', 80), f(`${type} affinity`, 18), f('Jev: complexity 2.1 → standard tier', 10), f('Token efficiency (14 tasks)', 3), f('Spreading usage across subscriptions', -2)] },
  { providerId: 'copilot', providerName: 'GitHub Copilot', eligible: true, score: 92, factors: [f('Configured priority', 76), f(`${type} affinity`, 16)] },
  { providerId: 'opencode', providerName: 'OpenCode', eligible: true, score: 84, factors: [f('Configured priority', 70), f('Balanced policy', 10), f('Jev: complexity 2.1 → standard tier', 10), f('Latency efficiency (6 tasks)', -6)] },
  { providerId: 'ollama', providerName: 'Ollama', eligible: false, skippedReason: `Not enabled for ${type} work` } ], advisor: { mode: 'active', applied: true }, ...extra })
const advice = { source: 'jev', model: 'jev-1.13.0', at: iso(8), latencyMs: 184, inputTokens: 1520, taskType: 'coding', heuristicTaskType: 'coding',
  taskTypeProbs: { coding: 0.74, debugging: 0.15, review: 0.04, planning: 0.04, documentation: 0.02, general: 0.01 }, taskTypeConfidence: 0.68,
  complexity: 2.1, complexityConfidence: 0.74, editsFiles: 0.97, longContext: 0.44, splitWorthy: 0.58,
  target: { choice: 'claude::claude-sonnet-5', confidence: 0.61, probabilities: { 'claude::claude-sonnet-5': 0.49, 'codex::gpt-5-codex': 0.21, 'claude::claude-opus-5': 0.14, 'opencode::anthropic/claude-sonnet-4-5': 0.08, 'codex::gpt-5-mini': 0.05, 'claude::claude-haiku-4-5': 0.03 } } }
const text = `I'll add refresh-token rotation to \`src/auth/tokens.ts\` and cover it with tests.\n\n**Plan**\n1. Issue a new refresh token on every use and revoke the old one.\n2. Detect reuse of a revoked token and revoke the whole family.\n3. Add tests for rotation, reuse detection, and expiry.\n\n\`\`\`ts\nexport async function rotate(token: string): Promise<TokenPair> {\n  const record = await store.find(token)\n  if (!record || record.revokedAt) return revokeFamily(record?.familyId)\n  await store.revoke(record.id)\n  return issue(record.userId, record.familyId)\n}\n\`\`\``
const act = (m, label, detail) => ({ kind: 'tool', label, detail, at: iso(m) })
const tasks = [
  { id: 't1', prompt: 'Add refresh-token rotation to the auth service and cover it with tests', cwd: CWD, mode: 'balanced', type: 'coding', status: 'completed', completedAt: iso(1), providerId: 'claude', selectedProviderId: 'claude', model: 'claude-sonnet-5', createdAt: iso(8), startedAt: iso(8), output: text, estimatedInputTokens: 1400, estimatedOutputTokens: 0,
    attempts: [{ providerId: 'claude', startedAt: iso(8), finishedAt: iso(1), status: 'completed' }], advice, routedModel: { providerId: 'claude', model: 'claude-sonnet-5', reason: 'Jev: complexity 2.1 suggests the standard tier' }, routing: route('claude', 'coding', 'balanced'),
    turns: [{ id: 'u1', role: 'user', content: 'Add refresh-token rotation to the auth service and cover it with tests', at: iso(8) }, { id: 'a1', role: 'assistant', content: text, providerId: 'claude', model: 'claude-sonnet-5', status: 'completed', at: iso(7) }],
    activity: [act(7, 'Read', 'src/auth/tokens.ts'), act(6, 'Grep', 'refreshToken'), act(5, 'Edit', 'src/auth/tokens.ts'), act(3, 'Write', 'tests/auth/rotation.test.ts'), act(1, 'Bash', 'pnpm test tests/auth')],
    filesChanged: [{ path: 'src/auth/tokens.ts', action: 'edit', at: iso(5) }, { path: 'tests/auth/rotation.test.ts', action: 'create', at: iso(3) }], contextTokens: 61000, contextWindow: 200000 },
  { id: 't2', prompt: 'Why does the CSV import drop the last row?', cwd: CWD, mode: 'balanced', type: 'debugging', status: 'queued', createdAt: iso(1), output: '', attempts: [], estimatedInputTokens: 300, estimatedOutputTokens: 0, turns: [{ id: 'u2', role: 'user', content: 'Why does the CSV import drop the last row?', at: iso(1) }] },
  { id: 't3', prompt: 'Split the notifications module into email and push providers', cwd: CWD, mode: 'quality', type: 'coding', status: 'completed', providerId: 'codex', selectedProviderId: 'codex', model: 'gpt-5-codex', createdAt: iso(95), startedAt: iso(95), completedAt: iso(61), output: 'Done — two branches ready for review.', orchestrated: true, orchestrationStage: 'done', attempts: [], estimatedInputTokens: 900, estimatedOutputTokens: 2200,
    turns: [{ id: 'u3', role: 'user', content: 'Split the notifications module into email and push providers', at: iso(95) }], filesChanged: [{ path: 'src/notify/email.ts', action: 'create', at: iso(70) }], routing: route('codex', 'coding', 'quality') },
  { id: 't4', prompt: 'Review the rate limiter for off-by-one errors', cwd: CWD, mode: 'balanced', type: 'review', status: 'completed', providerId: 'copilot', selectedProviderId: 'copilot', model: 'gpt-5', createdAt: iso(180), startedAt: iso(180), completedAt: iso(171), output: 'No off-by-one found; one boundary test is missing.', attempts: [], estimatedInputTokens: 400, estimatedOutputTokens: 700, turns: [{ id: 'u4', role: 'user', content: 'Review the rate limiter for off-by-one errors', at: iso(180) }], routing: route('copilot', 'review', 'balanced') },
  { id: 't5', prompt: 'Document the public REST endpoints in docs/api.md', cwd: CWD, mode: 'saver', type: 'documentation', status: 'completed', providerId: 'opencode', selectedProviderId: 'opencode', model: 'ollama/qwen3-coder', createdAt: iso(300), completedAt: iso(290), output: 'Documented 14 endpoints.', attempts: [], estimatedInputTokens: 300, estimatedOutputTokens: 1800, turns: [{ id: 'u5', role: 'user', content: 'Document the public REST endpoints in docs/api.md', at: iso(300) }] },
  { id: 't6', prompt: 'Upgrade the ORM to v6', cwd: CWD, mode: 'balanced', type: 'coding', status: 'failed', providerId: 'codex', selectedProviderId: 'codex', createdAt: iso(420), output: '', error: 'Plan usage limit reached; failed over to Claude Code, which was busy.', attempts: [], estimatedInputTokens: 200, estimatedOutputTokens: 0, turns: [{ id: 'u6', role: 'user', content: 'Upgrade the ORM to v6', at: iso(420) }] }
]
const settings = { maxParallelTasks: 2, quotaCooldownMinutes: 20, memory: '', skills: { disabledIds: [] }, verification: { enabled: true, commands: [], timeoutSeconds: 300 }, notifications: { enabled: true, onlyWhenUnfocused: true }, learnFromOutcomes: true,
  controlPlane: { systemPrompt: '', addDirs: [], allowedTools: [], disallowedTools: [], mcpServers: [], strictMcp: false }, providers, advisor: { mode: 'active', model: 'jev-latest', minConfidence: 0.5, shareRepoFacts: true, previewWhileTyping: false } }
window.__fixture = { tasks, providers, settings, mcpAuth: [], workspaces: [], advisor: { hasKey: true, lastCheckedAt: iso(2) } }
const vr = (ok) => ({ ran: true, ok, at: iso(60), checks: [{ name: 'typecheck', command: 'pnpm typecheck', ok: true, exitCode: 0, durationMs: 8200, output: '' }, { name: 'test', command: 'pnpm test', ok, exitCode: ok ? 0 : 1, durationMs: 23100, output: ok ? '' : '1 failed' }] })
const branches = [
  { cwd: CWD, branch: 'frontier/t3/1-email-provider', taskId: 't3', subject: 'Extract email provider', committedAt: iso(66), ahead: 1, merged: false, files: [{ path: 'src/notify/email.ts', action: 'create', additions: 84, deletions: 0 }, { path: 'src/notify/index.ts', action: 'edit', additions: 6, deletions: 41 }], verification: vr(true) },
  { cwd: CWD, branch: 'frontier/t3/2-push-provider', taskId: 't3', subject: 'Extract push provider', committedAt: iso(63), ahead: 1, merged: false, files: [{ path: 'src/notify/push.ts', action: 'create', additions: 71, deletions: 0 }, { path: 'tests/notify/push.test.ts', action: 'create', additions: 38, deletions: 0 }], verification: vr(false) }
]
window.__results = {
  listBranchInbox: () => [{ cwd: CWD, name: 'todo-api', currentBranch: 'main', dirty: false, branches }],
  listSkills: () => ({ skills: [], roots: [] }), listWorkspaceEntries: () => [],
  previewControlPlane: () => ({ args: [], promptPrefix: '' }),
  getTaskWorkspace: () => ({ entries: [{ kind: 'folder', name: 'src', path: 'src' }, { kind: 'folder', name: 'auth', path: 'src/auth' }, { kind: 'file', name: 'tokens.ts', path: 'src/auth/tokens.ts' }, { kind: 'folder', name: 'tests', path: 'tests' }, { kind: 'file', name: 'rotation.test.ts', path: 'tests/auth/rotation.test.ts' }], changes: tasks[0].filesChanged }),
  readBranchFile: () => '@@ -1,4 +1,9 @@\n+export async function sendEmail(to: string, body: string) {\n+  return transport.send({ to, body })\n+}\n',
  previewAdvisor: () => ({ request: { state: { task: 'Add refresh-token rotation…', repo: { languages: ['TypeScript'], fileCount: 212, manifests: ['package.json'], topLevelFolders: ['src', 'tests', 'docs'] } }, model: 'jev-latest', questions: {} }, heuristic: { source: 'heuristic', at: iso(0), taskType: 'coding', heuristicTaskType: 'coding' }, decision: route('claude', 'coding', 'balanced'), model: 'claude-sonnet-5' }),
  testAdvisor: () => ({ ok: true, model: 'jev-1.13.0', latencyMs: 171 }), chooseDirectory: () => CWD
}
window.frontier = new Proxy({}, { get: (_, name) => (...args) => {
  if (String(name).startsWith('on')) return () => {}
  const r = window.__results[name]; return Promise.resolve(r ? r(...args) : window.__fixture)
} })
})()
