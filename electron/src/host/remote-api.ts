// 远程访问的 HTTP 面。
//
// 分成两类端点,界线只有一条:**本机能看到凭证,远程只能兑换一次**。
//   - 本机端点(建配对、开关监听、看设备清单、吊销)—— 远程来源一律 403;
//   - 公开端点(status / redeem)—— 远程未认证也能打,但 redeem 受来源限流,
//     且失败原因合并成同一条消息,不给枚举反馈。
//
// 令牌在响应体里返回一次(供原生 App 保存),同时种进 HttpOnly Cookie
// (供浏览器 WebView 直接使用)。两条路径用同一个令牌,不需要各自一套。

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  encodePairingLink,
  parsePairingLink,
  type AccessDecision,
  type RemoteRuntime,
} from './remote.ts'
import type { QuickTunnelStatus } from './quick-tunnel.ts'
import type { RelayPairingCandidate } from './relay.ts'
import type { RelayServiceStatus } from './relay-service.ts'

/** 监听器的当前实况,由 server.ts 提供。 */
export interface RemoteListenerState {
  listening: boolean
  host: string | null
  port: number
  error: string | null
}

export interface RemoteApiDeps {
  remote: RemoteRuntime
  json: (res: ServerResponse, status: number, body: unknown) => void
  apiError: (res: ServerResponse, status: number, code: string, message: string) => void
  readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>
  listener: () => RemoteListenerState
  startListener: () => Promise<void>
  stopListener: () => Promise<void>
  /** 内置公网隧道；未接入时相关端点返回 501。 */
  tunnel?: {
    start: () => Promise<QuickTunnelStatus>
    stop: () => Promise<QuickTunnelStatus>
    status: () => QuickTunnelStatus
  }
  /** 私有中继(端到端加密)。 */
  relay?: {
    start: () => Promise<RelayServiceStatus>
    stop: () => Promise<RelayServiceStatus>
    status: () => RelayServiceStatus
    pairingCandidate: () => RelayPairingCandidate | null
  }
  /** 宿主主机名,作为配对设备看到的服务器名。 */
  serverLabel: () => string
}

