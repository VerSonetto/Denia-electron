// pi bridge tests.
//
// pi-ai owns the provider protocols. These tests cover Denia's side of the
// contract: provider settings -> pi model calls, wire stream -> `StreamChunk`
// vocabulary, cache identity, and error code propagation.

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { Agent } from '@earendil-works/pi-agent-core'

import type { StreamChunk } from '../src/core/wire.ts'
import { normalizePromptCacheKey } from '../src/llm/cache-key.ts'
import { createPiStreamFn, LlmRequestError, streamFor, toPiModel } from '../src/llm/index.ts'
import type { ProviderConfig } from '../src/config.ts'

const sse = (payload: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(payload)}\n\n`

interface Captured {
  path: string
  body: Record<string, unknown>
  headers?: http.IncomingHttpHeaders
}

async function startMock(
  handler: () => string,
  captured: Captured,
): Promise<{ baseURL: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        /* ignore */
      }
      captured.path = req.url ?? ''
      captured.body = body
      captured.headers = req.headers
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(handler())
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

function provider(
  protocol: ProviderConfig['protocol'],
  baseURL: string,
  options: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id: 'mock',
    name: 'Mock',
    baseURL,
    protocol,
    models: [{ id: 'mock-1' }],
    ...options,
  }
}

async function collect(stream: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function blocksOf(chunks: StreamChunk[]): unknown[] {
  return chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
}

const anthropicToolStream = (): string =>
  [
    sse(
      { type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 5 } } },
      'message_start',
    ),
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }, 'content_block_start'),
    sse(
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '看一下' } },
      'content_block_delta',
    ),
    sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop'),
    sse(
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file' } },
      'content_block_start',
    ),
    sse(
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } },
      'content_block_delta',
    ),
    sse({ type: 'content_block_stop', index: 1 }, 'content_block_stop'),
    sse(
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      'message_delta',
    ),
    sse({ type: 'message_stop' }, 'message_stop'),
  ].join('')

const chatToolStream = (): string =>
  [
    sse({ choices: [{ index: 0, delta: { reasoning_content: '先想' } }] }),
    sse({ choices: [{ index: 0, delta: { content: '你好' } }] }),
    sse({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '{"command":' } }],
          },
        },
      ],
    }),
    sse({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }],
    }),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    sse({
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    }),
    'data: [DONE]\n\n',
  ].join('')

const chatTextStream = (): string =>
  [
    sse({ choices: [{ index: 0, delta: { content: 'ok' } }] }),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ].join('')

const responsesStream = (): string =>
  [
    sse({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }),
    sse({
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'msg_1', type: 'message', role: 'assistant' },
    }),
    sse({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: '好的' }),
    sse({
      type: 'response.output_item.done',
      output_index: 0,
      item: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的' }] },
    }),
    sse({
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'completed',
        usage: { input_tokens: 3, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } },
      },
    }),
  ].join('')

test('openai-completions maps text, reasoning, tool calls and cached usage', async () => {
  const captured: Captured = { path: '', body: {} }
  const mock = await startMock(chatToolStream, captured)
  try {
    const chunks = await collect(
      streamFor({
        provider: provider('openai-completions', mock.baseURL),
        model: 'mock-1',
        system: 'SYS',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
        reasoningEffort: 'high',
        cacheKey: 'session-1',
      }),
    )
    assert.deepEqual(blocksOf(chunks), [
      { type: 'reasoning', text: '先想' },
      { type: 'text', text: '你好' },
      { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
    ])
    assert.deepEqual(chunks.find((chunk) => chunk.type === 'usage')?.usage, {
      inputTokens: 9,
      outputTokens: 7,
      cacheReadTokens: 3,
      reasoningTokens: 2,
    })
    assert.deepEqual(chunks.find((chunk) => chunk.type === 'finish')?.reason, { kind: 'tool-calls' })

    assert.equal((captured.body.messages as { role: string; content: string }[])[0]?.content, 'SYS')
    assert.deepEqual(captured.body.tools, [
      { type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object' } } },
    ])
    assert.equal(captured.body.reasoning_effort, 'high')
    assert.equal(captured.body.prompt_cache_key, 'session-1')
    assert.deepEqual(captured.body.stream_options, { include_usage: true })
    // No configured output cap: neither dialect field is sent.
    assert.equal('max_tokens' in captured.body, false)
    assert.equal('max_completion_tokens' in captured.body, false)
  } finally {
    await mock.close()
  }
})

test('openai-completions splits inline think tags at the event boundary', async () => {
  const mock = await startMock(
    () =>
      [
        sse({ choices: [{ index: 0, delta: { content: '思考中' } }] }),
        sse({ choices: [{ index: 0, delta: { content: '\u003c/think\u003e答案' } }] }),
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n',
      ].join(''),
    { path: '', body: {} },
  )
  try {
    const chunks = await collect(
      streamFor({
        provider: provider('openai-completions', mock.baseURL, { inlineThinkTags: true }),
        model: 'mock-1',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      }),
    )
    assert.deepEqual(blocksOf(chunks), [
      { type: 'reasoning', text: '思考中' },
      { type: 'text', text: '答案' },
    ])
  } finally {
    await mock.close()
  }
})

test('anthropic-messages maps content blocks and usage', async () => {
  const captured: Captured = { path: '', body: {} }
  const mock = await startMock(anthropicToolStream, captured)
  try {
    const chunks = await collect(
      streamFor({
        provider: provider('anthropic-messages', mock.baseURL),
        model: 'mock-1',
        system: 'SYS',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'tu_0', name: 'bash', arguments: '{"command":"ls"}' }],
          },
          { role: 'tool', content: 'a.txt', toolCallId: 'tu_0' },
        ],
        tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
      }),
    )
    assert.deepEqual(blocksOf(chunks), [
      { type: 'text', text: '看一下' },
      { type: 'tool-call', id: 'tu_1', name: 'read_file', arguments: '{"path":"a"}' },
    ])
    assert.deepEqual(chunks.find((chunk) => chunk.type === 'usage')?.usage, {
      inputTokens: 20,
      outputTokens: 9,
      cacheReadTokens: 5,
    })
    assert.deepEqual(chunks.find((chunk) => chunk.type === 'finish')?.reason, { kind: 'tool-calls' })

    assert.match(captured.path, /\/v1\/messages(\?.*)?$/)
    assert.equal(captured.body.max_tokens, 8192)
    const system = captured.body.system as { type: string; text: string }[]
    assert.equal(system[0]?.type, 'text')
    assert.equal(system[0]?.text, 'SYS')
    const messages = captured.body.messages as { role: string; content: unknown[] }[]
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'user'])
    assert.equal((messages[2]!.content[0] as { type: string }).type, 'tool_result')
  } finally {
    await mock.close()
  }
})

test('openai-responses maps text and usage', async () => {
  const captured: Captured = { path: '', body: {} }
  const mock = await startMock(responsesStream, captured)
  try {
    const chunks = await collect(
      streamFor({
        provider: provider('openai-responses', mock.baseURL),
        model: 'mock-1',
        system: 'SYS',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      }),
    )
    assert.deepEqual(blocksOf(chunks), [{ type: 'text', text: '好的' }])
    assert.deepEqual(chunks.find((chunk) => chunk.type === 'usage')?.usage, {
      inputTokens: 2,
      outputTokens: 2,
      cacheReadTokens: 1,
    })
    assert.deepEqual(chunks.find((chunk) => chunk.type === 'finish')?.reason, { kind: 'stop' })
    assert.match(captured.path, /\/v1\/responses$/)
    assert.equal(captured.body.store, false)
    assert.equal('max_output_tokens' in captured.body, false)
    const input = captured.body.input as { role: string }[]
    assert.equal(input[0]?.role, 'system')
  } finally {
    await mock.close()
  }
})

test('an explicit output cap is sent, the pi fallback is not', async () => {
  const captured: Captured = { path: '', body: {} }
  const mock = await startMock(chatToolStream, captured)
  try {
    await collect(
      streamFor({
        provider: provider('openai-completions', mock.baseURL, { defaultMaxTokens: 2048 }),
        model: 'mock-1',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      }),
    )
    assert.equal(captured.body.max_tokens, 2048)

    await collect(
      streamFor({
        provider: provider('openai-completions', mock.baseURL, { defaultMaxTokens: 2048 }),
        model: 'mock-1',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        maxTokens: 123,
      }),
    )
    assert.equal(captured.body.max_tokens, 123)
  } finally {
    await mock.close()
  }
})

test('the agent kernel omits the implicit pi output cap too', async () => {
  const captured: Captured = { path: '', body: {} }
  const mock = await startMock(chatTextStream, captured)
  const run = async (config: Partial<ProviderConfig>): Promise<void> => {
    const p = provider('openai-completions', mock.baseURL, config)
    const agent = new Agent({
      initialState: { systemPrompt: 'SYS', model: toPiModel(p, 'mock-1') },
      streamFn: createPiStreamFn(p),
      convertToLlm: (messages) => messages,
    })
    await agent.prompt('hi')
  }
  try {
    await run({})
    assert.equal('max_tokens' in captured.body, false)
    assert.equal('max_completion_tokens' in captured.body, false)

    captured.body = {}
    await run({ defaultMaxTokens: 2048 })
    assert.equal(captured.body.max_tokens, 2048)
  } finally {
    await mock.close()
  }
})

test('long cache and opt-out keep prompt-cache fields under Denia control', async () => {
  const captured: Captured = { path: '', body: {} }
  const mock = await startMock(chatToolStream, captured)
  const send = async (options: Partial<ProviderConfig>): Promise<void> => {
    await collect(
      streamFor({
        provider: provider('openai-completions', mock.baseURL, options),
        model: 'mock-1',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        cacheKey: `session-${'x'.repeat(60)}`,
      }),
    )
  }
  try {
    await send({ longCache: true })
    assert.equal(captured.body.prompt_cache_key, 'pc_ef2786600162b04e')
    assert.equal(captured.body.prompt_cache_retention, '24h')

    await send({ supportsPromptCacheKey: false })
    assert.equal('prompt_cache_key' in captured.body, false)
    assert.equal('prompt_cache_retention' in captured.body, false)
  } finally {
    await mock.close()
  }
})

test('mid-stream provider errors keep the provider error code', async () => {
  const mock = await startMock(
    () => [sse({ error: { message: 'boom', code: 'bad' } }), 'data: [DONE]\n\n'].join(''),
    { path: '', body: {} },
  )
  try {
    await assert.rejects(
      collect(
        streamFor({
          provider: provider('openai-completions', mock.baseURL),
          model: 'mock-1',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
        }),
      ),
      (error: unknown) => error instanceof LlmRequestError && error.message.includes('boom'),
    )
  } finally {
    await mock.close()
  }
})

test('normalizePromptCacheKey trims short keys and digests long ones', () => {
  assert.equal(normalizePromptCacheKey('   '), undefined)
  assert.equal(normalizePromptCacheKey('  session-1 '), 'session-1')
  assert.equal(normalizePromptCacheKey('a'.repeat(64)), 'a'.repeat(64))
  const long = `session-${'x'.repeat(60)}`
  assert.equal(normalizePromptCacheKey(long), 'pc_ef2786600162b04e')
  assert.equal(
    normalizePromptCacheKey(`  ${long}y  `),
    normalizePromptCacheKey(`${long}y`),
  )
})