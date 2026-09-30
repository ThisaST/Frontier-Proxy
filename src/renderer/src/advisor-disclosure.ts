// The header privacy chip's words (ui-plan §6.2, ADR 0002). Pure, so the rule it enforces is
// unit-tested (tests/disclosure.test.ts): with the advisor on and a key stored, the chip names
// Jev and the mode and says exactly what leaves the machine, split-run subtask prompts included,
// and never says "local". Off, or on without a stored key, is still exactly local process mode.
import type { AppSettings } from '../../shared/types'

export interface AdvisorDisclosure { label: string; tone: 'ok' | 'info'; sentence: string }

export function advisorDisclosure(settings: AppSettings, hasKey: boolean): AdvisorDisclosure {
  const advisor = settings.advisor
  if (advisor.mode === 'off' || !hasKey) return { label: 'Local', tone: 'ok', sentence: 'Local process mode. Prompts stay between this app and your CLIs.' }
  const mode = advisor.mode === 'shadow' ? 'Shadow' : 'Active'
  // Everything that can leave the machine while the advisor is on, including the extra split &
  // delegate planning call (subtask titles/prompts can quote code the planner read).
  const scope = advisor.shareRepoFacts ? 'Prompt text, repo facts and split-run subtask prompts are' : 'Prompt text and split-run subtask prompts are'
  return { label: `Jev · ${mode}`, tone: 'info', sentence: `Routing advisor: Jev (${mode}). ${scope} sent to TypeSafe.` }
}
