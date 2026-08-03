import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { OrchestrationEngine } from './engine'
import { JsonStore } from './store'
import { McpAuthManager } from './mcp-auth'
import { hydrateExecutablePath } from './env'
import type { ChatContextItem, CreateTaskInput, ProviderPatch, SelectedImage } from '../shared/types'

let engine: OrchestrationEngine
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

async function selectedImage(path: string, name = basename(path), id: string = randomUUID()): Promise<SelectedImage> {
  const mimeType = IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()]
  if (!mimeType) throw new Error('Only PNG, JPEG, GIF, and WebP images can be attached.')
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error('Images must be smaller than 20 MB.')
  const data = await readFile(path)
  return {
    attachment: { id, kind: 'image', name, path, mimeType },
    previewUrl: `data:${mimeType};base64,${data.toString('base64')}`
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, payload)
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0c0e0d',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

function registerIpc(): void {
  ipcMain.handle('frontier:snapshot', () => engine.snapshot())
  ipcMain.handle('frontier:create-task', (_event, input: CreateTaskInput) => engine.createTask(input))
  ipcMain.handle('frontier:cancel-task', (_event, taskId: string) => engine.cancelTask(taskId))
  ipcMain.handle('frontier:retry-task', (_event, taskId: string) => engine.retryTask(taskId))
  ipcMain.handle('frontier:change-task-provider', (_event, taskId: string, providerId: string) => engine.changeTaskProvider(taskId, providerId))
  ipcMain.handle('frontier:continue-task', (_event, taskId: string, message: string, attachments?: ChatContextItem[]) => engine.continueTask(taskId, message, attachments))
  ipcMain.handle('frontier:read-task-file', (_event, taskId: string, path: string) => engine.readTaskFile(taskId, path))
  ipcMain.handle('frontier:task-workspace', (_event, taskId: string) => engine.getTaskWorkspace(taskId))
  ipcMain.handle('frontier:list-workspace-entries', (_event, cwd: string, query: string) => engine.listWorkspaceEntries(cwd, query))
  ipcMain.handle('frontier:choose-images', async () => {
    const window = BrowserWindow.getFocusedWindow()
    const options = {
      title: 'Attach images', buttonLabel: 'Attach', properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    return await Promise.all(result.filePaths.slice(0, 12).map((path) => selectedImage(path)))
  })
  ipcMain.handle('frontier:save-pasted-image', async (_event, input: { dataUrl: string; name?: string }) => {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=]+)$/i.exec(input.dataUrl)
    if (!match) throw new Error('The pasted item is not a supported image.')
    const data = Buffer.from(match[2], 'base64')
    if (!data.length || data.length > MAX_IMAGE_BYTES) throw new Error('Images must be smaller than 20 MB.')
    const id = randomUUID()
    const extension = match[1].toLowerCase() === 'image/jpeg' ? '.jpg' : `.${match[1].split('/')[1].toLowerCase()}`
    const directory = join(app.getPath('userData'), 'frontier-attachments')
    await mkdir(directory, { recursive: true })
    const path = join(directory, `${id}${extension}`)
    await writeFile(path, data)
    return await selectedImage(path, input.name?.trim() || `Pasted image${extension}`, id)
  })
  ipcMain.handle('frontier:attachment-preview', async (_event, taskId: string, attachmentId: string) => selectedImage(engine.attachmentPath(taskId, attachmentId), undefined, attachmentId).then((value) => value.previewUrl))
  ipcMain.handle('frontier:branch-inbox', () => engine.listBranchInbox())
  ipcMain.handle('frontier:branch-file', (_event, cwd: string, branch: string, path: string) => engine.readBranchFile(cwd, branch, path))
  ipcMain.handle('frontier:merge-branch', (_event, cwd: string, branch: string) => engine.mergeBranch(cwd, branch))
  ipcMain.handle('frontier:delete-branch', (_event, cwd: string, branch: string) => engine.deleteBranch(cwd, branch))
  ipcMain.handle('frontier:clear-finished', () => engine.clearFinishedTasks())
  ipcMain.handle('frontier:check-providers', () => engine.checkProviders())
  ipcMain.handle('frontier:update-provider', (_event, patch: ProviderPatch) => engine.updateProvider(patch))
  ipcMain.handle('frontier:add-custom-provider', () => engine.addCustomProvider())
  ipcMain.handle('frontier:remove-provider', (_event, providerId: string) => engine.removeProvider(providerId))
  ipcMain.handle('frontier:update-settings', (_event, changes) => engine.updateSettings(changes))
  ipcMain.handle('frontier:update-control-plane', (_event, profile) => engine.updateControlPlane(profile))
  ipcMain.handle('frontier:preview-control-plane', (_event, providerId: string, profile, options?: { cwd?: string; skillIds?: string[] }) => engine.previewControlPlane(providerId, profile, options))
  ipcMain.handle('frontier:list-skills', (_event, cwd: string, refresh?: boolean) => engine.listSkills(cwd, refresh))
  ipcMain.handle('frontier:authenticate-mcp', (_event, serverId: string) => engine.authenticateMcpServer(serverId))
  ipcMain.handle('frontier:disconnect-mcp', (_event, serverId: string) => engine.disconnectMcpServer(serverId))
  ipcMain.handle('frontier:choose-directory', (_event, currentPath?: string) => {
    const window = BrowserWindow.getFocusedWindow()
    const options = {
      title: 'Choose an agent working directory',
      buttonLabel: 'Use this folder',
      defaultPath: currentPath?.trim() || undefined,
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    }
    // Keep the native panel app-modal and visible above the renderer's HTML dialog.
    const paths = window ? dialog.showOpenDialogSync(window, options) : dialog.showOpenDialogSync(options)
    return paths?.[0] ?? null
  })
}

// Only one Frontier instance may run: a second process would share the same
// frontier-state.json and clobber it (last-writer-wins), silently dropping tasks
// and usage. Refuse the second launch and focus the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const existing = BrowserWindow.getAllWindows()[0]
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
  })
  startApp()
}

function startApp(): void {
app.whenReady().then(async () => {
  await hydrateExecutablePath()
  const userData = app.getPath('userData')
  const store = new JsonStore(join(userData, 'frontier-state.json'))
  const mcpAuth = new McpAuthManager(join(userData, 'frontier-mcp-auth.json'), {
    cipher: {
      encrypt: (value) => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this system.')
        return safeStorage.encryptString(value).toString('base64')
      },
      decrypt: (value) => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this system.')
        return safeStorage.decryptString(Buffer.from(value, 'base64'))
      }
    },
    openExternal: async (url) => { await shell.openExternal(url) }
  })
  engine = new OrchestrationEngine(store, mcpAuth)
  await engine.initialize()
  engine.on('snapshot', (snapshot) => broadcast('frontier:snapshot-changed', snapshot))
  engine.on('stream', (event) => broadcast('frontier:stream', event))
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
}
