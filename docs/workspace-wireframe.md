# Workspace view — UI wireframe

Companion to [ADR 0001](adr/0001-collaborative-workspaces.md). Reuses the existing shell:
fixed `100vh`, no page scroll, panels scroll independently, same palette and type scale as
`src/renderer/src/styles.css`.

## 1. Main view (`#workspace-view`)

```
┌────┬──────────────────────┬───────────────────────────────────────────┬─────────────────────┐
│ ◇  │  WORKSPACES      [+] │  #frontier-proxy                          │  PARTICIPANTS   [+] │
│ ⌁  │ ┌──────────────────┐ │  ~/Development/Personal/proxy-app · main  │                     │
│ ⑃  │ │▍#frontier-proxy  │ │───────────────────────────────────────────│  HUMANS             │
│ ◫  │ │ 3 agents      ●2 │ │                                           │  ● Thisara      you │
│ ⊹  │ ├──────────────────┤ │  ┌ Thisara ─────────────── 09:12 ──┐      │                     │
│ ❖  │ │ #site-redesign   │ │  │ @nova can you look at how       │      │  AGENTS             │
│ ▣ ◀│ │ 2 agents         │ │  │ skills.ts walks up to the repo  │      │  ● nova         ⋯   │
│ ⌘  │ ├──────────────────┤ │  │ root? @rex review it after.     │      │    Claude Code      │
│    │ │ #infra           │ │  └─────────────────────────────────┘      │    opus-5 · Reviewer │
│    │ │ 1 agent          │ │                                           │    ⌁ read  ⎇ branch │
│    │ └──────────────────┘ │  ┌ nova · Reviewer ─────── 09:12 ──┐      │                     │
│    │                      │  │ ▓▓▓ reading src/main/skills.ts  │      │  ● rex          ⋯   │
│    │  REPO CONTEXT        │  │ ▓▓▓ Grep  \.agents/skills       │      │    Codex            │
│    │  ~/…/proxy-app       │  │─────────────────────────────────│      │    gpt-5 · Builder  │
│    │  main · 2 uncommitted│  │ It stops at the first `.git`,   │      │    ⌁ read  ⎇ branch │
│    │  Skills 6 · MCP 2    │  │ so a nested project root…       │      │                     │
│    │  [Context & Tools →] │  │                    ▌streaming    │      │  ○ atlas        ⋯   │
│    │                      │  └─────────────────────────────────┘      │    Copilot          │
│    │                      │                                           │    logged out       │
│    │                      │  ┌ rex · Builder ───────── 09:14 ──┐      │                     │
│    │                      │  │ Patched the walk to stop at the │      │─────────────────────│
│    │                      │  │ outermost root instead.         │      │  Only participants  │
│    │                      │  │ ⎇ frontier/ws-frontier-proxy/   │      │  you @mention will  │
│    │                      │  │   4-rex  · 2 files  [Review →]  │      │  reply.             │
│    │                      │  └─────────────────────────────────┘      │                     │
│    │                      │───────────────────────────────────────────│                     │
│    │                      │ ┌───────────────────────────────────────┐ │                     │
│    │                      │ │ Message #frontier-proxy…              │ │                     │
│    │                      │ │                          @  ⧉   [Send]│ │                     │
│    │                      │ └───────────────────────────────────────┘ │                     │
│    │                      │  Addressing @nova, @rex                   │                     │
└────┴──────────────────────┴───────────────────────────────────────────┴─────────────────────┘
```

- **Nav rail** — one new item, `▣ Workspaces`, `data-view="workspace"`, between Tasks and
  Review. Everything else is unchanged.
- **Column 2** is the workspace list plus a read-only repo-context card. The card links
  to the existing Context & Tools screen rather than duplicating its editing.
- **Column 3** is the single conversation. It is the only scrolling region.
- **Column 4** is the roster. `●` available, `○` unavailable with the reason inline —
  this is where a logged-out CLI becomes visible, since "Ready" only proves the binary
  exists.
