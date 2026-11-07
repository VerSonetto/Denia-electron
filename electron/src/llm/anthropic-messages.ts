// Anthropic Messages API adapter (`/v1/messages`).
//
// Tool results travel inside a `user` message as `tool_result` parts, and
// consecutive same-role messages must be merged. Streaming is a sequence of
// `content_block_*` events; the assembler maps them onto the shared chunk
// vocabulary used by the UI.

import type { ChatMessage, ContentBlock, FinishReason, StreamChunk, TokenUsage, ToolSchema } from '../core/wire.ts'
import { resolveApiKey } from '../config.ts'
import { ssePayloads, readErrorBody } from './sse.ts'
import { StreamAssembler } from './stream-assembler.ts'
import { LlmRequestError, type GenerateRequest } from './types.ts'

const ANTHROPIC_VERSION = '2023-06-01'
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
  content_block?: {
    type?: string
    id?: string
    name?: string
  }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string | null
  }
  usage?: {
    output_tokens?: number
    input_tokens?: number
    cache_read_input_tokens?: number
  }
  error?: { type?: string; message?: string }
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

function thinkingBudget(effort: string | undefined): number | null {
  switch (effort) {
    case 'low':
      return 2048
    case 'medium':
      return 4096
    case 'high':
      return 8192
    case 'xhigh':
      return 12000
    case 'max':
      return 16384
    default:
      return null
  }
}

export async function* streamAnthropic(request: GenerateRequest): AsyncGenerator<StreamChunk> {
  const { provider, signal } = request
  const apiKey = resolveApiKey(provider)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'anthropic-version': ANTHROPIC_VERSION,
    ...(provider.headers ?? {}),
  }
  if (apiKey) headers['x-api-key'] = apiKey

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
  if (budget !== null && maxTokens > budget + 1024) {
    body.thinking = { type: 'enabled', budget_tokens: budget }
  }

  const url = `${provider.baseURL.replace(/\/+$/, '')}/messages`
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok || !response.body) {
    const error = await readErrorBody(response)
    throw new LlmRequestError(error.message, error.code ?? `http-${response.status}`, response.status)
  }

  const assembler = new StreamAssembler()
  let inputTokens = 0
  let cacheReadTokens = 0
  let outputTokens = 0
  let stopReason: string | null = null

  for await (const payload of ssePayloads(response.body)) {
    let event: AnthropicEvent
    try {
      event = JSON.parse(payload) as AnthropicEvent
    } catch {
      continue
    }
    switch (event.type) {
      case 'message_start': {
        inputTokens = event.message?.usage?.input_tokens ?? 0
        cacheReadTokens = event.message?.usage?.cache_read_input_tokens ?? 0
        break
      }
      case 'content_block_start': {
        const block = event.content_block
        if (block?.type === 'tool_use') {
          const key = `anthropic:${event.index ?? 0}`
          for (const chunk of assembler.toolCallDelta(key, {
            ...(block.id === undefined ? {} : { id: block.id }),
            ...(block.name === undefined ? {} : { name: block.name }),
          })) {
            yield chunk
          }
        }
        break
      }
      case 'content_block_delta': {
        const delta = event.delta
        if (delta?.type === 'text_delta' && delta.text) {
          for (const chunk of assembler.textDelta(delta.text)) yield chunk
        } else if (delta?.type === 'thinking_delta' && delta.thinking) {
          for (const chunk of assembler.reasoningDelta(delta.thinking)) yield chunk
        } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
          const key = `anthropic:${event.index ?? 0}`
          for (const chunk of assembler.toolCallDelta(key, { arguments: delta.partial_json })) yield chunk
        }
        break
      }
      case 'message_delta': {
        if (event.delta?.stop_reason !== undefined) stopReason = event.delta.stop_reason
        if (event.usage?.output_tokens !== undefined) outputTokens = event.usage.output_tokens
        if (event.usage?.input_tokens !== undefined) inputTokens = event.usage.input_tokens
        if (event.usage?.cache_read_input_tokens !== undefined) {
          cacheReadTokens = event.usage.cache_read_input_tokens
        }
        break
      }
      case 'message_stop': {
        break
      }
      case 'error': {
        throw new LlmRequestError(event.error?.message ?? 'Anthropic 流返回错误', event.error?.type ?? 'llm-error')
      }
      default:
        break
    }
  }

  const usage: TokenUsage = { inputTokens, outputTokens }
  if (cacheReadTokens > 0) usage.cacheReadTokens = cacheReadTokens

  for (const chunk of assembler.finishChunks()) yield chunk
  yield { type: 'usage', usage }
  let finishReason: FinishReason = { kind: 'stop' }
  if (stopReason === 'tool_use' || assembler.hasToolCalls()) finishReason = { kind: 'tool-calls' }
  else if (stopReason === 'max_tokens') finishReason = { kind: 'max-tokens' }
  yield { type: 'finish', reason: finishReason }
}