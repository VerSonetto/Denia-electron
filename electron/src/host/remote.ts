// 远程访问:让同一台机器上的宿主被别的设备（手机 / 另一台电脑）访问。
//
// 分两件事,刻意不混在一起:
//   1. **可达性** —— 监听非回环地址,或由用户自建隧道/中继把它映射出去。
//      这一层不改鉴权,只决定「能不能连上」。
//   2. **授权** —— 配对码兑换出的设备令牌 + 会话 Cookie。
//      远程来源一律要过这道门;回环来源（桌面窗口、本机浏览器）免鉴权,
//      与改造前完全一致。
//
// 为什么不做端到端加密隧道:宿主自己就是被访问的一端,流量已经由传输层
// （HTTPS / SSH / WireGuard / 用户自建隧道）保护。这里只保证「谁能进来」。

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage } from 'node:http'

/** 远程会话 Cookie 名。 */
export const SESSION_COOKIE = 'denia_remote_session'

const TOKEN_PREFIX = 'denia_client_'
const TOKEN_BYTES = 32
const PAIRING_ID_PREFIX = 'pair_'
const PAIRING_SECRET_BYTES = 32
const PAIRING_TTL_MS = 10 * 60 * 1000
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_LABEL_LENGTH = 80

/** 配对码兑换限流：同一来源地址 5 分钟内最多试 10 次。 */
const REDEEM_WINDOW_MS = 5 * 60 * 1000
const REDEEM_MAX_ATTEMPTS = 10

export type ClientKind = 'mobile' | 'desktop' | 'browser'

export interface RemoteClient {
  id: string
  label: string
  tokenHash: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  clientKind: ClientKind
  deviceName: string | null
  devicePlatform: string | null
  appVersion: string | null
  dedupeKey: string | null
}

export interface PublicClient {
  id: string
  label: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  clientKind: ClientKind
  deviceName: string | null
  devicePlatform: string | null
  appVersion: string | null
}

export interface PairingSession {
  id: string
  secretHash: string
  /** 可手输的短配对码摘要。手机没有扫码时用它代替长链接。 */
  codeHash: string
  createdAt: string
  expiresAt: string
  usedAt: string | null
  cancelledAt: string | null
  clientId: string | null
  label: string | null
  /** 带外核对用的短指纹,形如 A1B2-C3D4。 */
  fingerprint: string
  allowedKinds: ClientKind[]
}

export interface PublicPairing {
  id: string
  createdAt: string
  expiresAt: string
  usedAt: string | null
  cancelledAt: string | null
  clientId: string | null
  label: string | null
  fingerprint: string
  allowedKinds: ClientKind[]
}

export interface RemoteConfig {
  /** 监听非回环地址。关闭时只有本机能连。 */
  enabled: boolean
  /** 显式指定的监听地址；空表示监听全部 IPv4。 */
  bindHost: string | null
  /** 显式指定的对外地址（反向代理 / 隧道后面的公网域名）。 */
  publicUrl: string | null
  /** 远程监听的独立端口。与回环主端口分开,两端口同号在 Windows 上会争用地址。 */
  listenPort: number
}

const DEFAULT_CONFIG: RemoteConfig = {
  enabled: false,
  bindHost: null,
  publicUrl: null,
  listenPort: 0,
}

const VALID_KINDS = new Set<ClientKind>(['mobile', 'desktop', 'browser'])
const GENERIC_REDEEM_ERROR = '配对码无效或已过期'

/**
 * 手输配对码的字母表。剔掉 0/O/1/I/L 这类在手机上抄写时容易认错的字符，
 * 8 位即约 1.1e12 种组合，配合一次性使用与限流足够。
 */
const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const PAIRING_CODE_LENGTH = 8

const generatePairingCode = (): string => {
  const bytes = crypto.randomBytes(PAIRING_CODE_LENGTH)
  let out = ''
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    out += PAIRING_CODE_ALPHABET[bytes[index]! % PAIRING_CODE_ALPHABET.length]
  }
  return out
}

