// OpenAI Responses API adapter (`/v1/responses`).
//
// The official SDK owns HTTP and SSE framing. This adapter maps Responses
// events (text/reasoning deltas, function calls, terminal response) onto the
// shared chunk vocabulary the web UI already folds.

import type OpenAI from 'openai'

import type { ChatMessage, FinishReason, StreamChunk, TokenUsage, ToolSchema } from '../core/wire.ts'
import { openAiClient, isAbortError, toRequestError } from './client.ts'
import { isRecord, mapResponsesUsage } from './normalize.ts'
import { StreamAssembler } from './stream-assembler.ts'
import { LlmRequestError, type GenerateRequest } from './types.ts'

interface ResponsesEvent {
  type?: string
  item?: Record<string, unknown>
  item_id?: string
  output_index?: number
  delta?: string
  arguments?: string
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
      for (const replay of message.reasoningReplay ?? []) {
        if (
          replay.protocol === 'openai-responses' &&
          isRecord(replay.payload) &&
          replay.payload.type === 'reasoning' &&
          typeof replay.payload.encrypted_content === 'string' &&
          replay.payload.encrypted_content.length > 0
        ) {
          input.push(replay.payload)
        }
      }
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

export async function* streamOpenAiResponses(request: GenerateRequest): AsyncGenerator<StreamChunk> {
  const { provider, signal } = request
  const client = openAiClient(provider)
  const body: Record<string, unknown> = {
    model: request.model,
    input: toInput(request.messages),
    stream: true,
    // Self-hosted and gateway endpoints have no conversation store; without
    // this flag some of them reject the request outright.
    store: false,
    // Needed for reasoning items to come back replayable on the next turn.
    include: ['reasoning.encrypted_content'],
  }
  if (request.system) body.instructions = request.system
  const tools = toTools(request.tools)
  if (tools) body.tools = tools
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.maxTokens !== undefined) body.max_output_tokens = request.maxTokens
  if (request.reasoningEffort && request.reasoningEffort !== 'off') {
    body.reasoning = { effort: request.reasoningEffort }
  }

  const assembler = new StreamAssembler()
  let usage: TokenUsage | null = null
  let incomplete = false
  let hadToolCall = false
  let sawBlock = false
  const streamedArguments = new Set<string>()

  try {
    const stream = await client.responses.create(
      body as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
      { signal },
    )
    for await (const raw of stream) {
      const event = raw as unknown as ResponsesEvent
      switch (event.type) {
        case 'response.output_item.added': {
          const item = event.item
          if (item?.type === 'function_call') {
            const key = toolKey(event)
            sawBlock = true
            hadToolCall = true
            yield* assembler.toolCallDelta(key, {
              ...(typeof item.call_id === 'string' ? { id: item.call_id } : {}),
              ...(typeof item.name === 'string' ? { name: item.name } : {}),
            })
          }
          break
        }
        case 'response.output_text.delta':
        case 'response.text.delta': {
          if (typeof event.delta === 'string' && event.delta.length > 0) {
            sawBlock = true
            yield* assembler.textDelta(event.delta)
          }
          break
        }
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
        case 'response.reasoning.delta': {
          if (typeof event.delta === 'string' && event.delta.length > 0) {
            sawBlock = true
            yield* assembler.reasoningDelta(event.delta)
          }
          break
        }
        case 'response.function_call_arguments.delta': {
          const key = toolKey(event)
          streamedArguments.add(key)
          if (typeof event.delta === 'string' && event.delta.length > 0) {
            sawBlock = true
            yield* assembler.toolCallDelta(key, { arguments: event.delta })
          }
          break
        }
        case 'response.function_call_arguments.done': {
          const key = toolKey(event)
          if (typeof event.arguments === 'string' && !streamedArguments.has(key)) {
            assembler.setToolArguments(key, event.arguments)
          }
          break
        }
        case 'response.output_item.done': {
          const item = event.item
          if (item?.type === 'function_call') {
            const key = toolKey(event)
            if (typeof item.arguments === 'string' && !streamedArguments.has(key)) {
              assembler.setToolArguments(key, item.arguments)
            }
            if (item.status === 'incomplete') assembler.setToolIncomplete(key)
            if (typeof item.call_id === 'string' || typeof item.name === 'string') {
              yield* assembler.toolCallDelta(key, {
                ...(typeof item.call_id === 'string' ? { id: item.call_id } : {}),
                ...(typeof item.name === 'string' ? { name: item.name } : {}),
              })
            }
          } else if (item?.type === 'reasoning') {
            assembler.setReasoningReplay('openai-responses', item)
          }
          break
        }
        case 'response.completed': {
          const next = event.response?.usage
          if (next) usage = mapResponsesUsage(next)
          break
        }
        case 'response.incomplete': {
          incomplete = true
          const next = event.response?.usage
          if (next) usage = mapResponsesUsage(next)
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
          throw new LlmRequestError(
            event.error?.message ?? '模型流返回错误',
            event.error?.code ?? 'llm-error',
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

  if (!sawBlock) {
    throw new LlmRequestError('the model produced no output blocks', 'EMPTY_RESPONSE')
  }
  // Gateways that only append `[DONE]` never send `response.completed`; the
  // SDK hides that sentinel, so a non-empty stream without a terminal event is
  // accepted rather than reporting every such turn as truncated.
  for (const item of assembler.finishChunks()) yield item
  if (usage) yield { type: 'usage', usage }
  yield {
    type: 'finish',
    reason: hadToolCall ? { kind: 'tool-calls' } : incomplete ? { kind: 'max-tokens' } : { kind: 'stop' },
  }
}