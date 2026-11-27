// Built-in Cloudflare Quick Tunnel for zero-config public access.
//
// Cloudflared dials out to Cloudflare and gives us a random HTTPS URL that
// forwards to the remote listener. No account, domain or router change is
// needed. The client keeps the same bearer-token auth: Cloudflare terminates
// TLS, so this is a public HTTPS hop (not the private relay).
//
// The child is detached and its URL is persisted, so restarting Denia reuses
// the same tunnel while the machine stays up. A machine reboot produces a new
// random hostname and devices must pair again.

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { Readable } from 'node:stream'
import path from 'node:path'

import { errorMessage } from '../core/util.ts'

export type QuickTunnelState = 'idle' | 'starting' | 'running' | 'error'

export interface QuickTunnelStatus {
  state: QuickTunnelState
  url: string | null
  pid: number | null
  targetPort: number | null
  startedAt: string | null
  error: string | null
  binary: string | null
}

interface TunnelStateFile {
  pid: number
  url: string | null
  targetPort: number
  startedAt: string
}

export interface QuickTunnelOptions {
  home: string
  targetPort: () => number
  serverId: () => string
  /** Distinguishes multiple tunnels (HTTP access vs private relay). */
  id?: string
  onChange?: (status: QuickTunnelStatus) => void
  logger?: Pick<Console, 'info' | 'warn'>
  /** Test/override seam; otherwise DENIA_CLOUDFLARED, bundled, or downloaded. */
  binaryPath?: string
}

const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
const DOWNLOAD_TIMEOUT_MS = 240_000
const START_TIMEOUT_MS = 60_000
const LOG_LIMIT_BYTES = 512 * 1024

export const parseQuickTunnelUrl = (text: string): string | null => text.match(QUICK_URL)?.[0] ?? null

/** Cloudflare can delete a quick tunnel while the local process stays alive. */
export const tunnelLogIndicatesDead = (text: string): boolean => {
  let lastFatal = -1
  for (const match of text.matchAll(/(?:Unauthorized:\s*)?Tunnel not found/gi)) {
    lastFatal = Math.max(lastFatal, match.index ?? -1)
  }
  if (lastFatal < 0) return false
  const lastRegistered = Math.max(
    text.lastIndexOf('Registered tunnel connection'),
    text.lastIndexOf('Connection registered'),
  )
  return lastFatal > lastRegistered
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function platformAsset(): { name: string; tar: boolean } {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? '386' : 'amd64'
  if (process.platform === 'win32') {
    return { name: `cloudflared-windows-${arch}.exe`, tar: false }
  }
  if (process.platform === 'darwin') {
    return { name: `cloudflared-darwin-${arch}.tgz`, tar: true }
  }
  return { name: `cloudflared-linux-${arch}`, tar: false }
}

function binaryName(): string {
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function stopProcess(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return
  try {
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
        child.once('exit', () => resolve())
        child.once('error', () => resolve())
      })
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        process.kill(pid, 'SIGTERM')
      }
      for (let index = 0; index < 20 && isProcessAlive(pid); index += 1) {
        await sleep(100)
      }
      if (isProcessAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
  } catch {
    // A missing process is the desired end state.
  }
}

export class QuickTunnel {
  private readonly options: QuickTunnelOptions
  private readonly statePath: string
  private readonly logPath: string
  private readonly cacheDir: string
  private starting: Promise<QuickTunnelStatus> | null = null
  private lastError: string | null = null
  private child: ChildProcess | null = null
  private startOffset = 0
  private binary: string | null = null
  private watchdog: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private checking = false
  private restartAttempts = 0

  constructor(options: QuickTunnelOptions) {
    this.options = options
    const id = options.id?.trim() || 'quick'
    this.statePath = path.join(options.home, `${id}-tunnel.json`)
    this.logPath = path.join(options.home, `${id}-tunnel.log`)
    this.cacheDir = path.join(options.home, 'bin')
    this.binary = options.binaryPath ?? null
  }

