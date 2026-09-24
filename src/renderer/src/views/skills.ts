// Skills view — cwd-scoped catalog, enable/disable per skill.
import type { SkillCatalog } from '../../../shared/types'
import { byId, element, emptyState } from '../ui/dom'
import { reportError } from '../ui/feedback'
import { snapshot, setSnapshot } from '../state'

// Kinds whose CLI can be handed a skill selection at all (ollama/custom never
// see the control plane, so they never see skills either). Exported for the
// new-task dialog's own skills selector.
export const SKILL_CAPABLE_KINDS = ['claude', 'copilot', 'codex', 'codex-oss'] as const
export const SKILL_KIND_LABELS: Record<string, string> = { claude: 'Claude Code', copilot: 'GitHub Copilot', codex: 'Codex', 'codex-oss': 'Codex + Ollama' }

function readStorage(key: string): string | undefined { try { return localStorage.getItem(key) ?? undefined } catch { return undefined } }
function writeStorage(key: string, value: string): void { try { localStorage.setItem(key, value) } catch { /* private mode / disabled storage */ } }

const SKILLS_CWD_KEY = 'fp-skills-cwd'
let skillsCwd = readStorage(SKILLS_CWD_KEY) ?? ''
let skillCatalog: SkillCatalog | undefined

// Kinds among the configured providers that the catalog's per-source
// `nativeFor` can be checked against — the badge is about the CLI, not any
// one instance of it, so kinds are de-duplicated.
function configuredSkillKinds(): string[] {
  const kinds = new Set(
    snapshot.providers
      .map((provider) => provider.kind)
      .filter((kind): kind is typeof SKILL_CAPABLE_KINDS[number] => (SKILL_CAPABLE_KINDS as readonly string[]).includes(kind))
  )
  return [...kinds]
}

export function skillBadges(sources: SkillCatalog['skills'][number]['sources']): HTMLElement {
  const nativeFor = new Set(sources.flatMap((source) => source.nativeFor))
  const badges = element('div', 'skill-badges')
  for (const kind of configuredSkillKinds()) {
    const native = nativeFor.has(kind as typeof SKILL_CAPABLE_KINDS[number])
    // Native = enforced via the CLI's own flag (Claude's Skill(...)). Everything
    // else is only ever a prompt-injected suggestion — no flag can stop the CLI
    // from discovering the skill itself, so this must never read as a guarantee.
    badges.append(element('span', `skill-badge ${native ? 'native' : 'injected'}`, `${SKILL_KIND_LABELS[kind] ?? kind} · ${native ? 'native' : 'prompt-injected · best effort'}`))
  }
  return badges
}

function renderSkillRoots(): void {
  const container = byId('skills-roots')
  if (!skillCatalog) { container.replaceChildren(); return }
  container.replaceChildren(...skillCatalog.roots.map((root) => {
    const item = element('div', `skill-root${root.exists ? '' : ' absent'}`)
    const kinds = root.nativeFor.map((kind) => SKILL_KIND_LABELS[kind] ?? kind).join(', ')
    item.append(
      element('strong', undefined, root.root),
      element('small', undefined, `${root.scope === 'personal' ? 'Personal' : 'Project'} · native for ${kinds}${root.exists ? '' : ' · not found'}`)
    )
    return item
  }))
}

function renderSkillList(): void {
  const list = byId('skills-list')
  if (!skillCatalog) { list.replaceChildren(emptyState('Choose a project', 'Pick a working directory to scan for skills.')); return }
  if (!skillCatalog.skills.length) { list.replaceChildren(emptyState('No skills found', 'No SKILL.md folders were found under the scanned roots for this project.')); return }
  const disabled = new Set(snapshot.settings.skills.disabledIds)
  list.replaceChildren(...skillCatalog.skills.map((skill) => {
    const card = element('div', 'skill-card')
    const top = element('div', 'skill-card-top')
    const heading = element('div', 'skill-card-heading')
    heading.append(element('strong', undefined, skill.name), element('p', undefined, skill.description || 'No description provided.'))

    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = !disabled.has(skill.id)
    toggle.setAttribute('aria-label', `Enable ${skill.name}`)
    const toggleWrap = document.createElement('label'); toggleWrap.className = 'switch small'
    toggleWrap.append(toggle, element('span', 'slider'))
    toggle.addEventListener('change', async () => {
      toggle.disabled = true
      const next = new Set(snapshot.settings.skills.disabledIds)
      if (toggle.checked) next.delete(skill.id); else next.add(skill.id)
      try { setSnapshot(await window.frontier.updateSettings({ skills: { disabledIds: [...next] } })) }
      catch (error) { toggle.checked = !toggle.checked; reportError('Could not update skill', error) }
      // Nothing else on the card depends on the disabled set, and the checkbox
      // already shows the new state, so don't repaint the list — that replaces
      // every node and drops focus mid-toggle for keyboard users.
      finally { toggle.disabled = false }
    })
    top.append(heading, toggleWrap)
    card.append(top, skillBadges(skill.sources))
    if (skill.sources.length > 1) card.append(element('div', 'skill-source', `Defined in ${skill.sources.length} places: ${skill.sources.map((source) => source.root).join(', ')}`))
    return card
  }))
}

async function loadSkillsView(refresh = false): Promise<void> {
  const cwd = byId<HTMLInputElement>('skills-cwd').value.trim()
  skillsCwd = cwd
  writeStorage(SKILLS_CWD_KEY, cwd)
  if (!cwd) { skillCatalog = undefined; renderSkillRoots(); renderSkillList(); return }
  try {
    skillCatalog = await window.frontier.listSkills(cwd, refresh)
  } catch (error) {
    skillCatalog = undefined
    reportError('Could not scan skills', error)
  }
  renderSkillRoots()
  renderSkillList()
}

// Entry point from switchView — async and cwd-scoped, so (like renderControlPlane)
// it only runs on entry, never from the general snapshot-driven render().
export async function renderSkills(): Promise<void> {
  if (!skillsCwd) skillsCwd = snapshot.tasks[0]?.cwd ?? ''
  byId<HTMLInputElement>('skills-cwd').value = skillsCwd
  await loadSkillsView()
}

export function initSkillsView(): void {
  byId('skills-choose-directory').addEventListener('click', async () => {
    const button = byId<HTMLButtonElement>('skills-choose-directory')
    button.disabled = true
    button.textContent = 'Choosing…'
    try {
      const input = byId<HTMLInputElement>('skills-cwd')
      const directory = await window.frontier.chooseDirectory(input.value)
      if (directory) { input.value = directory; await loadSkillsView() }
    } catch (error) { reportError('Folder picker failed', error) }
    finally { button.disabled = false; button.textContent = 'Choose folder…' }
  })
  byId<HTMLInputElement>('skills-cwd').addEventListener('change', () => void loadSkillsView())
  byId('skills-refresh').addEventListener('click', () => void loadSkillsView(true))
}
