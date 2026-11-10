// 浏览器可执行文件探测与启动参数。
//
// 只驱动用户机器上已安装的 Chrome / Edge / Chromium:不随包分发浏览器,
// 也不下载任何二进制。profile 落在 `$DENIA_HOME/browser/profile`。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

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

/**
 * 问一次浏览器自己报的 UA。
 *
 * 用一次性 profile 以 `--remote-debugging-port=0` 起一个后台实例,从
 * stderr 拿 DevTools 端点,读 `/json/version` 的 UA 后立即结束。
 * 版本号必须来自这里:写死的版本在浏览器升级后会和 `userAgentData.brands`
 * 冲突,那是比无头标记更明显的伪造痕迹。
 */
export function probeUserAgent(executable: string, timeoutMs = 15_000): Promise<string | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-ua-'))
  const child = spawn(executable, [
    `--user-data-dir=${dir}`,
    '--remote-debugging-port=0',
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

  return new Promise((resolve) => {
    let settled = false
    let buffer = ''
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      child.kill()
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 临时目录可能仍被占用,留给系统清理 */
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()

    child.stderr?.on('data', (chunk: Buffer) => {
      buffer += String(chunk)
      const endpoint = /DevTools listening on (ws:\/\/\S+)/.exec(buffer)?.[1]
      if (!endpoint) return
      // ws://127.0.0.1:<port>/devtools/browser/<id> → http://127.0.0.1:<port>/json/version
      const port = /:(\d+)\//.exec(endpoint)?.[1]
      if (!port) {
        clearTimeout(timer)
        finish(null)
        return
      }
      fetch(`http://127.0.0.1:${port}/json/version`)
        .then((response) => (response.ok ? response.json() : null))
        .then((body: unknown) => {
          clearTimeout(timer)
          const ua = (body as { 'User-Agent'?: unknown } | null)?.['User-Agent']
          finish(typeof ua === 'string' ? ua : null)
        })
        .catch(() => {
          clearTimeout(timer)
          finish(null)
        })
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish(null)
    })
  })
}