  status(): QuickTunnelStatus {
    const state = this.readState()
    const targetPort = this.options.targetPort() || null
    if (!state) {
      return {
        state: this.lastError ? 'error' : 'idle',
        url: null,
        pid: null,
        targetPort,
        startedAt: null,
        error: this.lastError,
        binary: this.binary,
      }
    }
    if (!isProcessAlive(state.pid)) {
      return {
        state: 'idle',
        url: null,
        pid: null,
        targetPort,
        startedAt: null,
        error: null,
        binary: this.binary,
      }
    }
    return {
      state: state.url ? 'running' : 'starting',
      url: state.url,
      pid: state.pid,
      targetPort,
      startedAt: state.startedAt,
      error: this.lastError,
      binary: this.binary,
    }
  }

  /** Resume a still-running tunnel or start a new one. */
  async start(): Promise<QuickTunnelStatus> {
    if (this.starting) return this.starting
    this.starting = this.startInternal().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startInternal(): Promise<QuickTunnelStatus> {
    this.lastError = null
    const targetPort = this.options.targetPort()
    if (!targetPort) {
      throw new Error('远程监听尚未启动，无法建立公网隧道')
    }

    this.cancelRetry()
    const existing = await this.reuseExisting(targetPort)
    if (existing) {
      if (existing.pid) this.armWatchdog(existing.pid)
      this.emit(existing)
      return existing
    }

    const binary = await this.ensureBinary()
    this.binary = binary
    await this.prepareLog()

    const state: TunnelStateFile = {
      pid: 0,
      url: null,
      targetPort,
      startedAt: new Date().toISOString(),
    }

    const logFd = fs.openSync(this.logPath, 'a')
    fs.writeSync(logFd, `\n[denia] starting quick tunnel for 127.0.0.1:${targetPort}\n`)
    const child = spawn(
      binary,
      ['tunnel', '--url', `http://127.0.0.1:${targetPort}`, '--no-autoupdate', '--loglevel', 'info'],
      {
        cwd: this.options.home,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, NO_COLOR: '1' },
      },
    )
    fs.closeSync(logFd)
    this.child = child
    child.unref()
    if (!child.pid) {
      throw new Error('cloudflared 启动失败')
    }
    state.pid = child.pid
    this.writeState(state)
    this.emit(this.status())

    let exited: string | null = null
    child.once('exit', (code, signal) => {
      exited = `cloudflared 退出（${signal ?? code ?? 'unknown'}）`
    })
    child.once('error', (error) => {
      exited = `cloudflared 启动失败：${errorMessage(error)}`
    })

    const deadline = Date.now() + START_TIMEOUT_MS
    let url: string | null = null
    while (Date.now() < deadline) {
      if (exited) break
      const chunk = await this.readNewLog()
      const match = parseQuickTunnelUrl(chunk)
      if (match) {
        url = match
        break
      }
      await sleep(350)
    }

    if (!url) {
      const logTail = await this.readLogTail()
      await stopProcess(state.pid)
      this.clearState()
      const provisioning = logTail.match(/quick tunnel provisioning failed[^\n]*/i)?.[0]
      this.lastError = provisioning
        ? `Cloudflare 快速隧道暂时不可用：${provisioning}`
        : exited ?? '创建 Cloudflare 快速隧道超时'
      this.emit(this.status())
      throw new Error(this.lastError)
    }

    state.url = url
    this.writeState(state)
    this.emit(this.status())

    // The local DNS resolver is allowed to be broken or to filter random
    // trycloudflare names; Cloudflare logs the connection state itself.
    const readyDeadline = Date.now() + 20_000
    while (Date.now() < readyDeadline) {
      const chunk = await this.readNewLog()
      if (/Registered tunnel connection/i.test(chunk)) break
      await sleep(250)
    }

    const result = this.status()
    this.emit(result)
    this.restartAttempts = 0
    this.armWatchdog(state.pid)
    return result
  }

  async stop(): Promise<QuickTunnelStatus> {
    this.clearWatchdog()
    this.cancelRetry()
    const state = this.readState()
    if (state) await stopProcess(state.pid)
    this.clearState()
    this.lastError = null
    const result = this.status()
    this.emit(result)
    return result
  }

