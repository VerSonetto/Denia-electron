// 远程访问:配对兑换、令牌鉴权、来源判定与链接编解码。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { IncomingMessage } from 'node:http'

import {
  RemoteRuntime,
  decideAccess,
  encodePairingLink,
  isBlockedForRemote,
  parsePairingLink,
  GENERIC_REDEEM_ERROR,
} from '../src/host/remote.ts'

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'denia-remote-'))
}

function runtime(home = tempHome()): RemoteRuntime {
  return new RemoteRuntime({ home, port: () => 43655, bindHost: () => '127.0.0.1' })
}

/** 只造出 decideAccess 用到的字段,避免依赖真实的 socket。 */
function request(input: {
  remoteAddress?: string
  authorization?: string
  cookie?: string
  host?: string
  forwardedFor?: string
}): IncomingMessage {
  return {
    socket: { remoteAddress: input.remoteAddress ?? '127.0.0.1' },
    headers: {
      ...(input.authorization ? { authorization: input.authorization } : {}),
      ...(input.cookie ? { cookie: input.cookie } : {}),
      ...(input.host ? { host: input.host } : {}),
      ...(input.forwardedFor ? { 'x-forwarded-for': input.forwardedFor } : {}),
    },
  } as unknown as IncomingMessage
}

test('配对兑换得到可用令牌,且配对只能用一次', () => {
  const remote = runtime()
  const { pairing, secret } = remote.createPairing({ label: '我的手机' })

  const redeemed = remote.redeemPairing({
    pairingId: pairing.id,
    secret,
    clientKind: 'mobile',
    deviceName: 'Pixel',
    peerAddress: '192.168.1.20',
  })
  assert.match(redeemed.token, /^denia_client_/)
  assert.equal(redeemed.client.label, '我的手机')
  assert.equal(redeemed.client.clientKind, 'mobile')

  // 令牌立刻可用。
  assert.equal(remote.authenticateToken(redeemed.token)?.id, redeemed.client.id)

  // 同一个配对会话再兑一次必须失败。
  assert.throws(
    () => remote.redeemPairing({ pairingId: pairing.id, secret, peerAddress: '192.168.1.20' }),
    (error: Error) => error.message === GENERIC_REDEEM_ERROR,
  )
})

test('错误密钥、未知会话、过期会话给出同一条错误', () => {
  const remote = runtime()
  const { pairing } = remote.createPairing({})

  assert.throws(
    () => remote.redeemPairing({ pairingId: pairing.id, secret: 'wrong-secret', peerAddress: '10.0.0.5' }),
    (error: Error) => error.message === GENERIC_REDEEM_ERROR,
  )
  assert.throws(
    () => remote.redeemPairing({ pairingId: 'pair_missing', secret: 'x', peerAddress: '10.0.0.6' }),
    (error: Error) => error.message === GENERIC_REDEEM_ERROR,
  )
})

test('手输短码可以兑换,且大小写与分隔符不敏感', () => {
  const remote = runtime()
  const { pairing, code } = remote.createPairing({ label: '平板' })
  assert.match(code, /^[2-9A-HJKMNP-Z]{8}$/)

  const messy = `${code.slice(0, 4)}-${code.slice(4).toLowerCase()}`
  const redeemed = remote.redeemPairing({
    code: messy,
    clientKind: 'mobile',
    peerAddress: '192.168.1.30',
  })
  assert.equal(redeemed.client.label, '平板')
  assert.equal(redeemed.pairing.usedAt !== null, true)
  assert.equal(remote.listPendingPairings().length, 0)
  assert.equal(remote.listClients().length, 1)
})

test('吊销后令牌立即失效；重复配对按去重键只留一条设备', () => {
  const remote = runtime()
  const first = remote.createPairing({ label: '手机' })
  const one = remote.redeemPairing({
    pairingId: first.pairing.id,
    secret: first.secret,
    dedupeKey: 'device-abc',
    peerAddress: '192.168.1.40',
  })
  const second = remote.createPairing({ label: '手机改名' })
  const two = remote.redeemPairing({
    pairingId: second.pairing.id,
    secret: second.secret,
    dedupeKey: 'device-abc',
    peerAddress: '192.168.1.40',
  })

  // 去重键相同:旧记录被替换。本次配对显式给的名字优先于旧名。
  assert.equal(remote.listClients().length, 1)
  assert.equal(two.client.label, '手机改名')
  assert.equal(remote.authenticateToken(one.token), null)

  assert.equal(remote.revokeClient(two.client.id), true)
  assert.equal(remote.authenticateToken(two.token), null)
  assert.equal(remote.purgeRevoked(), 1)
  assert.equal(remote.listClients().length, 0)
})

