// End-to-end prefix behavior: the wire system stays frozen when the prompt
// changes, and microcompaction rewrites old tool results in place.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startHost } from '../src/host/server.ts'
import type { Host } from '../src/host/server.ts'
import { deriveHistory } from '../src/agent/history.ts'
import type { Envelope } from '../src/core/wire.ts'
import {
  lastToolContents,
  lastUserText,
  startMockGateway,
  writeConfig,
  type GatewayRequest,
  type MockGateway,
} from './helpers/mock-gateway.ts'

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

function withUser(request: GatewayRequest, text: string): boolean {
  return request.messages.some((message) => message.role === 'user' && message.content === text)
}

test('a changed system prompt travels as an update while the wire prefix stays frozen', async () => {
  const home = tempDir('denia-cache-prefix-home-')
  const cwd = tempDir('denia-cache-prefix-cwd-')
  const webDir = tempDir('denia-cache-prefix-web-')
  const mock = await startMockGateway((request) => {
    const text = withUser(request, 'second') ? 'second done' : 'first done'
    return { text }
  })
  writeConfig(home, mock.baseURL)
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const sessionId = await createSession(host, cwd)
    await prompt(host, sessionId, 'first')
    await waitFor(async () => {
      const current = await snapshot(host, sessionId)
      return !host.driver.isRunning(sessionId) &&
        current.events.some(
          (event) =>
            event.type === 'assistant-message' &&
            event.blocks.some((block) => block.type === 'text' && block.text === 'first done'),
        )
        ? true
        : null
    })
    const first = mock.requests.find((request) => withUser(request, 'first'))
    assert.ok(first, 'the first turn reached the gateway')

    const saved = await fetch(`${host.baseUrl}/api/system-prompt`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'NEW-PERSONA' }),
    })
    assert.equal(saved.status, 200)

    await prompt(host, sessionId, 'second')
    await waitFor(async () => {
      const current = await snapshot(host, sessionId)
      return !host.driver.isRunning(sessionId) &&
        current.events.some(
          (event) =>
            event.type === 'assistant-message' &&
            event.blocks.some((block) => block.type === 'text' && block.text === 'second done'),
        )
        ? true
        : null
    })
    const second = mock.requests.find((request) => withUser(request, 'second'))
    assert.ok(second, 'the second turn reached the gateway')

    const systemOf = (request: GatewayRequest): string => {
      const system = request.messages.find((message) => message.role === 'system')
      return typeof system?.content === 'string' ? system.content : ''
    }
    assert.equal(systemOf(second), systemOf(first), 'system bytes must stay frozen')
    assert.ok(!systemOf(second).includes('NEW-PERSONA'))
    assert.ok(
      second.messages.some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('系统提示更新') &&
          message.content.includes('NEW-PERSONA'),
      ),
      'the new prompt is appended as an update message',
    )
    assert.equal(second.prompt_cache_key, sessionId, 'the session id is the cache affinity hint')

    const events = (await snapshot(host, sessionId)).events
    assert.equal(
      events.filter((event) => event.type === 'request-header').length,
      1,
      'a frozen system and unchanged tools keep one request header',
    )

    // A rebuilt prompt is visible in the transcript even though the wire
    // prefix did not change.
    const latestPrompt = [...events]
      .reverse()
      .find((event) => event.type === 'system-prompt')
    assert.ok(latestPrompt && latestPrompt.type === 'system-prompt')
    assert.ok(latestPrompt.text.includes('NEW-PERSONA'))
  } finally {
    await host.close()
    await mock.close()
  }
})

