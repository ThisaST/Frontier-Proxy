import type { SubTask, TaskType } from '../shared/types'

const TASK_TYPES: TaskType[] = ['coding', 'debugging', 'review', 'planning', 'documentation', 'general']

export interface PlannedSubtask {
  title: string
  prompt: string
  type: TaskType
}

export function buildPlannerPrompt(taskPrompt: string): string {
  return [
    'You are a planning coordinator that splits work for a team of coding agents.',
    'Break the TASK below into 2–5 independent subtasks that can run in parallel.',
    'Each subtask prompt must be fully self-contained (assume the agent sees only that prompt and the working directory).',
    'Respond with ONLY a JSON array and no other prose, in exactly this shape:',
    '[{"title": "short label", "prompt": "self-contained instruction", "type": "coding|debugging|review|planning|documentation|general"}]',
    '',
    'TASK:',
    taskPrompt
  ].join('\n')
}

// Pull the first JSON array out of a model response that may wrap it in prose or fences.
function extractJsonArray(text: string): string | undefined {
  const fenced = /```(?:json)?\s*(\[[\s\S]*?\])\s*```/i.exec(text)
  if (fenced) return fenced[1]
  const start = text.indexOf('[')
  if (start < 0) return undefined
  let depth = 0
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '[') depth += 1
    else if (text[i] === ']') { depth -= 1; if (depth === 0) return text.slice(start, i + 1) }
  }
  return undefined
}

export function parsePlan(text: string): PlannedSubtask[] {
  const json = extractJsonArray(text)
  if (!json) return []
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return [] }
  if (!Array.isArray(raw)) return []
  const plan: PlannedSubtask[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : ''
    if (!prompt) continue
    const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : prompt.slice(0, 48)
    const type = TASK_TYPES.includes(record.type as TaskType) ? (record.type as TaskType) : 'general'
    plan.push({ title, prompt, type })
  }
  return plan.slice(0, 6)
}

export function buildSynthesisPrompt(taskPrompt: string, subtasks: SubTask[]): string {
  const sections = subtasks.map((subtask) => {
    const body = subtask.status === 'completed' ? subtask.output.trim() || '(no output)' : `(did not complete: ${subtask.error ?? subtask.status})`
    const branch = subtask.branch ? ` (committed to branch \`${subtask.branch}\`)` : ''
    return `## ${subtask.title}${branch}\n${body}`
  })
  const committed = subtasks.filter((subtask) => subtask.committed && subtask.branch)
  return [
    'You are writing the final report for several subtasks already completed by other agents.',
    'Combine their results into a single cohesive, de-duplicated summary that addresses the ORIGINAL GOAL.',
    'Resolve any conflicts between subtask outputs and note anything left unfinished.',
    '',
    'IMPORTANT — this is a read-only reporting step. Do NOT create, edit, or delete any file, and do NOT',
    'redo the subtasks. Each subtask ran in its own isolated git worktree, so its files are committed on',
    'its own branch and are deliberately absent from the current working tree. Files "missing" here is the',
    'expected state, not a problem to fix. Report on the work; the user merges the branches themselves.',
    ...(committed.length ? ['', 'Committed branches:', ...committed.map((subtask) => `- ${subtask.branch} — ${subtask.title}`)] : []),
    '',
    'ORIGINAL GOAL:',
    taskPrompt,
    '',
    'SUBTASK RESULTS:',
    ...sections
  ].join('\n')
}
