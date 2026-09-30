// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSaveBar, createDirtyGuard } from '../src/renderer/src/ui/dirty'

const input = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement
const type = (id: string, value: string): void => { input(id).value = value; input(id).dispatchEvent(new Event('input', { bubbles: true })) }

beforeEach(() => {
  document.body.innerHTML = `
    <input id="max-parallel" type="number" value="3" />
    <textarea id="memory"></textarea>
    <input id="notify" type="checkbox" />
    <button id="elsewhere">x</button>
    <div class="save-bar" id="bar"><span data-save-hint hidden>Unsaved changes</span><button data-save-discard hidden>Discard</button><button data-save>Save</button></div>`
})

describe('createDirtyGuard', () => {
  it('reflects snapshot values into clean fields, checkboxes included', () => {
    const guard = createDirtyGuard(['max-parallel', 'memory', 'notify'])
    guard.reflect('max-parallel', 5); guard.reflect('memory', 'Use pnpm'); guard.reflect('notify', true)
    expect(input('max-parallel').value).toBe('5')
    expect((document.getElementById('memory') as HTMLTextAreaElement).value).toBe('Use pnpm')
    expect(input('notify').checked).toBe(true)
    expect(guard.isDirty()).toBe(false)
  })

  it('a snapshot render skips a field the user has edited', () => {
    const guard = createDirtyGuard(['max-parallel', 'memory'])
    type('max-parallel', '7')
    input('max-parallel').blur()
    expect(guard.isDirty('max-parallel')).toBe(true)
    expect(guard.isDirty('memory')).toBe(false)
    guard.reflect('max-parallel', 3) // a streamed snapshot still carrying the saved value
    guard.reflect('memory', 'from snapshot')
    expect(input('max-parallel').value).toBe('7')
    expect((document.getElementById('memory') as HTMLTextAreaElement).value).toBe('from snapshot')
  })

  it('a checkbox change marks it dirty too', () => {
    const guard = createDirtyGuard(['notify'])
    input('notify').checked = true; input('notify').dispatchEvent(new Event('change'))
    guard.reflect('notify', false)
    expect(input('notify').checked).toBe(true)
  })

  it('save and discard clear the flag, so the next snapshot is reflected again', () => {
    const guard = createDirtyGuard(['max-parallel', 'memory'])
    type('max-parallel', '7'); type('memory', 'draft')
    guard.clear('max-parallel') // e.g. an instant-apply control whose save resolved
    expect(guard.isDirty('max-parallel')).toBe(false)
    expect(guard.isDirty()).toBe(true)
    guard.clear()
    expect(guard.isDirty()).toBe(false)
    input('max-parallel').blur()
    guard.reflect('max-parallel', 4); guard.reflect('memory', 'saved')
    expect(input('max-parallel').value).toBe('4')
    expect((document.getElementById('memory') as HTMLTextAreaElement).value).toBe('saved')
  })

  it('never overwrites the focused field, even when it is clean', () => {
    const guard = createDirtyGuard(['max-parallel'])
    input('max-parallel').focus()
    expect(document.activeElement).toBe(input('max-parallel'))
    guard.reflect('max-parallel', 8)
    expect(input('max-parallel').value).toBe('3')
    ;(document.getElementById('elsewhere') as HTMLButtonElement).focus()
    guard.reflect('max-parallel', 8)
    expect(input('max-parallel').value).toBe('8')
  })

  it('notifies listeners only when it flips between clean and dirty', () => {
    const guard = createDirtyGuard(['max-parallel', 'memory'])
    const listener = vi.fn()
    guard.onChange(listener)
    type('max-parallel', '6'); type('max-parallel', '7'); type('memory', 'x')
    expect(listener.mock.calls).toEqual([[true]])
    guard.clear('memory'); guard.clear()
    expect(listener.mock.calls).toEqual([[true], [false]])
  })
})

describe('bindSaveBar', () => {
  it('shows "Unsaved changes" and Discard only while dirty, and clears on save and on discard', async () => {
    const guard = createDirtyGuard(['max-parallel'])
    const save = vi.fn(async () => { guard.clear() })
    const discard = vi.fn()
    bindSaveBar(document.getElementById('bar')!, guard, { save, discard })
    const hint = document.querySelector<HTMLElement>('[data-save-hint]')!
    const discardButton = document.querySelector<HTMLButtonElement>('[data-save-discard]')!
    const saveButton = document.querySelector<HTMLButtonElement>('[data-save]')!
    expect(hint.hidden).toBe(true); expect(discardButton.hidden).toBe(true); expect(saveButton.disabled).toBe(true)

    type('max-parallel', '6')
    expect(hint.hidden).toBe(false); expect(discardButton.hidden).toBe(false); expect(saveButton.disabled).toBe(false)
    expect(document.getElementById('bar')!.classList.contains('is-dirty')).toBe(true)

    saveButton.click()
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(saveButton.disabled).toBe(true))
    expect(guard.isDirty()).toBe(false); expect(hint.hidden).toBe(true)

    type('max-parallel', '2')
    discardButton.click()
    expect(discard).toHaveBeenCalledOnce()
    expect(guard.isDirty()).toBe(false)
    expect(hint.hidden).toBe(true)
  })

  it('a failed save leaves the edit dirty', async () => {
    const guard = createDirtyGuard(['max-parallel'])
    bindSaveBar(document.getElementById('bar')!, guard, { save: async () => { /* rejected upstream: reportError, no clear */ }, discard: () => undefined })
    type('max-parallel', '6')
    document.querySelector<HTMLButtonElement>('[data-save]')!.click()
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-save]')!.disabled).toBe(false))
    expect(guard.isDirty()).toBe(true)
  })
})
