import { ipcRenderer, contextBridge } from 'electron'

type BackendConfig = {
  projectPath: string | null
}

type SettingsUi = {
  values: Record<string, string>
  hasSecrets: {
    GROQ_API_KEY: boolean
    VOYAGE_API_KEY: boolean
    GEMMA_API_KEY: boolean
  }
}

const api = {
  selectFolder: async () => {
    const result = await ipcRenderer.invoke('dialog:selectFolder')
    return (result as string | null) ?? null
  },
  getBackendUrl: async () => {
    const result = await ipcRenderer.invoke('backend:getUrl')
    return result as { url: string }
  },
  getBackendConfig: async () => {
    const result = await ipcRenderer.invoke('backend:getConfig')
    return result as BackendConfig
  },
  setProjectPath: async (projectPath: string) => {
    const result = await ipcRenderer.invoke('backend:setProjectPath', { projectPath })
    return result as { ok: true; config: BackendConfig }
  },
  getSettings: async () => {
    const result = await ipcRenderer.invoke('settings:get')
    return result as SettingsUi
  },
  saveSettings: async (args: { values?: Record<string, unknown>; secrets?: Record<string, unknown> }) => {
    const result = await ipcRenderer.invoke('settings:update', args)
    return result as SettingsUi
  },
  getMcpInfo: async () => {
    const result = await ipcRenderer.invoke('app:getMcpInfo')
    return result as { mcpServerPath: string; backendUrl: string }
  },
  setQuarterScreen: async (corner?: 'bottom-right' | 'top-right' | 'bottom-left' | 'top-left') => {
    return (await ipcRenderer.invoke('window:setQuarterScreen', { corner })) as { ok: boolean; isQuarter: boolean }
  },
  isQuarterScreen: async () => {
    return (await ipcRenderer.invoke('window:isQuarterScreen')) as { isQuarter: boolean }
  },
  onQuarterChanged: (callback: (data: { isQuarter: boolean }) => void) => {
    const handler = (_event: any, data: { isQuarter: boolean }) => callback(data)
    ipcRenderer.on('window:quarterChanged', handler)
    return () => {
      ipcRenderer.removeListener('window:quarterChanged', handler)
    }
  },
  toggleAlwaysOnTop: async () => {
    return (await ipcRenderer.invoke('window:toggleAlwaysOnTop')) as { ok: boolean; alwaysOnTop: boolean }
  },
  toggleMaximize: async () => {
    return (await ipcRenderer.invoke('window:toggleMaximize')) as { ok: boolean; isMaximized: boolean }
  },
  hideToTray: async () => {
    return (await ipcRenderer.invoke('app:hideToTray')) as { ok: boolean }
  },
  showWindow: async () => {
    return (await ipcRenderer.invoke('app:showWindow')) as { ok: boolean }
  },
  getSystemSettings: async () => {
    return (await ipcRenderer.invoke('app:getSystemSettings')) as {
      runInBackground: boolean
      openAtLogin: boolean
      backendUrl: string
    }
  },
  setRunInBackground: async (enabled: boolean) => {
    return (await ipcRenderer.invoke('app:setRunInBackground', { enabled })) as { runInBackground: boolean }
  },
  setOpenAtLogin: async (enabled: boolean) => {
    return (await ipcRenderer.invoke('app:setOpenAtLogin', { enabled })) as { openAtLogin: boolean }
  },
  quitApp: async () => {
    return (await ipcRenderer.invoke('app:quit')) as { ok: boolean }
  },
  clearCache: async () => {
    return (await ipcRenderer.invoke('app:clearCache')) as { ok: boolean; error?: string }
  },
}

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('embeding', api)
