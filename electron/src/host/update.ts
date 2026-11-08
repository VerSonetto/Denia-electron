// 更新检查与安装：固定发布仓库，只在打包版里可用。
//
// 与 Rust 版的历史保持一致——release 资产叫
// `Denia-<tag>-windows-x64-setup.exe` 或 `Denia-v<version>-windows-x64-setup.exe`，
// 安装包旁放 SHA256SUMS.txt。这样两个版本看同一套发布规则。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

export interface UpdateRelease {
  version: string
  tag: string
  name: string
  body: string
  htmlUrl: string
  publishedAt: string | null
  prerelease: boolean
  installer: { name: string; size: number } | null
}

export interface UpdateCheck {
  currentVersion: string
  latest: UpdateRelease | null
  updateAvailable: boolean
  canInstall: boolean
  checkedAt: number
  repositoryUrl: string
}

export interface UpdateSource {
  label: string
  host: string
  direct: boolean
  latencyMs: number | null
}

export interface UpdateStatus {
  phase: 'idle' | 'selecting' | 'downloading' | 'verifying' | 'launching' | 'launched' | 'failed'
  version: string | null
  downloadedBytes: number
  totalBytes: number | null
  error: string | null
  source: UpdateSource | null
}

interface GithubAsset {
  name: string
  size: number
  browser_download_url: string
  digest?: string | null
}

interface GithubRelease {
  tag_name: string
  name: string | null
  body: string | null
  html_url: string
  published_at: string | null
  draft: boolean
  prerelease: boolean
  assets: GithubAsset[]
}

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  pre: string[]
}

const CACHE_TTL_MS = 30 * 60 * 1000
const CHECK_TIMEOUT_MS = 20_000
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024
const MAX_CHECKSUM_BYTES = 1024 * 1024

/** `v1.2.3`、`1.2`、`1.2.3-beta.1+sha` 都归一成可比较的版本。 */
export function parseVersion(tag: string): ParsedVersion | null {
  const stripped = tag.replace(/^v/i, '').trim()
  if (!stripped) return null
  const core = stripped.split(/[-+]/, 1)[0]!
  const parts = core.split('.')
  if (parts.length < 2 || parts.length > 3) return null
  const numbers: number[] = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    numbers.push(Number(part))
  }
  const rest = stripped.slice(core.length)
  const pre = rest.startsWith('-') ? rest.slice(1).split('.').filter(Boolean) : []
  return { major: numbers[0]!, minor: numbers[1]!, patch: numbers[2] ?? 0, pre }
}

/** semver 的 precedence 比较：build 元数据不参与，预发布版本小于正式版本。 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const length = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < length; i += 1) {
    const left = a.pre[i]
    const right = b.pre[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      const delta = Number(left) - Number(right)
      if (delta !== 0) return delta
    } else if (leftNumeric) {
      return -1
    } else if (rightNumeric) {
      return 1
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  return 0
}

function installerNames(tag: string, version: ParsedVersion): string[] {
  return [
    `Denia-${tag}-windows-x64-setup.exe`,
    `Denia-v${version.major}.${version.minor}.${version.patch}-windows-x64-setup.exe`,
    `Denia-v${tag.replace(/^v/i, '')}-windows-x64-setup.exe`,
  ]
}

export interface UpdaterOptions {
  currentVersion: string
  /** `owner/repo`。 */
  repository: string
  /** 下载目录，通常是 `<home>/updates`。 */
  downloadDir: string
  /** 测试用；默认当前平台。 */
  platform?: NodeJS.Platform
}

export class Updater {
  private readonly repository: string
  private readonly currentVersion: string
  private readonly downloadDir: string
  private readonly platform: NodeJS.Platform
  private cached: { at: number; check: UpdateCheck } | null = null
  private state: UpdateStatus = {
    phase: 'idle',
    version: null,
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
    source: null,
  }

  constructor(options: UpdaterOptions) {
    this.repository = options.repository
    this.currentVersion = options.currentVersion
    this.downloadDir = options.downloadDir
    this.platform = options.platform ?? process.platform
  }

  get repositoryUrl(): string {
    return `https://github.com/${this.repository}`
  }

  get supported(): boolean {
    return this.platform === 'win32'
  }

  status(): UpdateStatus {
    return { ...this.state }
  }

  async check(force = false): Promise<UpdateCheck> {
    const now = Date.now()
    if (!force && this.cached && now - this.cached.at < CACHE_TTL_MS) return this.cached.check

    const releases = await this.fetchReleases()
    const current = parseVersion(this.currentVersion)
    let best: { version: ParsedVersion; release: GithubRelease } | null = null
    for (const release of releases) {
      if (release.draft) continue
      const version = parseVersion(release.tag_name)
      if (!version) continue
      if (!best || compareVersions(version, best.version) > 0) best = { version, release }
    }

    const check: UpdateCheck = {
      currentVersion: this.currentVersion,
      latest: best ? this.project(best.release, best.version) : null,
      updateAvailable: Boolean(
        best && current && compareVersions(best.version, current) > 0 && best.release.assets.some((asset) => this.installerOf(best!.release, best!.version)),
      ),
      canInstall: this.supported,
      checkedAt: now,
      repositoryUrl: this.repositoryUrl,
    }
    this.cached = { at: now, check }
    return check
  }

