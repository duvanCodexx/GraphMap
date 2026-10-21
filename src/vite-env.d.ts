/// <reference types="vite/client" />

type BackendEnvSummary = {
  projectPath: string | null
}

interface Window {
  embeding: {
    selectFolder: () => Promise<string | null>
    getBackendUrl: () => Promise<{ url: string }>
    getBackendConfig: () => Promise<BackendEnvSummary>
    setProjectPath: (projectPath: string) => Promise<{ ok: true; config: BackendEnvSummary }>
    getSettings: () => Promise<{
      values: Record<string, string>
      hasSecrets: { GROQ_API_KEY: boolean; VOYAGE_API_KEY: boolean; GEMMA_API_KEY: boolean }
    }>
    saveSettings: (args: { values?: Record<string, unknown>; secrets?: Record<string, unknown> }) => Promise<{
      values: Record<string, string>
      hasSecrets: { GROQ_API_KEY: boolean; VOYAGE_API_KEY: boolean; GEMMA_API_KEY: boolean }
    }>
    getMcpInfo: () => Promise<{ mcpServerPath: string; backendUrl: string }>
    setQuarterScreen: (corner?: 'bottom-right' | 'top-right' | 'bottom-left' | 'top-left') => Promise<{ ok: boolean; isQuarter: boolean }>
    isQuarterScreen: () => Promise<{ isQuarter: boolean }>
    onQuarterChanged: (callback: (data: { isQuarter: boolean }) => void) => () => void
    toggleAlwaysOnTop: () => Promise<{ ok: boolean; alwaysOnTop: boolean }>
    toggleMaximize: () => Promise<{ ok: boolean; isMaximized: boolean }>
    hideToTray: () => Promise<{ ok: boolean }>
    showWindow: () => Promise<{ ok: boolean }>
    getSystemSettings: () => Promise<{
      runInBackground: boolean
      openAtLogin: boolean
      backendUrl: string
    }>
    setRunInBackground: (enabled: boolean) => Promise<{ runInBackground: boolean }>
    setOpenAtLogin: (enabled: boolean) => Promise<{ openAtLogin: boolean }>
    quitApp: () => Promise<{ ok: boolean }>
  }
}
