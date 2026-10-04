// The Office scene: what the 2D office shows, derived purely from an AppSnapshot. One avatar per
// configured agent; its state is where it stands. Pure and DOM-free (compiled under
// tsconfig.node.json), so `now` is always passed in. Unit-tested in tests/office-model.test.ts.
//
// Never reads a provider's kind (tests/renderer-scan.test.ts): appearance is a hash of id + name.
import type { ActivityEvent, AppSnapshot } from './types'
import { activeCooldown, providerLimitReached } from './provider-capacity'

export type OfficeAgentState =
  | 'meeting' | 'working' | 'waiting' | 'idle'                       // present
  | 'cooldown' | 'limited' | 'logged-out' | 'offline' | 'disabled'   // away
export type OfficeWorkKind = 'task' | 'subtask' | 'bench' | 'stage' | 'turn'

export interface OfficeBadge { handle: string; role: string; accent?: string }

export interface OfficeWork {
  kind: OfficeWorkKind
  status: 'running' | 'queued'
  cwd: string
  inScope: boolean                 // projectMatches(cwd) for the caller's projectCwd
  taskId?: string
  subtaskId?: string
  workspaceId?: string
  turnId?: string
  title: string                    // task prompt (first line, ≤80 chars) | subtask title | workspace name
  activity?: string                // activityLabel(latest ActivityEvent)
  badge?: OfficeBadge              // turns only: the participant the agent is "wearing"
  startedAt?: string
}

export interface OfficeAgent {
  providerId: string
  name: string
  state: OfficeAgentState
  work: OfficeWork[]               // running before queued, in-scope before out, then startedAt
  primary?: OfficeWork             // work[0] when state is meeting/working/waiting; drives the zone
  badge?: OfficeBadge              // primary?.badge
  reason?: string                  // away states only, sentence case
  until?: string                   // cooldown end (ISO); the renderer formats the countdown
  running: number
  maxConcurrent: number
}

export interface OfficeRoom {
  workspaceId: string
  name: string
  cwd: string
  seated: string[]                 // providerIds with a running turn here
  waiting: string[]                // providerIds with a queued turn here (and not already seated)
}

export interface OfficeScene {
  agents: OfficeAgent[]            // snapshot.providers order
  rooms: OfficeRoom[]              // in-scope workspaces with ≥1 queued|running turn, by workspace id
  reviewCount: number
  summary: string                  // "4 agents: 2 working, 1 in a meeting, 1 idle"
}

export interface OfficeInput { now: number; projectCwd?: string; reviewCount: number }

export interface OfficeAppearance { skin: number; hair: number; shirt: number }

export const AWAY_STATES: readonly OfficeAgentState[] = ['cooldown', 'limited', 'logged-out', 'offline', 'disabled']
export const isAway = (state: OfficeAgentState): boolean => AWAY_STATES.includes(state)
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)
const firstLine = (text: string): string => clip((text.split('\n').find((line) => line.trim()) ?? '').trim().replace(/\s+/g, ' '), 80)

// Same rule as the renderer's project switcher (`projectMatches`: an unset project matches everything, otherwise
// an exact cwd match); copied rather than imported because shared code must stay DOM-free.
const inProject = (cwd: string, projectCwd?: string): boolean => !projectCwd || cwd === projectCwd

const compareWork = (left: OfficeWork, right: OfficeWork): number => {
  if (left.status !== right.status) return left.status === 'running' ? -1 : 1
  if (left.inScope !== right.inScope) return left.inScope ? -1 : 1
  if (left.startedAt === right.startedAt) return 0
  if (left.startedAt === undefined) return 1
  if (right.startedAt === undefined) return -1
  return Date.parse(left.startedAt) - Date.parse(right.startedAt) || (left.startedAt < right.startedAt ? -1 : 1)
}

function agentState(provider: AppSnapshot['providers'][number], work: readonly OfficeWork[], now: number): Pick<OfficeAgent, 'state' | 'reason' | 'until'> {
  const { runtime } = provider
  if (!provider.enabled) return { state: 'disabled', reason: 'Disabled' }
  if (!runtime.available) return { state: 'offline', reason: 'CLI not detected' }
  if (runtime.auth?.state === 'logged-out') return { state: 'logged-out', reason: 'Logged out' }
  if (activeCooldown(provider, now)) return { state: 'cooldown', until: runtime.cooldownUntil, reason: 'Cooling down' }
  if (providerLimitReached(provider, now)) return { state: 'limited', reason: 'Usage limit reached' }
  if (work.some((item) => item.kind === 'turn' && item.status === 'running' && item.inScope)) return { state: 'meeting' }
  // An out-of-scope running turn is not a meeting here (its room isn't shown), so the agent is simply busy.
  if (work.some((item) => item.status === 'running' && (item.kind !== 'turn' || !item.inScope))) return { state: 'working' }
  if (work.some((item) => item.status === 'queued')) return { state: 'waiting' }
  return { state: runtime.running > 0 ? 'working' : 'idle' }
}

