// Shared across engine tests: a no-op PATH hydrator so constructing an
// OrchestrationEngine in-process never spawns the developer's real login
// shell (see src/main/env.ts — an interactive zsh can hang well past its
// own timeout on a slow .zshrc).
export async function noopHydrate(): Promise<void> {}
