import { contextBridge, ipcRenderer } from 'electron'
import type { AppSettings, AppSnapshot, ChatContextItem, ControlPlaneProfile, CreateTaskInput, FrontierApi, ProviderPatch, ProxyTask, SelectedImage, StreamEvent, TaskFileContent, TaskWorkspaceSnapshot, WorkspaceEntry } from '../shared/types'

const api: FrontierApi = {
  getSnapshot: () => ipcRenderer.invoke('frontier:snapshot') as Promise<AppSnapshot>,
  createTask: (input: CreateTaskInput) => ipcRenderer.invoke('frontier:create-task', input) as Promise<ProxyTask>,
  cancelTask: (taskId: string) => ipcRenderer.invoke('frontier:cancel-task', taskId) as Promise<void>,
  retryTask: (taskId: string) => ipcRenderer.invoke('frontier:retry-task', taskId) as Promise<ProxyTask>,
  changeTaskProvider: (taskId: string, providerId: string) => ipcRenderer.invoke('frontier:change-task-provider', taskId, providerId) as Promise<ProxyTask>,
  continueTask: (taskId: string, message: string, attachments?: ChatContextItem[]) => ipcRenderer.invoke('frontier:continue-task', taskId, message, attachments) as Promise<ProxyTask>,
  readTaskFile: (taskId: string, path: string) => ipcRenderer.invoke('frontier:read-task-file', taskId, path) as Promise<TaskFileContent>,
  getTaskWorkspace: (taskId: string) => ipcRenderer.invoke('frontier:task-workspace', taskId) as Promise<TaskWorkspaceSnapshot>,
  listWorkspaceEntries: (cwd: string, query: string) => ipcRenderer.invoke('frontier:list-workspace-entries', cwd, query) as Promise<WorkspaceEntry[]>,
  chooseImages: () => ipcRenderer.invoke('frontier:choose-images') as Promise<SelectedImage[]>,
  savePastedImage: (input: { dataUrl: string; name?: string }) => ipcRenderer.invoke('frontier:save-pasted-image', input) as Promise<SelectedImage>,
  getAttachmentPreview: (taskId: string, attachmentId: string) => ipcRenderer.invoke('frontier:attachment-preview', taskId, attachmentId) as Promise<string>,
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
  authenticateMcpServer: (serverId: string) =>
    ipcRenderer.invoke('frontier:authenticate-mcp', serverId) as Promise<AppSnapshot>,
  disconnectMcpServer: (serverId: string) =>
    ipcRenderer.invoke('frontier:disconnect-mcp', serverId) as Promise<AppSnapshot>,
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
