// 远程监听的端到端行为:本机不受影响、远程必须持令牌、配对在远程口上可兑换。
//
// 用本机的局域网地址回连自己来制造「非回环来源」——操作系统把这条连接的
// 源地址填成网卡地址,服务端因此按远程请求处理。没有可用网卡时跳过。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startHost } from '../src/host/server.ts'

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'denia-host-remote-'))
}

function lanIPv4(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')) {
        return entry.address
      }
    }
  }
  return null
}

/** 找一个空闲端口:绑 0 拿到系统分配的号,再立刻释放。 */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:http')
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const address = probe.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

test('远程监听:本机免鉴权、远程需令牌、配对可兑换', async (t) => {
  const lan = lanIPv4()
  if (!lan) {
    t.skip('没有可用的局域网 IPv4 地址')
    return
  }
  const home = tempHome()
  const webDir = path.join(home, 'web')
  fs.mkdirSync(webDir, { recursive: true })
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>test</title>', 'utf8')

  const listenPort = await freePort()
  const host = await startHost({ home, webDir, port: 0 })
  try {
    // 本机(回环)连接:改造前后行为一致,不需要任何凭证。
    const localHealth = await fetch(`${host.baseUrl}/api/sessions`)
    assert.equal(localHealth.status, 200)

    // 打开远程监听。
    const enabled = await fetch(`${host.baseUrl}/api/remote/enable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listenPort, bindHost: '0.0.0.0' }),
    })
    assert.equal(enabled.status, 200)
    const status = (await enabled.json()) as { enabled: boolean; listening: boolean; listenPort: number }
    assert.equal(status.enabled, true)
    assert.equal(status.listening, true)
    assert.equal(status.listenPort, listenPort)

    const remoteBase = `http://${lan}:${listenPort}`

    // 界面本身必须能远程加载,否则设备连输入配对码的机会都没有。
    const shell = await fetch(`${remoteBase}/`)
    assert.equal(shell.status, 200)
    assert.match(shell.headers.get('content-type') ?? '', /text\/html/)

    // 远程口:未认证的 API 一律 401。
    const denied = await fetch(`${remoteBase}/api/sessions`)
    assert.equal(denied.status, 401)
    const deniedBody = (await denied.json()) as { error: { code: string } }
    assert.equal(deniedBody.error.code, 'remote/unauthorized')

    // /api/remote/status 允许匿名读,但不泄漏设备清单与内网拓扑。
    const remoteStatus = await fetch(`${remoteBase}/api/remote/status`)
    assert.equal(remoteStatus.status, 200)
    const statusBody = (await remoteStatus.json()) as {
      local: boolean
      authenticated: boolean
      clients?: unknown
      addresses?: { lan: string[] }
    }
    assert.equal(statusBody.local, false)
    assert.equal(statusBody.authenticated, false)
    // 未认证也能读到 serverId:App 要先核对身份,再决定要不要发令牌。
    assert.match((statusBody as { serverId?: string }).serverId ?? '', /^[0-9a-f]{32}$/)
    assert.equal(statusBody.clients, undefined)
    assert.deepEqual(statusBody.addresses, { lan: [], publicUrl: null })

    // 未认证的远程来源连这些端点都进不去(401 早于 403)。
    const unauthEnable = await fetch(`${remoteBase}/api/remote/enable`, { method: 'POST' })
    assert.equal(unauthEnable.status, 401)

    // 本机建配对,拿到链接与短码。
    const created = await fetch(`${host.baseUrl}/api/remote/pairing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: '测试手机' }),
    })
    assert.equal(created.status, 201)
    const pairing = (await created.json()) as {
      secret: string
      code: string
      link: string
      pairing: { id: string; fingerprint: string }
      candidates: { type: string; url: string }[]
    }
    assert.match(pairing.link, /^denia:\/\/connect\?v=2&p=/)
    assert.ok(pairing.candidates.some((candidate) => candidate.type === 'lan'))

    // 远程口兑换:带上短码即可,不需要先认证。
    const redeemed = await fetch(`${remoteBase}/api/remote/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingId: pairing.pairing.id, secret: pairing.secret, clientKind: 'mobile' }),
    })
    assert.equal(redeemed.status, 200)
    const session = (await redeemed.json()) as { clientToken: string }
    assert.match(session.clientToken, /^denia_client_/)

    // 兑换时种下的会话 Cookie 同样能通过(浏览器 WebView 走这条)。
    const setCookie = redeemed.headers.get('set-cookie') ?? ''
    const cookiePair = setCookie.split(';')[0] ?? ''
    assert.match(cookiePair, /^denia_remote_session/)
    const viaCookie = await fetch(`${remoteBase}/api/sessions`, { headers: { cookie: cookiePair } })
    assert.equal(viaCookie.status, 200)

    // 带令牌后远程口可用。
    const allowed = await fetch(`${remoteBase}/api/sessions`, {
      headers: { authorization: `Bearer ${session.clientToken}` },
    })
    assert.equal(allowed.status, 200)

    // 已认证的远程设备仍然不能管理宿主:开监听、看设备清单一律 403。
    const forbidden = await fetch(`${remoteBase}/api/remote/enable`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.clientToken}` },
    })
    assert.equal(forbidden.status, 403)
    const clientsForbidden = await fetch(`${remoteBase}/api/remote/clients`, {
      headers: { authorization: `Bearer ${session.clientToken}` },
    })
    assert.equal(clientsForbidden.status, 403)

    // 远程受限面仍然拒绝,即使已经认证。
    const blocked = await fetch(`${remoteBase}/api/fs/pick`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.clientToken}`, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(blocked.status, 403)
    const blockedBody = (await blocked.json()) as { error: { code: string } }
    assert.equal(blockedBody.error.code, 'remote/blocked')

    // 吊销后立刻回到 401。设备可以从远程吊销自己。
    const clients = (await (await fetch(`${host.baseUrl}/api/remote/clients`)).json()) as {
      clients: { id: string }[]
    }
    assert.equal(clients.clients.length, 1)
    const selfId = clients.clients[0]!.id
    const revoked = await fetch(`${remoteBase}/api/remote/clients/${selfId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${session.clientToken}` },
    })
    assert.equal(revoked.status, 200)
    const afterRevoke = await fetch(`${remoteBase}/api/sessions`, {
      headers: { authorization: `Bearer ${session.clientToken}` },
    })
    assert.equal(afterRevoke.status, 401)

    // 关闭远程:端口不再接受连接。
    const disabled = await fetch(`${host.baseUrl}/api/remote/disable`, { method: 'POST' })
    assert.equal(disabled.status, 200)
    await assert.rejects(fetch(`${remoteBase}/api/remote/status`))
  } finally {
    await host.close()
  }
})
