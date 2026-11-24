// /api/llm/chat: the streaming endpoint behind prompt optimization and the
// settings connectivity probe. It must emit the shared StreamChunk vocabulary
// on `data:` frames and report upstream failures as one named `error` frame.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startHost } from '../src/host/server.ts'
import type { Host } from '../src/host/server.ts'
import { startMockGateway, writeConfig } from './helpers/mock-gateway.ts'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

async function chat(host: Host, body: unknown): Promise<Response> {
  return fetch(`${host.baseUrl}/api/llm/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('chat streams chunks for a messages request and forwards the system prompt', async () => {
  const home = tempDir('denia-llm-chat-home-')
  const webDir = tempDir('denia-llm-chat-web-')
  const gateway = await startMockGateway(() => ({ text: '改写后的提示词' }))
  writeConfig(home, gateway.baseURL)
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const response = await chat(host, {
      provider: 'mock',
      model: 'mock-1',
      system: '只输出改写结果',
      messages: [{ role: 'user', content: '帮我改一下' }],
    })
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /"type":"text-delta"/)
    assert.match(body, /改写后的提示词/)
    assert.match(body, /"type":"finish"/)
    // 心跳帧混在流里也无害:前端解析器忽略未知 type。
    const request = gateway.requests.at(-1)
    assert.ok(request)
    assert.deepEqual(request.messages[0], { role: 'system', content: '只输出改写结果' })
    assert.deepEqual(request.messages[1], { role: 'user', content: '帮我改一下' })
  } finally {
    await host.close()
    await gateway.close()
  }
})

test('chat accepts the single-prompt form used by the connectivity probe', async () => {
  const home = tempDir('denia-llm-probe-home-')
  const webDir = tempDir('denia-llm-probe-web-')
  const gateway = await startMockGateway(() => ({ text: 'pong' }))
  writeConfig(home, gateway.baseURL)
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const response = await chat(host, {
      provider: 'mock',
      model: 'mock-1',
      prompt: 'ping',
      max_tokens: 16,
    })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /pong/)
    const request = gateway.requests.at(-1)
    assert.ok(request)
    assert.deepEqual(request.messages.at(-1), { role: 'user', content: 'ping' })
  } finally {
    await host.close()
    await gateway.close()
  }
})

test('chat rejects incomplete or unknown selections before streaming', async () => {
  const home = tempDir('denia-llm-bad-home-')
  const webDir = tempDir('denia-llm-bad-web-')
  const gateway = await startMockGateway(() => ({ text: 'unused' }))
  writeConfig(home, gateway.baseURL)
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const missing = await chat(host, { provider: 'mock', prompt: 'x' })
    assert.equal(missing.status, 400)
    assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'chat/incomplete')

    const provider = await chat(host, { provider: 'nope', model: 'm', prompt: 'x' })
    assert.equal(provider.status, 400)
    assert.equal(
      ((await provider.json()) as { error: { code: string } }).error.code,
      'chat/unknown-provider',
    )

    const model = await chat(host, { provider: 'mock', model: 'missing', prompt: 'x' })
    assert.equal(model.status, 400)
    assert.equal(
      ((await model.json()) as { error: { code: string } }).error.code,
      'chat/unknown-model',
    )

    const empty = await chat(host, { provider: 'mock', model: 'mock-1' })
    assert.equal(empty.status, 400)
    assert.equal(((await empty.json()) as { error: { code: string } }).error.code, 'chat/empty')
    assert.equal(gateway.requests.length, 0)
  } finally {
    await host.close()
    await gateway.close()
  }
})

test('an upstream failure after the stream started arrives as an error frame', async () => {
  const home = tempDir('denia-llm-fail-home-')
  const webDir = tempDir('denia-llm-fail-web-')
  const upstream = http.createServer((req, res) => {
    req.resume()
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        error: { message: 'bad key', type: 'invalid_request_error', code: 'invalid_api_key' },
      }),
    )
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  const port = typeof address === 'object' && address ? address.port : 0
  writeConfig(home, `http://127.0.0.1:${port}/v1`)
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const response = await chat(host, { provider: 'mock', model: 'mock-1', prompt: 'x' })
    // 头已经发出去了,所以握手失败只能走流内 error 帧。
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /event: error/)
    assert.match(body, /"code":"invalid_api_key"/)
    assert.match(body, /bad key/)
  } finally {
    await host.close()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})
