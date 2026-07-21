import type { TaskType } from './types'

const rules: Array<[TaskType, RegExp]> = [
  ['debugging', /\b(debug|fix|bug|error|exception|failing|failure|crash|regression|diagnos)/i],
  ['review', /\b(review|audit|security|vulnerabilit|pull request|\bpr\b|code quality)/i],
  ['documentation', /\b(document|readme|docs?|comment|guide|tutorial|changelog)/i],
  ['planning', /\b(plan|architect|design|proposal|strategy|roadmap|brainstorm)/i],
  ['coding', /\b(build|implement|create|add|refactor|migrate|code|test|component|function|class|api|cli|app)/i]
]

export function classifyTask(prompt: string): TaskType {
  for (const [type, pattern] of rules) if (pattern.test(prompt)) return type
  return 'general'
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}