/** 4 字节随机指纹,印在二维码旁边供带外核对,形如 A1B2-C3D4。 */
const generateFingerprint = (): string =>
  crypto.randomBytes(4).toString('hex').toUpperCase().replace(/^(.{4})(.{4})$/, '$1-$2')

/** 用户抄写时可能带空格或小写，统一归一后再比对。 */
export const normalizePairingCode = (value: unknown): string => {
  const raw = optionalString(value)
  if (!raw) return ''
  return raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase()
}

interface RemoteStore {
  version: 1
  clients: RemoteClient[]
  pairings: PairingSession[]
}

const emptyStore = (): RemoteStore => ({ version: 1, clients: [], pairings: [] })

const optionalString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const normalizeLabel = (value: unknown, fallback = '远程设备'): string => {
  const trimmed = optionalString(value)
  if (!trimmed) return fallback
  return trimmed.length > MAX_LABEL_LENGTH ? trimmed.slice(0, MAX_LABEL_LENGTH) : trimmed
}

const normalizeKind = (value: unknown): ClientKind | null => {
  const trimmed = optionalString(value)
  return trimmed && VALID_KINDS.has(trimmed as ClientKind) ? (trimmed as ClientKind) : null
}

const normalizeTimestamp = (value: unknown): string | null => {
  const trimmed = optionalString(value)
  if (!trimmed) return null
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

const safeJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 常量时间比较：等长十六进制摘要。长度不同直接失败,不泄漏前缀信息。 */
const constantTimeEqualHex = (left: string, right: string): boolean => {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  if (a.length !== b.length || a.length === 0) return false
  return crypto.timingSafeEqual(a, b)
}

/** 只保留稳定字段的 Cookie 名；宿主可能监听多个地址,按 Host 区分会话。 */
export const cookieNameFor = (req: IncomingMessage): string => {
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  const hostname = host.replace(/:\d+$/, '').toLowerCase()
  if (!hostname) return SESSION_COOKIE
  return `${SESSION_COOKIE}_${hostname.replace(/[^a-z0-9]+/g, '_')}`
}

export const parseCookies = (header: string | undefined): Record<string, string> => {
  if (!header) return {}
  const out: Record<string, string> = {}
  for (const segment of header.split(';')) {
    const index = segment.indexOf('=')
    if (index === -1) continue
    const name = segment.slice(0, index).trim()
    if (!name) continue
    const raw = segment.slice(index + 1).trim()
    try {
      out[name] = decodeURIComponent(raw)
    } catch {
      out[name] = raw
    }
  }
  return out
}

/** 回环判定：这些来源视为本机操作者,免鉴权。 */
export const isLoopbackAddress = (address: string | undefined): boolean => {
  if (!address) return false
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  return normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.')
}

export interface RemoteRuntimeOptions {
  home: string
  /** 宿主回环监听的实际端口，用于推导默认的远程端口。 */
  port: () => number
  /** 宿主回环监听地址。 */
  bindHost: () => string
}

export class RemoteRuntime {
  private readonly storePath: string
  private readonly configPath: string
  private readonly identityPath: string
  private readonly options: RemoteRuntimeOptions
  private readonly redeemAttempts = new Map<string, { count: number; firstAttemptAt: number }>()

  constructor(options: RemoteRuntimeOptions) {
    this.options = options
    this.storePath = path.join(options.home, 'remote-clients.json')
    this.configPath = path.join(options.home, 'remote.json')
    this.identityPath = path.join(options.home, 'remote-identity.json')
  }

  /**
   * 这台服务器的稳定标识。
   *
   * 原生 App 把它钉在连接上:局域网地址被 DHCP 换给另一台机器时,App 先在
   * /api/remote/status 上核对这个值,不一致就不把设备令牌发出去。它不是密钥,
   * 只是一个「不是这台机器」的判据;真正的信任来自配对时的那次一次性密钥。
   */
  serverId(): string {
    try {
      if (fs.existsSync(this.identityPath)) {
        const parsed = safeJson(fs.readFileSync(this.identityPath, 'utf8'))
        if (parsed && typeof parsed === 'object') {
          const id = optionalString((parsed as Record<string, unknown>).serverId)
          if (id) return id
        }
      }
    } catch {
      // 读不出来就重新生成:身份对不上会让 App 拒绝连接,比静默沿用错误值安全。
    }
    const serverId = crypto.randomBytes(16).toString('hex')
    try {
      fs.mkdirSync(path.dirname(this.identityPath), { recursive: true })
      fs.writeFileSync(this.identityPath, JSON.stringify({ serverId }, null, 2), { encoding: 'utf8', mode: 0o600 })
    } catch {
      // 落盘失败不影响本次运行;下次启动会重新生成,App 会要求重新配对。
    }
    return serverId
  }

  // —— 持久化 ——

  private readStore(): RemoteStore {
    if (!fs.existsSync(this.storePath)) return emptyStore()
    const parsed = safeJson(fs.readFileSync(this.storePath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return emptyStore()
    const record = parsed as Record<string, unknown>
    const clients = Array.isArray(record.clients)
      ? record.clients.flatMap((entry): RemoteClient[] => {
        if (typeof entry !== 'object' || entry === null) return []
        const item = entry as Record<string, unknown>
        const id = optionalString(item.id)
        const tokenHash = optionalString(item.tokenHash)
        if (!id || !tokenHash) return []
        return [{
          id,
          tokenHash,
          label: normalizeLabel(item.label),
          createdAt: normalizeTimestamp(item.createdAt) ?? new Date().toISOString(),
          lastUsedAt: normalizeTimestamp(item.lastUsedAt),
          revokedAt: normalizeTimestamp(item.revokedAt),
          clientKind: normalizeKind(item.clientKind) ?? 'mobile',
          deviceName: optionalString(item.deviceName),
          devicePlatform: optionalString(item.devicePlatform),
          appVersion: optionalString(item.appVersion),
          dedupeKey: optionalString(item.dedupeKey),
        }]
      })
      : []
    const pairings = Array.isArray(record.pairings)
      ? record.pairings.flatMap((entry): PairingSession[] => {
        if (typeof entry !== 'object' || entry === null) return []
        const item = entry as Record<string, unknown>
        const id = optionalString(item.id)
        const secretHash = optionalString(item.secretHash)
        const expiresAt = normalizeTimestamp(item.expiresAt)
        if (!id || !secretHash || !expiresAt) return []
        const kinds = Array.isArray(item.allowedKinds)
          ? item.allowedKinds.map(normalizeKind).filter((kind): kind is ClientKind => kind !== null)
          : []
        return [{
          id,
          secretHash,
          codeHash: optionalString(item.codeHash) ?? '',
          createdAt: normalizeTimestamp(item.createdAt) ?? new Date().toISOString(),
          expiresAt,
          usedAt: normalizeTimestamp(item.usedAt),
          cancelledAt: normalizeTimestamp(item.cancelledAt),
          clientId: optionalString(item.clientId),
          label: optionalString(item.label),
          fingerprint: optionalString(item.fingerprint) ?? generateFingerprint(),
          allowedKinds: kinds.length > 0 ? kinds : ['mobile', 'desktop', 'browser'],
        }]
      })
      : []
    return { version: 1, clients, pairings }
  }

  private writeStore(store: RemoteStore): void {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true })
    // 0600:令牌摘要在里面,虽然不可反推,但设备清单本身也不该外泄。
    fs.writeFileSync(this.storePath, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 })
    try {
      fs.chmodSync(this.storePath, 0o600)
    } catch {
      /* Windows 上 chmod 无实际意义,失败不影响正确性 */
    }
  }

  /** 远程监听端口的默认值：主端口 + 1（两端口同号在 Windows 上争用地址）。 */
  private defaultListenPort(): number {
    return this.options.port() + 1
  }

  readConfig(): RemoteConfig {
    const fallback: RemoteConfig = { ...DEFAULT_CONFIG, listenPort: this.defaultListenPort() }
    if (!fs.existsSync(this.configPath)) return fallback
    const parsed = safeJson(fs.readFileSync(this.configPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return fallback
    const record = parsed as Record<string, unknown>
    const storedPort = typeof record.listenPort === 'number' ? record.listenPort : Number(record.listenPort)
    return {
      enabled: record.enabled === true,
      bindHost: optionalString(record.bindHost),
      publicUrl: optionalString(record.publicUrl),
      listenPort: Number.isInteger(storedPort) && storedPort > 0 && storedPort < 65536
        ? storedPort
        : this.defaultListenPort(),
    }
  }

  writeConfig(next: Partial<RemoteConfig>): RemoteConfig {
    const current = this.readConfig()
    const requestedPort = next.listenPort === undefined ? current.listenPort : next.listenPort
    const merged: RemoteConfig = {
      enabled: typeof next.enabled === 'boolean' ? next.enabled : current.enabled,
      bindHost: next.bindHost === undefined ? current.bindHost : optionalString(next.bindHost),
      publicUrl: next.publicUrl === undefined ? current.publicUrl : optionalString(next.publicUrl),
      listenPort: Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536
        ? requestedPort
        : current.listenPort,
    }
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true })
    fs.writeFileSync(this.configPath, JSON.stringify({
      enabled: merged.enabled,
      bindHost: merged.bindHost,
      publicUrl: merged.publicUrl,
      listenPort: merged.listenPort,
    }, null, 2), 'utf8')
    return merged
  }

  // —— 客户端令牌 ——

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex')
  }

  private present(client: RemoteClient): PublicClient {
    return {
      id: client.id,
      label: client.label,
      createdAt: client.createdAt,
      lastUsedAt: client.lastUsedAt,
      revokedAt: client.revokedAt,
      clientKind: client.clientKind,
      deviceName: client.deviceName,
      devicePlatform: client.devicePlatform,
      appVersion: client.appVersion,
    }
  }

  listClients(): PublicClient[] {
    return this.readStore().clients.map((client) => this.present(client))
  }

  private createClient(input: {
    label?: unknown
    clientKind?: unknown
    deviceName?: unknown
    devicePlatform?: unknown
    appVersion?: unknown
    dedupeKey?: unknown
  }): { client: PublicClient; token: string } {
    const store = this.readStore()
    const token = `${TOKEN_PREFIX}${crypto.randomBytes(TOKEN_BYTES).toString('base64url')}`
    const dedupeKey = optionalString(input.dedupeKey)
    // 同一台设备重复配对时复用旧记录的名字:操作者手工起的名字优先于设备自报。
    const existing = dedupeKey ? store.clients.find((entry) => entry.dedupeKey === dedupeKey) : undefined
    const client: RemoteClient = {
      id: crypto.randomBytes(12).toString('hex'),
      label: normalizeLabel(input.label, existing?.label ?? normalizeLabel(input.deviceName)),
      tokenHash: this.hashToken(token),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
      clientKind: normalizeKind(input.clientKind) ?? 'mobile',
      deviceName: optionalString(input.deviceName),
      devicePlatform: optionalString(input.devicePlatform),
      appVersion: optionalString(input.appVersion),
      dedupeKey,
    }
    // 去重键相同的旧记录被替换,而不是并存——否则每次重新配对所有出一条幽灵设备。
    store.clients = dedupeKey
      ? store.clients.filter((entry) => entry.dedupeKey !== dedupeKey)
      : store.clients
    store.clients.push(client)
    this.writeStore(store)
    return { client: this.present(client), token }
  }

  revokeClient(id: string): boolean {
    const store = this.readStore()
    const client = store.clients.find((entry) => entry.id === id)
    if (!client) return false
    if (!client.revokedAt) client.revokedAt = new Date().toISOString()
    this.writeStore(store)
    return true
  }

  purgeRevoked(): number {
    const store = this.readStore()
    const before = store.clients.length
    store.clients = store.clients.filter((entry) => !entry.revokedAt)
    const purged = before - store.clients.length
    if (purged > 0) this.writeStore(store)
    return purged
  }

  /** Bearer 令牌认证。命中即刷新 lastUsedAt（节流到 60 秒,少写盘）。 */
  authenticateToken(token: string | null): PublicClient | null {
    if (!token || !token.startsWith(TOKEN_PREFIX)) return null
    const store = this.readStore()
    const hash = this.hashToken(token)
    const client = store.clients.find((entry) => !entry.revokedAt && constantTimeEqualHex(entry.tokenHash, hash))
    if (!client) return null
    const lastUsed = Date.parse(client.lastUsedAt ?? '')
    if (!Number.isFinite(lastUsed) || Date.now() - lastUsed >= 60_000) {
      client.lastUsedAt = new Date().toISOString()
      this.writeStore(store)
    }
    return this.present(client)
  }

  // —— 配对会话 ——

  private presentPairing(session: PairingSession): PublicPairing {
    return {
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      usedAt: session.usedAt,
      cancelledAt: session.cancelledAt,
      clientId: session.clientId,
      label: session.label,
      fingerprint: session.fingerprint,
      allowedKinds: session.allowedKinds,
    }
  }

  private isPending(session: PairingSession): boolean {
    return !session.usedAt
      && !session.cancelledAt
      && Number.isFinite(Date.parse(session.expiresAt))
      && Date.parse(session.expiresAt) > Date.now()
  }

  createPairing(input: { label?: unknown; allowedKinds?: unknown }): { pairing: PublicPairing; secret: string; code: string } {
    const store = this.readStore()
    // 顺手清掉过期且未使用的会话,避免文件无限增长。
    store.pairings = store.pairings.filter((session) => this.isPending(session))
    const secret = crypto.randomBytes(PAIRING_SECRET_BYTES).toString('base64url')
    const code = generatePairingCode()
    const kinds = Array.isArray(input.allowedKinds)
      ? input.allowedKinds.map(normalizeKind).filter((kind): kind is ClientKind => kind !== null)
      : []
    const session: PairingSession = {
      id: `${PAIRING_ID_PREFIX}${crypto.randomBytes(12).toString('hex')}`,
      secretHash: this.hashToken(secret),
      codeHash: this.hashToken(code),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
      usedAt: null,
      cancelledAt: null,
      clientId: null,
      label: optionalString(input.label),
      fingerprint: generateFingerprint(),
      allowedKinds: kinds.length > 0 ? kinds : ['mobile', 'desktop', 'browser'],
    }
    store.pairings.push(session)
    this.writeStore(store)
    return { pairing: this.presentPairing(session), secret, code }
  }

  listPendingPairings(): PublicPairing[] {
    return this.readStore().pairings.filter((session) => this.isPending(session)).map((session) => this.presentPairing(session))
  }

  cancelPairing(id: string): boolean {
    const store = this.readStore()
    const session = store.pairings.find((entry) => entry.id === id)
    if (!session) return false
    if (!session.cancelledAt) session.cancelledAt = new Date().toISOString()
    this.writeStore(store)
    return true
  }

  /** 兑换限流：按来源地址计数,超出后一律返回同一个错误,不区分「错」与「太频繁」。 */
  private admitRedeem(peerAddress: string): boolean {
    const now = Date.now()
    for (const [key, entry] of this.redeemAttempts) {
      if (now - entry.firstAttemptAt >= REDEEM_WINDOW_MS) this.redeemAttempts.delete(key)
    }
    const entry = this.redeemAttempts.get(peerAddress)
    if (!entry) {
      this.redeemAttempts.set(peerAddress, { count: 1, firstAttemptAt: now })
      return true
    }
    entry.count += 1
    return entry.count <= REDEEM_MAX_ATTEMPTS
  }

  /**
   * 用一次性配对密钥换设备令牌。
   *
   * 失败原因一律合并成同一条消息:区分「不存在 / 已用过 / 已过期 / 密钥错」
   * 等于给攻击者一个免费的枚举反馈。
   */
  redeemPairing(input: {
    pairingId?: unknown
    secret?: unknown
    /** 手输短码。与 pairingId + secret 二选一。 */
    code?: unknown
    label?: unknown
    clientKind?: unknown
    deviceName?: unknown
    devicePlatform?: unknown
    appVersion?: unknown
    dedupeKey?: unknown
    peerAddress: string
  }): { client: PublicClient; token: string; pairing: PublicPairing } {
    if (!this.admitRedeem(input.peerAddress)) {
      throw Object.assign(new Error(GENERIC_REDEEM_ERROR), { statusCode: 429 })
    }
    const pairingId = optionalString(input.pairingId)
    const secret = optionalString(input.secret)
    const code = normalizePairingCode(input.code)
    const store = this.readStore()
    // 短码路径：没有 pairingId 时用码反查会话（码本身已含足够熵）。
    const session = pairingId
      ? store.pairings.find((entry) => entry.id === pairingId)
      : code
        ? store.pairings.find((entry) => entry.codeHash && constantTimeEqualHex(entry.codeHash, this.hashToken(code)))
        : undefined
    if (!session || !this.isPending(session)) {
      throw Object.assign(new Error(GENERIC_REDEEM_ERROR), { statusCode: 400 })
    }
    // 有 pairingId 时必须同时验密钥或短码，避免只凭会话 id 就能兑。
    if (pairingId) {
      const secretOk = Boolean(secret) && constantTimeEqualHex(session.secretHash, this.hashToken(secret!))
      const codeOk = Boolean(code) && Boolean(session.codeHash) && constantTimeEqualHex(session.codeHash, this.hashToken(code))
      if (!secretOk && !codeOk) {
        throw Object.assign(new Error(GENERIC_REDEEM_ERROR), { statusCode: 400 })
      }
    }
    const kind = normalizeKind(input.clientKind) ?? 'mobile'
    if (!session.allowedKinds.includes(kind)) {
      throw Object.assign(new Error(GENERIC_REDEEM_ERROR), { statusCode: 400 })
    }
    const created = this.createClient({
      label: session.label ?? input.label,
      clientKind: kind,
      deviceName: input.deviceName,
      devicePlatform: input.devicePlatform,
      appVersion: input.appVersion,
      // 未提供去重键时退回配对会话 id:每次配对各自独立,不会误吞别的设备。
      dedupeKey: optionalString(input.dedupeKey) ?? `pairing:${session.id}`,
    })
    // createClient 已写盘;这里重读再标记会话已用,避免两次写覆盖。
    const after = this.readStore()
    const target = after.pairings.find((entry) => entry.id === session.id)
    if (target) {
      target.usedAt = new Date().toISOString()
      target.clientId = created.client.id
      this.writeStore(after)
    }
    const pairing = target ? this.presentPairing(target) : this.presentPairing(session)
    return { ...created, pairing }
  }

  // —— 会话 Cookie ——

  /** 会话 Cookie 承载的是设备令牌本身;客户端只需保存这一条。 */
  sessionTokenFromRequest(req: IncomingMessage): string | null {
    const cookies = parseCookies(req.headers.cookie)
    const name = cookieNameFor(req)
    return cookies[name] ?? cookies[SESSION_COOKIE] ?? null
  }

  buildSessionCookie(req: IncomingMessage, token: string): string {
    const secure = isSecureRequest(req) ? '; Secure' : ''
    const maxAge = Math.floor(SESSION_TTL_MS / 1000)
    return `${cookieNameFor(req)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`
  }

  buildClearCookie(req: IncomingMessage): string {
    const secure = isSecureRequest(req) ? '; Secure' : ''
    return `${cookieNameFor(req)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
  }

  /** 当前对外可用地址,给配对二维码用。 */
  addresses(): { lan: string[]; publicUrl: string | null } {
    const config = this.readConfig()
    const port = config.listenPort
    const lan = new Set<string>()
    for (const list of Object.values(os.networkInterfaces())) {
      for (const entry of list ?? []) {
        if (entry.family === 'IPv4' && !entry.internal) lan.add(`http://${entry.address}:${port}`)
      }
    }
    return { lan: [...lan], publicUrl: config.publicUrl }
  }

  /**
   * 配对载荷里的候选清单，按优先级排好。
   *
   * 显式配置的对外地址（反向代理 / 隧道）排第一：它是用户明确声明的
   * 可达路径，比自动枚举的网卡地址更可信。局域网地址按枚举顺序兜底。
   */
  pairingCandidates(): PairingCandidate[] {
    const { lan, publicUrl } = this.addresses()
    const candidates: PairingCandidate[] = []
    if (publicUrl) candidates.push({ type: 'tunnel', url: publicUrl, priority: 10 })
    lan.forEach((url, index) => {
      candidates.push({ type: 'lan', url, priority: 20 + index })
    })
    return candidates
  }
}

