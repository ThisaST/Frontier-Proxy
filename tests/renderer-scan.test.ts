import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Source scan (no DOM needed): the renderer must not branch on a provider's kind where it does
// not have to. CLAUDE.md, "Collaborative workspaces" (ADR 0001 D2): the workspace UI only ever
// sees `ParticipantView` (availability is computed in the main process), so adding a sixth
// provider kind must never touch it.
//
// What is true today, and what this keeps true:
//  1. The workspace view (`workspace.ts`) contains no `provider.kind`, no `ProviderKind`, and no
//     comparison against a provider-kind literal.
//  2. `provider.kind` appears in the renderer only in the files that configure or describe a
//     provider itself (the allowlist below). A new file may not start reading it; shrinking the
//     list is always fine.
// Comments are stripped first, so prose may still explain the rule.

const SRC = fileURLToPath(new URL('../src/renderer/src', import.meta.url))
const read = (file: string): string => readFileSync(join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const files = (readdirSync(SRC, { recursive: true }) as string[]).map((file) => file.replaceAll('\\', '/')).filter((file) => file.endsWith('.ts'))

const PROVIDER_KIND_ACCESS = /\bprovider\.kind\b|\bproviders?\[[^\]]*\]\.kind\b/
const KIND_LITERAL = /\.kind\s*[!=]==?\s*['"](?:claude|codex|codex-oss|copilot|opencode|ollama|custom)['"]/

// Screens about a provider itself: they legitimately show or gate on what kind of CLI it is.
const PROVIDER_KIND_ALLOWED = [
  'task-form.ts',
  'task-helpers.ts', // routePreviewText: the route preview names the picked provider's tier (was views/home.ts)
  'views/agents.ts',
  'views/control.ts',
  'views/routing.ts',
  'views/skills.ts'
]

describe('renderer source scan: provider kinds', () => {
  it('finds the renderer sources', () => {
    expect(files).toContain('workspace.ts')
    expect(files.length).toBeGreaterThan(15)
  })

  it('the workspace view never reads a provider kind', () => {
    const source = read('workspace.ts')
    expect(source).not.toMatch(PROVIDER_KIND_ACCESS)
    expect(source).not.toMatch(/\bProviderKind\b/)
    expect(source).not.toMatch(KIND_LITERAL)
  })

  it('the Office model, grid and simulation never read a provider kind', () => {
    for (const file of ['office-model.ts', 'office-grid.ts', 'office-sim.ts']) {
      const source = readFileSync(fileURLToPath(new URL(`../src/shared/${file}`, import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
      expect(source, file).not.toMatch(PROVIDER_KIND_ACCESS)
      expect(source, file).not.toMatch(/\bProviderKind\b/)
      expect(source, file).not.toMatch(KIND_LITERAL)
    }
  })

  it('provider.kind is read only by the files that describe a provider', () => {
    const readers = files.filter((file) => PROVIDER_KIND_ACCESS.test(read(file)))
    expect(readers.filter((file) => !PROVIDER_KIND_ALLOWED.includes(file))).toEqual([])
  })

  it('no file compares a kind against a provider-kind literal outside the allowlist', () => {
    const offenders = files.filter((file) => KIND_LITERAL.test(read(file)) && !PROVIDER_KIND_ALLOWED.includes(file))
    expect(offenders).toEqual([])
  })
})
