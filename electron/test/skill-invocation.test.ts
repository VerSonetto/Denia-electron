// Skill invocation through the composer: a first-line `/skill-name` gesture and
// explicit `skills[]` selections both inject the skill body before the model
// answers. Everything else in the slash menu (`/plan`, `/compact`) is handled
// by the web client against existing endpoints and is not exercised here.

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
  requests: { messages?: { role: string; content?: unknown }[] }[]
  close(): Promise<void>
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

async function startMockGateway(): Promise<MockGateway> {
  const requests: MockGateway['requests'] = []
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
      try {
        requests.push(JSON.parse(raw) as MockGateway['requests'][number])
      } catch {
        requests.push({})
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(sseChunk({ choices: [{ index: 0, delta: { role: 'assistant' } }] }))
      res.write(sseChunk({ choices: [{ index: 0, delta: { content: '好的' } }] }))
      res.write(sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock server did not bind')
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function waitForTurnEnd(baseURL: string, sessionId: string): Promise<Envelope[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${baseURL}/api/sessions/${sessionId}`)
    const session = (await response.json()) as { events: Envelope[] }
    if (session.events.some((event) => event.type === 'turn-end')) return session.events
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('turn did not finish')
}

function messageTexts(request: MockGateway['requests'][number] | undefined): string[] {
  return (request?.messages ?? [])
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .filter((text) => text !== '')
}

test('a first-line skill gesture injects the skill body', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-skill-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-skill-cwd-'))
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-skill-web-'))
  fs.mkdirSync(path.join(home, 'skills', 'review'), { recursive: true })
  fs.writeFileSync(
    path.join(home, 'skills', 'review', 'SKILL.md'),
    '---\nname: review\ndescription: Review code carefully\n---\n# Review\nSKILL-BODY-MARKER\n',
  )
  const mock = await startMockGateway()
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      providers: [
        { id: 'mock', name: 'Mock', baseURL: mock.baseURL, models: [{ id: 'mock-1' }] },
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
    assert.equal(created.status, 201)
    const { session } = (await created.json()) as { session: { id: string } }

    const prompted = await fetch(`${host.baseUrl}/api/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '/review\n帮我审查一下',
        provider: 'mock',
        model: 'mock-1',
      }),
    })
    assert.equal(prompted.status, 202)
    await waitForTurnEnd(host.baseUrl, session.id)

    const texts = mock.requests.flatMap((request) => messageTexts(request))
    assert.ok(
      texts.some((text) => text.includes('[技能正文 review') && text.includes('SKILL-BODY-MARKER')),
      `gesture body missing: ${JSON.stringify(texts.slice(-4))}`,
    )
  } finally {
    await host.close()
    await mock.close()
  }
})

test('explicit skills[] selections inject the skill before the prompt', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-skill-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-skill-cwd-'))
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-skill-web-'))
  fs.mkdirSync(path.join(home, 'skills', 'review'), { recursive: true })
  fs.writeFileSync(
    path.join(home, 'skills', 'review', 'SKILL.md'),
    '---\nname: review\ndescription: Review code carefully\n---\n# Review\nSKILL-BODY-MARKER\n',
  )
  const mock = await startMockGateway()
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      providers: [
        { id: 'mock', name: 'Mock', baseURL: mock.baseURL, models: [{ id: 'mock-1' }] },
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
    assert.equal(created.status, 201)
    const { session } = (await created.json()) as { session: { id: string } }

    const prompted = await fetch(`${host.baseUrl}/api/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '看一下这段实现',
        skills: ['review'],
        provider: 'mock',
        model: 'mock-1',
      }),
    })
    assert.equal(prompted.status, 202)
    await waitForTurnEnd(host.baseUrl, session.id)

    const texts = mock.requests.flatMap((request) => messageTexts(request))
    assert.ok(
      texts.some(
        (text) => text.includes('[用户显式调用技能：review') && text.includes('SKILL-BODY-MARKER'),
      ),
      `explicit skill body missing: ${JSON.stringify(texts.slice(-4))}`,
    )
  } finally {
    await host.close()
    await mock.close()
  }
})