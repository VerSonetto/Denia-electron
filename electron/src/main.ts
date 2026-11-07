// Electron main process: start the HTTP host, then point the window at it.
//
// The window loads `http://127.0.0.1:<port>` exactly like the old desktop
// shell, so the reused web UI keeps using relative `/api` paths and SSE.

import path from 'node:path'
import fs from 'node:fs'

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { WebContents } from 'electron'

import { startHost } from './host/server.ts'

const WINDOW_TITLE = 'Denia Electron'
const WINDOW_SIZE = { width: 1280, height: 860 }
const MIN_SIZE = { width: 720, height: 480 }
/** The Electron build listens on its own port; the Rust instance owns 43654. */
const DEFAULT_PORT = 43655
const PRELOAD = path.join(import.meta.dirname, 'preload.cjs')

let mainWindow: BrowserWindow | null = null
let closing = false

function webDist(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'web')
  // dist/main.js → electron/dist → repo root → web/dist
  return process.env.DENIA_WEB_DIR ?? path.resolve(import.meta.dirname, '..', '..', 'web', 'dist')
}

/**
 * Caption IPC for the frameless window. The window is resolved from the sender
 * so the bridge never has to pass or trust a window id.
 */
function registerWindowControls(): void {
  const windowFrom = (sender: WebContents): BrowserWindow | null => BrowserWindow.fromWebContents(sender)

  ipcMain.on('desktop-window:minimize', (event) => {
    windowFrom(event.sender)?.minimize()
  })
  ipcMain.on('desktop-window:toggle-maximize', (event) => {
    const window = windowFrom(event.sender)
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipcMain.on('desktop-window:close', (event) => {
    windowFrom(event.sender)?.close()
  })
  ipcMain.handle('desktop-window:is-maximized', (event) => {
    return windowFrom(event.sender)?.isMaximized() ?? false
  })
}

async function createWindow(url: string): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: WINDOW_SIZE.width,
    height: WINDOW_SIZE.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: WINDOW_TITLE,
    frame: false,
    backgroundColor: '#0b0b0c',
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const sendMaximized = (maximized: boolean) => {
    if (!window.isDestroyed()) window.webContents.send('desktop-window:maximized', maximized)
  }
  window.on('maximize', () => sendMaximized(true))
  window.on('unmaximize', () => sendMaximized(false))
  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })
  await window.loadURL(url)
  return window
}

async function main(): Promise<void> {
  registerWindowControls()
  const host = await startHost({
    ...(process.env.DENIA_HOME ? { home: process.env.DENIA_HOME } : {}),
    webDir: webDist(),
    ...(process.env.DENIA_HOST ? { host: process.env.DENIA_HOST } : {}),
    port: Number(process.env.DENIA_PORT ?? DEFAULT_PORT),
  })
  console.log(`[denia] host listening at ${host.baseUrl} (home: ${host.home})`)

  // Dev mode: the Vite server proxies /api to DENIA_API_URL (see web/vite.config.ts).
  const uiUrl = process.env.DENIA_WEB_URL?.trim()
  mainWindow = await createWindow(uiUrl || host.baseUrl)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.on('close', (event) => {
    if (closing) return
    event.preventDefault()
    closing = true
    void host.close().finally(() => {
      mainWindow?.destroy()
      app.quit()
    })
  })

  // Smoke mode: prove the real Electron renderer can load the UI, then exit.
  const shotPath = process.env.DENIA_SMOKE_SHOT?.trim()
  if (shotPath) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const image = await mainWindow.webContents.capturePage()
    fs.writeFileSync(shotPath, image.toPNG())
    console.log(`[denia] smoke screenshot written to ${shotPath}`)
    closing = true
    await host.close()
    app.quit()
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId('dev.denia.electron')
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    console.error('[denia] startup failed:', message)
    dialog.showErrorBox('Denia 启动失败', message)
    app.quit()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})