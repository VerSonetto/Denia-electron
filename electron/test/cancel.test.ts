// Cancellation test: pressing stop must close the turn even while the model
// stream is still open, without waiting for the provider to finish.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startHost } from '../src/host/server.ts'
import type { Envelope } from '../src/core/wire.ts'

interface MockGateway {
  baseURL: string
  close(): Promise<void>
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** A provider that accepts the request and then keeps the stream open. */
async function startHangingGateway(): Promise<MockGateway> {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-1' }] }))
      return
    }
    if (!req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write(sseChunk({ choices: [{ index: 0, delta: { role: 'assistant' } }] }))
    // Never call res.end(): the model is "still thinking" until the turn is
    // cancelled (which closes this socket from the client side).
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** A provider that asks for a long-running bash command. */
async function startToolGateway(): Promise<MockGateway> {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-1' }] }))
      return
    }
    if (!req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const write = (payload: unknown) => res.write(sseChunk(payload))
    write({ choices: [{ index: 0, delta: { role: 'assistant' } }] })
    write({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_sleep',
                type: 'function',
                function: {
                  name: 'bash',
                  arguments: JSON.stringify({
                    command: 'node -e "setTimeout(() => {}, 30000)"',
                  }),
                },
              },
            ],
          },
        },
      ],
    })
    write({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

async function startHostWith(home: string, webDir: string, mock: MockGateway) {
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      providers: [
        {
          id: 'mock',
          name: 'Mock',
          baseURL: mock.baseURL,
          protocol: 'openai-completions',
          models: [{ id: 'mock-1', name: 'Mock 1' }],
        },
      ],
      default: { provider: 'mock', model: 'mock-1' },
    }),
  )
  return startHost({ home, webDir, port: 0 })
}

async function eventsOf(baseUrl: string, sessionId: string): Promise<Envelope[]> {
  const response = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
  const snapshot = (await response.json()) as { events: Envelope[] }
  return snapshot.events
}

async function waitForType(
  baseUrl: string,
  sessionId: string,
  type: string,
  timeoutMs: number,
): Promise<Envelope[]> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = await eventsOf(baseUrl, sessionId)
    if (events.some((event) => event.type === type)) return events
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${type}`)
}

test('stop closes a turn whose model stream is still open', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-cancel-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-cancel-cwd-'))
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-cancel-web-'))
  const mock = await startHangingGateway()
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      providers: [
        {
          id: 'mock',
          name: 'Mock',
          baseURL: mock.baseURL,
          protocol: 'openai-completions',
          models: [{ id: 'mock-1', name: 'Mock 1' }],
        },
      ],
      default: { provider: 'mock', model: 'mock-1' },
    }),
  )
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const created = await fetch(`${host.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd }),
    })
    const { session } = (await created.json()) as { session: { id: string } }

    const prompted = await fetch(`${host.baseUrl}/api/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '保持流式输出', provider: 'mock', model: 'mock-1' }),
    })
    assert.equal(prompted.status, 202)
    await waitForType(host.baseUrl, session.id, 'request-context', 10_000)

    const cancelledAt = Date.now()
    const cancelled = await fetch(`${host.baseUrl}/api/sessions/${session.id}/cancel`, {
      method: 'POST',
    })
    assert.equal(cancelled.status, 200)

    const events = await waitForType(host.baseUrl, session.id, 'turn-end', 5_000)
    assert.ok(
      Date.now() - cancelledAt < 3_000,
      `turn-end took ${Date.now() - cancelledAt}ms after cancel`,
    )
    const end = events.find((event) => event.type === 'turn-end') as { reason: unknown }
    assert.deepEqual(end.reason, { kind: 'aborted', cause: { kind: 'user' } })
  } finally {
    await host.close()
    await mock.close()
  }
})

test('stop closes a turn while a long-running tool is in flight', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-cancel-tool-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-cancel-tool-cwd-'))
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-cancel-tool-web-'))
  const mock = await startToolGateway()
  const host = await startHostWith(home, webDir, mock)
  try {
    const created = await fetch(`${host.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd }),
    })
    const { session } = (await created.json()) as { session: { id: string } }

    const prompted = await fetch(`${host.baseUrl}/api/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '跑一个长命令', provider: 'mock', model: 'mock-1' }),
    })
    assert.equal(prompted.status, 202)
    await waitForType(host.baseUrl, session.id, 'tool-call', 10_000)

    const cancelledAt = Date.now()
    const cancelled = await fetch(`${host.baseUrl}/api/sessions/${session.id}/cancel`, {
      method: 'POST',
    })
    assert.equal(cancelled.status, 200)

    const events = await waitForType(host.baseUrl, session.id, 'turn-end', 5_000)
    assert.ok(
      Date.now() - cancelledAt < 3_000,
      `turn-end took ${Date.now() - cancelledAt}ms after cancel`,
    )
    const end = events.find((event) => event.type === 'turn-end') as { reason: unknown }
    assert.deepEqual(end.reason, { kind: 'aborted', cause: { kind: 'user' } })

    const result = events.find(
      (event) => event.type === 'tool-result' && (event as { call_id: string }).call_id === 'call_sleep',
    ) as { is_error: boolean; content: string } | undefined
    assert.ok(result, 'the interrupted tool still needs a tool-result event')
    assert.equal(result.is_error, true)
    assert.match(result.content, /中断/)
  } finally {
    await host.close()
    await mock.close()
  }
})