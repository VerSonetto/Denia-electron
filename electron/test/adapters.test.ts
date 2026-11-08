// Adapter-level tests for the two non-completions protocols.
//
// Each mock speaks exactly the event vocabulary the adapter claims to handle;
// assertions cover the shared chunk vocabulary (what the UI folds) plus the
// request shape (system/tools/max_tokens) that providers actually receive.

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import type { StreamChunk } from '../src/core/wire.ts'
import {
  applyAnthropicMessageCaching,
  normalizePromptCacheKey,
  type WireCacheMeta,
} from '../src/llm/cache.ts'
import { streamFor, LlmRequestError } from '../src/llm/index.ts'
import type { ProviderConfig } from '../src/config.ts'

const sse = (payload: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(payload)}\n\n`

interface Captured {
  path: string
  body: Record<string, unknown>
  headers?: http.IncomingHttpHeaders
}

async function startMock(handler: (path: string, body: Record<string, unknown>) => string, captured: Captured): Promise<{ baseURL: string; close(): Promise<void> }> {
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
      res.end(handler(req.url ?? '', body))
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

test('openai-responses maps event stream to shared chunks', async () => {
  const captured: Captured = { path: '', body: {} }
  const mock = await startMock((path) => {
    assert.match(path, /\/v1\/responses$/)
    return [
      sse({ type: 'response.created' }),
      sse({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant' } }),
      sse({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: '你好' }),
      sse({ type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message' } }),
      sse({
        type: 'response.output_item.added',
        output_index: 1,
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '' },
      }),
      sse({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"command":"echo ok"}' }),
      sse({
        type: 'response.output_item.done',
        output_index: 1,
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '{"command":"echo ok"}' },
      }),
      sse({
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: {
            input_tokens: 12,
            output_tokens: 7,
            input_tokens_details: { cached_tokens: 3 },
            output_tokens_details: { reasoning_tokens: 2 },
          },
        },
      }),
    ].join('')
  }, captured)

  try {
    const chunks = await collect(
      streamFor({
        provider: provider('openai-responses', mock.baseURL),
        model: 'mock-1',
        system: 'SYS',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
      }),
    )
    const blocks = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
    assert.deepEqual(blocks[0], { type: 'text', text: '你好' })
    assert.deepEqual(blocks[1], {
      type: 'tool-call',
      id: 'call_1',
      name: 'bash',
      arguments: '{"command":"echo ok"}',
    })
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    // Rust contract: input_tokens is the uncached prompt (12 - 3 cached).
    assert.deepEqual(usage?.usage, {
      inputTokens: 9,
      outputTokens: 7,
      cacheReadTokens: 3,
      reasoningTokens: 2,
    })
    const finish = chunks.find((chunk) => chunk.type === 'finish')
    assert.deepEqual(finish?.reason, { kind: 'tool-calls' })

    assert.equal(captured.body.instructions, 'SYS')
    assert.deepEqual(captured.body.tools, [
      { type: 'function', name: 'bash', description: 'run', parameters: { type: 'object' } },
    ])
  } finally {
    await mock.close()
  }
})

test('openai-completions maps text, reasoning, tool calls and cached usage', async () => {
  const captured: Captured = { path: '', body: {} }
  const mock = await startMock((path) => {
    assert.match(path, /\/v1\/chat\/completions$/)
    return [
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
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } },
        ],
      }),
      sse({
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 3 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      }),
      'data: [DONE]\n\n',
    ].join('')
  }, captured)

  try {
    const chunks = await collect(
      streamFor({
        provider: provider('openai-completions', mock.baseURL),
        model: 'mock-1',
        system: 'SYS',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
        reasoningEffort: 'high',
      }),
    )
    const blocks = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
    assert.deepEqual(blocks[0], { type: 'reasoning', text: '先想' })
    assert.deepEqual(blocks[1], { type: 'text', text: '你好' })
    assert.deepEqual(blocks[2], {
      type: 'tool-call',
      id: 'call_1',
      name: 'bash',
      arguments: '{"command":"ls"}',
    })
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    assert.deepEqual(usage?.usage, {
      inputTokens: 9,
      outputTokens: 7,
      cacheReadTokens: 3,
      reasoningTokens: 2,
    })
    assert.deepEqual(chunks.find((chunk) => chunk.type === 'finish')?.reason, {
      kind: 'tool-calls',
    })

    assert.equal(captured.body.reasoning_effort, 'high')
    assert.deepEqual(captured.body.stream_options, { include_usage: true })
  } finally {
    await mock.close()
  }
})

test('openai-completions handles CRLF frames, content parts and thinking fields', async () => {
  const crlf = (payload: unknown) => `data: ${JSON.stringify(payload)}\r\n\r\n`
  const mock = await startMock(() =>
    [
      crlf({ choices: [{ index: 0, delta: { thinking: '推理' } }] }),
      crlf({ choices: [{ index: 0, delta: { content: [{ type: 'text', text: '数组正文' }] } }] }),
      crlf({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\r\n\r\n',
    ].join(''),
  { path: '', body: {} })

  try {
    const chunks = await collect(
      streamFor({
        provider: provider('openai-completions', mock.baseURL),
        model: 'mock-1',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      }),
    )
    const blocks = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
    assert.deepEqual(blocks[0], { type: 'reasoning', text: '推理' })
    assert.deepEqual(blocks[1], { type: 'text', text: '数组正文' })
  } finally {
    await mock.close()
  }
})

test('openai-completions surfaces mid-stream provider errors', async () => {
  const mock = await startMock(() =>
    [sse({ error: { message: 'boom', code: 'bad' } }), 'data: [DONE]\n\n'].join(''),
  { path: '', body: {} })

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
      (error: unknown) => error instanceof LlmRequestError && error.code === 'bad',
    )
  } finally {
    await mock.close()
  }
})

test('openai-completions rejects an empty completion', async () => {
  const mock = await startMock(() =>
    [
      sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 0 } }),
      'data: [DONE]\n\n',
    ].join(''),
  { path: '', body: {} })

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
      (error: unknown) => error instanceof LlmRequestError && error.code === 'EMPTY_RESPONSE',
    )
  } finally {
    await mock.close()
  }
})

test('openai-completions splits inline think tags', async () => {
  const mock = await startMock(() =>
    [
      sse({ choices: [{ index: 0, delta: { content: '思考中' } }] }),
      sse({ choices: [{ index: 0, delta: { content: '\u003c/think\u003e答案' } }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ].join(''),
  { path: '', body: {} })

  try {
    const chunks = await collect(
      streamFor({
        provider: provider('openai-completions', mock.baseURL, { inlineThinkTags: true }),
        model: 'mock-1',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      }),
    )
    const blocks = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
    assert.deepEqual(blocks[0], { type: 'reasoning', text: '思考中' })
    assert.deepEqual(blocks[1], { type: 'text', text: '答案' })
  } finally {
    await mock.close()
  }
})

test('openai-completions keeps quoted think-tag references in reasoning', async () => {
  const mock = await startMock(() =>
    [
      sse({ choices: [{ index: 0, delta: { content: '思考中 `' } }] }),
      sse({ choices: [{ index: 0, delta: { content: '\u003c/think\u003e` 直接拼在思考内容后' } }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ].join(''),
  { path: '', body: {} })

  try {
    const chunks = await collect(
      streamFor({
        provider: provider('openai-completions', mock.baseURL, { inlineThinkTags: true }),
        model: 'mock-1',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      }),
    )
    const blocks = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0]?.type, 'reasoning')
    assert.ok(blocks[0]?.text.startsWith('思考中'))
    assert.ok(blocks[0]?.text.endsWith('直接拼在思考内容后'))
    assert.ok(blocks[0]?.text.includes('think'))
  } finally {
    await mock.close()
  }
})