- The gutter between columns 2/3 and 3/4 is draggable and persisted to `localStorage`,
  same mechanism as `fp-wq-width`.
- **"Addressing @nova, @rex"** under the composer is live feedback from the shared
  `parseMentions`. With no mention it reads *"No one addressed — this will be posted to
  the log only."*

## 2. Mention autocomplete

Triggered by `@` in the composer. Same keyboard contract as the existing file-mention
menu (↑↓ navigate, Enter/Tab accept, Esc close), so it reuses that code path.

```
        ┌──────────────────────────────────────────┐
        │ ● nova     Reviewer   Claude Code        │◀ selected
        │ ● rex      Builder    Codex              │
        │ ○ atlas    Perf       Copilot · logged out│
        │ ● Thisara  you                            │
        └──────────────────────────────────────────┘
   @no▌
```

Unavailable participants stay listed and selectable — you find out why at send time via a
system message, rather than the handle silently not existing.

## 3. Message states

```
queued     ┌ rex · Builder ──── ⏳ waiting for Codex (1 running) ─┐
running    ┌ nova · Reviewer ── ▌ ───────────────────────────────┐   live activity feed
done       ┌ rex · Builder ──── 09:14 ─────────────────────────┐     + ⎇ branch chip
failed     ┌ rex · Builder ──── ⚠ Codex quota reached ────────┐      [Retry this reply]
blocked    ┌ system ─────────────────────────────────────────┐      "@atlas is unavailable:
                                                                     Copilot CLI is logged out."
```

The activity feed inside a running bubble is the same `task.activity` rendering used in
the task view — tool label plus one-line detail from `summarizeToolInput`.

**Retry is per turn.** It re-runs that one participant against the same trigger message
and does not touch the others' replies.

## 4. Participant editor (modal)

```
┌─ Add participant ────────────────────────────────┐
│  Name     [ Nova                              ]  │
│  Handle   [ @nova                             ]  │ unique per workspace
│  Role     [ Reviewer                          ]  │ free text, shown on every message
│  Type     ( ) Human   (•) AI agent               │
│  Agent    [ Claude Code                     ▾ ]  │ from configured providers
│  Model    [ claude-opus-5                   ▾ ]  │ scoped to the chosen agent
│  Accent   [ ■ ][ ■ ][ ■ ][ ■ ][ ■ ][ ■ ]         │
│                                                  │
│  Capabilities                                    │
│   [x] Read the repo                              │
│   [x] Work on an isolated branch                 │
│       Edits run in their own git worktree and    │
│       are committed to a frontier/ branch for    │
│       review. Not a permission boundary.         │
│   [ ] Run commands                               │
│                                                  │
│                          [ Cancel ]  [ Add ]     │
└──────────────────────────────────────────────────┘
```

The Agent and Model dropdowns are populated from the snapshot's provider list and
`runtime.models`, reusing `renderTaskModelOptions`' scoping rule — model options are
filtered to the selected agent, because model ids do not travel between CLIs.

The capability copy is deliberately literal about what isolation does and does not
guarantee (ADR D6). No wording may imply a sandbox.

## 5. Empty and first-run

```
        ┌──────────────────────────────────────────┐
        │             ▣                            │
        │      No workspaces yet                   │
        │                                          │
        │  A workspace is one repo, one            │
        │  conversation, and the agents you        │
        │  invite into it.                         │
        │                                          │
        │        [ Create a workspace ]            │
        └──────────────────────────────────────────┘
```

Creation asks for a name and a folder (reusing `chooseDirectory`), then seeds the roster
with the local human and every enabled provider as a suggested — not yet added —
participant.

## 6. What this view does not have

Stated so it does not get built by accident: no channels or threads within a workspace,
no `@here`, no automatic routing of unaddressed messages, no agent-to-agent replies, no
presence/typing indicators for other humans.