test('来源判定:回环免鉴权,外部来源必须持令牌或会话 Cookie', () => {
  const remote = runtime()
  const { pairing, secret } = remote.createPairing({})
  const { token } = remote.redeemPairing({
    pairingId: pairing.id,
    secret,
    peerAddress: '192.168.1.50',
  })

  assert.equal(decideAccess(remote, request({ remoteAddress: '127.0.0.1' }), { requireToken: true }).kind, 'local')
  assert.equal(decideAccess(remote, request({ remoteAddress: '::1' }), { requireToken: true }).kind, 'local')
  // 外部来源无凭证。
  assert.equal(
    decideAccess(remote, request({ remoteAddress: '192.168.1.9' }), { requireToken: true }).kind,
    'unauthorized',
  )
  // Bearer。
  assert.equal(
    decideAccess(remote, request({ remoteAddress: '192.168.1.9', authorization: `Bearer ${token}` }), { requireToken: true }).kind,
    'authorized',
  )
  // 会话 Cookie(浏览器 WebView 走这条)。
  const cookieName = 'denia_remote_session_192_168_1_9'
  assert.equal(
    decideAccess(
      remote,
      request({ remoteAddress: '192.168.1.9', host: '192.168.1.9:43656', cookie: `${cookieName}=${token}` }),
      { requireToken: true },
    ).kind,
    'authorized',
  )
  // 伪造令牌。
  assert.equal(
    decideAccess(remote, request({ remoteAddress: '192.168.1.9', authorization: 'Bearer denia_client_forged' }), { requireToken: true }).kind,
    'unauthorized',
  )
})

test('反向代理从回环转发时不冒充本机', () => {
  const remote = runtime()

  // 回环来源 + 公网 Host:这是反代转发的典型形态,必须按远程处理。
  assert.equal(
    decideAccess(remote, request({ remoteAddress: '127.0.0.1', host: 'denia.example.com' }), { requireToken: true }).kind,
    'unauthorized',
  )
  // 回环来源 + 真实来源在 XFF 里。
  assert.equal(
    decideAccess(
      remote,
      request({ remoteAddress: '127.0.0.1', host: '127.0.0.1:43655', forwardedFor: '203.0.113.7' }),
      { requireToken: true },
    ).kind,
    'unauthorized',
  )
  // 回环 Host + 回环 XFF:确实来自本机。
  assert.equal(
    decideAccess(
      remote,
      request({ remoteAddress: '127.0.0.1', host: '127.0.0.1:43655', forwardedFor: '127.0.0.1' }),
      { requireToken: true },
    ).kind,
    'local',
  )
  // 公网来源永远不是本机,哪怕 Host 写成 localhost。
  assert.equal(
    decideAccess(remote, request({ remoteAddress: '203.0.113.7', host: 'localhost' }), { requireToken: true }).kind,
    'unauthorized',
  )
})

test('远程受限面覆盖宿主本地能力', () => {
  assert.equal(isBlockedForRemote('/api/fs/pick'), true)
  assert.equal(isBlockedForRemote('/api/fs/pick-files'), true)
  assert.equal(isBlockedForRemote('/api/open-in-app/open'), true)
  assert.equal(isBlockedForRemote('/api/update/install'), true)
  assert.equal(isBlockedForRemote('/api/browser/command'), true)
  assert.equal(isBlockedForRemote('/api/sessions'), false)
  assert.equal(isBlockedForRemote('/api/llm/chat'), false)
})

test('配对链接往返一致,并拒绝旧版本与缺候选的载荷', () => {
  const link = encodePairingLink({
    v: 2,
    pairingId: 'pair_abc',
    secret: 'sekret',
    serverId: 'deadbeefdeadbeef',
    fingerprint: 'A1B2-C3D4',
    label: '书房电脑',
    candidates: [
      { type: 'tunnel', url: 'https://denia.example.com', priority: 10 },
      { type: 'lan', url: 'http://192.168.1.8:43656', priority: 20 },
    ],
  })
  assert.match(link, /^denia:\/\/connect\?v=2&p=/)
  const parsed = parsePairingLink(link)
  assert.equal(parsed?.pairingId, 'pair_abc')
  assert.equal(parsed?.secret, 'sekret')
  assert.equal(parsed?.fingerprint, 'A1B2-C3D4')
  assert.equal(parsed?.serverId, 'deadbeefdeadbeef')
  assert.equal(parsed?.candidates.length, 2)
  assert.equal(parsed?.candidates[0]?.type, 'tunnel')

  // 旧版本号不再接受。
  assert.equal(parsePairingLink(link.replace('v=2', 'v=1')), null)
  // 非本协议。
  assert.equal(parsePairingLink('openchamber://connect?v=2&p=e30'), null)
  assert.equal(parsePairingLink('denia://connect'), null)

  // 候选为空的载荷视为无效。
  const empty = encodePairingLink({ v: 2, pairingId: 'pair_x', secret: 's', candidates: [] })
  assert.equal(parsePairingLink(empty), null)
})

test('服务器身份稳定且落盘', () => {
  const home = tempHome()
  const first = runtime(home).serverId()
  assert.match(first, /^[0-9a-f]{32}$/)
  // 重启后仍是同一个值:App 靠它判断「还是这台机器」。
  assert.equal(runtime(home).serverId(), first)
  // 另一个数据目录是另一台服务器。
  assert.notEqual(runtime(tempHome()).serverId(), first)
})

test('监听配置读写与端口校验', () => {
  const home = tempHome()
  const remote = runtime(home)
  assert.equal(remote.readConfig().listenPort, 43656)
  assert.equal(remote.readConfig().enabled, false)

  const saved = remote.writeConfig({ enabled: true, listenPort: 50000, publicUrl: 'https://denia.example.com' })
  assert.equal(saved.enabled, true)
  assert.equal(saved.listenPort, 50000)

  // 非法端口回落而不是写坏配置。
  const fallback = remote.writeConfig({ listenPort: 70000 })
  assert.equal(fallback.listenPort, 50000)

  // 重新打开后仍然读得回来。
  const reopened = runtime(home)
  assert.equal(reopened.readConfig().enabled, true)
  assert.equal(reopened.readConfig().publicUrl, 'https://denia.example.com')
})
