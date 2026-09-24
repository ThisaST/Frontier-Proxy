// Composer draft state (attachments + @mentions), shared by the task surface's
// follow-up composer and the new-task dialog's prompt field.
import type { ChatContextItem, SelectedImage, WorkspaceEntry } from '../../shared/types'
import { byId } from './ui/dom'
import { icon } from './ui/icons'
import { reportError, showToast } from './ui/feedback'
import { selectedTaskId, snapshot } from './state'
import { currentProject } from './project'

export interface ComposerDraft {
  items: ChatContextItem[]
  previews: Map<string, string>
  mentionEntries: WorkspaceEntry[]
  mentionIndex: number
  mentionRange?: { start: number; end: number }
  requestVersion: number
}

const composerDrafts = new Map<string, ComposerDraft>()
export const attachmentPreviewCache = new Map<string, string>()

export function composerDraft(inputId: string): ComposerDraft {
  let draft = composerDrafts.get(inputId)
  if (!draft) {
    draft = { items: [], previews: new Map(), mentionEntries: [], mentionIndex: 0, requestVersion: 0 }
    composerDrafts.set(inputId, draft)
  }
  return draft
}

export function composerCwd(inputId: string): string | undefined {
  if (inputId === 'prompt') return byId<HTMLInputElement>('cwd').value.trim() || undefined
  // Home's composer has no free-text folder field — it is always the current project.
  if (inputId === 'home-prompt') return currentProject
  return snapshot?.tasks.find((task) => task.id === selectedTaskId)?.cwd
}

export function renderDraftImages(inputId: string): void {
  const draft = composerDraft(inputId)
  const container = byId(`${inputId}-attachments`)
  const images = draft.items.filter((item) => item.kind === 'image')
  container.replaceChildren(...images.map((item) => {
    const chip = document.createElement('div'); chip.className = 'composer-image-chip'; chip.title = item.name
    const image = document.createElement('img'); image.alt = item.name; image.src = draft.previews.get(item.id) ?? ''
    const remove = document.createElement('button'); remove.type = 'button'; remove.append(icon('close', 14)); remove.setAttribute('aria-label', `Remove ${item.name}`)
    remove.addEventListener('click', () => {
      draft.items = draft.items.filter((candidate) => candidate.id !== item.id)
      draft.previews.delete(item.id)
      renderDraftImages(inputId)
    })
    chip.append(image, remove); return chip
  }))
}

export function addImages(inputId: string, selected: SelectedImage[]): void {
  const draft = composerDraft(inputId)
  for (const item of selected) {
    if (draft.items.length >= 12) { showToast('A message can include up to 12 context items'); break }
    if (draft.items.some((candidate) => candidate.id === item.attachment.id)) continue
    draft.items.push(item.attachment)
    draft.previews.set(item.attachment.id, item.previewUrl)
  }
  renderDraftImages(inputId)
}

function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image.'))
    reader.readAsDataURL(file)
  })
}

async function saveDroppedImages(inputId: string, files: File[]): Promise<void> {
  const images = files.filter((file) => file.type.startsWith('image/'))
  if (!images.length) return
  try {
    const selected: SelectedImage[] = []
    for (const file of images.slice(0, 12)) selected.push(await window.frontier.savePastedImage({ dataUrl: await fileDataUrl(file), name: file.name }))
    addImages(inputId, selected)
  } catch (error) { reportError('Could not attach image', error) }
}

export function closeMentions(inputId: string): void {
  const draft = composerDraft(inputId)
  draft.mentionEntries = []; draft.mentionRange = undefined; draft.mentionIndex = 0; draft.requestVersion += 1
  byId(`${inputId}-mentions`).hidden = true
}

export function selectMention(inputId: string, entry: WorkspaceEntry): void {
  const input = byId<HTMLTextAreaElement>(inputId)
  const draft = composerDraft(inputId)
  if (!draft.mentionRange) return
  const suffix = entry.kind === 'folder' ? '/' : ''
  const insertion = `@${entry.path}${suffix} `
  input.value = `${input.value.slice(0, draft.mentionRange.start)}${insertion}${input.value.slice(draft.mentionRange.end)}`
  const caret = draft.mentionRange.start + insertion.length
  input.setSelectionRange(caret, caret)
  if (!draft.items.some((item) => item.kind === entry.kind && item.path === entry.path) && draft.items.length < 12) {
    draft.items.push({ id: crypto.randomUUID(), kind: entry.kind, name: entry.name, path: entry.path })
  }
  closeMentions(inputId)
  input.focus()
}