  /** Stop reading logs but leave the detached tunnel alive for the next launch. */
  dispose(): void {
    this.clearWatchdog()
    this.cancelRetry()
    this.child = null
  }

  private armWatchdog(pid: number): void {
    this.clearWatchdog()
    this.watchdog = setInterval(() => {
      void this.checkHealth(pid)
    }, 30_000)
    this.watchdog.unref?.()
  }

  private clearWatchdog(): void {
    if (!this.watchdog) return
    clearInterval(this.watchdog)
    this.watchdog = null
  }

  private cancelRetry(): void {
    if (!this.retryTimer) return
    clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.starting) return
    this.restartAttempts += 1
    const delay = Math.min(60_000 * 2 ** Math.min(this.restartAttempts - 1, 2), 300_000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.start().catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error)
        this.emit(this.status())
        this.scheduleRetry()
      })
    }, delay)
    this.retryTimer.unref?.()
  }

  private async checkHealth(pid: number): Promise<void> {
    if (this.checking || this.starting) return
    if (!isProcessAlive(pid)) {
      this.clearState()
      this.lastError = 'Cloudflare 快速隧道进程已退出，正在重建'
      this.emit(this.status())
      this.scheduleRetry()
      return
    }
    let tail = ''
    try {
      tail = await this.readLogTail()
    } catch {
      return
    }
    if (!tunnelLogIndicatesDead(tail)) return
    this.checking = true
    try {
      this.clearWatchdog()
      this.lastError = 'Cloudflare 快速隧道已失效，正在重建'
      await stopProcess(pid)
      this.clearState()
      this.emit(this.status())
      await this.start()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.emit(this.status())
      this.scheduleRetry()
    } finally {
      this.checking = false
    }
  }

  private async reuseExisting(targetPort: number): Promise<QuickTunnelStatus | null> {
    const state = this.readState()
    if (!state) return null
    if (!isProcessAlive(state.pid)) {
      this.clearState()
      return null
    }
    if (state.targetPort !== targetPort) {
      await stopProcess(state.pid)
      this.clearState()
      return null
    }
    if (!state.url) {
      // A previous start was interrupted; wait briefly for its URL.
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && isProcessAlive(state.pid)) {
        const chunk = await this.readNewLog()
        const match = parseQuickTunnelUrl(chunk)
        if (match) {
          state.url = match
          this.writeState(state)
          break
        }
        await sleep(350)
      }
    }
    if (state.url) {
      if (tunnelLogIndicatesDead(await this.readLogTail())) {
        this.lastError = 'Cloudflare 快速隧道已失效，正在重建'
        await stopProcess(state.pid)
        this.clearState()
        return null
      }
      const result = this.status()
      this.emit(result)
      return result
    }
    await stopProcess(state.pid)
    this.clearState()
    return null
  }

  private async ensureBinary(): Promise<string> {
    const override = this.options.binaryPath ?? process.env.DENIA_CLOUDFLARED
    if (override) {
      if (!fs.existsSync(override)) throw new Error(`找不到 cloudflared：${override}`)
      return override
    }
    const cached = path.join(this.cacheDir, binaryName())
    if (fs.existsSync(cached)) return cached

    for (const candidate of this.bundledCandidates()) {
      if (fs.existsSync(candidate)) return candidate
    }

    await fsp.mkdir(this.cacheDir, { recursive: true, mode: 0o700 })
    const asset = platformAsset()
    const configured = process.env.DENIA_CLOUDFLARED_URL?.trim()
    const base = configured || 'https://github.com/cloudflare/cloudflared/releases/latest/download'
    const url = `${base.replace(/\/+$/, '')}/${asset.name}`
    const archive = path.join(this.cacheDir, asset.name)
    this.options.logger?.info?.(`[denia] downloading cloudflared: ${url}`)
    await this.download(url, archive)

    if (!asset.tar) {
      await fsp.rename(archive, cached)
    } else {
      await new Promise<void>((resolve, reject) => {
        const tar = spawn('tar', ['-xzf', archive, '-C', this.cacheDir], {
          stdio: 'ignore',
          windowsHide: true,
        })
        tar.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解压 cloudflared 失败（${code}）`))))
        tar.once('error', reject)
      })
      await fsp.rename(path.join(this.cacheDir, 'cloudflared'), cached)
      await fsp.rm(archive, { force: true })
    }
    await fsp.chmod(cached, 0o755)
    return cached
  }

  private bundledCandidates(): string[] {
    const name = binaryName()
    const candidates: string[] = []
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'cloudflared', name))
    }
    // src/host/quick-tunnel.ts -> electron/resources, and dist -> electron/resources
    candidates.push(path.resolve(import.meta.dirname, '..', '..', 'resources', 'cloudflared', name))
    candidates.push(path.resolve(import.meta.dirname, '..', 'resources', 'cloudflared', name))
    return candidates
  }

  private async download(url: string, target: string): Promise<void> {
    if (!/^https:\/\//i.test(url)) throw new Error('cloudflared 下载地址必须是 HTTPS')
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'denia-host' },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    })
    if (!response.ok || !response.body) {
      throw new Error(`下载 cloudflared 失败（HTTP ${response.status}）。可设置 DENIA_CLOUDFLARED 指向本地二进制`)
    }
    const temp = `${target}.download`
    const file = await fsp.open(temp, 'w', 0o600)
    try {
      const stream = Readable.fromWeb(response.body as never)
      for await (const chunk of stream) {
        await file.write(chunk as Buffer)
      }
    } finally {
      await file.close()
    }
    const stat = await fsp.stat(temp)
    if (stat.size < 1_000_000) {
      await fsp.rm(temp, { force: true })
      throw new Error('下载的 cloudflared 文件不完整')
    }
    await fsp.rename(temp, target)
  }

  private async prepareLog(): Promise<void> {
    await fsp.mkdir(path.dirname(this.logPath), { recursive: true })
    try {
      const stat = await fsp.stat(this.logPath)
      if (stat.size > LOG_LIMIT_BYTES) await fsp.rm(this.logPath, { force: true })
    } catch {
      // no log yet
    }
    this.startOffset = fs.existsSync(this.logPath) ? fs.statSync(this.logPath).size : 0
  }

  private async readNewLog(): Promise<string> {
    try {
      const stat = await fsp.stat(this.logPath)
      if (stat.size <= this.startOffset) return ''
      const handle = await fsp.open(this.logPath, 'r')
      try {
        const length = Math.min(stat.size - this.startOffset, LOG_LIMIT_BYTES)
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, this.startOffset)
        this.startOffset += length
        return buffer.toString('utf8')
      } finally {
        await handle.close()
      }
    } catch {
      return ''
    }
  }

  private async readLogTail(): Promise<string> {
    try {
      const stat = await fsp.stat(this.logPath)
      const length = Math.min(stat.size, 8 * 1024)
      const handle = await fsp.open(this.logPath, 'r')
      try {
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, stat.size - length)
        return buffer.toString('utf8')
      } finally {
        await handle.close()
      }
    } catch {
      return ''
    }
  }

  private readState(): TunnelStateFile | null {
    try {
      if (!fs.existsSync(this.statePath)) return null
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as Partial<TunnelStateFile>
      if (
        typeof parsed.pid !== 'number' ||
        typeof parsed.targetPort !== 'number' ||
        typeof parsed.startedAt !== 'string'
      ) {
        return null
      }
      return {
        pid: parsed.pid,
        url: typeof parsed.url === 'string' ? parsed.url : null,
        targetPort: parsed.targetPort,
        startedAt: parsed.startedAt,
      }
    } catch {
      return null
    }
  }

  private writeState(state: TunnelStateFile): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true })
      fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
    } catch {
      // The tunnel still works this run; the next launch may need to re-create it.
    }
  }

  private clearState(): void {
    try {
      fs.rmSync(this.statePath, { force: true })
    } catch {
      // ignore
    }
  }

  private emit(status: QuickTunnelStatus): void {
    try {
      this.options.onChange?.(status)
    } catch {
      // status callbacks must never break the tunnel
    }
  }
}
