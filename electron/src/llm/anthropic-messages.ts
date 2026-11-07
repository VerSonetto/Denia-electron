// Anthropic Messages adapter (`/v1/messages`).
//
// The official SDK owns HTTP and SSE framing. This adapter maps raw message
// events (text/thinking/signature/tool-use) onto the shared chunk vocabulary,
// keeping provider-native thinking blocks for the next turn's replay.

import type Anthropic from '@anthropic-ai/sdk'

import type {
  ChatMessage,
  ContentBlock,
  FinishReason,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from '../core/wire.ts'
import { anthropicClient, isAbortError, toRequestError } from './client.ts'
import { isRecord } from './normalize.ts'
import { StreamAssembler } from './stream-assembler.ts'
import { LlmRequestError, type GenerateRequest } from './types.ts'

const DEFAULT_MAX_TOKENS = 8192

interface AnthropicEvent {
  type?: string
  index?: number
  message?: {
    usage?: {
      input_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  content_block?: Record<string, unknown>
  delta?: Record<string, unknown>
  usage?: {
    output_tokens?: number
    input_tokens?: number
    cache_read_input_tokens?: number
  }
  error?: { type?: string; message?: string }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseToolInput(argumentsText: string): unknown {
  try {
    const parsed = JSON.parse(argumentsText) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: { role: 'user' | 'assistant'; content: unknown[] }[] = []
  const push = (role: 'user' | 'assistant', parts: unknown[]): void => {
    if (parts.length === 0) return
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(...parts)
    else out.push({ role, content: parts })
  }
  for (const message of messages) {
    if (message.role === 'user') {
      const parts: unknown[] = []
      if (message.content) parts.push({ type: 'text', text: message.content })
      for (const image of message.images ?? []) {
        parts.push({
          type: 'image',
          source: { type: 'base64', media_type: image.mime, data: image.data },
        })
      }
      push('user', parts)
      continue
    }
    if (message.role === 'assistant') {
      const parts: unknown[] = []
      for (const replay of message.reasoningReplay ?? []) {
        if (
          replay.protocol === 'anthropic-messages' &&
          isRecord(replay.payload) &&
          (replay.payload.type === 'thinking' || replay.payload.type === 'redacted_thinking')
        ) {
          parts.push(replay.payload)
        }
      }
      if (message.content) parts.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls ?? []) {
        parts.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: parseToolInput(call.arguments),
        })
      }
      push('assistant', parts)
      continue
    }
    if (message.role === 'tool') {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId ?? '',
          content: message.content,
        },
      ])
    }
  }
  return out
}

function toTools(tools: ToolSchema[]): unknown[] | undefined {
  if (tools.length === 0) return undefined
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
}

/** Anthropic's effort presets, clamped to the request's output budget below. */
function thinkingBudget(effort: string | undefined): number | null {
  switch (effort) {
    case 'low':
      return 4096
    case 'medium':
      return 8192
    case 'high':
      return 16384
    case 'xhigh':
      return 24576
    case 'max':
      return 32768
    default:
      return null
  }
}

function finishOf(stopReason: string | null, hasToolCalls: boolean): FinishReason {
  if (stopReason === 'refusal') {
    throw new LlmRequestError('the model refused to continue', 'REFUSED')
  }
  if (stopReason === 'tool_use' || hasToolCalls) return { kind: 'tool-calls' }
  if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') {
    return { kind: 'max-tokens' }
  }
  if (stopReason === null || stopReason === 'end_turn' || stopReason === 'stop_sequence') {
    return { kind: 'stop' }
  }
  throw new LlmRequestError(
    `model stopped with unknown reason: ${stopReason}`,
    stopReason.toUpperCase(),
  )
}

