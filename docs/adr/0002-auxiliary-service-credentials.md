# ADR 0002 — Auxiliary service credentials

Status: **accepted** (2026-09-24)

## Context

Frontier's founding rule is *no API keys, ever*. Every coding agent authenticates through
its own CLI login, and prompts only travel between the app and those CLIs. The rule exists so
that Frontier never becomes a second, weaker place to keep a model-provider secret, and so
that "which agent ran" always means "which subscription paid".

Two features need a credential that is not a model-execution key:

- **Jev routing advisor** (TypeSafe's System One model): a hosted classifier that returns
  calibrated, typed decisions about a task. It generates no text and runs no agent. Using it
  means sending task text to `api.typesafe.ai`.
- **Forge APIs** (GitHub / GitLab / Bitbucket), to open pull requests. This is deferred, but
  it falls under the same rule.

## Decision

Narrow the rule instead of dropping it.

1. **Still forbidden:** any key that runs a coding agent or model *on the user's behalf*,
   such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or Copilot tokens. Agents keep
   authenticating through their own CLI. A provider that cannot authenticate is still fixed
   by logging in to that CLI.
2. **Allowed, opt-in:** credentials for **auxiliary services** that never execute a coding
   agent: the routing advisor and forge APIs.
3. Every auxiliary credential:
   - is encrypted with Electron `safeStorage` and stored in the main process only (the same
     pattern as MCP OAuth tokens);
   - is never sent to the renderer, which only learns `hasKey`;
   - is never written to logs, task output, or `frontier-state.json`;
   - is redacted from every error message.
4. **Auxiliary services are off by default.** Turning one on shows exactly what will leave the
   machine. The sidebar privacy note is derived from settings and never claims "local only"
   while an advisor is active.
5. **Auxiliary services only inform decisions.** Losing one (offline, invalid key, rate
   limited, slow) must leave Frontier behaving exactly as it did without it.

## Consequences

- `CLAUDE.md`, `README.md`, the Agents screen intro and the site copy state the narrowed
  rule.
- Reviewers check new credential code against the list in point 3.
- A future request for "just add an OpenAI key" is still out of scope under point 1.
