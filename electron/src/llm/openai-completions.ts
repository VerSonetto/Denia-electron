// OpenAI-compatible chat completions adapter (`/v1/chat/completions`).
//
// One attempt streams `StreamChunk`s in the same shape the web UI folds from
// the Rust backend: block-start → deltas → block-end, then usage and finish.
// Mid-stream failures throw; the agent loop turns them into a turn-end event.

import type { ChatMessage, FinishReason, StreamChunk, TokenUsage, ToolSchema } from '../core/wire.ts'
import { resolveApiKey } from '../config.ts'
import { ssePayloads, readErrorBody } from './sse.ts'
import { StreamAssembler } from './stream-assembler.ts'
import { LlmRequestError, type GenerateRequest } from './types.ts'

interface OpenAiDelta {
  role?: string
  content?: string | null
  reasoning_content?: string | null
  reasoning?: string | null
  tool_calls?: {
    index?: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }[]
}

interface OpenAiChunk {
  choices?: {
    index?: number
    delta?: OpenAiDelta
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  }
  error?: { message?: string; code?: string }
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

function usageOf(chunk: OpenAiChunk): TokenUsage | null {
  if (!chunk.usage) return null
  const usage: TokenUsage = {
    inputTokens: chunk.usage.prompt_tokens ?? 0,
    outputTokens: chunk.usage.completion_tokens ?? 0,
  }
  const cached = chunk.usage.prompt_tokens_details?.cached_tokens
  if (typeof cached === 'number') usage.cacheReadTokens = cached
  const reasoning = chunk.usage.completion_tokens_details?.reasoning_tokens
  if (typeof reasoning === 'number') usage.reasoningTokens = reasoning
  return usage
}

export async function* streamOpenAi(request: GenerateRequest): AsyncGenerator<StreamChunk> {
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
    stream: true,
    stream_options: { include_usage: true },
    messages: toOpenAiMessages(request.system, request.messages),
  }
  const tools = toOpenAiTools(request.tools)
  if (tools) body.tools = tools
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
  if (request.stop && request.stop.length > 0) body.stop = request.stop
  if (request.reasoningEffort) body.reasoning_effort = request.reasoningEffort

  const url = `${provider.baseURL.replace(/\/+$/, '')}/chat/completions`
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
  let finishReason: FinishReason = { kind: 'stop' }
  let lastUsage: TokenUsage | null = null

  for await (const payload of ssePayloads(response.body)) {
    if (payload === '[DONE]') break
    let chunk: OpenAiChunk
    try {
      chunk = JSON.parse(payload) as OpenAiChunk
    } catch {
      continue
    }
    if (chunk.error) {
      throw new LlmRequestError(chunk.error.message ?? '模型流返回错误', chunk.error.code ?? 'llm-error')
    }
    const usage = usageOf(chunk)
    if (usage) lastUsage = usage

    const choice = chunk.choices?.[0]
    if (choice?.delta) {
      const delta = choice.delta
      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (reasoning) {
        for (const item of assembler.reasoningDelta(reasoning)) yield item
      }
      if (delta.content) {
        for (const item of assembler.textDelta(delta.content)) yield item
      }
      if (delta.tool_calls) {
        for (const raw of delta.tool_calls) {
          const key = `openai:${raw.index ?? 0}`
          for (const item of assembler.toolCallDelta(key, {
            ...(raw.id === undefined ? {} : { id: raw.id }),
            ...(raw.function?.name === undefined ? {} : { name: raw.function.name }),
            ...(raw.function?.arguments === undefined ? {} : { arguments: raw.function.arguments }),
          })) {
            yield item
          }
        }
      }
    }
    if (choice?.finish_reason) {
      if (choice.finish_reason === 'tool_calls' || assembler.hasToolCalls()) {
        finishReason = { kind: 'tool-calls' }
      } else if (choice.finish_reason === 'length') {
        finishReason = { kind: 'max-tokens' }
      } else {
        finishReason = { kind: 'stop' }
      }
    }
  }

  for (const item of assembler.finishChunks()) yield item
  if (lastUsage) yield { type: 'usage', usage: lastUsage }
  yield { type: 'finish', reason: finishReason }
}