// Denia <-> pi bridges.
//
// pi-ai owns every provider protocol (OpenAI chat completions, OpenAI
// responses, Anthropic messages) plus retries, thinking levels, prompt-cache
// hints and usage accounting. This module only maps Denia's provider settings,
// wire messages and chunk vocabulary onto that API. The agent kernel lives in
// `@earendil-works/pi-agent-core`; one-shot side calls (titles, compaction,
// review, prompt optimization) use the same bridge.

import {
  normalizeContext,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type ProviderId,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  type Usage,
} from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { streamSimple as anthropicStreamSimple } from '@earendil-works/pi-ai/api/anthropic-messages'
import { streamSimple as completionsStreamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { streamSimple as responsesStreamSimple } from '@earendil-works/pi-ai/api/openai-responses'

import type { ProviderConfig, WireProtocol } from '../config.ts'
import { resolveApiKey } from '../config.ts'
import type {
  ChatMessage,
  ContentBlock,
  FinishReason,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from '../core/wire.ts'
import { isRecord } from '../core/util.ts'
import { ChunkBuilder, chunksForAssistantEvent, finishChunk, usageChunk } from './chunks.ts'
import { splitInlineThinking } from './inline-think.ts'
import { normalizePromptCacheKey } from './cache-key.ts'
import { LlmRequestError, type GenerateRequest } from './types.ts'

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const THINKING_LEVELS = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

/** Denia stores a free-form effort string; pi accepts a fixed vocabulary. */
export function thinkingLevelOf(effort: string | undefined): 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  const value = (effort ?? '').trim()
  return (THINKING_LEVELS.has(value) ? value : 'off') as ReturnType<typeof thinkingLevelOf>
}

function apiOf(provider: ProviderConfig): Api {
  return provider.protocol ?? 'openai-completions'
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/** The Anthropic SDK appends `/v1/messages`; a configured `/v1` would double it. */
function baseUrlOf(provider: ProviderConfig): string {
  const base = trimSlash(provider.baseURL)
  return provider.protocol === 'anthropic-messages' ? base.replace(/\/v1$/, '') : base
}

function isOpenAiHost(baseUrl: string): boolean {
  try {
    return /(^|\.)api\.openai\.com(\/|$)/.test(new URL(baseUrl).hostname)
  } catch {
    return false
  }
}

function contextWindowOf(provider: ProviderConfig, modelId: string): number {
  const model = provider.models.find((entry) => entry.id === modelId)
  return model?.contextWindow ?? provider.defaultContextWindow ?? 128_000
}

function inputModalitiesOf(provider: ProviderConfig, modelId: string): ('text' | 'image')[] {
  const model = provider.models.find((entry) => entry.id === modelId)
  const values = model?.inputModalities ?? []
  const input: ('text' | 'image')[] = ['text']
  if (values.includes('image') || values.length === 0) input.push('image')
  return input
}

/**
 * Build a pi model from one Denia provider/model pair.
 *
 * Compatibility switches reproduce Denia's old wire behavior for arbitrary
 * OpenAI-compatible gateways: no `store` field, `max_tokens` instead of
 * `max_completion_tokens`, and an explicit prompt-cache key unless the route
 * opted out.
 */
export function toPiModel(
  provider: ProviderConfig,
  modelId: string,
  options: { reasoningEffort?: string } = {},
): Model<Api> {
  const config = provider.models.find((entry) => entry.id === modelId)
  const api = apiOf(provider)
  const baseUrl = baseUrlOf(provider)
  const openai = api === 'openai-completions' && isOpenAiHost(baseUrl)
  const reasoning =
    config?.thinkingSupported === true ||
    (config?.reasoningEfforts?.length ?? 0) > 0 ||
    options.reasoningEffort !== undefined
  const compat =
    api === 'openai-completions'
      ? {
          supportsStore: openai,
          promptCacheKeyMode: provider.supportsPromptCacheKey === false ? ('disabled' as const) : ('enabled' as const),
          ...(openai ? {} : { maxTokensField: 'max_tokens' as const }),
        }
      : api === 'anthropic-messages'
        ? { supportsMessageThreads: false }
        : { supportsDeveloperRole: openai }

  return {
    id: modelId,
    name: config?.name ?? config?.description ?? modelId,
    api,
    provider: provider.id as ProviderId,
    baseUrl,
    reasoning,
    input: inputModalitiesOf(provider, modelId),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextWindowOf(provider, modelId),
    maxTokens: provider.defaultMaxTokens ?? 8_192,
    ...(provider.headers ? { headers: provider.headers } : {}),
    ...(compat ? { compat: compat as Model<Api>['compat'] } : {}),
  }
}

export function toPiTools(tools: readonly ToolSchema[]): Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters:
      isRecord(tool.parameters) ? tool.parameters : { type: 'object', properties: {} },
  }))
}

