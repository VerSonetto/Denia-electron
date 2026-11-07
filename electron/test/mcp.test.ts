// MCP subsystem tests: stdio/HTTP transports, pagination identity, host API,
// lazy tool loading and the mcp_list catalog.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startHost } from '../src/host/server.ts'
import { McpManager } from '../src/mcp/manager.ts'
import { normalizeServerConfig, qualifyToolName } from '../src/mcp/config.ts'
import type { McpServerConfig } from '../src/mcp/config.ts'
import { startMockGateway, lastToolContents, writeConfig } from './helpers/mock-gateway.ts'
import type { Envelope } from '../src/core/wire.ts'

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures', 'mcp-stdio-server.mjs')

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function stdioConfig(): McpServerConfig {
  return normalizeServerConfig({
    id: 'fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
  })
}

async function waitFor<T>(fn: () => Promise<T | null> | T | null, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value !== null && value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('condition not met in time')
}

async function snapshotOf(baseURL: string, sessionId: string): Promise<Envelope[]> {
  const response = await fetch(`${baseURL}/api/sessions/${sessionId}`)
  const body = (await response.json()) as { events: Envelope[] }
  return body.events
}

test('stdio MCP: handshake, catalog, pagination identity and result cache', async () => {
  const manager = new McpManager(['bash', 'read_file'])
  const config = stdioConfig()
  await manager.reload([config])
  const snapshot = manager.snapshot()
  assert.equal(snapshot.servers.length, 1)
  assert.equal(snapshot.servers[0]?.status, 'connected')
  assert.ok(snapshot.hasConnected())
  const names = snapshot.toolNames()
  assert.ok(names.includes('mcp__fixture__echo'), names.join(','))
  assert.ok(names.includes('mcp__fixture__quirky_name_v2'), names.join(','))
  assert.ok(!names.includes('mcp__fixture__missing'))

  const echo = await manager.callPaged({
    qualified: 'mcp__fixture__echo',
    arguments: { text: 'hi' },
    offset: 0,
    limit: 100,
    legacyResume: false,
    session: 's1',
  })
  assert.equal(echo.text, 'echo:hi')
  assert.equal(echo.isError, false)
  assert.ok(echo.resultId)

  const firstPage = await manager.callPaged({
    qualified: 'mcp__fixture__big',
    arguments: {},
    offset: 0,
    limit: 10,
    legacyResume: false,
    session: 's1',
  })
  assert.equal(firstPage.text, '0123456789')
  assert.equal(firstPage.totalChars, 20_000)
  assert.equal(firstPage.hasMore, true)
  assert.ok(firstPage.resultId)

  const secondPage = await manager.callPaged({
    qualified: 'mcp__fixture__big',
    arguments: {},
    offset: 10,
    limit: 10,
    ...(firstPage.resultId ? { resultId: firstPage.resultId } : {}),
    legacyResume: false,
    session: 's1',
  })
  assert.equal(secondPage.text, '0123456789')
  assert.equal(secondPage.fromCache, true)

  const firstCount = await manager.callPaged({
    qualified: 'mcp__fixture__count',
    arguments: {},
    offset: 0,
    limit: 100,
    legacyResume: false,
    session: 's1',
  })
  const secondCount = await manager.callPaged({
    qualified: 'mcp__fixture__count',
    arguments: {},
    offset: 0,
    limit: 100,
    legacyResume: false,
    session: 's1',
  })
  assert.equal(firstCount.text, 'count:1')
  assert.equal(secondCount.text, 'count:2', 'a call without a token must really execute')
  const resumed = await manager.callPaged({
    qualified: 'mcp__fixture__count',
    arguments: {},
    offset: 0,
    limit: 100,
    ...(firstCount.resultId ? { resultId: firstCount.resultId } : {}),
    legacyResume: false,
    session: 's1',
  })
  assert.equal(resumed.text, 'count:1', 'a token must resume the original result, not re-run')

  const failed = await manager.callPaged({
    qualified: 'mcp__fixture__fail',
    arguments: {},
    offset: 0,
    limit: 100,
    legacyResume: false,
    session: 's1',
  })
  assert.equal(failed.isError, true)
  assert.equal(failed.text, 'boom')

  const quirky = await manager.callPaged({
    qualified: 'mcp__fixture__quirky_name_v2',
    arguments: {},
    offset: 0,
    limit: 100,
    legacyResume: false,
    session: 's1',
  })
  assert.ok(quirky.text.includes('quirky'))
  assert.ok(quirky.text.includes('不支持回传图片'))
  assert.ok(quirky.text.includes('file:///a.txt'))

  await manager.shutdownAll()
  assert.equal(manager.snapshot().servers.length, 0)
})

