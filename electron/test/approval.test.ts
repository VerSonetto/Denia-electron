// Approval pipeline: the HTTP host parks a prompt, the bridge settles it, and
// the driver either runs, rejects, caches the grant, or aborts the turn.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { ApprovalAnswer, ApprovalBridge, ApprovalRequest } from '../src/agent/gate.ts'
import type { Reviewer } from '../src/agent/reviewer.ts'
import type { Envelope } from '../src/core/wire.ts'
import { startHost } from '../src/host/server.ts'

interface MockGateway {
  baseURL: string
  /** Number of requests seen, and the tool schema names of the last one. */
  seen: { count: number; toolNames: string[] }
  close(): Promise<void>
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** A gateway that emits a bash tool call until `calls` tool results arrived. */
async function startMockGateway(calls = 1): Promise<MockGateway> {
  const seen = { count: 0, toolNames: [] as string[] }
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
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      let body: { messages?: { role: string; content?: unknown }[]; tools?: { function?: { name?: string } }[] } = {}
      try {
        body = JSON.parse(raw) as typeof body
      } catch {
        /* ignore */
      }
      seen.count += 1
      seen.toolNames = (body.tools ?? []).map((tool) => tool.function?.name ?? '')
      const toolResults = (body.messages ?? []).filter((message) => message.role === 'tool').length

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const write = (payload: unknown) => res.write(sseChunk(payload))
      write({ choices: [{ index: 0, delta: { role: 'assistant' } }] })
      if (toolResults < calls) {
        write({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_bash_${toolResults + 1}`,
                    type: 'function',
                    function: {
                      name: 'bash',
                      arguments: JSON.stringify({ command: 'echo hi > out.txt' }),
                    },
                  },
                ],
              },
            },
          ],
        })
        write({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        write({ choices: [{ index: 0, delta: { content: '完成。' } }] })
        write({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      }
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

class FakeBridge implements ApprovalBridge {
  readonly requests: ApprovalRequest[] = []
  private readonly decide: (request: ApprovalRequest) => ApprovalAnswer
  constructor(decide: (request: ApprovalRequest) => ApprovalAnswer) {
    this.decide = decide
  }
  async request(request: ApprovalRequest): Promise<ApprovalAnswer> {
    this.requests.push(request)
    return this.decide(request)
  }
}

async function waitForTurnEnd(baseURL: string, sessionId: string): Promise<Envelope[]> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const response = await fetch(`${baseURL}/api/sessions/${sessionId}`)
    const snapshot = (await response.json()) as { events: Envelope[] }
    if (snapshot.events.some((event) => event.type === 'turn-end')) return snapshot.events
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('turn did not finish in time')
}

interface Harness {
  home: string
  cwd: string
  sessionId: string
  baseUrl: string
  close(): Promise<void>
}

async function startHarness(
  options: { bridge?: ApprovalBridge; reviewer?: Reviewer; legacyMode?: string; calls?: number } = {},
): Promise<Harness> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-perm-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-perm-cwd-'))
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-perm-web-'))
  const mock = await startMockGateway(options.calls ?? 1)
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
  const host = await startHost({
    home,
    webDir,
    port: 0,
    ...(options.bridge ? { bridge: options.bridge } : {}),
    ...(options.reviewer ? { reviewer: options.reviewer } : {}),
  })
  const created = await fetch(`${host.baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd }),
  })
  assert.equal(created.status, 201)
  const { session } = (await created.json()) as { session: { id: string } }
  if (options.legacyMode) {
    const changed = await fetch(`${host.baseUrl}/api/sessions/${session.id}/permission`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: options.legacyMode }),
    })
    assert.equal(changed.status, 200)
  }
  return {
    home,
    cwd,
    sessionId: session.id,
    baseUrl: host.baseUrl,
    async close() {
      await host.close()
      await mock.close()
    },
  }
}