/** 请求是否经过 TLS 终止;决定 Cookie 要不要带 Secure。 */
export const isSecureRequest = (req: IncomingMessage): boolean => {
  const forwarded = req.headers['x-forwarded-proto']
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (typeof value === 'string' && value.split(',')[0]?.trim().toLowerCase() === 'https') return true
  return Boolean((req.socket as { encrypted?: boolean }).encrypted)
}

export const isLoopbackHostName = (host: string): boolean => {
  const normalized = host.trim().toLowerCase()
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]'
}

/**
 * 鉴权判定结果。
 *
 * `local` 的请求完全不加干预 —— 桌面窗口和本机浏览器保持原有行为,
 * 这样即使远程功能没启用,本机体验也一字不变。
 */
export type AccessDecision =
  | { kind: 'local' }
  | { kind: 'authorized'; client: PublicClient }
  | { kind: 'unauthorized' }

/**
 * 这次请求是否真的是「坐在宿主机前的人」发起的。
 *
 * 只看对端地址不够:反向代理通常就在同一台机器上,它转发进来的请求源地址
 * 是 127.0.0.1,但背后站着的是公网上的任意人。所以真正的判据是三件事同时成立:
 *   1. 对端地址是回环;
 *   2. Host 头指向回环名(经代理进来时它是公网域名);
 *   3. 没有携带非回环的 X-Forwarded-For(代理会补上真实来源)。
 * 任何一条不成立就按远程处理 —— 宁可多要一次配对,也不能把门开给公网。
 */
