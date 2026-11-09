// 浏览器可执行文件探测与启动参数。
//
// 只驱动用户机器上已安装的 Chrome / Edge / Chromium:不随包分发浏览器,
// 也不下载任何二进制。profile 落在 `$DENIA_HOME/browser/profile`。

import fs from 'node:fs'
import path from 'node:path'

export interface BrowserLaunchSpec {
  executable: string
  profileDir: string
  artifactsDir: string
  headless: boolean
  viewport: { width: number; height: number }
}

const WINDOWS_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Chromium\\Application\\chrome.exe',
]

const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]

const LINUX_CANDIDATES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'microsoft-edge-stable',
]

function exists(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function fromPath(name: string): string | undefined {
  const raw = process.env.PATH ?? ''
  const names = process.platform === 'win32' ? [name, `${name}.exe`] : [name]
  for (const part of raw.split(path.delimiter)) {
    if (part.trim() === '') continue
    for (const candidate of names) {
      const full = path.join(part, candidate)
      if (exists(full)) return full
    }
  }
  return undefined
}

/** Chrome → Edge → Chromium 顺序探测;`DENIA_BROWSER_EXECUTABLE` 显式覆盖。 */
export function detectBrowserExecutable(): string {
  const override = process.env.DENIA_BROWSER_EXECUTABLE?.trim()
  if (override) {
    if (!exists(override)) {
      throw new Error(`DENIA_BROWSER_EXECUTABLE 指向的文件不存在:${override}`)
    }
    return override
  }
  const candidates =
    process.platform === 'win32'
      ? WINDOWS_CANDIDATES
      : process.platform === 'darwin'
        ? MAC_CANDIDATES
        : LINUX_CANDIDATES
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (exists(candidate)) return candidate
    } else {
      const found = fromPath(candidate)
      if (found) return found
    }
  }
  throw new Error(
    '未找到 Chrome / Edge / Chromium。请安装其中任意一个,或用 DENIA_BROWSER_EXECUTABLE 指向浏览器可执行文件',
  )
}

export function launchSpec(home: string): BrowserLaunchSpec {
  const browserHome = path.join(home, 'browser')
  return {
    executable: detectBrowserExecutable(),
    profileDir: path.join(browserHome, 'profile'),
    artifactsDir: path.join(browserHome, 'artifacts'),
    // 默认无窗口:控制台侧栏已经实时显示画面。DENIA_BROWSER_HEADFUL=1 时
    // 显示真实窗口(强反爬站点更接近真人环境)。
    headless: process.env.DENIA_BROWSER_HEADFUL?.trim() !== '1',
    viewport: { width: 1440, height: 900 },
  }
}