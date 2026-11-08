// Goal integration: HTTP command → continuation turn → verifier → completion.
//
// The mock gateway answers normal turns with plain text and recognizes the
// verifier request by its prompt, so the whole host path is exercised without
// a network provider.

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
  verifierCalls: () => number
  close(): Promise<void>
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

async function startMockGateway(): Promise<MockGateway> {
  let verifierCalls = 0
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404)
      res.end()
      return
    }
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      let body: { messages?: { role: string; content?: unknown }[] } = {}
      try {
        body = JSON.parse(raw) as typeof body
      } catch {
        /* ignore */
      }
      const messages = body.messages ?? []
      const lastUser = [...messages].reverse().find((message) => message.role === 'user')
      const prompt = typeof lastUser?.content === 'string' ? lastUser.content : ''
      const isVerifier = prompt.includes('Verify whether the active session goal is actually complete')

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const write = (payload: unknown) => res.write(sseChunk(payload))
      write({ choices: [{ index: 0, delta: { role: 'assistant' } }] })

      if (isVerifier) {
        verifierCalls += 1
        const verdict =
          verifierCalls === 1
            ? { passed: false, reason: 'tests missing', nextAction: 'add the missing test' }
            : { passed: true, reason: 'all requirements verified' }
        write({ choices: [{ index: 0, delta: { content: JSON.stringify(verdict) } }] })
        write({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      } else {
        write({ choices: [{ index: 0, delta: { content: 'done with this iteration' } }] })
        write({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock gateway did not bind')
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    verifierCalls: () => verifierCalls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  while (!done(last)) {
    if (Date.now() > deadline) throw new Error(`timed out; last=${JSON.stringify(last)}`)
    await new Promise((resolve) => setTimeout(resolve, 40))
    last = await read()
  }
  return last
}

test('goal command drives continuation turns until the verifier passes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-goal-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-goal-cwd-'))
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-goal-web-'))
  const mock = await startMockGateway()
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
    const base = `${host.baseUrl}/api/sessions/${session.id}`

    const empty = (await (await fetch(`${base}/goal`)).json()) as { goal: unknown }
    assert.equal(empty.goal, null)

    const started = await fetch(`${base}/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'set',
        objective: 'Ship the goal mode',
        provider: 'mock',
        model: 'mock-1',
        echoText: '/goal Ship the goal mode',
      }),
    })
    assert.equal(started.status, 200)
    const first = (await started.json()) as {
      goal: { status: string; iteration: number; targetId: string }
    }
    assert.equal(first.goal.status, 'active')
    assert.equal(first.goal.iteration, 1)

    // Two continuation turns and two verifier calls complete the goal.
    const completed = await waitFor(
      async () => (await (await fetch(`${base}/goal`)).json()) as {
        goal: {
          status: string
          iteration: number
          verifications: { outcome: string; reason?: string }[]
        } | null
      },
      (view) => view.goal?.status === 'complete',
    )
    assert.equal(completed.goal?.iteration, 2)
    assert.deepEqual(
      completed.goal?.verifications.map((entry) => entry.outcome),
      ['not-satisfied', 'pass'],
    )
    assert.equal(mock.verifierCalls(), 2)

    const page = (await (await fetch(`${base}/events?limit=2000`)).json()) as {
      events: Envelope[]
    }
    const injected = page.events.filter(
      (event) => event.type === 'user-message' && event.injected && event.channel === 'goal-continuation',
    )
    assert.equal(injected.length, 2)
    assert.ok(page.events.some((event) => event.type === 'goal' && event.op === 'set'))
    assert.ok(page.events.some((event) => event.type === 'goal' && event.op === 'verified'))
    assert.ok(page.events.some((event) => event.type === 'command-run' && event.name === 'goal'))

    // A completed goal rejects resume but still allows clearing.
    const resumed = await fetch(`${base}/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'resume' }),
    })
    assert.equal(resumed.status, 409)
    const cleared = await fetch(`${base}/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'clear' }),
    })
    assert.equal(cleared.status, 200)
    const after = (await (await fetch(`${base}/goal`)).json()) as { goal: unknown }
    assert.equal(after.goal, null)
  } finally {
    await host.close()
    await mock.close()
  }
})
