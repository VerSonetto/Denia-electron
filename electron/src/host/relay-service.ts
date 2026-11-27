// Lifecycle around the private relay: one local relay room exposed through a
// Cloudflare Quick Tunnel, one outbound host client, and the pairing candidate
// that tells phones how to reach it. The relay itself never sees plaintext.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { QuickTunnel, type QuickTunnelStatus } from './quick-tunnel.ts'
import { loadRelayIdentity } from './relay-crypto.ts'
import type { RelayPublicJwk } from './relay-crypto.ts'
import { RelayHostClient, RelayServer, type RelayHostStatus, type RelayPairingCandidate } from './relay.ts'

export interface RelayConfig {
  enabled: boolean
  relayPort: number | null
  publicUrl: string | null
}

export interface RelayServiceStatus {
  enabled: boolean
  state: 'disabled' | 'starting' | 'running' | 'error'
  relayUrl: string | null
  relayPort: number | null
  publicUrl: string | null
  serverClients: number
  host: RelayHostStatus
  hostEncPubJwk: RelayPublicJwk | null
  error: string | null
}

export interface RelayServiceOptions {
  home: string
  serverId: () => string
  remotePort: () => number
}

const DEFAULT_CONFIG: RelayConfig = { enabled: false, relayPort: null, publicUrl: null }

const tunnelToRelayUrl = (publicUrl: string): string => {
  const url = new URL(publicUrl)
  url.protocol = 'wss:'
  url.pathname = '/ws'
  url.search = ''
  url.hash = ''
  return url.toString()
}

export class RelayService {
  private readonly home: string
  private readonly serverId: () => string
  private readonly remotePort: () => number
  private readonly configPath: string
  private readonly server = new RelayServer()
  private readonly tunnel: QuickTunnel
  private host: RelayHostClient | null = null
  private identity: ReturnType<typeof loadRelayIdentity> | null = null
  private hostToken = ''
  private hostStatus: RelayHostStatus = { state: 'idle', connectedClients: 0, lastError: null }
  private state: RelayServiceStatus['state'] = 'disabled'
  private lastError: string | null = null
  private relayPort = 0
  private publicUrl: string | null = null
  private starting: Promise<RelayServiceStatus> | null = null

  constructor(options: RelayServiceOptions) {
    this.home = options.home
    this.serverId = options.serverId
    this.remotePort = options.remotePort
    this.configPath = path.join(options.home, 'relay.json')
    this.tunnel = new QuickTunnel({
      home: options.home,
      id: 'relay-tunnel',
      targetPort: () => this.relayPort,
      serverId: () => this.serverId(),
      logger: console,
      onChange: (status) => this.onTunnelStatus(status),
    })
  }

  readConfig(): RelayConfig {
    try {
      if (!fs.existsSync(this.configPath)) return { ...DEFAULT_CONFIG }
      const parsed = JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as Partial<RelayConfig>
      return {
        enabled: parsed.enabled === true,
        relayPort: typeof parsed.relayPort === 'number' ? parsed.relayPort : null,
        publicUrl: typeof parsed.publicUrl === 'string' ? parsed.publicUrl : null,
      }
    } catch {
      return { ...DEFAULT_CONFIG }
    }
  }

