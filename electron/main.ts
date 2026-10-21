import { app, BrowserWindow, dialog, ipcMain, screen, Menu, Tray, nativeImage, Notification, session } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import dns from 'node:dns'

try {
  dns.setDefaultResultOrder('ipv4first')
} catch {}

import { getBackendConfig, setBackendProjectPath, startBackendServer, type BackendServer } from './backend/server'
import { getSettingsUi, updateSettingsUi } from './backend/settings'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

// Estado global de la aplicación y la ventana
let win: BrowserWindow | null = null
let tray: Tray | null = null
let prevBounds: Electron.Rectangle | null = null
let backend: BackendServer | null = null
let isQuitting = false
let runInBackground = true
let hasShownTrayNotice = false

// Bloqueo de instancia única (Single Instance Lock)
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    } else {
      createWindow()
    }
  })
}

function getAppIconPath(): string {
  const distPng = path.join(process.env.APP_ROOT, 'dist', 'icon.png')
  if (fs.existsSync(distPng)) return distPng
  const ico = path.join(process.env.APP_ROOT, 'build', 'icon.ico')
  if (fs.existsSync(ico)) return ico
  const png = path.join(process.env.APP_ROOT, 'public', 'icon.png')
  if (fs.existsSync(png)) return png
  return path.join(process.env.VITE_PUBLIC, 'icon.png')
}

function getTrayIconPath(): string {
  const distTray16 = path.join(process.env.APP_ROOT, 'dist', 'tray-icon-16.png')
  if (fs.existsSync(distTray16)) return distTray16
  const distTray32 = path.join(process.env.APP_ROOT, 'dist', 'tray-icon.png')
  if (fs.existsSync(distTray32)) return distTray32
  const tray16 = path.join(process.env.APP_ROOT, 'public', 'tray-icon-16.png')
  if (fs.existsSync(tray16)) return tray16
  const tray32 = path.join(process.env.APP_ROOT, 'public', 'tray-icon.png')
  if (fs.existsSync(tray32)) return tray32
  return getAppIconPath()
}

function updateTrayMenu() {
  if (!tray) return
  const isLoginOpen = app.getLoginItemSettings().openAtLogin
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Abrir GraphMap',
      click: () => {
        if (!win) {
          createWindow()
        } else {
          win.show()
          win.focus()
        }
      },
    },
    {
      label: 'Ocultar a la bandeja',
      click: () => {
        win?.hide()
      },
    },
    {
      label: 'Limpiar caché y recargar',
      click: async () => {
        try {
          await session.defaultSession.clearCache()
          await session.defaultSession.clearStorageData({
            storages: ['cachestorage', 'shadercache'],
          })
          if (win) {
            win.webContents.reloadIgnoringCache()
          }
        } catch (e) {
          console.error('[Electron] Error al limpiar caché:', e)
        }
      },
    },
    { type: 'separator' },
    {
      label: `Servidor Local: ${backend?.url || 'http://127.0.0.1:8001'} (Activo)`,
      enabled: false,
    },
    {
      label: `Protocolo MCP: Activo (${backend?.url || 'http://127.0.0.1:8001'})`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Ejecutar en segundo plano al cerrar',
      type: 'checkbox',
      checked: runInBackground,
      click: (item) => {
        runInBackground = item.checked
        updateTrayMenu()
      },
    },
    {
      label: 'Iniciar con Windows',
      type: 'checkbox',
      checked: isLoginOpen,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          openAsHidden: true,
        })
        updateTrayMenu()
      },
    },
    { type: 'separator' },
    {
      label: 'Salir completamente',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(contextMenu)
}

function createTray() {
  if (tray) return
  const iconPath = getTrayIconPath()
  const trayImg = nativeImage.createFromPath(iconPath)
  tray = new Tray(trayImg)

  tray.setToolTip(`GraphMap — Motor de Embeddings & MCP (${backend?.url || 'Puerto 8001'})`)
  updateTrayMenu()

  tray.on('double-click', () => {
    if (!win) {
      createWindow()
    } else {
      win.show()
      win.focus()
    }
  })

  tray.on('click', () => {
    if (!win) {
      createWindow()
    } else if (win.isVisible() && !win.isMinimized()) {
      win.focus()
    } else {
      win.show()
      win.focus()
    }
  })
}

