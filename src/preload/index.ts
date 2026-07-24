import { contextBridge, ipcRenderer } from 'electron'
import type { AppSettings, AppSnapshot, ControlPlaneProfile, CreateTaskInput, FrontierApi, ProviderPatch, ProxyTask, StreamEvent } from '../shared/types'

const api: FrontierApi = {
  getSnapshot: () => ipcRenderer.invoke('frontier:snapshot') as Promise<AppSnapshot>,
  createTask: (input: CreateTaskInput) => ipcRenderer.invoke('frontier:create-task', input) as Promise<ProxyTask>,
  cancelTask: (taskId: string) => ipcRenderer.invoke('frontier:cancel-task', taskId) as Promise<void>,
  retryTask: (taskId: string) => ipcRenderer.invoke('frontier:retry-task', taskId) as Promise<ProxyTask>,
  continueTask: (taskId: string, message: string) => ipcRenderer.invoke('frontier:continue-task', taskId, message) as Promise<ProxyTask>,
  clearFinishedTasks: () => ipcRenderer.invoke('frontier:clear-finished') as Promise<void>,
  checkProviders: () => ipcRenderer.invoke('frontier:check-providers') as Promise<AppSnapshot>,
  updateProvider: (patch: ProviderPatch) => ipcRenderer.invoke('frontier:update-provider', patch) as Promise<AppSnapshot>,
  addCustomProvider: () => ipcRenderer.invoke('frontier:add-custom-provider') as Promise<AppSnapshot>,
  removeProvider: (providerId: string) => ipcRenderer.invoke('frontier:remove-provider', providerId) as Promise<AppSnapshot>,
  updateSettings: (changes: Partial<Pick<AppSettings, 'maxParallelTasks' | 'quotaCooldownMinutes'>>) =>
    ipcRenderer.invoke('frontier:update-settings', changes) as Promise<AppSnapshot>,
  updateControlPlane: (profile: ControlPlaneProfile) =>
    ipcRenderer.invoke('frontier:update-control-plane', profile) as Promise<AppSnapshot>,
  previewControlPlane: (providerId: string, profile?: ControlPlaneProfile) =>
    ipcRenderer.invoke('frontier:preview-control-plane', providerId, profile) as Promise<string[]>,
  chooseDirectory: (currentPath?: string) => ipcRenderer.invoke('frontier:choose-directory', currentPath) as Promise<string | null>,
  onSnapshot: (callback: (snapshot: AppSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot): void => callback(snapshot)
    ipcRenderer.on('frontier:snapshot-changed', listener)
    return () => ipcRenderer.removeListener('frontier:snapshot-changed', listener)
  },
  onStream: (callback: (event: StreamEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, streamEvent: StreamEvent): void => callback(streamEvent)
    ipcRenderer.on('frontier:stream', listener)
    return () => ipcRenderer.removeListener('frontier:stream', listener)
  }
}

contextBridge.exposeInMainWorld('frontier', api)