test('microcompaction replaces an old tool result in place before the next request', async () => {
  const home = tempDir('denia-microcompact-home-')
  const cwd = tempDir('denia-microcompact-cwd-')
  const webDir = tempDir('denia-microcompact-web-')
  fs.writeFileSync(path.join(cwd, 'big1.txt'), 'x'.repeat(2_000))
  fs.writeFileSync(path.join(cwd, 'big2.txt'), 'y'.repeat(2_000))
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      providers: [
        {
          id: 'mock',
          name: 'Mock',
          baseURL: '',
          protocol: 'openai-completions',
          models: [{ id: 'mock-1', name: 'Mock 1', contextWindow: 1_000 }],
        },
      ],
      default: { provider: 'mock', model: 'mock-1' },
    }),
  )
  fs.writeFileSync(
    path.join(home, 'settings.yaml'),
    'console:\n  microcompact:\n    microcompactKeepRecentGroups: 1\n',
  )
  const mock: MockGateway = await startMockGateway((request) => {
    const results = lastToolContents(request)
    if (results.length < 2) {
      return {
        calls: [
          {
            name: 'read_file',
            arguments: { path: `big${results.length + 1}.txt` },
          },
        ],
        usage: { inputTokens: 1_000, outputTokens: 1 },
      }
    }
    return { text: 'done', usage: { inputTokens: 1_000, outputTokens: 1 } }
  })
  // The config file needs the live gateway URL after the server starts.
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) as {
    providers: { baseURL: string }[]
  }
  config.providers[0]!.baseURL = mock.baseURL
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config))
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const sessionId = await createSession(host, cwd)
    await prompt(host, sessionId, 'go')
    await waitFor(async () => {
      const current = await snapshot(host, sessionId)
      return !host.driver.isRunning(sessionId) &&
        current.events.some(
          (event) =>
            event.type === 'assistant-message' &&
            event.blocks.some((block) => block.type === 'text' && block.text === 'done'),
        )
        ? true
        : null
    })

    const requests = mock.requests.filter((request) =>
      request.messages.some((message) => message.role === 'tool'),
    )
    const last = requests[requests.length - 1]
    assert.ok(last, 'the turn used tools')
    const results = lastToolContents(last)
    assert.equal(results.length, 2)
    assert.equal(results[0], '[旧工具结果内容已清理]')
    assert.ok(results[1]!.includes('y'.repeat(100)))

    const events = (await snapshot(host, sessionId)).events
    const replacement = events.find(
      (event) => event.type === 'tool-result' && event.replaces !== undefined,
    )
    assert.ok(replacement && replacement.type === 'tool-result')
    assert.equal(replacement.content, '[旧工具结果内容已清理]')
    const history = deriveHistory(events)
    assert.ok(
      history.some(
        (message) => message.role === 'tool' && message.content === '[旧工具结果内容已清理]',
      ),
    )
  } finally {
    await host.close()
    await mock.close()
  }
})
test('manual compaction reuses the last request prefix so the summary call hits the cache', async () => {
  const home = tempDir('denia-compact-prefix-home-')
  const cwd = tempDir('denia-compact-prefix-cwd-')
  const webDir = tempDir('denia-compact-prefix-web-')
  const mock = await startMockGateway((request) => {
    const all = request.messages
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n')
    if (all.includes('上下文压缩器')) return { text: '压缩摘要' }
    const user = lastUserText(request)
    const results = lastToolContents(request).join('\n')
    for (const word of ['one', 'two', 'three']) {
      if (!user.includes(word)) continue
      if (!results.includes('已更新任务列表')) {
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
    return { text: 'ok' }
  })
  writeConfig(home, mock.baseURL)
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const sessionId = await createSession(host, cwd)
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
    const systemOf = (request: GatewayRequest): string => {
      const system = request.messages.find((message) => message.role === 'system')
      return typeof system?.content === 'string' ? system.content : ''
    }
    const isCompactionRequest = (request: GatewayRequest): boolean => {
      const last = request.messages[request.messages.length - 1]
      return (
        last?.role === 'user' &&
        typeof last.content === 'string' &&
        last.content.includes('把以上历史压缩成一段事实性摘要')
      )
    }
    const isTitleRequest = (request: GatewayRequest): boolean =>
      systemOf(request).startsWith('为一次 AI 编码助手会话起一个简洁标题')
    const main = mock.requests.filter(
      (request) => !isCompactionRequest(request) && !isTitleRequest(request),
    )
    const lastMain = main[main.length - 1]
    assert.ok(lastMain, 'a main request was captured')

    const compacted = await fetch(`${host.baseUrl}/api/sessions/${sessionId}/compact`, {
      method: 'POST',
    })
    assert.equal(compacted.status, 202)
    await waitFor(async () => {
      const current = await snapshot(host, sessionId)
      return current.events.some((event) => event.type === 'compaction-summary') ? true : null
    })
    const summaryRequest = mock.requests.find(isCompactionRequest)
    assert.ok(summaryRequest, 'the summary request was captured')
    assert.equal(systemOf(summaryRequest), systemOf(lastMain), 'the summary keeps the frozen system')
    assert.ok((summaryRequest.tools?.length ?? 0) > 0, 'the summary keeps the tool prefix')
    assert.equal(summaryRequest.prompt_cache_key, sessionId, 'the summary keeps cache affinity')
  } finally {
    await host.close()
    await mock.close()
  }
})
