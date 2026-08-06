import type { WorkspaceParticipant } from './types'

// Mentions are the only dispatch mechanism (ADR D3) — pure and shared by the renderer's
// autocomplete and the main-process dispatcher so the two cannot drift.

// A mention starts at a '@' preceded by nothing (string start), whitespace, or an
// opening bracket/paren — this is what keeps `email@nova.com` from matching `@nova`.
// The handle itself is a run of letters/digits/-/_, so trailing punctuation like
// `@nova,` or `@nova.` is never part of the match.
const MENTION_PATTERN = /(?:^|[\s([{])@([A-Za-z0-9_-]+)/g
const FENCED_CODE = /```[\s\S]*?```/g
const INLINE_CODE = /`[^`\n]*`/g
const HANDLE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/

// A stored/compared handle is always lowercased and stripped of its leading '@'.
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@/, '').toLowerCase()
}

// Used for uniqueness validation when a participant's handle is created/edited.
export function isValidHandle(raw: string): boolean {
  return HANDLE_PATTERN.test(normalizeHandle(raw))
}

// Mentions inside fenced or inline code are examples, not addresses — blank them out
// before scanning so a code sample never dispatches an agent.
function stripCode(text: string): string {
  return text.replace(FENCED_CODE, ' ').replace(INLINE_CODE, ' ')
}

export function parseMentions(text: string, participants: WorkspaceParticipant[]): { addressed: string[]; unknown: string[] } {
  const byHandle = new Map(participants.map((participant) => [normalizeHandle(participant.handle), participant.id]))
  const addressed: string[] = []
  const unknown: string[] = []
  const seenIds = new Set<string>()
  const seenHandles = new Set<string>()
  for (const match of stripCode(text).matchAll(MENTION_PATTERN)) {
    const handle = normalizeHandle(match[1])
    const participantId = byHandle.get(handle)
    if (participantId) {
      if (!seenIds.has(participantId)) { seenIds.add(participantId); addressed.push(participantId) }
    } else if (!seenHandles.has(handle)) { seenHandles.add(handle); unknown.push(handle) }
  }
  return { addressed, unknown }
}