async function prompt(harness: Harness, baseURL: string, text = '改个文件'): Promise<Envelope[]> {
  const host = await hostFor(harness)
  const prompted = await fetch(`${host}/api/sessions/${harness.sessionId}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: text, provider: 'mock', model: 'mock-1' }),
  })
  assert.equal(prompted.status, 202)
  return waitForTurnEnd(host, harness.sessionId)
}

/** The host URL is not kept on the harness; stash it on the object. */
const hostUrls = new WeakMap<Harness, string>()
async function hostFor(harness: Harness): Promise<string> {
  const url = hostUrls.get(harness)
  if (!url) throw new Error('harness host url missing')
  return url
}

test('workspace-write asks, allow-once runs the command', async () => {
  const bridge = new FakeBridge(() => ({ choice: 'accept' }))
  const harness = await startHarness({ bridge })
  const host = await startHostFor(harness)
  hostUrls.set(harness, host)
  try {
    const events = await prompt(harness, host)
    assert.equal(bridge.requests.length, 1)
    assert.equal(bridge.requests[0]?.tool, 'bash')
    assert.deepEqual(bridge.requests[0]?.availableDecisions, [
      'accept',
      'accept-for-session',
      'accept-with-rule',
      'decline',
      'cancel',
    ])
    const asked = events.find((event) => event.type === 'approval-asked')
    assert.ok(asked, 'approval-asked must be logged')
    const decided = events.find((event) => event.type === 'approval-decided') as
      | { outcome: string }
      | undefined
    assert.equal(decided?.outcome, 'allowed-once')
    const result = events.find((event) => event.type === 'tool-result') as
      | { is_error: boolean }
      | undefined
    assert.equal(result?.is_error, false)
    assert.equal(fs.readFileSync(path.join(harness.cwd, 'out.txt'), 'utf8').trim(), 'hi')
  } finally {
    await harness.close()
  }
})

test('reject keeps the turn going with a readable error', async () => {
  const bridge = new FakeBridge(() => ({ choice: 'decline' }))
  const harness = await startHarness({ bridge })
  const host = await startHostFor(harness)
  hostUrls.set(harness, host)
  try {
    const events = await prompt(harness, host)
    const result = events.find((event) => event.type === 'tool-result') as
      | { is_error: boolean; content: string }
      | undefined
    assert.equal(result?.is_error, true)
    assert.match(result?.content ?? '', /拒绝/)
    const end = events.find((event) => event.type === 'turn-end') as { reason: unknown }
    assert.deepEqual(end.reason, { kind: 'completed' })
    assert.equal(fs.existsSync(path.join(harness.cwd, 'out.txt')), false)
  } finally {
    await harness.close()
  }
})

test('allow-session answers the second identical call without prompting', async () => {
  const bridge = new FakeBridge(() => ({ choice: 'accept-for-session' }))
  const harness = await startHarness({ bridge, calls: 2 })
  const host = await startHostFor(harness)
  hostUrls.set(harness, host)
  try {
    const events = await prompt(harness, host)
    // Two bash calls in one turn, one approval.
    assert.equal(bridge.requests.length, 1)
    const results = events.filter((event) => event.type === 'tool-result') as { is_error: boolean }[]
    assert.equal(results.length, 2)
    assert.ok(results.every((result) => result.is_error === false))
  } finally {
    await harness.close()
  }
})

test('cancel aborts the turn', async () => {
  const bridge = new FakeBridge(() => ({ choice: 'cancel' }))
  const harness = await startHarness({ bridge })
  const host = await startHostFor(harness)
  hostUrls.set(harness, host)
  try {
    const events = await prompt(harness, host)
    const end = events.find((event) => event.type === 'turn-end') as { reason: unknown }
    assert.deepEqual(end.reason, { kind: 'aborted', cause: { kind: 'user' } })
  } finally {
    await harness.close()
  }
})

test('read-only rejects a writing command without asking', async () => {
  const bridge = new FakeBridge(() => ({ choice: 'accept' }))
  const harness = await startHarness({ bridge, legacyMode: 'read-only' })
  const host = await startHostFor(harness)
  hostUrls.set(harness, host)
  try {
    const events = await prompt(harness, host)
    assert.equal(bridge.requests.length, 0)
    const result = events.find((event) => event.type === 'tool-result') as
      | { is_error: boolean; content: string }
      | undefined
    assert.equal(result?.is_error, true)
    assert.match(result?.content ?? '', /只读/)
    assert.equal(fs.existsSync(path.join(harness.cwd, 'out.txt')), false)
  } finally {
    await harness.close()
  }
})

test('approve-for-me lets the automatic reviewer decide', async () => {
  const bridge = new FakeBridge(() => ({ choice: 'decline' }))
  const reviewer: Reviewer = {
    async review() {
      return { outcome: 'allow', riskLevel: 'low', userAuthorization: 'high', rationale: 'test' }
    },
  }
  const harness = await startHarness({ bridge, reviewer, legacyMode: 'auto-edit' })
  const host = await startHostFor(harness)
  hostUrls.set(harness, host)
  // Switch the session to the approve-for-me preset.
  const switched = await fetch(`${host}/api/sessions/${harness.sessionId}/permission`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentMode: 'approve-for-me' }),
  })
  assert.equal(switched.status, 200)
  try {
    const events = await prompt(harness, host)
    assert.equal(bridge.requests.length, 0, 'the user bridge must not be consulted')
    const result = events.find((event) => event.type === 'tool-result') as
      | { is_error: boolean }
      | undefined
    assert.equal(result?.is_error, false)
  } finally {
    await harness.close()
  }
})

test('approve-for-me denial is a normal tool error', async () => {
  const bridge = new FakeBridge(() => ({ choice: 'accept' }))
  const reviewer: Reviewer = {
    async review() {
      return { outcome: 'deny', riskLevel: 'high', userAuthorization: 'low', rationale: 'test deny' }
    },
  }
  const harness = await startHarness({ bridge, reviewer })
  const host = await startHostFor(harness)
  hostUrls.set(harness, host)
  await fetch(`${host}/api/sessions/${harness.sessionId}/permission`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentMode: 'approve-for-me' }),
  })
  try {
    const events = await prompt(harness, host)
    assert.equal(bridge.requests.length, 0)
    const result = events.find((event) => event.type === 'tool-result') as
      | { is_error: boolean }
      | undefined
    assert.equal(result?.is_error, true)
    const end = events.find((event) => event.type === 'turn-end') as { reason: unknown }
    assert.deepEqual(end.reason, { kind: 'completed' })
  } finally {
    await harness.close()
  }
})

async function startHostFor(harness: Harness): Promise<string> {
  return harness.baseUrl
}