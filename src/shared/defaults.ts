import type { AppSettings } from './types'

export const DEFAULT_SETTINGS: AppSettings = {
  maxParallelTasks: 2,
  quotaCooldownMinutes: 20,
  providers: [
    {
      id: 'codex', name: 'Codex', kind: 'codex', enabled: true, executable: 'codex',
      priority: 80, maxConcurrent: 1,
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
