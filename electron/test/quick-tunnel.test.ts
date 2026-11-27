import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { QuickTunnel, parseQuickTunnelUrl, tunnelLogIndicatesDead } from '../src/host/quick-tunnel.ts'

test('解析 cloudflared 的快速隧道地址', () => {
  const log = [
    '2026-11-26T15:29:12Z INF +--------------------------------------------------------------------------------------------+',
    '2026-11-26T15:29:12Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
    '2026-11-26T15:29:12Z INF |  https://interactive-phones-assured-hurricane.trycloudflare.com                            |',
    '2026-11-26T15:29:12Z INF +--------------------------------------------------------------------------------------------+',
  ].join('\n')
  assert.equal(
    parseQuickTunnelUrl(log),
    'https://interactive-phones-assured-hurricane.trycloudflare.com',
  )
  assert.equal(parseQuickTunnelUrl('no url here'), null)
  assert.equal(parseQuickTunnelUrl('https://example.com'), null)
})

test('没有状态文件时报告 idle，且不误报公网地址', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-quick-tunnel-'))
  const tunnel = new QuickTunnel({
    home,
    targetPort: () => 0,
    serverId: () => 'server-1',
  })
  const status = tunnel.status()
  assert.equal(status.state, 'idle')
  assert.equal(status.url, null)
  assert.equal(status.pid, null)
  assert.equal(status.targetPort, null)
})

test('未启动监听时 start 明确失败', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-quick-tunnel-'))
  const tunnel = new QuickTunnel({
    home,
    targetPort: () => 0,
    serverId: () => 'server-1',
  })
  await assert.rejects(() => tunnel.start(), /远程监听尚未启动/)
})


test('Cloudflare 删除快速隧道后能从日志识别', () => {
  assert.equal(
    tunnelLogIndicatesDead('INF Registered tunnel connection connIndex=0'),
    false,
  )
  assert.equal(
    tunnelLogIndicatesDead([
      'INF Registered tunnel connection connIndex=0',
      'ERR Register tunnel error from server side error="Unauthorized: Tunnel not found"',
      'INF Retrying connection in up to 32s',
    ].join('\n')),
    true,
  )
  // It recovered after the error: a later registration line wins.
  assert.equal(
    tunnelLogIndicatesDead([
      'ERR Register tunnel error from server side error="Unauthorized: Tunnel not found"',
      'INF Registered tunnel connection connIndex=0',
    ].join('\n')),
    false,
  )
})
