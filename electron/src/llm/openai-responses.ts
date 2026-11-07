// OpenAI Responses API adapter (`/v1/responses`).
//
// The wire is event-oriented: output items are created first and their text /
// arguments arrive as `*.delta` events. The assembler keeps the emitted chunk
// vocabulary identical to the chat-completions adapter.

import type { ChatMessage, FinishReason, StreamChunk, TokenUsage, ToolSchema } from '../core/wire.ts'
import { resolveApiKey } from '../config.ts'
import { ssePayloads, readErrorBody } from './sse.ts'
import { StreamAssembler } from './stream-assembler.ts'
import { LlmRequestError, type GenerateRequest } from './types.ts'

interface ResponsesEvent {
  type?: string
  item?: {
    id?: string
    type?: string
    role?: string
    name?: string
    call_id?: string
    arguments?: string
  }
  item_id?: string
  output_index?: number
  delta?: string
  response?: {
    status?: string
    incomplete_details?: { reason?: string } | null
    usage?: {
      input_tokens?: number
      output_tokens?: number
      input_tokens_details?: { cached_tokens?: number }
      output_tokens_details?: { reasoning_tokens?: number }
    }
    error?: { code?: string; message?: string }
  }
  error?: { code?: string; message?: string }
  message?: string
}

function toInput(messages: ChatMessage[]): unknown[] {
  const input: unknown[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const parts: unknown[] = []
      if (message.content) parts.push({ type: 'input_text', text: message.content })
      for (const image of message.images ?? []) {
        parts.push({ type: 'input_image', image_url: `data:${image.mime};base64,${image.data}` })
      }
      input.push({ role: 'user', content: parts })
      continue
    }
    if (message.role === 'assistant') {
      if (message.content) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] })
      }
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        })
      }
      continue
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId ?? '',
        output: message.content,
      })
    }
  }
  return input
}

function toTools(tools: ToolSchema[]): unknown[] | undefined {
  if (tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

function toolKey(event: ResponsesEvent): string {
  return `resp:${event.item_id ?? event.item?.id ?? event.output_index ?? 0}`
}

function usageOf(event: ResponsesEvent): TokenUsage | null {
  const usage = event.response?.usage
  if (!usage) return null
  const result: TokenUsage = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  }
  const cached = usage.input_tokens_details?.cached_tokens
  if (typeof cached === 'number') result.cacheReadTokens = cached
  const reasoning = usage.output_tokens_details?.reasoning_tokens
  if (typeof reasoning === 'number') result.reasoningTokens = reasoning
  return result
}

export async function* streamOpenAiResponses(request: GenerateRequest): AsyncGenerator<StreamChunk> {
  const { provider, signal } = request
  const apiKey = resolveApiKey(provider)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...(provider.headers ?? {}),
  }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`

  const body: Record<string, unknown> = {
    model: request.model,
    input: toInput(request.messages),
    stream: true,
  }
  if (request.system) body.instructions = request.system
  const tools = toTools(request.tools)
  if (tools) body.tools = tools
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.maxTokens !== undefined) body.max_output_tokens = request.maxTokens
  if (request.reasoningEffort) body.reasoning = { effort: request.reasoningEffort }

  const url = `${provider.baseURL.replace(/\/+$/, '')}/responses`
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
  let lastUsage: TokenUsage | null = null
  let finishReason: FinishReason = { kind: 'stop' }
  let incompleteReason: string | null = null
  const streamedArguments = new Set<string>()

  for await (const payload of ssePayloads(response.body)) {
    if (payload === '[DONE]') break
    let event: ResponsesEvent
    try {
      event = JSON.parse(payload) as ResponsesEvent
    } catch {
      continue
    }
    switch (event.type) {
      case 'response.output_item.added': {
        const item = event.item
        if (item?.type === 'function_call') {
          const key = toolKey(event)
          for (const chunk of assembler.toolCallDelta(key, {
            ...(item.call_id ?? item.id ? { id: item.call_id ?? item.id } : {}),
            ...(item.name === undefined ? {} : { name: item.name }),
            ...(item.arguments ? { arguments: item.arguments } : {}),
          })) {
            yield chunk
          }
        }
        break
      }
      case 'response.output_text.delta':
      case 'response.text.delta': {
        if (typeof event.delta === 'string' && event.delta.length > 0) {
          for (const chunk of assembler.textDelta(event.delta)) yield chunk
        }
        break
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        if (typeof event.delta === 'string' && event.delta.length > 0) {
          for (const chunk of assembler.reasoningDelta(event.delta)) yield chunk
        }
        break
      }
      case 'response.function_call_arguments.delta': {
        const key = toolKey(event)
        streamedArguments.add(key)
        if (typeof event.delta === 'string' && event.delta.length > 0) {
          for (const chunk of assembler.toolCallDelta(key, { arguments: event.delta })) yield chunk
        }
        break
      }
      case 'response.function_call_arguments.done': {
        const key = toolKey(event)
        if (typeof event.delta === 'string' && !streamedArguments.has(key)) {
          assembler.setToolArguments(key, event.delta)
        }
        break
      }
      case 'response.output_item.done': {
        const item = event.item
        if (item?.type === 'function_call') {
          const key = toolKey(event)
          if (item.arguments && !streamedArguments.has(key)) {
            assembler.setToolArguments(key, item.arguments)
          }
          if (item.call_id || item.id || item.name !== undefined) {
            for (const chunk of assembler.toolCallDelta(key, {
              ...(item.call_id ?? item.id ? { id: item.call_id ?? item.id } : {}),
              ...(item.name === undefined ? {} : { name: item.name }),
            })) {
              yield chunk
            }
          }
        }
        break
      }
      case 'response.completed': {
        lastUsage = usageOf(event) ?? lastUsage
        break
      }
      case 'response.incomplete': {
        incompleteReason = event.response?.incomplete_details?.reason ?? null
        lastUsage = usageOf(event) ?? lastUsage
        break
      }
      case 'response.failed': {
        const failure = event.response?.error
        throw new LlmRequestError(
          failure?.message ?? event.message ?? 'Responses API 返回失败',
          failure?.code ?? 'response-failed',
        )
      }
      case 'error': {
        throw new LlmRequestError(event.error?.message ?? '模型流返回错误', event.error?.code ?? 'llm-error')
      }
      default:
        break
    }
  }

  for (const chunk of assembler.finishChunks()) yield chunk
  if (assembler.hasToolCalls()) finishReason = { kind: 'tool-calls' }
  else if (incompleteReason === 'max_output_tokens') finishReason = { kind: 'max-tokens' }
  if (lastUsage) yield { type: 'usage', usage: lastUsage }
  yield { type: 'finish', reason: finishReason }
}