export const isLocalRequest = (req: IncomingMessage): boolean => {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false

  const hostHeader = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
  const hostName = String(hostHeader ?? '').trim().replace(/^\[/, '').split(/\]:|:/)[0] ?? ''
  if (hostName && !isLoopbackHostName(hostName)) return false

  const forwarded = req.headers['x-forwarded-for']
  const forwardedValue = Array.isArray(forwarded) ? forwarded.join(',') : forwarded
  if (forwardedValue) {
    for (const entry of forwardedValue.split(',')) {
      const address = entry.trim()
      if (address && !isLoopbackAddress(address)) return false
    }
  }
  return true
}

export const decideAccess = (
  runtime: RemoteRuntime,
  req: IncomingMessage,
  options: { requireToken: boolean },
): AccessDecision => {
  if (isLocalRequest(req)) return { kind: 'local' }
  if (!options.requireToken) return { kind: 'local' }

  const header = req.headers.authorization
  const value = Array.isArray(header) ? header[0] : header
  const bearer = typeof value === 'string' && /^Bearer\s+(.+)$/i.test(value)
    ? value.replace(/^Bearer\s+/i, '').trim()
    : null
  const token = bearer ?? runtime.sessionTokenFromRequest(req)
  const client = runtime.authenticateToken(token)
  return client ? { kind: 'authorized', client } : { kind: 'unauthorized' }
}

