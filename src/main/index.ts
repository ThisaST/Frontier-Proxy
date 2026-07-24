import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { delimiter } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { OrchestrationEngine } from './engine'
import { JsonStore } from './store'
import type { CreateTaskInput, ProviderPatch } from '../shared/types'

let engine: OrchestrationEngine
const execFileAsync = promisify(execFile)

async function hydrateExecutablePath(): Promise<void> {
  if (process.platform === 'win32') return
  const paths = new Set((process.env.PATH ?? '').split(delimiter).filter(Boolean))
  for (const common of ['/usr/local/bin', '/opt/homebrew/bin', '/Applications/ChatGPT.app/Contents/Resources']) paths.add(common)
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const { stdout } = await execFileAsync(shell, ['-ilc', 'printf %s "$PATH"'], { timeout: 5_000, encoding: 'utf8' })
    for (const entry of stdout.split(delimiter).filter(Boolean)) paths.add(entry)
  } catch {
    // Common locations above still make packaged GUI launches useful when shell startup fails.
  }
  process.env.PATH = [...paths].join(delimiter)
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
  ipcMain.handle('frontier:continue-task', (_event, taskId: string, message: string) => engine.continueTask(taskId, message))
  ipcMain.handle('frontier:clear-finished', () => engine.clearFinishedTasks())
  ipcMain.handle('frontier:check-providers', () => engine.checkProviders())
  ipcMain.handle('frontier:update-provider', (_event, patch: ProviderPatch) => engine.updateProvider(patch))
  ipcMain.handle('frontier:add-custom-provider', () => engine.addCustomProvider())
  ipcMain.handle('frontier:remove-provider', (_event, providerId: string) => engine.removeProvider(providerId))
  ipcMain.handle('frontier:update-settings', (_event, changes) => engine.updateSettings(changes))
  ipcMain.handle('frontier:update-control-plane', (_event, profile) => engine.updateControlPlane(profile))
  ipcMain.handle('frontier:preview-control-plane', (_event, providerId: string, profile) => engine.previewControlPlane(providerId, profile))
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

app.whenReady().then(async () => {
  await hydrateExecutablePath()
  const store = new JsonStore(join(app.getPath('userData'), 'frontier-state.json'))
  engine = new OrchestrationEngine(store)
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