const peerAddress = (req: IncomingMessage): string => {
  const address = req.socket.remoteAddress ?? ''
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

/** 空对象也要是 `Record<string, unknown>`,否则调用方用不了 body.xxx。 */
const emptyBody = (): Record<string, unknown> => ({})

const statusPayload = (deps: RemoteApiDeps, access: AccessDecision): Record<string, unknown> => {
  const config = deps.remote.readConfig()
  const state = deps.listener()
  const local = access.kind === 'local'
  const authenticated = local || access.kind === 'authorized'
  const clientKind = access.kind === 'authorized' ? access.client.clientKind : null

  const base: Record<string, unknown> = {
    local,
    authenticated,
    enabled: config.enabled,
    listenPort: config.listenPort,
    bindHost: config.bindHost,
    publicUrl: config.publicUrl,
    listening: state.listening,
    listeningHost: state.host,
    listeningPort: state.port,
    listenerError: state.error,
    // 远程拿不到内网地址清单:那等于给它一份内网拓扑。
    addresses: local ? deps.remote.addresses() : { lan: [], publicUrl: config.publicUrl },
    clientKind,
    // 服务器名与身份对未认证的远程也可见:App 要先认机器,再决定发不发令牌。
    serverLabel: deps.serverLabel(),
    serverId: deps.remote.serverId(),
  }
  // A paired phone needs the current relay address after the host restarts;
  // unauthenticated callers only get the identity needed for pairing.
  const relayCandidate = local || access.kind === 'authorized'
    ? deps.relay?.pairingCandidate() ?? null
    : null
  if (!local) return relayCandidate ? { ...base, relayCandidate } : base
  return {
    ...base,
    quickTunnel: config.quickTunnel,
    tunnel: deps.tunnel?.status() ?? null,
    relay: deps.relay?.status() ?? null,
    relayCandidate,
    clients: deps.remote.listClients(),
    pending: deps.remote.listPendingPairings(),
  }
}

/**
 * 处理 `/api/remote/*`。命中返回 true,未命中返回 false 交给后续路由。
 *
 * `access` 必须是本次请求已经判定过的结果 —— 这里不再重新鉴权,避免两处
 * 判定不一致导致绕过。
 */
export const handleRemoteApi = async (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  access: AccessDecision,
  deps: RemoteApiDeps,
): Promise<boolean> => {
  if (!pathname.startsWith('/api/remote/')) return false
  const method = req.method ?? 'GET'
  const isLocal = access.kind === 'local'

  /** 只有宿主自己这台机器能调的端点。 */
  const requireLocal = (): boolean => {
    if (isLocal) return true
    deps.apiError(res, 403, 'remote/local-only', '该操作只能在宿主机器上进行')
    return false
  }

  // —— 状态 ——
  if (pathname === '/api/remote/status' && method === 'GET') {
    deps.json(res, 200, statusPayload(deps, access))
    return true
  }

  // —— 开关监听 ——
  if (pathname === '/api/remote/enable' && method === 'POST') {
    if (!requireLocal()) return true
    const body = await deps.readJson(req).catch(emptyBody)
    const rawPort = body.listenPort
    const requestedPort = typeof rawPort === 'number' ? rawPort : undefined
    if (requestedPort !== undefined && (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535)) {
      deps.apiError(res, 400, 'remote/bad-port', '端口必须是 1024–65535 的整数')
      return true
    }
    deps.remote.writeConfig({
      enabled: true,
      ...(requestedPort === undefined ? {} : { listenPort: requestedPort }),
      ...(typeof body.bindHost === 'string' ? { bindHost: body.bindHost } : {}),
      ...(typeof body.publicUrl === 'string' ? { publicUrl: body.publicUrl } : {}),
    })
    try {
      await deps.startListener()
    } catch (error) {
      // 起不来就回滚,否则界面会显示「已开启」而实际没有任何监听。
      deps.remote.writeConfig({ enabled: false })
      await deps.stopListener().catch(() => {})
      deps.apiError(res, 500, 'remote/listen-failed', error instanceof Error ? error.message : String(error))
      return true
    }
    deps.json(res, 200, statusPayload(deps, access))
    return true
  }

  if (pathname === '/api/remote/disable' && method === 'POST') {
    if (!requireLocal()) return true
    const config = deps.remote.readConfig()
    if (deps.tunnel) await deps.tunnel.stop().catch(() => {})
    if (deps.relay) await deps.relay.stop().catch(() => {})
    deps.remote.writeConfig({
      enabled: false,
      ...(config.quickTunnel ? { publicUrl: null, quickTunnel: false } : {}),
    })
    await deps.stopListener()
    deps.json(res, 200, statusPayload(deps, access))
    return true
  }

  // —— 内置公网隧道（Cloudflare Quick Tunnel）——
  if (pathname === '/api/remote/tunnel/start' && method === 'POST') {
    if (!requireLocal()) return true
    if (!deps.tunnel) {
      deps.apiError(res, 501, 'remote/tunnel-unavailable', '当前构建没有内置公网隧道')
      return true
    }
    const state = deps.listener()
    if (!state.listening) {
      deps.apiError(res, 400, 'remote/tunnel-needs-listener', '请先开启远程访问')
      return true
    }
    try {
      const result = await deps.tunnel.start()
      if (!result.url) throw new Error('隧道没有返回公网地址')
      deps.remote.writeConfig({ publicUrl: result.url, quickTunnel: true })
      deps.json(res, 200, statusPayload(deps, access))
    } catch (error) {
      deps.apiError(res, 502, 'remote/tunnel-failed', error instanceof Error ? error.message : String(error))
    }
    return true
  }

  if (pathname === '/api/remote/tunnel/stop' && method === 'POST') {
    if (!requireLocal()) return true
    if (!deps.tunnel) {
      deps.apiError(res, 501, 'remote/tunnel-unavailable', '当前构建没有内置公网隧道')
      return true
    }
    await deps.tunnel.stop().catch(() => {})
    const config = deps.remote.readConfig()
    deps.remote.writeConfig({
      ...(config.quickTunnel ? { publicUrl: null, quickTunnel: false } : {}),
    })
    deps.json(res, 200, statusPayload(deps, access))
    return true
  }

  if (pathname === '/api/remote/tunnel/status' && method === 'GET') {
    if (!requireLocal()) return true
    deps.json(res, 200, {
      tunnel: deps.tunnel?.status() ?? null,
      publicUrl: deps.remote.readConfig().publicUrl,
      quickTunnel: deps.remote.readConfig().quickTunnel,
    })
    return true
  }

  // —— 私有中继（端到端加密） ——
  if (pathname === '/api/remote/relay/start' && method === 'POST') {
    if (!requireLocal()) return true
    if (!deps.relay) {
      deps.apiError(res, 501, 'remote/relay-unavailable', '当前构建没有私有中继')
      return true
    }
    if (!deps.listener().listening) {
      deps.apiError(res, 400, 'remote/relay-needs-listener', '请先开启远程访问')
      return true
    }
    try {
      await deps.relay.start()
      deps.json(res, 200, statusPayload(deps, access))
    } catch (error) {
      deps.apiError(res, 502, 'remote/relay-failed', error instanceof Error ? error.message : String(error))
    }
    return true
  }

  if (pathname === '/api/remote/relay/stop' && method === 'POST') {
    if (!requireLocal()) return true
    if (!deps.relay) {
      deps.apiError(res, 501, 'remote/relay-unavailable', '当前构建没有私有中继')
      return true
    }
    await deps.relay.stop().catch(() => {})
    deps.json(res, 200, statusPayload(deps, access))
    return true
  }

  if (pathname === '/api/remote/relay/status' && method === 'GET') {
    if (!requireLocal()) return true
    deps.json(res, 200, { relay: deps.relay?.status() ?? null })
    return true
  }

  // —— 配对 ——
  if (pathname === '/api/remote/pairing' && method === 'POST') {
    if (!requireLocal()) return true
    const body = await deps.readJson(req).catch(emptyBody)
    const relayCandidate = deps.relay?.pairingCandidate() ?? null
    const directCandidates = deps.remote.pairingCandidates()
    // A private relay is the preferred remote path: it works away from home
    // and the relay cannot read traffic. Direct LAN stays as a fallback.
    const candidates = relayCandidate
      ? [
          relayCandidate,
          ...directCandidates.map((candidate) => ({
            ...candidate,
            priority: candidate.type === 'lan' ? 20 : 30,
          })),
        ]
      : directCandidates
    if (candidates.length === 0) {
      deps.apiError(res, 400, 'remote/no-address', '没有可用的对外地址,请先启用远程访问并确认机器在局域网内')
      return true
    }
    const created = deps.remote.createPairing({
      label: body.label,
      allowedKinds: body.allowedKinds,
    })
    const link = encodePairingLink({
      v: 2,
      pairingId: created.pairing.id,
      secret: created.secret,
      serverId: deps.remote.serverId(),
      fingerprint: created.pairing.fingerprint,
      label: deps.serverLabel(),
      expiresAt: created.pairing.expiresAt,
      candidates,
    })
    // secret 与 code 只在本机响应里出现一次;之后服务端只留摘要。
    deps.json(res, 201, {
      pairing: created.pairing,
      secret: created.secret,
      code: created.code,
      link,
      candidates,
    })
    return true
  }

  if (pathname === '/api/remote/pairings' && method === 'GET') {
    if (!requireLocal()) return true
    deps.json(res, 200, { pending: deps.remote.listPendingPairings() })
    return true
  }

  const pairingMatch = /^\/api\/remote\/pairings\/([^/]+)$/.exec(pathname)
  if (pairingMatch && method === 'DELETE') {
    if (!requireLocal()) return true
    const cancelled = deps.remote.cancelPairing(decodeURIComponent(pairingMatch[1]!))
    if (!cancelled) {
      deps.apiError(res, 404, 'remote/pairing-not-found', '配对会话不存在')
      return true
    }
    deps.json(res, 200, { cancelled: true })
    return true
  }

  // —— 兑换(远程可达,受限流保护)——
  if (pathname === '/api/remote/redeem' && method === 'POST') {
    const body = await deps.readJson(req).catch(emptyBody)
    const link = typeof body.link === 'string' ? body.link.trim() : ''
    // Native clients hand back the whole link the QR encoded. Parsing it here
    // keeps the payload format server-owned; clients never split `p`.
    const parsed = link ? parsePairingLink(link) : null
    if (link && !parsed) {
      deps.apiError(res, 400, 'remote/redeem-failed', '配对码无效或已过期')
      return true
    }
    try {
      const result = deps.remote.redeemPairing({
        pairingId: parsed?.pairingId ?? body.pairingId,
        secret: parsed?.secret ?? body.secret,
        code: parsed ? undefined : body.code,
        label: body.label,
        clientKind: body.clientKind,
        deviceName: body.deviceName,
        devicePlatform: body.devicePlatform,
        appVersion: body.appVersion,
        dedupeKey: body.dedupeKey,
        peerAddress: peerAddress(req),
      })
      res.setHeader('Set-Cookie', deps.remote.buildSessionCookie(req, result.token))
      res.setHeader('Cache-Control', 'no-store')
      deps.json(res, 200, {
        ok: true,
        clientToken: result.token,
        client: result.client,
        server: {
          label: deps.serverLabel(),
          // 回给对端的是它自己打通的那条地址,不是服务端猜的。
          url: `${url.protocol}//${url.host}`,
          fingerprint: result.pairing.fingerprint,
        },
      })
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode === 429 ? 429 : 400
      deps.apiError(res, status, 'remote/redeem-failed', error instanceof Error ? error.message : '配对失败')
    }
    return true
  }

  if (pathname === '/api/remote/logout' && method === 'POST') {
    res.setHeader('Set-Cookie', deps.remote.buildClearCookie(req))
    deps.json(res, 200, { ok: true })
    return true
  }

  // —— 设备台账 ——
  if (pathname === '/api/remote/clients' && method === 'GET') {
    if (!requireLocal()) return true
    deps.json(res, 200, { clients: deps.remote.listClients() })
    return true
  }

  if (pathname === '/api/remote/clients/purge' && method === 'POST') {
    if (!requireLocal()) return true
    deps.json(res, 200, { purged: deps.remote.purgeRevoked() })
    return true
  }

  const clientMatch = /^\/api\/remote\/clients\/([^/]+)$/.exec(pathname)
  if (clientMatch && method === 'DELETE') {
    const targetId = decodeURIComponent(clientMatch[1]!)
    // 远程设备可以「取消自己这台」,但不能碰别人的记录。
    if (!isLocal) {
      if (access.kind !== 'authorized' || access.client.id !== targetId) {
        deps.apiError(res, 403, 'remote/local-only', '设备只能吊销自己的授权')
        return true
      }
    }
    const revoked = deps.remote.revokeClient(targetId)
    if (!revoked) {
      deps.apiError(res, 404, 'remote/client-not-found', '设备不存在')
      return true
    }
    deps.json(res, 200, { revoked: true })
    return true
  }

  deps.apiError(res, 404, 'remote/unknown-route', '未知的远程访问端点')
  return true
}