/**
 * 远程请求的受限面。
 *
 * 这些能力只在宿主自己的机器上有意义,或者会泄漏本机环境——远程来源一律拒绝,
 * 而不是靠 UI 藏起来。判定发生在鉴权之后、路由之前。
 */
const REMOTE_BLOCKED_PREFIXES = [
  '/api/fs/pick', // 原生文件选择器会弹在宿主机屏幕上
  '/api/fs/pick-files',
  '/api/open-in-app/', // 在宿主机上拉起 GUI 应用
  '/api/update/install', // 改写宿主机上的程序文件
  '/api/browser/', // 宿主机的 CDP 浏览器实例
]

export const isBlockedForRemote = (pathname: string): boolean =>
  REMOTE_BLOCKED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix))

export { GENERIC_REDEEM_ERROR, PAIRING_TTL_MS, SESSION_TTL_MS, TOKEN_PREFIX }

/**
 * 配对候选:一条可达的基地址 + 它的传输类型。
 *
 * 与 OpenChamber 的 pairing v2 同构,只是这里还没有 relay 实现。保留
 * `type` 判别而不是直接给一组 URL,是因为手机端的探测逻辑要按类型排序:
 * 直连优先,隧道兜底,以后加 relay 时不用改载荷结构。
 */
export type PairingCandidate =
  | { type: 'lan' | 'tunnel'; url: string; priority?: number }

