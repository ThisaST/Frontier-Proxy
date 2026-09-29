// Settings → Skills: the cwd-scoped catalog, each skill's switch applying the moment it changes.
// Async and cwd-scoped, so it renders on tab entry and on a project change, never from a snapshot.
import type { SkillCatalog, SkillScope } from '../../../shared/types'
import { byId, element } from '../ui/dom'
import { status, tag } from '../ui/components'
import { reportError } from '../ui/feedback'
import { snapshot, setSnapshot } from '../state'
import { emptyRow, settingsTable, switchControl, tableRow } from './settings-parts'

// Kinds whose CLI can be handed a skill selection at all (ollama/custom never
// see the control plane, so they never see skills either). Exported for the
// new-task dialog's own skills selector.
export const SKILL_CAPABLE_KINDS = ['claude', 'copilot', 'codex', 'codex-oss', 'opencode'] as const
export const SKILL_KIND_LABELS: Record<string, string> = { claude: 'Claude Code', copilot: 'GitHub Copilot', codex: 'Codex', 'codex-oss': 'Codex + Ollama', opencode: 'OpenCode' }
const SCOPE_LABEL: Record<SkillScope, string> = { personal: 'Personal', project: 'Project' }

function readStorage(key: string): string | undefined { try { return localStorage.getItem(key) ?? undefined } catch { return undefined } }
function writeStorage(key: string, value: string): void { try { localStorage.setItem(key, value) } catch { /* private mode / disabled storage */ } }

const SKILLS_CWD_KEY = 'fp-skills-cwd'
let skillsCwd = readStorage(SKILLS_CWD_KEY) ?? ''
let skillCatalog: SkillCatalog | undefined

// Kinds among the configured providers that the catalog's per-source
// `nativeFor` can be checked against — the tag is about the CLI, not any
// one instance of it, so kinds are de-duplicated.
function configuredSkillKinds(): string[] {
  const kinds = new Set(
    snapshot.providers
      .map((provider) => provider.kind)
      .filter((kind): kind is typeof SKILL_CAPABLE_KINDS[number] => (SKILL_CAPABLE_KINDS as readonly string[]).includes(kind))
  )
  return [...kinds]
}

// Which configured CLIs enforce this skill's switch, and which only get a prompt instruction.
// Native = enforced via the CLI's own flag (Claude's Skill(...)). OpenCode is enforced either way:
// a root it does not scan joins through its config (`skills.paths`) and the per-skill permission
// still applies. Everything else is only ever a prompt-injected suggestion (no flag can stop the
// CLI from discovering the skill itself), so it is labelled best effort, never a guarantee.
function skillReach(sources: SkillCatalog['skills'][number]['sources']): HTMLElement {
  const nativeFor = new Set<string>(sources.flatMap((source) => source.nativeFor))
  const enforced: string[] = [], bestEffort: string[] = []
  for (const kind of configuredSkillKinds()) {
    const label = SKILL_KIND_LABELS[kind] ?? kind
    if (nativeFor.has(kind)) enforced.push(label)
    else if (kind === 'opencode') enforced.push(`${label} (via config)`)
    else bestEffort.push(label)
  }
  const cell = element('div', 'skill-reach')
  const tags = element('div', 'tag-list')
  tags.append(...(enforced.length ? enforced.map(tag) : [element('span', 'cell-faint', 'None')]))
  cell.append(tags)
  if (bestEffort.length) cell.append(element('div', 'cell-note', `Prompt only, best effort: ${bestEffort.join(', ')}`))
  return cell
}

function renderSkillRoots(): void {
  const container = byId('skills-roots')
  const { box, body } = settingsTable(['Folder', 'Scope', 'Found by', 'Status'])
  if (!skillCatalog) body.append(emptyRow(4, 'Choose a project', 'Pick a working directory to see which folders are scanned.'))
  else body.append(...skillCatalog.roots.map((root) => tableRow([
    { content: root.root, className: 'cell-mono' },
    tag(SCOPE_LABEL[root.scope]),
    { content: root.nativeFor.map((kind) => SKILL_KIND_LABELS[kind] ?? kind).join(', '), className: 'cell-muted' },
    root.exists ? status('ok', 'Found') : status('neutral', 'Not found')
  ])))
  container.replaceChildren(box)
}

function renderSkillList(): void {
  const list = byId('skills-list')
  const { box, body } = settingsTable(['Skill', 'Scope', 'Enforced by', { label: 'Enabled', className: 'cell-end' }])
  if (!skillCatalog) body.append(emptyRow(4, 'Choose a project', 'Pick a working directory to scan for skills.'))
  else if (!skillCatalog.skills.length) body.append(emptyRow(4, 'No skills found', 'No SKILL.md folders were found under the scanned folders for this project.'))
  else {
    const disabled = new Set(snapshot.settings.skills.disabledIds)
    body.append(...skillCatalog.skills.map((skill) => {
      const about = element('div', 'skill-about')
      about.append(element('div', 'cell-strong', skill.name), element('div', 'cell-note', skill.description || 'No description provided.'))
      if (skill.sources.length > 1) about.append(element('div', 'cell-note cell-mono', `Defined in ${skill.sources.length} places: ${skill.sources.map((source) => source.root).join(', ')}`))
      const scopes = element('div', 'tag-list')
      scopes.append(...[...new Set(skill.sources.map((source) => source.scope))].map((scope) => tag(SCOPE_LABEL[scope])))

      const toggle = switchControl(undefined, !disabled.has(skill.id), `Enable ${skill.name}`)
      toggle.input.addEventListener('change', async () => {
        const input = toggle.input
        input.disabled = true
        const next = new Set(snapshot.settings.skills.disabledIds)
        if (input.checked) next.delete(skill.id); else next.add(skill.id)
        try { setSnapshot(await window.frontier.updateSettings({ skills: { disabledIds: [...next] } })) }
        catch (error) { input.checked = !input.checked; reportError('Could not update skill', error) }
        // Nothing else in the row depends on the disabled set, and the switch already shows the
        // new state, so don't repaint the table: that replaces every node and drops focus
        // mid-toggle for keyboard users.
        finally { input.disabled = false }
      })
      return tableRow([about, scopes, skillReach(skill.sources), { content: toggle.wrap, className: 'cell-end' }])
    }))
  }
  list.replaceChildren(box)
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

// Entry point from showSettingsTab — async and cwd-scoped, so (like renderControlPlane)
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