  private writeConfig(next: RelayConfig): void {
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true })
      fs.writeFileSync(this.configPath, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    } catch {
      // The relay still works this run; next launch may create a new URL.
    }
  }

  private onTunnelStatus(status: QuickTunnelStatus): void {
    const config = this.readConfig()
    if (!config.enabled) return
    if (status.state === 'running' && status.url) {
      const next = tunnelToRelayUrl(status.url)
      if (config.publicUrl !== next) {
        this.publicUrl = next
        this.writeConfig({
          enabled: true,
          relayPort: this.relayPort || config.relayPort,
          publicUrl: next,
        })
      }
    } else if (status.state === 'error' || status.state === 'idle') {
      if (config.publicUrl !== null) {
        this.publicUrl = null
        this.writeConfig({
          enabled: true,
          relayPort: this.relayPort || config.relayPort,
          publicUrl: null,
        })
      }
    }
  }

  status(): RelayServiceStatus {
    const config = this.readConfig()
    return {
      enabled: config.enabled,
      state: this.state,
      relayUrl: config.publicUrl,
      relayPort: this.relayPort || config.relayPort,
      publicUrl: config.publicUrl,
      serverClients: this.server.status().clients,
      host: this.hostStatus,
      hostEncPubJwk: this.identity?.publicJwk ?? null,
      error: this.lastError ?? this.hostStatus.lastError,
    }
  }

  /** Resume a configured relay after a desktop restart. */
  async resume(): Promise<void> {
    if (!this.readConfig().enabled) return
    try {
      await this.start()
    } catch (error) {
      this.state = 'error'
      this.lastError = error instanceof Error ? error.message : String(error)
    }
  }

  async start(): Promise<RelayServiceStatus> {
    if (this.starting) return this.starting
    this.starting = this.startInternal().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startInternal(): Promise<RelayServiceStatus> {
    if (this.host && this.server.status().listening) return this.status()
    const remotePort = this.remotePort()
    if (!remotePort) throw new Error('远程监听尚未启动，无法建立私有中继')
    this.state = 'starting'
    this.lastError = null
    this.identity = loadRelayIdentity(this.home)
    this.hostToken = crypto.randomBytes(32).toString('base64url')

    const configuredPort = this.readConfig().relayPort
    const port = configuredPort && configuredPort > 0 ? configuredPort : remotePort + 1
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error('私有中继端口无效')
    }

    try {
      const serverStatus = await this.server.start(this.hostToken, port)
      this.relayPort = serverStatus.port ?? port
      const relayUrl = `ws://127.0.0.1:${this.relayPort}/ws`
      this.host = new RelayHostClient({
        relayUrl,
        hostToken: this.hostToken,
        serverId: this.serverId(),
        identity: this.identity,
        remotePort: this.remotePort,
        onStatus: (status) => {
          this.hostStatus = status
        },
      })
      this.host.start()
      await this.waitForHost()
      const tunnel = await this.tunnel.start()
      if (!tunnel.url) throw new Error('私有中继没有拿到公网地址')
      this.publicUrl = tunnelToRelayUrl(tunnel.url)
      this.writeConfig({ enabled: true, relayPort: this.relayPort, publicUrl: this.publicUrl })
      this.state = 'running'
      this.lastError = null
      return this.status()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.state = 'error'
      this.host?.stop()
      this.host = null
      await this.server.stop().catch(() => {})
      await this.tunnel.stop().catch(() => {})
      this.publicUrl = null
      this.writeConfig({ enabled: false, relayPort: this.relayPort || null, publicUrl: null })
      throw error
    }
  }

  async stop(): Promise<RelayServiceStatus> {
    this.host?.stop()
    this.host = null
    await this.server.stop().catch(() => {})
    await this.tunnel.stop().catch(() => {})
    this.state = 'disabled'
    this.lastError = null
    this.publicUrl = null
    this.relayPort = 0
    this.writeConfig({ enabled: false, relayPort: null, publicUrl: null })
    return this.status()
  }

  /** Quit without killing the detached cloudflared; next launch reuses the URL. */
  dispose(): void {
    this.host?.stop()
    this.host = null
    void this.server.stop()
    this.tunnel.dispose()
  }

  pairingCandidate(): RelayPairingCandidate | null {
    const config = this.readConfig()
    if (!config.enabled || !config.publicUrl || !this.identity) return null
    if (this.state !== 'running') return null
    return {
      type: 'relay',
      relayUrl: config.publicUrl,
      serverId: this.serverId(),
      hostEncPubJwk: this.identity.publicJwk,
      priority: 10,
    }
  }

  private async waitForHost(): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (this.hostStatus.state === 'connected') return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(this.hostStatus.lastError ?? '中继主机连接超时')
  }
}