/**
 * 配对链接。手机扫到或粘贴这一条,就能兑换出设备令牌。
 *
 * 一次性密钥放在链接里,链接本身就是凭证 —— 只走二维码与剪贴板,
 * 不进日志、不进 referer。`fingerprint` 用于带外核对:二维码在屏幕上,
 * 指纹也在屏幕上,两者同源,所以它防的是「链接被换掉」而不是「看错链接」。
 */
export interface PairingLinkPayload {
  v: 2
  pairingId: string
  secret: string
  /** 服务器稳定标识,App 钉住它以免把令牌发给换了主的地址。 */
  serverId?: string
  fingerprint?: string
  label?: string
  expiresAt?: string
  candidates: PairingCandidate[]
}

const LINK_SCHEME = 'denia://connect'
const MAX_LINK_LENGTH = 8192

const base64UrlEncode = (value: string): string => Buffer.from(value, 'utf8').toString('base64url')
const base64UrlDecode = (value: string): string => Buffer.from(value, 'base64url').toString('utf8')

const normalizeCandidate = (value: unknown): PairingCandidate | null => {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const type = record.type === 'lan' || record.type === 'tunnel' ? record.type : null
  const url = optionalString(record.url)
  if (!type || !url) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    parsed.hash = ''
  } catch {
    return null
  }
  const priority = typeof record.priority === 'number' && Number.isFinite(record.priority)
    ? record.priority
    : undefined
  return priority === undefined ? { type, url } : { type, url, priority }
}

