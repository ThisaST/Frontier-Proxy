import type { AppSettings } from './types'

export const DEFAULT_SETTINGS: AppSettings = {
  maxParallelTasks: 2,
  quotaCooldownMinutes: 20,
  memory: '',
  skills: { disabledIds: [] },
  controlPlane: {
    systemPrompt: '',
    addDirs: [],
    allowedTools: [],
    disallowedTools: [],
    mcpServers: [],
    strictMcp: false
  },
  providers: [
    {
      id: 'codex', name: 'Codex', kind: 'codex', enabled: true, executable: 'codex',
      priority: 80, maxConcurrent: 1,
      // Codex's stream reports context occupancy but not the model's window, so
      // pair it with a GPT-5-family default (~400k) as a fallback the context
      // meter can use. Shown as an estimate; override per provider if it differs.
      contextWindow: 400_000,
      capabilities: ['coding', 'debugging', 'review', 'planning', 'documentation', 'general']
    },
    {
      id: 'claude', name: 'Claude Code', kind: 'claude', enabled: true, executable: 'claude',
      priority: 80, maxConcurrent: 1,
      capabilities: ['coding', 'debugging', 'review', 'planning', 'documentation', 'general']
    },
    {
      id: 'copilot', name: 'GitHub Copilot', kind: 'copilot', enabled: true, executable: 'copilot',
      priority: 76, maxConcurrent: 1,
      capabilities: ['coding', 'debugging', 'review', 'planning', 'documentation', 'general']
    },
    {
      id: 'antigravity', name: 'Antigravity', kind: 'antigravity', enabled: true, executable: 'agy',
      priority: 72, maxConcurrent: 1,
      // agy reports per-run token counts but never its model's window, so pair
      // the occupancy with a Gemini-3-family default (~1M) as an estimate.
      contextWindow: 1_000_000,
      capabilities: ['coding', 'debugging', 'review', 'planning', 'documentation', 'general']
    },
    {
      id: 'codex-ollama', name: 'Codex + Ollama', kind: 'codex-oss', enabled: false, executable: 'codex',
      model: 'qwen3-coder', priority: 65, maxConcurrent: 1,
      capabilities: ['coding', 'debugging', 'review', 'planning', 'documentation', 'general']
    },
    {
      id: 'ollama', name: 'Ollama', kind: 'ollama', enabled: false, executable: 'ollama',
      model: 'qwen3-coder', priority: 55, maxConcurrent: 1,
      capabilities: ['review', 'planning', 'documentation', 'general']
    }
  ]
}

export function freshDefaults(): AppSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings
}