  /** 下载并启动安装包。调用方负责在启动后退出应用。 */
  async install(version: string): Promise<UpdateStatus> {
    if (!this.supported) throw new Error('当前平台不支持桌面更新安装')
    if (this.state.phase === 'downloading' || this.state.phase === 'verifying') {
      throw new Error('安装包正在处理中')
    }

    const releases = await this.fetchReleases()
    const match = releases
      .filter((release) => !release.draft)
      .map((release) => ({ release, version: parseVersion(release.tag_name) }))
      .find((entry) => entry.version && versionStringMatches(entry.version, version))
    const target = match?.release
    const targetVersion = match?.version
    if (!target || !targetVersion) throw new Error(`找不到版本 ${version} 的发布记录`)

    const asset = this.installerOf(target, targetVersion)
    if (!asset) throw new Error(`版本 ${version} 没有兼容的 Windows 安装包`)

    fs.mkdirSync(this.downloadDir, { recursive: true })
    const destination = path.join(this.downloadDir, asset.name)
    this.state = {
      phase: 'downloading',
      version,
      downloadedBytes: 0,
      totalBytes: asset.size || null,
      error: null,
      source: { label: 'GitHub', host: 'github.com', direct: true, latencyMs: null },
    }

    try {
      const digest = await this.download(asset, destination, target)
      this.state = { ...this.state, phase: 'verifying' }
      if (digest) await this.verify(destination, target, asset, digest)
      this.state = { ...this.state, phase: 'launching' }
      const child = spawn(destination, [], { detached: true, stdio: 'ignore' })
      child.unref()
      this.state = { ...this.state, phase: 'launched' }
      return this.status()
    } catch (error) {
      this.state = {
        ...this.state,
        phase: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }
      throw error
    }
  }

  private project(release: GithubRelease, version: ParsedVersion): UpdateRelease {
    const installer = this.installerOf(release, version)
    return {
      version: `${version.major}.${version.minor}.${version.patch}${version.pre.length ? `-${version.pre.join('.')}` : ''}`,
      tag: release.tag_name,
      name: release.name ?? release.tag_name,
      body: release.body ?? '',
      htmlUrl: release.html_url,
      publishedAt: release.published_at,
      prerelease: release.prerelease || version.pre.length > 0,
      installer: installer ? { name: installer.name, size: installer.size } : null,
    }
  }

  private installerOf(release: GithubRelease, version: ParsedVersion): GithubAsset | null {
    if (this.platform !== 'win32') return null
    const names = installerNames(release.tag_name, version)
    return (
      release.assets.find(
        (asset) => names.includes(asset.name) && asset.size > 0 && asset.size <= MAX_INSTALLER_BYTES,
      ) ?? null
    )
  }

  private async fetchReleases(): Promise<GithubRelease[]> {
    const response = await fetch(`https://api.github.com/repos/${this.repository}/releases?per_page=30`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `Denia/${this.currentVersion}`,
      },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}）`)
    const body = (await response.json()) as unknown
    if (!Array.isArray(body)) throw new Error('更新服务返回了无效响应')
    return body as GithubRelease[]
  }

  private async download(asset: GithubAsset, destination: string, release: GithubRelease): Promise<string | null> {
    const response = await fetch(asset.browser_download_url, {
      headers: { 'user-agent': `Denia/${this.currentVersion}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    })
    if (!response.ok || !response.body) throw new Error(`下载安装包失败（HTTP ${response.status}）`)

    const hash = crypto.createHash('sha256')
    const out = fs.createWriteStream(destination)
    let received = 0
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.byteLength
        if (received > MAX_INSTALLER_BYTES) throw new Error('安装包超过大小上限')
        hash.update(chunk)
        this.state = { ...this.state, downloadedBytes: received }
        if (!out.write(chunk)) await once(out, 'drain')
      }
    } finally {
      await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())))
    }

    if (asset.size > 0 && received !== asset.size) {
      throw new Error('安装包下载不完整，大小与发布记录不一致')
    }
    return hash.digest('hex')
  }

  private async verify(
    file: string,
    release: GithubRelease,
    asset: GithubAsset,
    actual: string,
  ): Promise<void> {
    const published = asset.digest?.startsWith('sha256:') ? asset.digest.slice('sha256:'.length) : null
    if (published) {
      if (published.toLowerCase() !== actual) throw new Error('安装包校验失败，摘要与发布记录不一致')
      return
    }

    const checksums = release.assets.find(
      (entry) => entry.name === 'SHA256SUMS.txt' && entry.size > 0 && entry.size <= MAX_CHECKSUM_BYTES,
    )
    if (!checksums) return
    const response = await fetch(checksums.browser_download_url, {
      headers: { 'user-agent': `Denia/${this.currentVersion}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    if (!response.ok) return
    const text = await response.text()
    const expected = text
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find((parts) => parts[1] === asset.name)?.[0]
    if (!expected) return
    if (expected.toLowerCase() !== actual) {
      fs.rmSync(file, { force: true })
      throw new Error('安装包校验失败，SHA256 与 SHA256SUMS.txt 不一致')
    }
  }
}

/** 把 `0.6.0` 和 `v0.6.0` 两种写法都认成同一个版本。 */
function versionStringMatches(candidate: ParsedVersion, version: string): boolean {
  const target = parseVersion(version)
  return Boolean(target && compareVersions(candidate, target) === 0)
}

export { versionStringMatches }