function toolNamesOf(messages: readonly ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) names.set(call.id, call.name)
  }
  return names
}

function replayOf(
  message: ChatMessage,
  protocol: WireProtocol,
): Array<{ protocol: string; payload: unknown }> {
  return (message.reasoningReplay ?? []).filter((replay) => replay.protocol === protocol)
}

function thinkingContentOf(message: ChatMessage, provider: ProviderConfig): ThinkingContent[] {
  const reasoning = message.reasoningContent ?? ''
  const replays = replayOf(message, provider.protocol ?? 'openai-completions')
  if (provider.protocol === 'anthropic-messages') {
    return replays.flatMap((replay): ThinkingContent[] => {
      if (!isRecord(replay.payload)) return []
      if (replay.payload.type === 'redacted_thinking' && typeof replay.payload.data === 'string') {
        return [
          {
            type: 'thinking',
            thinking: '',
            thinkingSignature: replay.payload.data,
            redacted: true,
          },
        ]
      }
      if (replay.payload.type !== 'thinking') return []
      return [
        {
          type: 'thinking',
          thinking:
            typeof replay.payload.thinking === 'string' ? replay.payload.thinking : reasoning,
          thinkingSignature:
            typeof replay.payload.signature === 'string' ? replay.payload.signature : '',
        },
      ]
    })
  }
  if (provider.protocol === 'openai-responses') {
    return replays.flatMap((replay): ThinkingContent[] =>
      isRecord(replay.payload)
        ? [
            {
              type: 'thinking',
              thinking: reasoning,
              thinkingSignature: JSON.stringify(replay.payload),
            },
          ]
        : [],
    )
  }
  // Chat-completions replays reasoning text only when the route explicitly
  // needs it; replaying it by default re-bills every prior turn.
  if (provider.replayReasoning === true && reasoning !== '') {
    return [{ type: 'thinking', thinking: reasoning, thinkingSignature: 'reasoning_content' }]
  }
  return []
}

function toolCallsOf(message: ChatMessage): ToolCall[] {
  return (message.toolCalls ?? []).map((call) => {
    let args: ToolCall['arguments'] = {}
    try {
      const parsed: unknown = JSON.parse(call.arguments.trim() === '' ? '{}' : call.arguments)
      if (isRecord(parsed)) args = parsed as ToolCall['arguments']
    } catch {
      // pi reports malformed replay arguments as a validation error on use.
    }
    return { type: 'toolCall', id: call.id, name: call.name, arguments: args }
  })
}

function assistantContentOf(
  message: ChatMessage,
  provider: ProviderConfig,
): (TextContent | ThinkingContent | ToolCall)[] {
  const content: (TextContent | ThinkingContent | ToolCall)[] = []
  content.push(...thinkingContentOf(message, provider))
  if (message.content !== '') content.push({ type: 'text', text: message.content })
  content.push(...toolCallsOf(message))
  return content
}

/** Denia wire history -> pi transcript messages. */
export function toPiMessages(
  messages: readonly ChatMessage[],
  provider: ProviderConfig,
  modelId: string,
): Message[] {
  const names = toolNamesOf(messages)
  const out: Message[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const images = message.images ?? []
      if (images.length === 0) {
        out.push({ role: 'user', content: message.content, timestamp: Date.now() })
        continue
      }
      const parts: (TextContent | ImageContent)[] = []
      if (message.content !== '') parts.push({ type: 'text', text: message.content })
      for (const image of images) {
        parts.push({ type: 'image', data: image.data, mimeType: image.mime })
      }
      out.push({ role: 'user', content: parts, timestamp: Date.now() })
    } else if (message.role === 'assistant') {
      const content = assistantContentOf(message, provider)
      if (content.length === 0) continue
      out.push({
        role: 'assistant',
        content,
        api: apiOf(provider),
        provider: provider.id as ProviderId,
        model: modelId,
        usage: ZERO_USAGE,
        stopReason: 'stop',
        timestamp: Date.now(),
      })
    } else if (message.role === 'tool') {
      const callId = message.toolCallId ?? ''
      out.push({
        role: 'toolResult',
        toolCallId: callId,
        toolName: names.get(callId) ?? '',
        content: [{ type: 'text', text: message.content }],
        isError: false,
        timestamp: Date.now(),
      })
    } else {
      out.push({ role: 'system', content: message.content, timestamp: Date.now() })
    }
  }
  return out
}