export async function* streamAnthropic(request: GenerateRequest): AsyncGenerator<StreamChunk> {
  const { provider, signal } = request
  const client = anthropicClient(provider)
  const maxTokens = request.maxTokens ?? provider.defaultMaxTokens ?? DEFAULT_MAX_TOKENS
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: maxTokens,
    messages: toAnthropicMessages(request.messages),
    stream: true,
  }
  if (request.system) body.system = request.system
  const tools = toTools(request.tools)
  if (tools) body.tools = tools
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.stop && request.stop.length > 0) body.stop_sequences = request.stop
  const budget = thinkingBudget(request.reasoningEffort)
  if (budget !== null) {
    const budgetTokens = Math.min(budget, maxTokens - 1)
    // Below the API's floor the request would be rejected; skip thinking then.
    if (budgetTokens >= 1024) {
      body.thinking = { type: 'enabled', budget_tokens: budgetTokens }
    }
  }

  const assembler = new StreamAssembler()
  // Provider-native blocks, keyed by Anthropic's content index. Thinking
  // blocks are replayed verbatim next turn (signature included).
  const native = new Map<number, Record<string, unknown>>()
  const closed = new Set<number>()
  let sawBlock = false
  let stopped = false
  let stopReason: string | null = null
  let inputTokens = 0
  let cacheReadTokens = 0
  let outputTokens = 0

  try {
    const stream = await client.messages.create(
      body as unknown as Anthropic.MessageCreateParamsStreaming,
      { signal },
    )
    for await (const raw of stream) {
      const event = raw as unknown as AnthropicEvent
      switch (event.type) {
        case 'message_start': {
          inputTokens = event.message?.usage?.input_tokens ?? 0
          cacheReadTokens = event.message?.usage?.cache_read_input_tokens ?? 0
          break
        }
        case 'content_block_start': {
          const index = event.index ?? 0
          const block = { ...(event.content_block ?? {}) }
          native.set(index, block)
          const type = str(block.type)
          if (type === 'text') {
            sawBlock = true
            yield* assembler.openText()
            const initial = str(block.text)
            if (initial) yield* assembler.textDelta(initial)
          } else if (type === 'thinking') {
            sawBlock = true
            yield* assembler.openReasoning()
            const initial = str(block.thinking)
            if (initial) yield* assembler.reasoningDelta(initial)
          } else if (type === 'redacted_thinking') {
            sawBlock = true
            yield* assembler.openReasoning()
          } else if (type === 'tool_use') {
            sawBlock = true
            yield* assembler.toolCallDelta(`anthropic:${index}`, {
              ...(str(block.id) === undefined ? {} : { id: str(block.id) }),
              ...(str(block.name) === undefined ? {} : { name: str(block.name) }),
            })
          }
          break
        }
        case 'content_block_delta': {
          const index = event.index ?? 0
          const delta = event.delta ?? {}
          const type = str(delta.type)
          if (type === 'text_delta') {
            const text = str(delta.text)
            if (text) yield* assembler.textDelta(text)
          } else if (type === 'thinking_delta') {
            const text = str(delta.thinking)
            if (text) {
              const block = native.get(index)
              if (block) block.thinking = `${str(block.thinking) ?? ''}${text}`
              yield* assembler.reasoningDelta(text)
            }
          } else if (type === 'signature_delta') {
            const signature = str(delta.signature)
            if (signature) {
              const block = native.get(index)
              if (block) block.signature = `${str(block.signature) ?? ''}${signature}`
            }
          } else if (type === 'input_json_delta') {
            const partial = str(delta.partial_json)
            if (partial) {
              yield* assembler.toolCallDelta(`anthropic:${index}`, { arguments: partial })
            }
          }
          break
        }
        case 'content_block_stop': {
          const index = event.index ?? 0
          closed.add(index)
          const block = native.get(index)
          const type = block ? str(block.type) : undefined
          if (type === 'thinking' || type === 'redacted_thinking') {
            if (block) assembler.setReasoningReplay('anthropic-messages', block)
          } else if (type === 'tool_use' && block) {
            const input = block.input
            if (isRecord(input) && Object.keys(input).length > 0) {
              assembler.setToolArguments(`anthropic:${index}`, JSON.stringify(input))
            }
          }
          break
        }
        case 'message_delta': {
          const stop = str(event.delta?.stop_reason)
          if (stop) stopReason = stop
          if (typeof event.usage?.output_tokens === 'number') {
            outputTokens = event.usage.output_tokens
          }
          if (typeof event.usage?.input_tokens === 'number') inputTokens = event.usage.input_tokens
          if (typeof event.usage?.cache_read_input_tokens === 'number') {
            cacheReadTokens = event.usage.cache_read_input_tokens
          }
          break
        }
        case 'message_stop': {
          stopped = true
          break
        }
        case 'error': {
          throw new LlmRequestError(
            event.error?.message ?? 'Anthropic 流返回错误',
            event.error?.type ?? 'llm-error',
          )
        }
        default:
          break
      }
    }
  } catch (error) {
    if (isAbortError(error, signal)) throw error
    throw toRequestError(error)
  }

  if (!stopped) {
    throw new LlmRequestError('stream ended before message_stop', 'STREAM_CLOSED')
  }
  if (!sawBlock) {
    throw new LlmRequestError('the model produced no output blocks', 'EMPTY_RESPONSE')
  }
  // A tool_use block without its content_block_stop is incomplete.
  for (const key of assembler.toolKeys()) {
    const index = Number(key.slice('anthropic:'.length))
    if (!closed.has(index)) assembler.setToolIncomplete(key)
  }

  const usage: TokenUsage = { inputTokens, outputTokens }
  if (cacheReadTokens > 0) usage.cacheReadTokens = cacheReadTokens

  for (const chunk of assembler.finishChunks()) yield chunk
  yield { type: 'usage', usage }
  yield { type: 'finish', reason: finishOf(stopReason, assembler.hasToolCalls()) }
}

export type { ContentBlock }