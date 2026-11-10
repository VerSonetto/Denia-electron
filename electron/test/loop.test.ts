// Integration test: one complete tool-calling turn against a mock gateway.
//
// The mock speaks the same OpenAI-compatible SSE the adapter expects and
// drives three steps: todo_write → bash → final text. Assertions cover the
// event vocabulary the web UI folds, not just the final answer.

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

async function startMockGateway(): Promise<MockGateway> {
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
      let body: { messages?: { role: string; content?: unknown }[] } = {}
      try {
        body = JSON.parse(raw) as typeof body
      } catch {
        /* ignore */
      }
      const toolContents = (body.messages ?? [])
        .filter((message) => message.role === 'tool')
        .map((message) => (typeof message.content === 'string' ? message.content : ''))
      const sawTodo = toolContents.some((content) => content.includes('已更新任务列表'))
      const sawBash = toolContents.some((content) => content.includes('hi-from-mock'))

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const write = (payload: unknown) => res.write(sseChunk(payload))
      const role = { choices: [{ index: 0, delta: { role: 'assistant' } }] }

      if (!sawTodo) {
        write(role)
        write({ choices: [{ index: 0, delta: { reasoning_content: '先规划任务。' } }] })
        write({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_todo',
                    type: 'function',
                    function: {
                      name: 'todo_write',
                      arguments: JSON.stringify({
                        todos: [{ content: '运行命令验证链路', status: 'in_progress' }],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        })
        write({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
        write({ usage: { prompt_tokens: 10, completion_tokens: 5 } })
        res.end()
        return
      }
      if (!sawBash) {
        write(role)
        write({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_bash',
                    type: 'function',
                    function: { name: 'bash', arguments: JSON.stringify({ command: 'echo hi-from-mock' }) },
                  },
                ],
              },
            },
          ],
        })
        write({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
        res.end()
        return
      }
      write(role)
      write({ choices: [{ index: 0, delta: { content: '全部完成。' } }] })
      write({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      write({
        usage: {
          prompt_tokens: 30,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      })
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
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

test('agent loop runs a tool-calling turn and streams UI-visible events', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-cwd-'))
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-web-'))
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
    assert.equal(created.status, 201)
    const { session } = (await created.json()) as { session: { id: string } }

    const catalog = (await (await fetch(`${host.baseUrl}/api/llm/catalog`)).json()) as {
      groups: { id: string; models: { id: string }[] }[]
    }
    assert.equal(catalog.groups[0]?.id, 'mock')
    assert.equal(catalog.groups[0]?.models[0]?.id, 'mock-1')

    const prompted = await fetch(`${host.baseUrl}/api/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '跑一遍链路',
        provider: 'mock',
        model: 'mock-1',
      }),
    })
    assert.equal(prompted.status, 202)

    const events = await waitForTurnEnd(host.baseUrl, session.id)
    const types = events.map((event) => event.type)
    assert.ok(types.includes('turn-start'), `missing turn-start: ${types.join(',')}`)
    assert.ok(types.includes('user-message'))
    assert.ok(types.includes('assistant-chunk'))
    assert.ok(types.includes('assistant-message'))
    assert.equal(types.filter((type) => type === 'tool-call').length, 2)
    assert.equal(types.filter((type) => type === 'tool-result').length, 2)
    assert.ok(types.includes('todo-write'), 'todo_write must emit a todo-write event')
    assert.ok(types.includes('turn-end'))

    const end = events.find((event) => event.type === 'turn-end')
    assert.deepEqual((end as { reason: unknown }).reason, { kind: 'completed' })

    const assistant = events.filter((event) => event.type === 'assistant-message')
    const final = assistant[assistant.length - 1] as {
      blocks: { type: string; text?: string }[]
      usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; reasoningTokens?: number }
    }
    assert.equal(final.blocks[0]?.type, 'text')
    assert.equal(final.blocks[0]?.text, '全部完成。')
    assert.deepEqual(final.usage, {
      // Rust contract: inputTokens is the uncached prompt (30 - 4 cached).
      inputTokens: 26,
      outputTokens: 8,
      cacheReadTokens: 4,
      reasoningTokens: 2,
    })

    const bashResult = events.find(
      (event) => event.type === 'tool-result' && (event as { call_id: string }).call_id === 'call_bash',
    ) as { content: string; is_error: boolean; meta?: { exit_code?: number } }
    assert.equal(bashResult.is_error, false)
    assert.match(bashResult.content, /hi-from-mock/)
    assert.equal(bashResult.meta?.exit_code, 0)

    // The session must be readable through the paged endpoint too.
    const page = (await (
      await fetch(`${host.baseUrl}/api/sessions/${session.id}/events?limit=50`)
    ).json()) as { events: Envelope[]; total: number }
    // Paging counts display events: stream-only frames are not part of the window.
    const displayCount = events.filter(
      (event) => event.type !== 'assistant-chunk' && event.type !== 'tool-output-chunk',
    ).length
    assert.equal(page.total, displayCount)
    assert.ok(page.events.length <= page.total)
  } finally {
    await host.close()
    await mock.close()
  }
})

test('follow stream replays from a cursor and then streams live events', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-cwd-'))
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-web-'))
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
    const { session } = (await created.json()) as { session: { id: string } }

    // Seed one event (permission mode) before following, so `after=0` has a replay.
    const response = await fetch(`${host.baseUrl}/api/sessions/${session.id}/follow?after=0`, {
      headers: { accept: 'text/event-stream' },
    })
    assert.equal(response.status, 200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const envelopes: Envelope[] = []
    const deadline = Date.now() + 5_000
    while (envelopes.length < 2 && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = JSON.parse(line.slice(5).trim()) as Envelope | { type: 'hb' }
          if ((payload as { type: string }).type === 'hb') continue
          envelopes.push(payload as Envelope)
        }
      }
    }
    await reader.cancel()
    assert.ok(envelopes.length >= 1)
    assert.equal(envelopes[0]!.seq, 1)
    assert.equal(envelopes[0]!.type, 'permission-mode')
  } finally {
    await host.close()
    await mock.close()
  }
})