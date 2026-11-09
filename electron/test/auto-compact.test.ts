// Automatic summarization: the pressure gate only fires at the configured
// share of the window, and one summary replaces the oldest turns.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startHost } from '../src/host/server.ts'
import type { Host } from '../src/host/server.ts'
import type { Envelope } from '../src/core/wire.ts'
import {
  lastToolContents,
  lastUserText,
  startMockGateway,
  writeConfig,
  type GatewayRequest,
  type MockGateway,
} from './helpers/mock-gateway.ts'

const SUMMARY_MARKER = '你是编码会话的上下文压缩器'
const SUMMARY_TEXT = '摘要:第一轮读取了 notes.txt,用户随后继续追问。'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
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

async function createSession(host: Host, cwd: string): Promise<string> {
  const response = await fetch(`${host.baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd }),
  })
  return ((await response.json()) as { session: { id: string } }).session.id
}

async function prompt(host: Host, id: string, text: string): Promise<void> {
  const response = await fetch(`${host.baseUrl}/api/sessions/${id}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: text, provider: 'mock', model: 'mock-1' }),
  })
  assert.equal(response.status, 202)
}

async function snapshot(host: Host, id: string): Promise<{ events: Envelope[] }> {
  return (await (await fetch(`${host.baseUrl}/api/sessions/${id}`)).json()) as { events: Envelope[] }
}

async function settle(host: Host, id: string, turn: number): Promise<Envelope[]> {
  return waitFor(async () => {
    const current = await snapshot(host, id)
    const closed = current.events.some(
      (event) => event.type === 'turn-end' && event.turn === turn,
    )
    return closed && !host.driver.isRunning(id) ? current.events : null
  })
}

function isSummaryRequest(request: GatewayRequest): boolean {
  return request.messages.some(
    (message) => typeof message.content === 'string' && message.content.includes(SUMMARY_MARKER),
  )
}

/**
 * Three turns: the first carries a tool pair, the later ones refill the prompt
 * to the reported size. Compaction needs at least three turns because the two
 * newest are kept verbatim.
 */
async function runThreeTurns(
  home: string,
  cwd: string,
  webDir: string,
  inputTokens: number,
): Promise<{ host: Host; sessionId: string; mock: MockGateway; summaries: () => number }> {
  let summaries = 0
  const mock = await startMockGateway((request) => {
    if (isSummaryRequest(request)) {
      summaries += 1
      return { text: SUMMARY_TEXT }
    }
    const user = lastUserText(request)
    if (user === 'first' && lastToolContents(request).length === 0) {
      return { calls: [{ name: 'read_file', arguments: { path: 'notes.txt' } }] }
    }
    return { text: `${user} done`, usage: { inputTokens } }
  })
  writeConfig(home, mock.baseURL)
  const host = await startHost({ home, webDir, port: 0 })
  const sessionId = await createSession(host, cwd)
  await prompt(host, sessionId, 'first')
  await settle(host, sessionId, 1)
  await prompt(host, sessionId, 'second')
  await settle(host, sessionId, 2)
  await prompt(host, sessionId, 'third')
  await settle(host, sessionId, 3)
  return { host, sessionId, mock, summaries: () => summaries }
}

test('automatic compaction summarizes once the default threshold is crossed', async () => {
  const home = tempDir('denia-auto-compact-home-')
  const cwd = tempDir('denia-auto-compact-cwd-')
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'hello')
  const webDir = tempDir('denia-auto-compact-web-')
  const run = await runThreeTurns(home, cwd, webDir, 120_000)
  try {
    assert.equal(run.summaries(), 1, 'one summary request reaches the provider')
    const events = await snapshot(run.host, run.sessionId)
    const summary = events.events.find((event) => event.type === 'compaction-summary')
    assert.ok(summary, 'the summary event lands in the log')
    const last = run.mock.requests[run.mock.requests.length - 1]!
    assert.ok(
      last.messages.some(
        (message) => typeof message.content === 'string' && message.content.includes(SUMMARY_TEXT),
      ),
      'the request after compaction carries the summary instead of the first turn',
    )
    assert.ok(
      !last.messages.some(
        (message) => typeof message.content === 'string' && message.content === 'first',
      ),
      'the summarized turn no longer reaches the model',
    )
  } finally {
    await run.host.close()
    await run.mock.close()
  }
})

test('the configured ratio moves the trigger point', async () => {
  const home = tempDir('denia-auto-compact-ratio-home-')
  const cwd = tempDir('denia-auto-compact-ratio-cwd-')
  const webDir = tempDir('denia-auto-compact-ratio-web-')
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'hello')
  fs.writeFileSync(
    path.join(home, 'settings.yaml'),
    'console:\n  compaction:\n    compactRatio: 0.5\n',
  )
  const run = await runThreeTurns(home, cwd, webDir, 70_000)
  try {
    assert.equal(run.summaries(), 1)
    const events = await snapshot(run.host, run.sessionId)
    assert.ok(events.events.some((event) => event.type === 'compaction-summary'))
  } finally {
    await run.host.close()
    await run.mock.close()
  }
})

test('below the threshold nothing is summarized', async () => {
  const home = tempDir('denia-auto-compact-idle-home-')
  const cwd = tempDir('denia-auto-compact-idle-cwd-')
  const webDir = tempDir('denia-auto-compact-idle-web-')
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'hello')
  const run = await runThreeTurns(home, cwd, webDir, 100_000)
  try {
    assert.equal(run.summaries(), 0)
    const events = await snapshot(run.host, run.sessionId)
    assert.equal(
      events.events.some((event) => event.type === 'compaction-summary'),
      false,
    )
  } finally {
    await run.host.close()
    await run.mock.close()
  }
})