function reasoningReplayOf(block: ThinkingContent, api: string): { protocol: string; payload: unknown } | null {
  const signature = block.thinkingSignature ?? ''
  if (api === 'anthropic-messages') {
    if (signature === '') return null
    return block.redacted
      ? { protocol: 'anthropic-messages', payload: { type: 'redacted_thinking', data: signature } }
      : { protocol: 'anthropic-messages', payload: { type: 'thinking', thinking: block.thinking, signature } }
  }
  if (api === 'openai-responses') {
    if (signature === '') return null
    try {
      const parsed: unknown = JSON.parse(signature)
      return isRecord(parsed) ? { protocol: 'openai-responses', payload: parsed } : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Final pi assistant message -> Denia content blocks. Native reasoning wins
 * over the inline-tag dialect; inline providers are split here so the log and
 * the UI agree even when the provider only streamed one text channel.
 */
export function assistantBlocksOf(
  message: AssistantMessage,
  provider: ProviderConfig,
): ContentBlock[] {
  const hasNativeThinking = message.content.some((block) => block.type === 'thinking')
  const inline = provider.inlineThinkTags === true && !hasNativeThinking
  const blocks: ContentBlock[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      const split = splitInlineThinking(block.text, inline)
      if (split.reasoning !== '') {
        blocks.push({ type: 'reasoning', text: split.reasoning })
      }
      if (split.text !== '') blocks.push({ type: 'text', text: split.text })
    } else if (block.type === 'thinking') {
      const replay = reasoningReplayOf(block, message.api)
      blocks.push({
        type: 'reasoning',
        text: block.thinking,
        ...(replay ? { replay } : {}),
      })
    } else if (block.type === 'toolCall') {
      blocks.push({
        type: 'tool-call',
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.arguments),
        ...(block.argumentsError ? { incomplete: true } : {}),
      })
    }
  }
  return blocks
}

export function tokenUsageOf(usage: Usage): TokenUsage {
  return {
    inputTokens: Math.max(0, usage.input),
    outputTokens: Math.max(0, usage.output),
    ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.reasoning ? { reasoningTokens: usage.reasoning } : {}),
  }
}

/** Providers that omit a usage block produce an all-zero pi object. */
export function meaningfulUsage(usage: TokenUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined
  const total =
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.reasoningTokens ?? 0)
  return total > 0 ? usage : undefined
}

function finishReasonOf(message: AssistantMessage): FinishReason {
  switch (message.stopReason) {
    case 'length':
      return { kind: 'max-tokens' }
    case 'toolUse':
      return { kind: 'tool-calls' }
    case 'aborted':
      return {
        kind: 'aborted',
        failure: { code: 'aborted', message: message.errorMessage ?? 'aborted' },
      }
    case 'error':
      return {
        kind: 'error',
        failure: { code: 'llm/stream', message: message.errorMessage ?? 'provider error' },
      }
    default:
      return { kind: 'stop' }
  }
}

function streamSimpleOf(
  model: Model<Api>,
  context: ReturnType<typeof normalizeContext>,
  options: SimpleStreamOptions,
): AssistantMessageEventStream {
  switch (model.api) {
    case 'anthropic-messages':
      return anthropicStreamSimple(model as Model<'anthropic-messages'>, context, options)
    case 'openai-responses':
      return responsesStreamSimple(model as Model<'openai-responses'>, context, options)
    case 'openai-completions':
    default:
      return completionsStreamSimple(model as Model<'openai-completions'>, context, options)
  }
}

function providerErrorCode(message: string): string {
  const match = /"code"\s*:\s*"([^"]+)"/.exec(message)
  return match?.[1] ?? 'llm/stream'
}

function errorMessageOf(model: Model<Api>, error: unknown, aborted: boolean): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  }
}

const MAX_TOKEN_FIELDS = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'] as const

/**
 * pi always has a model.maxTokens fallback, so it emits an output cap on every
 * request. Denia's contract is to send one only when the deployment configured
 * `defaultMaxTokens` (or a one-shot caller passed `maxTokens`): arbitrary
 * OpenAI-compatible gateways may reject or ignore the field. Anthropic makes
 * `max_tokens` mandatory, so its payload is left untouched.
 */
function withoutOptionalMaxTokens(api: Api, payload: unknown): unknown {
  if (api === 'anthropic-messages') return payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload
  const next = { ...(payload as Record<string, unknown>) }
  let changed = false
  for (const field of MAX_TOKEN_FIELDS) {
    if (field in next) {
      delete next[field]
      changed = true
    }
  }
  return changed ? next : payload
}

function withMaxTokenSuppression(
  suppress: boolean,
  user: SimpleStreamOptions['onPayload'],
): SimpleStreamOptions['onPayload'] {
  if (!suppress) return user
  return async (payload, model) => {
    const base = user ? (await user(payload, model)) ?? payload : payload
    return withoutOptionalMaxTokens(model.api, base)
  }
}

/**
 * `StreamFn` used by the pi agent. Setup failures must become an error stream
 * rather than a rejected promise.
 */