function registerIpcHandlers() {
  ipcMain.handle('dialog:selectFolder', async () => {
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('backend:getUrl', async () => {
    if (!backend) throw new Error('Backend no iniciado')
    return { url: backend.url, port: backend.port }
  })

  ipcMain.handle('backend:getConfig', async () => {
    return await getBackendConfig()
  })

  ipcMain.handle('backend:setProjectPath', async (_event, args: { projectPath: string }) => {
    const cfg = await setBackendProjectPath(args.projectPath)
    return { ok: true, config: cfg }
  })

  ipcMain.handle('settings:get', async () => {
    return await getSettingsUi()
  })

  ipcMain.handle('app:getMcpInfo', async () => {
    const root = process.env.APP_ROOT || app.getAppPath()
    const mcpServerPath = path.resolve(root, 'mcp-server.cjs')
    return {
      mcpServerPath,
      backendUrl: backend?.url || 'http://127.0.0.1:8001',
    }
  })

  ipcMain.handle(
    'settings:update',
    async (_event, args: { values?: Record<string, unknown>; secrets?: Record<string, unknown> }) => {
      return await updateSettingsUi({
        values: (args.values || {}) as any,
        secrets: (args.secrets || {}) as any,
      })
    },
  )

  ipcMain.handle('window:toggleAlwaysOnTop', async () => {
    if (!win) return { ok: false, alwaysOnTop: false }
    const current = win.isAlwaysOnTop()
    win.setAlwaysOnTop(!current, 'screen-saver')
    return { ok: true, alwaysOnTop: !current }
  })

  ipcMain.handle('window:toggleMaximize', async () => {
    if (!win) return { ok: false, isMaximized: false }
    if (win.isMaximized()) {
      win.unmaximize()
      return { ok: true, isMaximized: false }
    } else {
      win.maximize()
      return { ok: true, isMaximized: true }
    }
  })

  // Control de Segundo Plano & Sistema
  ipcMain.handle('app:hideToTray', async () => {
    win?.hide()
    return { ok: true }
  })

  ipcMain.handle('app:showWindow', async () => {
    win?.show()
    win?.focus()
    return { ok: true }
  })

  ipcMain.handle('app:getSystemSettings', async () => {
    const isLoginOpen = app.getLoginItemSettings().openAtLogin
    return {
      runInBackground,
      openAtLogin: isLoginOpen,
      backendUrl: backend?.url || 'http://127.0.0.1:8001',
    }
  })

  ipcMain.handle('app:setRunInBackground', async (_event, args: { enabled: boolean }) => {
    runInBackground = Boolean(args?.enabled)
    updateTrayMenu()
    return { runInBackground }
  })

  ipcMain.handle('app:setOpenAtLogin', async (_event, args: { enabled: boolean }) => {
    const enabled = Boolean(args?.enabled)
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true,
    })
    updateTrayMenu()
    return { openAtLogin: enabled }
  })

  ipcMain.handle('app:quit', async () => {
    isQuitting = true
    app.quit()
    return { ok: true }
  })

  ipcMain.handle('app:clearCache', async () => {
    try {
      await session.defaultSession.clearCache()
      await session.defaultSession.clearStorageData({
        storages: ['cachestorage', 'shadercache'],
      })
      if (win) {
        win.webContents.reloadIgnoringCache()
      }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('window:isQuarterScreen', async () => {
    if (!win) return { isQuarter: false }
    const display = screen.getPrimaryDisplay()
    const { workArea } = display
    const quarterWidth = Math.round(workArea.width / 2)
    const quarterHeight = Math.round(workArea.height / 2)
    const currentBounds = win.getBounds()
    const isQuarter =
      Math.abs(currentBounds.width - quarterWidth) < 45 &&
      Math.abs(currentBounds.height - quarterHeight) < 45
    return { isQuarter }
  })

  ipcMain.handle('window:setQuarterScreen', async (_event, args: { corner?: string }) => {
    if (!win) return { ok: false, isQuarter: false }
    const display = screen.getPrimaryDisplay()
    const { workArea } = display

    const quarterWidth = Math.round(workArea.width / 2)
    const quarterHeight = Math.round(workArea.height / 2)

    const currentBounds = win.getBounds()
    const isAlreadyQuarter =
      Math.abs(currentBounds.width - quarterWidth) < 45 &&
      Math.abs(currentBounds.height - quarterHeight) < 45

    if (isAlreadyQuarter && prevBounds) {
      win.setBounds(prevBounds, true)
      prevBounds = null
      win.webContents.send('window:quarterChanged', { isQuarter: false })
      return { ok: true, isQuarter: false }
    }

    prevBounds = currentBounds
    if (win.isMaximized()) {
      win.unmaximize()
    }

    const corner = args?.corner || 'bottom-right'
    let x = workArea.x
    let y = workArea.y

    if (corner === 'bottom-right') {
      x = workArea.x + quarterWidth
      y = workArea.y + quarterHeight
    } else if (corner === 'top-right') {
      x = workArea.x + quarterWidth
      y = workArea.y
    } else if (corner === 'bottom-left') {
      x = workArea.x
      y = workArea.y + quarterHeight
    } else {
      x = workArea.x
      y = workArea.y
    }

    win.setBounds(
      {
        x,
        y,
        width: quarterWidth,
        height: quarterHeight,
      },
      true,
    )

    win.webContents.send('window:quarterChanged', { isQuarter: true })
    return { ok: true, isQuarter: true }
  })
}

function notifyQuarterStatus() {
  if (!win || win.isDestroyed()) return
  const display = screen.getPrimaryDisplay()
  const { workArea } = display
  const quarterWidth = Math.round(workArea.width / 2)
  const quarterHeight = Math.round(workArea.height / 2)
  const currentBounds = win.getBounds()
  const isQuarter =
    Math.abs(currentBounds.width - quarterWidth) < 45 &&
    Math.abs(currentBounds.height - quarterHeight) < 45
  win.webContents.send('window:quarterChanged', { isQuarter })
}

function createWindow() {
  const iconPath = getAppIconPath()

  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 320,
    minHeight: 240,
    autoHideMenuBar: true,
    title: 'GraphMap — Semantic Code Search & MCP',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: true,
    backgroundColor: '#0d1515',
  })

  // Atajo para abrir consola de desarrollador con F12 o Ctrl+Shift+I
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      win?.webContents.toggleDevTools()
    }
  })

  // Capturar logs y errores del Renderer en archivo persistente
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    try {
      const logFile = path.join(app.getPath('userData'), 'app.log')
      fs.appendFileSync(logFile, `[Renderer L${level}] ${message} (${sourceId}:${line})\n`, 'utf8')
    } catch {}
  })

  // Purga definitiva de barra de menú nativa
  win.removeMenu()
  win.setMenuBarVisibility(false)

  win.on('resize', () => {
    notifyQuarterStatus()
  })

  // Ocultar a la bandeja en lugar de cerrar el proceso si runInBackground está activo
  win.on('close', (event) => {
    if (!isQuitting && runInBackground) {
      event.preventDefault()
      win?.hide()
      if (Notification.isSupported() && !hasShownTrayNotice) {
        hasShownTrayNotice = true
        try {
          new Notification({
            title: 'GraphMap sigue activo en segundo plano',
            body: `El servidor local (${backend?.url || 'http://127.0.0.1:8001'}) y el servidor MCP continúan disponibles para tus agentes de IA.`,
            icon: getTrayIconPath(),
          }).show()
        } catch {}
      }
    }
  })

  win.webContents.on('did-finish-load', () => {
    win?.show()
    win?.focus()
    notifyQuarterStatus()
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[Electron] Failed to load: ${errorCode} - ${errorDescription}`)
  })

  const targetBackendUrl = backend?.url || 'http://127.0.0.1:8001'
  if (VITE_DEV_SERVER_URL) {
    win.loadURL(`${VITE_DEV_SERVER_URL}?backendUrl=${encodeURIComponent(targetBackendUrl)}`)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'), {
      search: `backendUrl=${encodeURIComponent(targetBackendUrl)}`,
    })
  }
}

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  if (process.platform === 'darwin' || runInBackground) {
    // Mantener backend activo en segundo plano
  } else {
    void backend?.close().catch(() => {})
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  } else {
    win?.show()
    win?.focus()
  }
})

app.whenReady().then(async () => {
  try {
    await session.defaultSession.clearCache()
  } catch {}
  Menu.setApplicationMenu(null)
  startBackendServer()
    .then((s) => {
      backend = s
      try {
        const infoFile = path.join(app.getPath('userData'), 'server-info.json')
        fs.writeFileSync(infoFile, JSON.stringify({ url: s.url, port: s.port, pid: process.pid }), 'utf8')
      } catch {}
    })
    .catch((err) => {
      console.error('[Electron Main] Error al iniciar backend en puertos auxiliares:', err)
    })
    .finally(() => {
      registerIpcHandlers()
      createWindow()
      createTray()
    })
})
