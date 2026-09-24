// Toasts, error surfacing, and the generic confirm dialog.
import { byId } from './dom'

const confirmDialog = byId<HTMLDialogElement>('confirm-dialog')

let toastTimer: number | undefined

export function showToast(message: string): void {
  const toast = byId('toast')
  toast.textContent = message
  toast.classList.remove('show')
  window.clearTimeout(toastTimer)
  requestAnimationFrame(() => toast.classList.add('show'))
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2_800)
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+':\s*/, '')
  return String(error)
}

export function reportError(action: string, error: unknown): void {
  const message = `${action}: ${errorMessage(error)}`
  console.error(message, error)
  showToast(message)
}

// A real confirmation step for anything that rewrites the user's repository.
export function confirmAction(title: string, body: string, acceptLabel: string): Promise<boolean> {
  byId('confirm-title').textContent = title
  byId('confirm-body').textContent = body
  const accept = byId<HTMLButtonElement>('confirm-accept')
  accept.textContent = acceptLabel
  confirmDialog.showModal()
  return new Promise((resolve) => {
    const finish = (value: boolean): void => {
      accept.removeEventListener('click', onAccept)
      confirmDialog.removeEventListener('close', onClose)
      confirmDialog.close()
      resolve(value)
    }
    const onAccept = (): void => finish(true)
    const onClose = (): void => resolve(false)
    accept.addEventListener('click', onAccept)
    confirmDialog.addEventListener('close', onClose, { once: true })
  })
}

byId('confirm-cancel').addEventListener('click', () => confirmDialog.close())