test('anthropic-messages maps content blocks and usage', async () => {
  const captured: Captured = { path: '', body: {} }
  const mock = await startMock((path) => {
    assert.match(path, /\/v1\/messages$/)
    return [
      sse({ type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 5 } } }, 'message_start'),
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }, 'content_block_start'),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '看一下' } }, 'content_block_delta'),
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
  }, captured)

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
    const blocks = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
    assert.deepEqual(blocks[0], { type: 'text', text: '看一下' })
    assert.deepEqual(blocks[1], {
      type: 'tool-call',
      id: 'tu_1',
      name: 'read_file',
      arguments: '{"path":"a"}',
    })
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    assert.deepEqual(usage?.usage, { inputTokens: 20, outputTokens: 9, cacheReadTokens: 5 })
    const finish = chunks.find((chunk) => chunk.type === 'finish')
    assert.deepEqual(finish?.reason, { kind: 'tool-calls' })

    assert.deepEqual(captured.body.system, [
      { type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } },
    ])
    assert.equal(captured.body.max_tokens, 8192)
    assert.deepEqual(captured.body.tools, [
      {
        name: 'read_file',
        description: 'read',
        input_schema: { type: 'object' },
        cache_control: { type: 'ephemeral' },
      },
    ])
    const messages = captured.body.messages as { role: string; content: unknown[] }[]
    assert.equal(messages[0]!.role, 'user')
    assert.equal(messages[1]!.role, 'assistant')
    assert.equal(messages[2]!.role, 'user')
    assert.equal((messages[2]!.content[0] as { type: string }).type, 'tool_result')
  } finally {
    await mock.close()
  }
})