test('HTTP MCP: session id, JSON responses and DELETE on shutdown', async () => {
  const sessions: string[] = []
  let deleted = 0
  const server = http.createServer((req, res) => {
    if (req.method === 'DELETE') {
      deleted += 1
      res.writeHead(200)
      res.end()
      return
    }
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const session = req.headers['mcp-session-id']
      if (typeof session === 'string') sessions.push(session)
      const message = JSON.parse(raw) as { id?: number; method?: string; params?: unknown }
      const reply = (result: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      }
      if (message.method === 'initialize') {
        res.setHeader('mcp-session-id', 'session-1')
        reply({ protocolVersion: '2024-11-05', capabilities: {} })
        return
      }
      if (message.method === 'notifications/initialized') {
        res.writeHead(202)
        res.end()
        return
      }
      if (message.method === 'tools/list') {
        reply({
          tools: [
            {
              name: 'http_echo',
              description: 'http echo',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            },
          ],
        })
        return
      }
      if (message.method === 'tools/call') {
        const params = message.params as { name: string; arguments: { text?: string } }
        reply({ content: [{ type: 'text', text: `http:${params.arguments.text ?? ''}` }] })
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const manager = new McpManager()
  const config = normalizeServerConfig({
    id: 'web',
    transport: 'http',
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { Authorization: 'Bearer test' },
  })
  await manager.reload([config])
  const snapshot = manager.snapshot()
  assert.equal(snapshot.servers[0]?.status, 'connected')
  assert.deepEqual(snapshot.toolNames(), ['mcp__web__http_echo'])
  const result = await manager.callPaged({
    qualified: 'mcp__web__http_echo',
    arguments: { text: 'ok' },
    offset: 0,
    limit: 100,
    legacyResume: false,
    session: 's1',
  })
  assert.equal(result.text, 'http:ok')
  assert.ok(sessions.includes('session-1'), `session id was not echoed back: ${sessions.join(',')}`)
  await manager.shutdownAll()
  assert.equal(deleted, 1)
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('host MCP API + agent loop: mcp_list, lazy loading and execution', async () => {
  const home = tempDir('denia-mcp-home-')
  const cwd = tempDir('denia-mcp-cwd-')
  const webDir = tempDir('denia-mcp-web-')
  const mock = await startMockGateway((request) => {
    const tools = lastToolContents(request)
    if (tools.some((content) => content.includes('echo:hello'))) {
      return { text: 'mcp done' }
    }
    if (tools.some((content) => content.includes('尚未加载参数定义'))) {
      return {
        calls: [{ name: 'mcp__fixture__echo', arguments: { text: 'hello' } }],
      }
    }
    if (tools.some((content) => content.includes('mcp__fixture__echo —'))) {
      return { calls: [{ name: 'mcp__fixture__echo', arguments: { text: 'hello' } }] }
    }
    return { calls: [{ name: 'mcp_list', arguments: {} }] }
  })
  fs.writeFileSync(
    path.join(home, 'settings.yaml'),
    JSON.stringify({
      mcp: {
        servers: [
          {
            id: 'fixture',
            transport: 'stdio',
            command: process.execPath,
            args: [FIXTURE],
            enabled: true,
          },
        ],
      },
    }),
  )
  writeConfig(home, mock.baseURL)
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const describe = (await waitFor(async () => {
      const response = await fetch(`${host.baseUrl}/api/mcp`)
      const body = (await response.json()) as {
        servers: { status: string; tools: { name: string }[] }[]
        toolCount: number
      }
      return body.servers[0]?.status === 'connected' ? body : null
    })) as unknown as { servers: { tools: { name: string; qualified: string }[] }[]; toolCount: number }
    assert.equal(describe.servers.length, 1)
    assert.equal(describe.toolCount, 5)
    assert.ok(describe.servers[0]?.tools.some((tool) => tool.qualified === 'mcp__fixture__echo'))

    // Disabling a tool only filters, it must not reconnect.
    const disabled = await fetch(`${host.baseUrl}/api/mcp/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server: 'fixture', tool: 'fail', enabled: false }),
    })
    const disabledBody = (await disabled.json()) as {
      toolCount: number
      servers: { tools: { name: string; enabled: boolean; disabledReason?: string }[] }[]
    }
    assert.equal(disabledBody.toolCount, 4)
    const fail = disabledBody.servers[0]?.tools.find((tool) => tool.name === 'fail')
    assert.equal(fail?.enabled, false)
    assert.match(fail?.disabledReason ?? '', /设置中关闭/)

    // A disabled server exposes no tools and does not run.
    const off = await fetch(`${host.baseUrl}/api/mcp/servers/fixture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'disable' }),
    })
    const offBody = (await off.json()) as { toolCount: number; servers: { status: string }[] }
    assert.equal(offBody.toolCount, 0)
    assert.equal(offBody.servers[0]?.status, 'disabled')
    const on = await fetch(`${host.baseUrl}/api/mcp/servers/fixture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'enable' }),
    })
    const onBody = (await on.json()) as { toolCount: number; servers: { status: string }[] }
    assert.equal(onBody.servers[0]?.status, 'connected')
    assert.equal(onBody.toolCount, 4)

    const created = await fetch(`${host.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd }),
    })
    const { session } = (await created.json()) as { session: { id: string } }
    await fetch(`${host.baseUrl}/api/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '用外部工具', provider: 'mock', model: 'mock-1' }),
    })
    const events = await waitFor(async () => {
      const snapshot = await snapshotOf(host.baseUrl, session.id)
      return snapshot.some((event) => event.type === 'turn-end') ? snapshot : null
    })
    const results = events.filter(
      (event): event is Extract<Envelope, { type: 'tool-result' }> => event.type === 'tool-result',
    )
    const list = results.find((event) => event.content.includes('mcp__fixture__echo —'))
    assert.ok(list, 'mcp_list must expose connected tools')
    const load = results.find((event) => event.content.includes('尚未加载参数定义'))
    assert.ok(load, 'the first call must return the schema instead of executing')
    assert.match(load?.content ?? '', /"text"/)
    const executed = results.filter((event) => event.content.includes('echo:hello'))
    assert.equal(executed.length, 1, 'the second call must execute against the server')
  } finally {
    await host.close()
    await mock.close()
  }
})
test('SSE MCP: endpoint event, POST message channel and shutdown', async () => {
  let stream: http.ServerResponse | null = null
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/sse') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write('event: endpoint\ndata: /message?sessionId=abc\n\n')
      stream = res
      return
    }
    if (req.method === 'POST' && url.pathname === '/message') {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        const message = JSON.parse(raw) as { id?: number; method?: string; params?: unknown }
        res.writeHead(202)
        res.end()
        if (!stream) return
        const reply = (result: unknown): void => {
          stream?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`)
        }
        if (message.method === 'initialize') {
          reply({ protocolVersion: '2024-11-05', capabilities: {} })
        } else if (message.method === 'tools/list') {
          reply({
            tools: [
              {
                name: 'sse_echo',
                description: 'sse echo',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          })
        } else if (message.method === 'tools/call') {
          reply({ content: [{ type: 'text', text: 'sse:ok' }] })
        }
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const manager = new McpManager()
  await manager.reload([
    normalizeServerConfig({
      id: 'sse',
      transport: 'sse',
      url: `http://127.0.0.1:${port}/sse`,
    }),
  ])
  const snapshot = manager.snapshot()
  assert.equal(snapshot.servers[0]?.status, 'connected')
  assert.deepEqual(snapshot.toolNames(), ['mcp__sse__sse_echo'])
  const result = await manager.callPaged({
    qualified: 'mcp__sse__sse_echo',
    arguments: {},
    offset: 0,
    limit: 100,
    legacyResume: false,
    session: 's1',
  })
  assert.equal(result.text, 'sse:ok')
  await manager.shutdownAll()
  ;(stream as http.ServerResponse | null)?.end()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
