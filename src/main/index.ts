import { app, BrowserWindow, shell, ipcMain, safeStorage, dialog } from 'electron'
import { join } from 'path'
import { registerSshHandlers } from './ssh-manager'
import { registerCredentialHandlers } from './credential-store'
import { is } from '@electron-toolkit/utils'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    frame: false,
    backgroundColor: '#1a1a2e',
    icon: join(__dirname, '../../assets/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false
    }
  })

  // Only open http/https links externally — block any other protocol (e.g. file://, javascript:)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        shell.openExternal(url)
      }
    } catch { /* invalid URL — ignore */ }
    return { action: 'deny' }
  })

  // Prevent the renderer from navigating away from the local page
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const appUrl = is.dev
      ? process.env['ELECTRON_RENDERER_URL'] ?? ''
      : `file://${join(__dirname, '../renderer/index.html')}`
    if (!url.startsWith(appUrl)) {
      event.preventDefault()
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Custom title bar controls
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize()
  else mainWindow?.maximize()
})
ipcMain.on('window:close', () => mainWindow?.close())

// File chooser for private key import
ipcMain.handle('dialog:openKey', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Select Private Key File',
    filters: [
      { name: 'Private Keys', extensions: ['pem', 'ppk', 'key', ''] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  })
  return result.canceled ? null : result.filePaths[0]
})

// Download destination chooser
ipcMain.handle('dialog:saveFile', async (_e, defaultName: string) => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: defaultName,
    properties: ['createDirectory']
  })
  return result.canceled ? null : result.filePath
})

// Upload file chooser
ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile', 'multiSelections']
  })
  return result.canceled ? [] : result.filePaths
})

app.whenReady().then(() => {
  // safeStorage uses DPAPI on Windows — must be ready before encrypting
  createWindow()
  registerSshHandlers(mainWindow!)
  registerCredentialHandlers()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