export function renderMentions(inputId: string): void {
  const draft = composerDraft(inputId)
  const menu = byId(`${inputId}-mentions`)
  const nodes = draft.mentionEntries.map((entry, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = `composer-mention ${index === draft.mentionIndex ? 'selected' : ''}`
    button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === draft.mentionIndex))
    const mentionIcon = document.createElement('span'); mentionIcon.className = 'composer-mention-icon'; mentionIcon.append(icon(entry.kind === 'folder' ? 'folder' : 'file', 14))
    const copy = document.createElement('span'); copy.className = 'composer-mention-copy'
    const name = document.createElement('strong'); name.textContent = entry.name
    const path = document.createElement('small'); path.textContent = entry.path
    copy.append(name, path); button.append(mentionIcon, copy)
    button.addEventListener('mousedown', (event) => { event.preventDefault(); selectMention(inputId, entry) })
    return button
  })
  if (!nodes.length) { const empty = document.createElement('div'); empty.className = 'composer-mention-empty'; empty.textContent = 'No matching files or folders'; menu.replaceChildren(empty) }
  else menu.replaceChildren(...nodes)
  menu.hidden = false
}

export async function refreshMentions(inputId: string): Promise<void> {
  const input = byId<HTMLTextAreaElement>(inputId)
  const caret = input.selectionStart ?? input.value.length
  const before = input.value.slice(0, caret)
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (!match) { closeMentions(inputId); return }
  const cwd = composerCwd(inputId)
  const menu = byId(`${inputId}-mentions`)
  if (!cwd) {
    const empty = document.createElement('div'); empty.className = 'composer-mention-empty'; empty.textContent = 'Choose a working folder first'
    menu.replaceChildren(empty); menu.hidden = false; return
  }
  const draft = composerDraft(inputId)
  const version = ++draft.requestVersion
  draft.mentionRange = { start: caret - match[1].length - 1, end: caret }
  try {
    const entries = await window.frontier.listWorkspaceEntries(cwd, match[1].trim())
    if (draft.requestVersion !== version) return
    draft.mentionEntries = entries; draft.mentionIndex = 0; renderMentions(inputId)
  } catch (error) {
    closeMentions(inputId)
    reportError('Could not list project files', error)
  }
}

export function handleMentionKeydown(inputId: string, event: KeyboardEvent): boolean {
  const draft = composerDraft(inputId)
  const menu = byId(`${inputId}-mentions`)
  if (menu.hidden || !draft.mentionEntries.length) return false
  if (event.key === 'ArrowDown') { event.preventDefault(); draft.mentionIndex = Math.min(draft.mentionEntries.length - 1, draft.mentionIndex + 1); renderMentions(inputId); return true }
  if (event.key === 'ArrowUp') { event.preventDefault(); draft.mentionIndex = Math.max(0, draft.mentionIndex - 1); renderMentions(inputId); return true }
  if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); selectMention(inputId, draft.mentionEntries[draft.mentionIndex]); return true }
  if (event.key === 'Escape') { event.preventDefault(); closeMentions(inputId); return true }
  return false
}

export function messageContext(inputId: string, message: string): ChatContextItem[] {
  return composerDraft(inputId).items.filter((item) => item.kind === 'image' || message.includes(`@${item.path}`))
}

export function clearComposerDraft(inputId: string): void {
  const draft = composerDraft(inputId)
  draft.items = []; draft.previews.clear(); closeMentions(inputId); renderDraftImages(inputId)
}

// Wires the attach button, @mention autocomplete, and image paste/drop for both
// composer surfaces. Must run exactly once, after the module has evaluated.
export function initComposerInputs(): void {
  for (const inputId of ['composer-input', 'prompt', 'home-prompt']) {
    const input = byId<HTMLTextAreaElement>(inputId)
    const attach = document.querySelector<HTMLButtonElement>(`.composer-attach[data-composer-input="${inputId}"]`)
    attach?.addEventListener('click', async () => {
      attach.disabled = true
      try { addImages(inputId, await window.frontier.chooseImages()) }
      catch (error) { reportError('Could not attach image', error) }
      finally { attach.disabled = false; input.focus() }
    })
    input.addEventListener('input', () => {
      const draft = composerDraft(inputId)
      draft.items = draft.items.filter((item) => item.kind === 'image' || input.value.includes(`@${item.path}`))
      void refreshMentions(inputId)
    })
    input.addEventListener('click', () => { void refreshMentions(inputId) })
    input.addEventListener('keydown', (event) => { if (handleMentionKeydown(inputId, event)) event.stopImmediatePropagation() })
    input.addEventListener('blur', () => window.setTimeout(() => closeMentions(inputId), 120))
    input.addEventListener('paste', (event) => {
      const files = [...(event.clipboardData?.files ?? [])]
      if (!files.some((file) => file.type.startsWith('image/'))) return
      event.preventDefault(); void saveDroppedImages(inputId, files)
    })
    const draft = input.closest<HTMLElement>('.composer-draft')
    draft?.addEventListener('dragover', (event) => { if ([...(event.dataTransfer?.items ?? [])].some((item) => item.type.startsWith('image/'))) { event.preventDefault(); draft.classList.add('dragging') } })
    draft?.addEventListener('dragleave', () => draft.classList.remove('dragging'))
    draft?.addEventListener('drop', (event) => {
      draft.classList.remove('dragging')
      const files = [...(event.dataTransfer?.files ?? [])]
      if (!files.some((file) => file.type.startsWith('image/'))) return
      event.preventDefault(); void saveDroppedImages(inputId, files)
    })
  }
}
