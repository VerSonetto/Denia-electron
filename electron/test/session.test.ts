// Session title, context breakdown and manual compaction.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startHost } from '../src/host/server.ts'
import type { Host } from '../src/host/server.ts'
import { deriveHistory } from '../src/agent/history.ts'
import type { Envelope } from '../src/core/wire.ts'
import { startMockGateway, lastToolContents, lastUserText, writeConfig } from './helpers/mock-gateway.ts'

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

async function snapshot(host: Host, id: string): Promise<{ events: Envelope[] }> {
  return (await (await fetch(`${host.baseUrl}/api/sessions/${id}`)).json()) as { events: Envelope[] }
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

test('session title, context breakdown and manual compaction', async () => {
  const home = tempDir('denia-session-home-')
  const cwd = tempDir('denia-session-cwd-')
  const webDir = tempDir('denia-session-web-')
  const mock = await startMockGateway((request) => {
    const all = request.messages
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n')
    if (all.includes('生成会话标题')) return { text: '测试标题' }
    if (all.includes('上下文压缩器')) return { text: '压缩摘要' }
    const user = lastUserText(request)
    const tools = lastToolContents(request).join('\n')
    if (user.includes('title me')) return { text: 'title turn done' }
    for (const word of ['one', 'two', 'three', 'four']) {
      if (user.includes(word)) {
        if (!tools.includes('已更新任务列表')) {
          return {
            calls: [
              {
                name: 'todo_write',
                arguments: { todos: [{ content: `${word} task`, status: 'in_progress' }] },
              },
            ],
          }
        }
        return { text: `${word} done` }
      }
    }
    return { text: 'ok' }
  })
  writeConfig(home, mock.baseURL)
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const sessionId = await createSession(host, cwd)
    await prompt(host, sessionId, 'title me')
    const title = await waitFor(async () => {
      const current = await snapshot(host, sessionId)
      const event = current.events.find((entry) => entry.type === 'session-title')
      return event && event.type === 'session-title' ? event.title : null
    })
    assert.equal(title, '测试标题')
    const summaries = (await (await fetch(`${host.baseUrl}/api/sessions`)).json()) as {
      sessions: { id: string; title: string | null }[]
    }
    assert.equal(summaries.sessions.find((entry) => entry.id === sessionId)?.title, '测试标题')

    const breakdown = (await (
      await fetch(`${host.baseUrl}/api/sessions/${sessionId}/context-breakdown`)
    ).json()) as {
      breakdown: {
        systemTokens: number
        toolsTokens: number
        messageTokens: number
        parts: { key: string; chars: number; tokens: number }[]
      }
      usage: { outputTokens: number }
    }
    const parts = breakdown.breakdown.parts
    assert.equal(parts.length, 6)
    assert.equal(
      parts.reduce((sum, part) => sum + part.tokens, 0),
      breakdown.breakdown.systemTokens +
        breakdown.breakdown.toolsTokens +
        breakdown.breakdown.messageTokens,
    )
    const tokensOf = (key: string) => parts.find((part) => part.key === key)?.tokens ?? 0
    assert.equal(
      breakdown.breakdown.systemTokens,
      tokensOf('systemPrompt') + tokensOf('metaUserContext') + tokensOf('skills'),
    )
    assert.equal(
      breakdown.breakdown.toolsTokens,
      tokensOf('systemTools') + tokensOf('mcpTools'),
    )
    assert.equal(breakdown.breakdown.messageTokens, tokensOf('messages'))
    assert.ok(breakdown.breakdown.systemTokens > 0)
    assert.ok(breakdown.breakdown.toolsTokens > 0)
    assert.ok(breakdown.breakdown.messageTokens > 0)
    assert.ok(breakdown.usage.outputTokens > 0)

    for (const word of ['one', 'two', 'three']) {
      await prompt(host, sessionId, word)
      await waitFor(async () => {
        const current = await snapshot(host, sessionId)
        return !host.driver.isRunning(sessionId) &&
          current.events.some(
            (event) =>
              event.type === 'assistant-message' &&
              event.blocks.some((block) => block.type === 'text' && block.text === `${word} done`),
          )
          ? true
          : null
      })
    }

    const compacted = await fetch(`${host.baseUrl}/api/sessions/${sessionId}/compact`, {
      method: 'POST',
    })
    assert.equal(compacted.status, 202)
    const summaryEvent = await waitFor(async () => {
      const current = await snapshot(host, sessionId)
      return (
        current.events.find(
          (event): event is Extract<Envelope, { type: 'compaction-summary' }> =>
            event.type === 'compaction-summary',
        ) ?? null
      )
    })
    assert.equal(summaryEvent.summary, '压缩摘要')
    assert.ok(summaryEvent.replaces_from > 0)
    assert.ok(summaryEvent.replaces_to >= summaryEvent.replaces_from)
    assert.ok(summaryEvent.keep_from > summaryEvent.replaces_to)

    const events = (await snapshot(host, sessionId)).events
    const history = deriveHistory(events)
    assert.ok(history.some((message) => message.role === 'user' && message.content === '压缩摘要'))
    assert.ok(
      !history.some(
        (message) => message.role === 'assistant' && message.content.includes('one done'),
      ),
      'summarized messages must leave the model surface',
    )

    await prompt(host, sessionId, 'four')
    await waitFor(async () => {
      const current = await snapshot(host, sessionId)
      return !host.driver.isRunning(sessionId) &&
        current.events.some(
          (event) =>
            event.type === 'assistant-message' &&
            event.blocks.some((block) => block.type === 'text' && block.text === 'four done'),
        )
        ? true
        : null
    })
    const lastRequest = mock.requests[mock.requests.length - 1]!
    const joined = lastRequest.messages
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n')
    assert.ok(joined.includes('压缩摘要'), 'the summary must reach the next request')
    assert.ok(!joined.includes('one done'), 'compacted history must not be resent')
  } finally {
    await host.close()
    await mock.close()
  }
})