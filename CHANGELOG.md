# frontier-proxy

## 0.11.0

### Minor Changes

- [#28](https://github.com/ThisaST/Frontier-Proxy/pull/28) [`afb893c`](https://github.com/ThisaST/Frontier-Proxy/commit/afb893c0dc80a95fc5c6c26f82722665b916a66f) Thanks [@ThisaST](https://github.com/ThisaST)! - New **Office** section: a Gather-style pixel-art map of where every agent is right now. Each configured agent is an avatar whose place is its state — at its desk while it runs a task (monitor lit, a speech bubble with its latest tool call), around a meeting-room table with the other participants of a workspace thread (wearing that participant's `@handle · role` tag), waiting by the door for a free slot, lounging when idle, or greyed out in the away area with the reason when it is cooling down, over a usage limit, logged out, not detected or disabled. A review desk stacks the branches waiting in Review. Agents walk between zones as their state changes (and snap when effects are off); you have an avatar too — arrow keys walk, Enter talks to the agent next to you, and stepping into a room opens that workspace. Clicking an avatar opens a card with what it is doing and buttons to open the task, workspace or agent sheet; clicking a room or the review desk opens that screen; and the roster under the map is its accessible twin.

## 0.10.0

### Minor Changes

- [#26](https://github.com/ThisaST/Frontier-Proxy/pull/26) [`bb2a63e`](https://github.com/ThisaST/Frontier-Proxy/commit/bb2a63e06781e37fe7459095c929100980f5e492) Thanks [@ThisaST](https://github.com/ThisaST)! - New "Calm" interface. Three theme families in light and dark, chosen in Settings → Appearance: Neutral (cool grays, one indigo accent, now the default), Mono (warm stone and ink) and Phosphor (the previous amber console look, kept as a family). A floating dock you can place at the bottom, left or right replaces the sidebar, and a slim header row with the project switcher and the privacy chip replaces the topbar. Home is folded into Tasks as a compose state with one composer; Routing, Context & Tools, Skills and Verification are Settings tabs, and every settings form keeps an unsaved edit safe from live updates. Dock labels, density and font size are settings too. A stored Console or Daylight theme becomes Neutral dark or light; Phosphor is one click away.

## 0.9.4

### Patch Changes

- [#22](https://github.com/ThisaST/Frontier-Proxy/pull/22) [`68e5c44`](https://github.com/ThisaST/Frontier-Proxy/commit/68e5c441f2434cefe391da75ffad3e4b9116cad0) Thanks [@ThisaST](https://github.com/ThisaST)! - Jev routing advisor fixes: tasks now show the model an agent actually ran (the advisor's pick or your override) instead of the provider's default when the CLI doesn't report its model; long pasted logs and non-English prompts get Jev advice instead of silently falling back to local rules; and Jev errors read as a plain sentence instead of raw JSON.
