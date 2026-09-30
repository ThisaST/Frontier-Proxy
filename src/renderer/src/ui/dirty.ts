// The dirty guard every settings form uses (CLAUDE.md, "Live snapshots must not clobber an unsaved
// form edit"). A streamed task fires a snapshot roughly every 60ms, and every view re-renders from
// it; without this a value the user just typed snaps back to the saved one and Save persists the
// stale value. A field turns dirty on its first `input`/`change` and stays dirty until the edit is
// saved or discarded (`clear`); `reflect` writes a snapshot value only into a field that is neither
// dirty nor focused. No app state and no Electron: unit-tested in tests/dirty.test.ts.

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement

export interface DirtyGuard {
  // With no id: whether any guarded field is dirty.
  isDirty(id?: string): boolean
  // For edits that do not come from a guarded control's own event (a row added to a list).
  mark(id: string): void
  // With no id: every field (after a save, or on Discard).
  clear(id?: string): void
  // Writes a snapshot value into a control unless it is dirty or focused. Checkboxes take a boolean.
  reflect(id: string, value: string | number | boolean): void
  // Called whenever the guard flips between clean and dirty.
  onChange(listener: (dirty: boolean) => void): void
}

const control = (id: string): Control | null => document.getElementById(id) as Control | null

export function createDirtyGuard(ids: readonly string[]): DirtyGuard {
  const dirty = new Set<string>()
  const listeners: Array<(dirty: boolean) => void> = []
  const notify = (before: boolean): void => { if (before !== dirty.size > 0) for (const listener of listeners) listener(dirty.size > 0) }
  const mark = (id: string): void => { const before = dirty.size > 0; dirty.add(id); notify(before) }
  for (const id of ids) {
    const node = control(id)
    node?.addEventListener('input', () => mark(id))
    node?.addEventListener('change', () => mark(id))
  }
  return {
    isDirty: (id) => (id === undefined ? dirty.size > 0 : dirty.has(id)),
    mark,
    clear(id) { const before = dirty.size > 0; if (id === undefined) dirty.clear(); else dirty.delete(id); notify(before) },
    reflect(id, value) {
      const node = control(id)
      if (!node || dirty.has(id) || document.activeElement === node) return
      if (node instanceof HTMLInputElement && node.type === 'checkbox') node.checked = Boolean(value)
      else if (node.value !== String(value)) node.value = String(value)
    },
    onChange(listener) { listeners.push(listener) }
  }
}

// The per-tab save bar: "Unsaved changes", Discard and Save. It is only for text fields; switches
// and segmented controls apply instantly and never touch it. Markup (index.html or built in TS):
// `.save-bar` holding `[data-save-hint]`, `[data-save-discard]` and `[data-save]` buttons. The
// hint and Discard show, and Save enables, only while the guard is dirty.
export interface SaveBarHandlers { save(): Promise<void>; discard(): void }

export function bindSaveBar(bar: HTMLElement, guard: DirtyGuard, handlers: SaveBarHandlers): void {
  const hint = bar.querySelector<HTMLElement>('[data-save-hint]')!
  const discard = bar.querySelector<HTMLButtonElement>('[data-save-discard]')!
  const save = bar.querySelector<HTMLButtonElement>('[data-save]')!
  let saving = false
  const sync = (): void => {
    const dirty = guard.isDirty()
    bar.classList.toggle('is-dirty', dirty)
    hint.hidden = !dirty; discard.hidden = !dirty
    save.disabled = saving || !dirty
  }
  guard.onChange(sync)
  discard.addEventListener('click', () => { guard.clear(); handlers.discard() })
  save.addEventListener('click', async () => {
    saving = true; sync()
    try { await handlers.save() } finally { saving = false; sync() }
  })
  sync()
}
