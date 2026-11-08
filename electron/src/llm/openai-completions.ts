// OpenAI-compatible chat completions adapter (`/v1/chat/completions`).
//
// The official SDK owns HTTP and SSE framing. This adapter only maps provider
// dialetries (content shapes, reasoning field names, cache accounting) onto
// the shared chunk vocabulary the web UI already folds.

import type OpenAI from 'openai'

import type { ChatMessage, FinishReason, StreamChunk, TokenUsage, ToolSchema } from '../core/wire.ts'
import { normalizePromptCacheKey } from './cache.ts'
import { openAiClient, isAbortError, toRequestError } from './client.ts'
import { InlineThinkSplitter, chatFinishReason, contentText, mapChatUsage, reasoningText } from './normalize.ts'
import { StreamAssembler } from './stream-assembler.ts'
import { LlmRequestError, type GenerateRequest } from './types.ts'

interface RawDelta {
  content?: unknown
  reasoning_content?: unknown
  refusal?: unknown
  tool_calls?: RawToolCall[]
  function_call?: { name?: string; arguments?: string }
  [key: string]: unknown
}

interface RawToolCall {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface RawChunk {
  choices?: Array<{
    index?: number
    delta?: RawDelta
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  }
  error?: { message?: string; code?: string; type?: string }
}

function toOpenAiMessages(system: string | undefined, messages: ChatMessage[]): unknown[] {
  const out: unknown[] = []
  if (system !== undefined && system.length > 0) {
    out.push({ role: 'system', content: system })
  }
  for (const message of messages) {
    if (message.role === 'user' && message.images && message.images.length > 0) {
      const parts: unknown[] = []
      if (message.content) parts.push({ type: 'text', text: message.content })
      for (const image of message.images) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${image.mime};base64,${image.data}` },
        })
      }
      out.push({ role: 'user', content: parts })
      continue
    }
    if (message.role === 'assistant') {
      const entry: Record<string, unknown> = {
        role: 'assistant',
        content: message.content || null,
      }
      if (message.reasoningContent) entry.reasoning_content = message.reasoningContent
      if (message.toolCalls && message.toolCalls.length > 0) {
        entry.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }))
      }
      out.push(entry)
      continue
    }
    if (message.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content })
      continue
    }
    out.push({ role: message.role, content: message.content })
  }
  return out
}

function toOpenAiTools(tools: ToolSchema[]): unknown[] | undefined {
  if (tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

export async function* streamOpenAi(request: GenerateRequest): AsyncGenerator<StreamChunk> {
  const { provider, signal } = request
  const client = openAiClient(provider)
  const tools = toOpenAiTools(request.tools)
  const body: Record<string, unknown> = {
    model: request.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: toOpenAiMessages(request.system, request.messages),
  }
  if (tools) body.tools = tools
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
  if (request.stop && request.stop.length > 0) body.stop = request.stop
  if (request.reasoningEffort && request.reasoningEffort !== 'off') {
    body.reasoning_effort = request.reasoningEffort
  }
  const cacheKey = request.cacheKey === undefined ? undefined : normalizePromptCacheKey(request.cacheKey)
  // Strict gateways reject unknown body fields, so the affinity hint is opt-out.
  if (cacheKey !== undefined && provider.supportsPromptCacheKey !== false) {
    body.prompt_cache_key = cacheKey
  }
  if (provider.longCache === true) body.prompt_cache_retention = '24h'

  const assembler = new StreamAssembler()
  const splitter = new InlineThinkSplitter(provider.inlineThinkTags === true)
  let finish: FinishReason | null = null
  let usage: TokenUsage | null = null
  let sawBlock = false
  let nextToolIndex = 0
  let lastToolIndex = 0

  const emitText = (text: string): StreamChunk[] => {
    sawBlock = true
    return assembler.textDelta(text)
  }
  const emitReasoning = (text: string): StreamChunk[] => {
    sawBlock = true
    return assembler.reasoningDelta(text)
  }
  const flushLeadAsText = (): StreamChunk[] => {
    const pending = splitter.flushAsText()
    return pending === null ? [] : emitText(pending)
  }
  const flushLeadAtEnd = (): StreamChunk[] => {
    const pending = splitter.flushAtEnd()
    if (pending === null) return []
    const out: StreamChunk[] = []
    if (pending.reasoning) out.push(...emitReasoning(pending.reasoning))
    if (pending.text) out.push(...emitText(pending.text))
    return out
  }

  try {
    const stream = await client.chat.completions.create(
      body as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
      { signal },
    )
    for await (const raw of stream) {
      const chunk = raw as unknown as RawChunk
      if (chunk.error) {
        throw new LlmRequestError(
          chunk.error.message ?? 'the provider reported an error mid-stream',
          chunk.error.code ?? chunk.error.type ?? 'PROVIDER_ERROR',
        )
      }
      if (chunk.usage) usage = mapChatUsage(chunk.usage)

      const choices = chunk.choices ?? []
      const choice = choices.find((entry) => (entry.index ?? 0) === 0) ?? choices[0]
      if (!choice?.delta) continue
      const delta = choice.delta

      const reasoning = reasoningText(delta)
      if (reasoning) {
        yield* flushLeadAsText()
        yield* emitReasoning(reasoning)
      }

      const text = contentText(delta.content)
      if (text) {
        if (splitter.active) {
          const split = splitter.push(text)
          if (split && split.reasoning) yield* emitReasoning(split.reasoning)
          if (split && split.text) yield* emitText(split.text)
        } else {
          yield* emitText(text)
        }
      }

      if (typeof delta.refusal === 'string' && delta.refusal.length > 0) {
        yield* flushLeadAsText()
        yield* emitText(delta.refusal)
      }

      if (delta.tool_calls) {
        yield* flushLeadAsText()
        for (const call of delta.tool_calls) {
          let key: string
          if (call.index !== undefined) {
            key = `openai:${call.index}`
            lastToolIndex = call.index
            if (call.index >= nextToolIndex) nextToolIndex = call.index + 1
          } else if (call.id || call.function?.name) {
            key = `openai:${nextToolIndex}`
            lastToolIndex = nextToolIndex
            nextToolIndex += 1
          } else {
            key = `openai:${lastToolIndex}`
          }
          sawBlock = true
          for (const item of assembler.toolCallDelta(key, {
            ...(call.id === undefined ? {} : { id: call.id }),
            ...(call.function?.name === undefined ? {} : { name: call.function.name }),
            ...(call.function?.arguments === undefined ? {} : { arguments: call.function.arguments }),
          })) {
            yield item
          }
        }
      }

      if (delta.function_call) {
        yield* flushLeadAsText()
        const key = `openai:${nextToolIndex}`
        nextToolIndex += 1
        lastToolIndex = nextToolIndex - 1
        sawBlock = true
        for (const item of assembler.toolCallDelta(key, {
          ...(delta.function_call.name === undefined ? {} : { name: delta.function_call.name }),
          ...(delta.function_call.arguments === undefined
            ? {}
            : { arguments: delta.function_call.arguments }),
        })) {
          yield item
        }
      }

      const mapped = chatFinishReason(choice.finish_reason)
      if (mapped) finish = mapped
    }
  } catch (error) {
    if (isAbortError(error, signal)) throw error
    throw toRequestError(error)
  }

  yield* flushLeadAtEnd()
  if (!sawBlock) {
    throw new LlmRequestError('the model produced no output blocks', 'EMPTY_RESPONSE')
  }
  for (const item of assembler.finishChunks()) yield item
  if (usage) yield { type: 'usage', usage }
  yield {
    type: 'finish',
    reason: finish ?? (assembler.hasToolCalls() ? { kind: 'tool-calls' } : { kind: 'stop' }),
  }
}