const anthropicStream = (text = 'ok'): string =>
  [
    sse({ type: 'message_start', message: { usage: { input_tokens: 8 } } }, 'message_start'),
    sse(
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      'content_block_start',
    ),
    sse(
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      'content_block_delta',
    ),
    sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop'),
    sse(
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      'message_delta',
    ),
    sse({ type: 'message_stop' }, 'message_stop'),
  ].join('')

const chatStream = (): string =>
  [
    sse({ choices: [{ index: 0, delta: { content: 'ok' } }] }),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ].join('')

const responsesStream = (): string =>
  [
    sse({
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'msg_1', type: 'message', role: 'assistant' },
    }),
    sse({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'ok' }),
    sse({ type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message' } }),
    sse({
      type: 'response.completed',
      response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 2 } },
    }),
  ].join('')

test('anthropic-messages spends breakpoints on head anchors and the message tail', async () => {
  const captured: Captured = { path: '', body: {} }
  const mock = await startMock(() => anthropicStream(), captured)
  try {
    await collect(
      streamFor({
        provider: provider('anthropic-messages', mock.baseURL),
        model: 'mock-1',
        system: 'SYS',
        messages: [
          { role: 'user', content: '先看仓库', cache: { conversationalUser: true } },
          {
            role: 'assistant',
            content: '我看一下',
            reasoningReplay: [
              {
                protocol: 'anthropic-messages',
                payload: { type: 'thinking', thinking: '想', signature: 'sig' },
              },
            ],
            toolCalls: [{ id: 'tu_1', name: 'bash', arguments: '{}' }],
          },
          { role: 'tool', content: 'a.txt', toolCallId: 'tu_1' },
          { role: 'user', content: '继续', cache: { conversationalUser: true } },
        ],
        tools: [
          { name: 'bash', description: 'run', parameters: { type: 'object' } },
          { name: 'read_file', description: 'read', parameters: { type: 'object' } },
        ],
      }),
    )
  } finally {
    await mock.close()
  }

  const body = captured.body
  assert.deepEqual(body.system, [
    { type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } },
  ])
  const tools = body.tools as Record<string, unknown>[]
  assert.equal(tools[0]?.cache_control, undefined)
  assert.deepEqual(tools[1]?.cache_control, { type: 'ephemeral' })

  const messages = body.messages as { role: string; content: Record<string, unknown>[] }[]
  assert.equal(messages.length, 3)
  // Reasoning blocks never carry a breakpoint; the tool_use behind it does.
  assert.equal(messages[1]?.content[0]?.type, 'thinking')
  assert.equal(messages[1]?.content[0]?.cache_control, undefined)
  assert.deepEqual(messages[1]?.content.at(-1), {
    type: 'tool_use',
    id: 'tu_1',
    name: 'bash',
    input: {},
    cache_control: { type: 'ephemeral' },
  })
  // The tool result and the next real user turn merge; the turn keeps the flag,
  // so the tail breakpoint lands on the user's text block.
  const tail = messages[2]!
  assert.equal(tail.content[0]?.type, 'tool_result')
  assert.deepEqual(tail.content.at(-1), {
    type: 'text',
    text: '继续',
    cache_control: { type: 'ephemeral' },
  })

  const markCount = (blocks: Record<string, unknown>[]): number =>
    blocks.filter((block) => block.cache_control !== undefined).length
  const breakpoints =
    markCount(body.system as Record<string, unknown>[]) +
    markCount(tools) +
    messages.reduce((count, message) => count + markCount(message.content), 0)
  assert.ok(breakpoints <= 4, `breakpoints ${breakpoints} exceed the limit`)
})

