// A single polite `aria-live` region (`#live-status` in index.html) for
// state changes that have no other text equivalent on screen the moment they
// happen — a task finishing, the Home route preview settling. Throttled and
// de-duplicated per `topic` so a streaming run (which touches task state many
// times a second — see CLAUDE.md's "Snapshot coalescing") never spams it;
// only the next distinct message per topic is ever announced, at most once
// every 300ms.
const REGION_ID = 'live-status'
const lastByTopic = new Map<string, string>()
let timer: number | undefined
let queued: string | undefined

function region(): HTMLElement | null { return document.getElementById(REGION_ID) }

export function announce(topic: string, message: string): void {
  if (!message || lastByTopic.get(topic) === message) return
  lastByTopic.set(topic, message)
  queued = message
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    const node = region()
    if (node && queued) node.textContent = queued
    queued = undefined
  }, 300)
}
