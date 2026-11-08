// Electron main process: open a splash window first, start the HTTP host in
// parallel, then point the window at it once the host is listening.
//
// The window loads `http://127.0.0.1:<port>` exactly like the old desktop
// shell, so the reused web UI keeps using relative `/api` paths and SSE.

import path from 'node:path'
import fs from 'node:fs'

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { WebContents } from 'electron'

import { startHost } from './host/server.ts'

// Windows 按 AppUserModelID 归属窗口和任务栏图标。这个 ID 必须与安装器写进
// 开始菜单快捷方式的那个一致,而且要在任何窗口创建之前设好,否则任务栏和
// 任务管理器会继续按 Electron 的默认身份显示应用。
app.setAppUserModelId('dev.denia.app')

const WINDOW_TITLE = 'Denia'
const WINDOW_SIZE = { width: 1280, height: 860 }
const MIN_SIZE = { width: 720, height: 480 }
/** The Electron build listens on its own port; the Rust instance owns 43654. */
const DEFAULT_PORT = 43655
const PRELOAD = path.join(import.meta.dirname, 'preload.cjs')
/** 自然时长:书写动画约 1.1s + 墨点落款约 0.7s;host 更快时也要等它播完再导航。 */
const SPLASH_ANIMATION_MS = 1800

let mainWindow: BrowserWindow | null = null
let closing = false

function appIcon(): string {
  // 打包后由 extraResources 放到 resources/icon.ico;开发模式直接用构建资源。
  if (app.isPackaged) return path.join(process.resourcesPath, 'icon.ico')
  return path.resolve(import.meta.dirname, '..', 'build', 'icon.ico')
}

function webDist(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'web')
  // dist/main.js → electron/dist → repo root → web/dist
  return process.env.DENIA_WEB_DIR ?? path.resolve(import.meta.dirname, '..', '..', 'web', 'dist')
}

/**
 * Splash page shown while the host starts up. The window opens on this local
 * file immediately, plays the ink animation, then navigates to the real UI;
 * a failed startup is injected into the same page instead of a blank window.
 */
function splashPath(): string {
  return 'file://' + path.join(import.meta.dirname, 'splash.html').replaceAll('\\', '/')
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

/** 把启动失败写进已经开着的窗口:用户看得见原因,而不是静默消失的进程。 */
async function showFatal(window: BrowserWindow | null, message: string): Promise<void> {
  if (!window || window.isDestroyed()) return
  const script =
    "document.body.dataset.fatal = '1';" +
    `document.getElementById('fatal-message').textContent = ${JSON.stringify(message)};`
  try {
    await window.webContents.executeJavaScript(script)
  } catch {
    // 窗口可能正在关闭,没有别的可展示的地方了。
  }
}

async function createWindow(url: string, onLoaded?: () => void): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: WINDOW_SIZE.width,
    height: WINDOW_SIZE.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: WINDOW_TITLE,
    icon: appIcon(),
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
  onLoaded?.()
  return window
}

async function main(): Promise<void> {
  registerWindowControls()

  // 窗口先行、host 并行:启动的几百毫秒里用户看到的是墨迹动画而不是"双击了
  // 没反应",host 起不来时也有窗口可以承载错误信息。
  let splashLoadedAt = 0
  const windowPromise = createWindow(splashPath(), () => {
    splashLoadedAt = Date.now()
  })
  const hostPromise = startHost({
    ...(process.env.DENIA_HOME ? { home: process.env.DENIA_HOME } : {}),
    webDir: webDist(),
    version: app.getVersion(),
    ...(process.env.DENIA_HOST ? { host: process.env.DENIA_HOST } : {}),
    port: Number(process.env.DENIA_PORT ?? DEFAULT_PORT),
  })

  mainWindow = await windowPromise
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  let host: Awaited<ReturnType<typeof startHost>>
  try {
    host = await hostPromise
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    console.error('[denia] startup failed:', message)
    await showFatal(mainWindow, message)
    if (process.env.DENIA_SMOKE_SHOT?.trim()) app.exit(1)
    // 没有 host 就没有要收尾的资源;窗口留着承载错误,用户关闭即退出。
    return
  }
  console.log(`[denia] host listening at ${host.baseUrl} (home: ${host.home})`)

  mainWindow.on('close', (event) => {
    if (closing) return
    event.preventDefault()
    closing = true
    void host.close().finally(() => {
      mainWindow?.destroy()
      app.quit()
    })
  })

  // 服务就绪 ≠ 启动页已画出来。按占位页加载完成的时刻起算,把动画的自然时长
  // 放完再导航;host 比动画慢时这里已经播完,无需等待。
  const elapsed = Date.now() - splashLoadedAt
  if (splashLoadedAt > 0 && elapsed < SPLASH_ANIMATION_MS) {
    await new Promise((resolve) => setTimeout(resolve, SPLASH_ANIMATION_MS - elapsed))
  }

  // Dev mode: the Vite server proxies /api to DENIA_API_URL (see web/vite.config.ts).
  const uiUrl = process.env.DENIA_WEB_URL?.trim() || host.baseUrl
  try {
    await mainWindow.loadURL(uiUrl)
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    console.error('[denia] failed to load console:', message)
    await showFatal(mainWindow, `无法加载控制台:${message}`)
    if (process.env.DENIA_SMOKE_SHOT?.trim()) app.exit(1)
    return
  }

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