test('anthropic-messages requests the long cache tier and its beta header', async () => {
  const captured: Captured = { path: '', body: {} }
  const mock = await startMock(() => anthropicStream(), captured)
  const betaOf = (headers: http.IncomingHttpHeaders | undefined): string => {
    const beta = headers?.['anthropic-beta']
    return Array.isArray(beta) ? beta.join(',') : (beta ?? '')
  }
  try {
    await collect(
      streamFor({
        provider: provider('anthropic-messages', mock.baseURL, {
          longCache: true,
          headers: { 'anthropic-beta': 'prompt-tools-2025-04-02' },
        }),
        model: 'mock-1',
        system: 'SYS',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
      }),
    )
    assert.deepEqual(
      (captured.body.system as { cache_control?: unknown }[])[0]?.cache_control,
      { type: 'ephemeral', ttl: '1h' },
    )
    const beta = betaOf(captured.headers)
    assert.match(beta, /prompt-tools-2025-04-02/)
    assert.match(beta, /extended-cache-ttl-2025-04-11/)

    // A caller that already opted in must not get the token twice.
    await collect(
      streamFor({
        provider: provider('anthropic-messages', mock.baseURL, {
          longCache: true,
          headers: { 'Anthropic-Beta': 'extended-cache-ttl-2025-04-11' },
        }),
        model: 'mock-1',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      }),
    )
    const merged = betaOf(captured.headers)
    assert.equal(merged.split('extended-cache-ttl-2025-04-11').length - 1, 1)
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

test('applyAnthropicMessageCaching spaces historical checkpoints 15 user turns apart', () => {
  const messages: { role: string; content: Record<string, unknown>[] }[] = []
  const metas: WireCacheMeta[] = []
  for (let turn = 0; turn < 45; turn += 1) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `u${turn}` }] })
    metas.push({ perCall: false, conversationalUser: true })
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `a${turn}` }] })
    metas.push({ perCall: false, conversationalUser: false })
  }
  // A rebuilt tail bounds the reusable prefix; it is never an anchor itself.
  messages.push({ role: 'assistant', content: [{ type: 'text', text: 'per-call' }] })
  metas.push({ perCall: true, conversationalUser: false })

  applyAnthropicMessageCaching(messages, metas, 0, { type: 'ephemeral' })

  const marked = messages.flatMap((message, index) =>
    message.content.some((block) => block.cache_control !== undefined) ? [index] : [],
  )
  assert.deepEqual(marked, [28, 58, 88, 89])
})

test('openai-completions sends a normalized prompt_cache_key', async () => {
  const captured: Captured = { path: '', body: {} }
  const mock = await startMock(() => chatStream(), captured)
  const longKey = `session-${'x'.repeat(60)}`
  const send = async (
    baseURL: string,
    cacheKey: string | undefined,
    options: Partial<ProviderConfig> = {},
  ): Promise<void> => {
    await collect(
      streamFor({
        provider: provider('openai-completions', baseURL, options),
        model: 'mock-1',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        ...(cacheKey === undefined ? {} : { cacheKey }),
      }),
    )
  }
  try {
    await send(mock.baseURL, longKey)
    assert.equal(captured.body.prompt_cache_key, 'pc_ef2786600162b04e')
    assert.equal(captured.body.prompt_cache_retention, undefined)

    await send(mock.baseURL, '  session-1  ')
    assert.equal(captured.body.prompt_cache_key, 'session-1')

    await send(mock.baseURL, 'session-1', { supportsPromptCacheKey: false })
    assert.equal('prompt_cache_key' in captured.body, false)

    await send(mock.baseURL, 'session-1', { longCache: true })
    assert.equal(captured.body.prompt_cache_key, 'session-1')
    assert.equal(captured.body.prompt_cache_retention, '24h')
  } finally {
    await mock.close()
  }
})

test('openai-responses sends a normalized prompt_cache_key', async () => {
  const captured: Captured = { path: '', body: {} }
  const mock = await startMock(() => responsesStream(), captured)
  const longKey = `session-${'x'.repeat(60)}`
  const send = async (
    baseURL: string,
    cacheKey: string | undefined,
    options: Partial<ProviderConfig> = {},
  ): Promise<void> => {
    await collect(
      streamFor({
        provider: provider('openai-responses', baseURL, options),
        model: 'mock-1',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        ...(cacheKey === undefined ? {} : { cacheKey }),
      }),
    )
  }
  try {
    await send(mock.baseURL, longKey)
    assert.equal(captured.body.prompt_cache_key, 'pc_ef2786600162b04e')
    assert.equal(captured.body.prompt_cache_retention, undefined)

    await send(mock.baseURL, 'session-1', { supportsPromptCacheKey: false })
    assert.equal('prompt_cache_key' in captured.body, false)

    await send(mock.baseURL, 'session-1', { longCache: true })
    assert.equal(captured.body.prompt_cache_key, 'session-1')
    assert.equal(captured.body.prompt_cache_retention, '24h')
  } finally {
    await mock.close()
  }
})