export const encodePairingLink = (payload: PairingLinkPayload): string => {
  const params = new URLSearchParams()
  params.set('v', '2')
  params.set('p', base64UrlEncode(JSON.stringify(payload)))
  return `${LINK_SCHEME}?${params.toString()}`
}

export const parsePairingLink = (raw: string): PairingLinkPayload | null => {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_LINK_LENGTH) return null
  if (!trimmed.toLowerCase().startsWith(LINK_SCHEME)) return null
  const question = trimmed.indexOf('?')
  if (question === -1) return null
  let encoded = ''
  let version = ''
  for (const part of trimmed.slice(question + 1).split('&')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq)
    const value = part.slice(eq + 1)
    if (key === 'v') version = value
    else if (key === 'p') encoded = value
  }
  if (version !== '2' || !encoded) return null
  try {
    const parsed = JSON.parse(base64UrlDecode(encoded)) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (record.v !== 2) return null
    const pairingId = optionalString(record.pairingId)
    const secret = optionalString(record.secret)
    if (!pairingId || !secret) return null
    const candidates = Array.isArray(record.candidates)
      ? record.candidates.map(normalizeCandidate).filter((entry): entry is PairingCandidate => entry !== null)
      : []
    if (candidates.length === 0) return null
    const fingerprint = optionalString(record.fingerprint)
    const label = optionalString(record.label)
    const expiresAt = optionalString(record.expiresAt)
    const serverId = optionalString(record.serverId)
    return {
      v: 2,
      pairingId,
      secret,
      candidates,
      ...(serverId ? { serverId } : {}),
      ...(fingerprint ? { fingerprint } : {}),
      ...(label ? { label } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    }
  } catch {
    return null
  }
}