export function createPiStreamFn(
  providerSource: ProviderConfig | (() => ProviderConfig),
): StreamFn {
  return (model, context, options) => {
    const provider = typeof providerSource === 'function' ? providerSource() : providerSource
    const onPayload = withMaxTokenSuppression(
      provider.defaultMaxTokens === undefined,
      options?.onPayload,
    )
    const request: SimpleStreamOptions = {
      ...options,
      apiKey: options?.apiKey ?? resolveApiKey(provider) ?? 'denia',
      cacheRetention: provider.longCache ? 'long' : (options?.cacheRetention ?? 'short'),
      ...(onPayload ? { onPayload } : {}),
      ...(provider.headers ? { headers: { ...provider.headers, ...options?.headers } } : {}),
    }
    try {
      return streamSimpleOf(model, context, request)
    } catch (error) {
      const stream = createAssistantMessageEventStream()
      const message = errorMessageOf(model, error, request.signal?.aborted === true)
      stream.push({
        type: 'error',
        reason: message.stopReason === 'aborted' ? 'aborted' : 'error',
        error: message,
      })
      stream.end(message)
      return stream
    }
  }
}

/**
 * One-shot streaming for titles, compaction, approval review, prompt
 * optimization and cache warming. Produces the same `StreamChunk` vocabulary
 * the UI folds for a normal turn.
 */
export async function* streamFor(request: GenerateRequest): AsyncGenerator<StreamChunk> {
  const { provider, signal } = request
  const model = toPiModel(provider, request.model, {
    ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
  })
  const context: Context = {
    ...(request.system !== undefined && request.system !== '' ? { systemPrompt: request.system } : {}),
    messages: toPiMessages(request.messages, provider, request.model),
    ...(request.tools.length > 0 ? { tools: toPiTools(request.tools) } : {}),
  }
  const normalized = normalizeContext(context)
  const sessionId = request.cacheKey === undefined ? undefined : normalizePromptCacheKey(request.cacheKey)
  const level = thinkingLevelOf(request.reasoningEffort)
  const suppressMaxTokens =
    request.maxTokens === undefined && provider.defaultMaxTokens === undefined
  const options: SimpleStreamOptions = {
    apiKey: resolveApiKey(provider) ?? 'denia',
    ...(level === 'off' ? {} : { reasoning: level }),
    cacheRetention: provider.longCache ? 'long' : 'short',
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    ...(suppressMaxTokens
      ? { onPayload: (payload: unknown, model: Model<Api>) => withoutOptionalMaxTokens(model.api, payload) }
      : {}),
    ...(signal === undefined ? {} : { signal }),
  }

  const builder = new ChunkBuilder({
    ...(provider.inlineThinkTags ? { inlineThinkTags: true } : {}),
  })
  const sawToolDelta = new Set<number>()
  let final: AssistantMessage | null = null

  let stream: AssistantMessageEventStream
  try {
    stream = streamSimpleOf(model, normalized, options)
  } catch (error) {
    throw new LlmRequestError(
      error instanceof Error ? error.message : String(error),
      'llm/setup',
    )
  }

  for await (const event of stream) {
    if (event.type === 'done') {
      final = event.message
      continue
    }
    if (event.type === 'error') {
      const message = event.error.errorMessage ?? 'provider stream failed'
      throw new LlmRequestError(
        message,
        event.reason === 'aborted' ? 'aborted' : providerErrorCode(message),
      )
    }
    for (const chunk of chunksForAssistantEvent(builder, event, sawToolDelta)) yield chunk
  }

  if (final === null) {
    throw new LlmRequestError('provider stream ended without a final message', 'llm/stream')
  }
  if (final.stopReason === 'aborted') {
    const error = new Error(final.errorMessage ?? 'aborted')
    error.name = 'AbortError'
    throw error
  }
  if (final.stopReason === 'error') {
    const message = final.errorMessage ?? 'provider error'
    throw new LlmRequestError(message, providerErrorCode(message))
  }

  for (const chunk of builder.flushInlineTail()) yield chunk
  const blocks = assistantBlocksOf(final, provider)
  if (blocks.length === 0) {
    throw new LlmRequestError('the model produced no output blocks', 'EMPTY_RESPONSE')
  }
  for (const chunk of builder.finish(blocks)) yield chunk
  for (const chunk of usageChunk(meaningfulUsage(tokenUsageOf(final.usage)))) yield chunk
  yield finishChunk(finishReasonOf(final))
}

/** Collect only the text of a one-shot completion. */
export async function completeText(input: GenerateRequest): Promise<string> {
  const parts: string[] = []
  for await (const chunk of streamFor(input)) {
    if (chunk.type === 'text-delta') parts.push(chunk.text)
  }
  return parts.join('')
}