export function buildOfficeScene(snapshot: Pick<AppSnapshot, 'tasks' | 'providers' | 'workspaces'>, input: OfficeInput): OfficeScene {
  const byProvider = new Map<string, OfficeWork[]>()
  const add = (providerId: string | undefined, item: Omit<OfficeWork, 'inScope'>): void => {
    if (!providerId) return
    const list = byProvider.get(providerId) ?? []
    list.push({ ...item, inScope: inProject(item.cwd, input.projectCwd) })
    byProvider.set(providerId, list)
  }
  for (const task of snapshot.tasks) {
    const latest = activityLabel(task.activity?.at(-1))
    const attempt = task.attempts.at(-1)
    if (task.status === 'running' && !task.orchestrated && !task.bench && attempt?.status === 'running') {
      add(attempt.providerId, { kind: 'task', status: 'running', taskId: task.id, cwd: task.cwd, title: firstLine(task.prompt), activity: latest, startedAt: attempt.startedAt })
    }
    for (const subtask of task.subtasks ?? []) {
      if (subtask.status !== 'running' && subtask.status !== 'queued') continue
      add(subtask.providerId, { kind: task.bench ? 'bench' : 'subtask', status: subtask.status, taskId: task.id, subtaskId: subtask.id, cwd: task.cwd, title: subtask.title, activity: task.bench ? undefined : latest, startedAt: subtask.startedAt })
    }
    const stage = task.orchestrationStage
    if (task.orchestrated && task.status === 'running' && (stage === 'planning' || stage === 'synthesizing')) {
      add(task.selectedProviderId, { kind: 'stage', status: 'running', taskId: task.id, cwd: task.cwd, title: `${stage === 'planning' ? 'Planning' : 'Synthesizing'}: ${firstLine(task.prompt)}`, startedAt: task.startedAt })
    }
  }
  for (const workspace of snapshot.workspaces) {
    for (const turn of workspace.turns) {
      if (turn.status !== 'queued' && turn.status !== 'running') continue
      const who = workspace.participants.find((candidate) => candidate.id === turn.participantId)
      add(turn.providerId, {
        kind: 'turn', status: turn.status, workspaceId: workspace.id, turnId: turn.id, cwd: workspace.cwd, title: workspace.name,
        activity: activityLabel(turn.activity?.at(-1)), startedAt: turn.startedAt,
        ...(who ? { badge: { handle: who.handle, role: who.role, ...(who.accent ? { accent: who.accent } : {}) } } : {})
      })
    }
  }
  const agents = snapshot.providers.map((provider): OfficeAgent => {
    const work = (byProvider.get(provider.id) ?? []).sort(compareWork)
    const { state, reason, until } = agentState(provider, work, input.now)
    const primary = state === 'meeting' || state === 'working' || state === 'waiting' ? work[0] : undefined
    return { providerId: provider.id, name: provider.name, state, work, primary, badge: primary?.badge, reason, until, running: provider.runtime.running, maxConcurrent: provider.maxConcurrent }
  })
  const present = new Set(agents.filter((agent) => !isAway(agent.state)).map((agent) => agent.providerId))
  const rooms = snapshot.workspaces
    .filter((workspace) => inProject(workspace.cwd, input.projectCwd))
    .map((workspace): OfficeRoom | undefined => {
      const active = workspace.turns.filter((turn) => (turn.status === 'running' || turn.status === 'queued') && present.has(turn.providerId))
      if (!workspace.turns.some((turn) => turn.status === 'running' || turn.status === 'queued')) return undefined
      const seated = [...new Set(active.filter((turn) => turn.status === 'running').map((turn) => turn.providerId))]
      const waiting = [...new Set(active.filter((turn) => turn.status === 'queued').map((turn) => turn.providerId))].filter((id) => !seated.includes(id))
      return { workspaceId: workspace.id, name: workspace.name, cwd: workspace.cwd, seated, waiting }
    })
    .filter((room): room is OfficeRoom => Boolean(room))
    .sort((left, right) => (left.workspaceId < right.workspaceId ? -1 : left.workspaceId > right.workspaceId ? 1 : 0))
  return { agents, rooms, reviewCount: input.reviewCount, summary: officeSummary(agents) }
}

export function activityLabel(event: ActivityEvent | undefined): string | undefined {
  if (!event) return undefined
  const text = event.kind === 'thinking' ? 'Thinking…' : event.kind === 'tool' && event.detail ? `${event.label} ${event.detail}` : event.label
  return clip(text.replace(/\s+/g, ' ').trim(), 60)
}

export function officeSummary(agents: readonly OfficeAgent[]): string {
  if (!agents.length) return 'No agents'
  const count = (match: (state: OfficeAgentState) => boolean): number => agents.filter((agent) => match(agent.state)).length
  const parts: Array<[number, string]> = [
    [count((state) => state === 'working'), 'working'], [count((state) => state === 'meeting'), 'in a meeting'],
    [count((state) => state === 'waiting'), 'waiting'], [count((state) => state === 'idle'), 'idle'], [count(isAway), 'away']
  ]
  return `${agents.length} agent${agents.length === 1 ? '' : 's'}: ${parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`).join(', ')}`
}

// FNV-1a, 32-bit.
export function officeHash(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0
  return hash >>> 0
}

export function agentAppearance(providerId: string, name: string): OfficeAppearance {
  const hash = officeHash(`${providerId}\u0000${name}`)
  return { skin: hash % 3, hair: (hash >>> 8) % 4, shirt: (hash >>> 16) % 6 }
}

