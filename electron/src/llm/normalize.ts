// Shared wire normalization for the SDK adapters.
//
// The SDKs hand back parsed JSON, but provider dialects still differ: content
// can be a string, an array of parts or an object; reasoning arrives under
// several names; `prompt_tokens` includes cache hits on most gateways. These
// helpers keep that dialect handling out of the three protocol adapters.

import type { FinishReason, TokenUsage } from '../core/wire.ts'
import { LlmRequestError } from './types.ts'

interface ChatUsageWire {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

interface ResponsesUsageWire {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

/**
 * `inputTokens` is the **uncached** prompt, disjoint from `cacheReadTokens`.
 * Feeding the raw prompt here would double count cache hits in the context
 * ring and halve the cache hit rate the UI shows.
 */
function usageOf(
  prompt: number,
  output: number,
  cacheRead: number | undefined,
  reasoning: number | undefined,
): TokenUsage {
  const usage: TokenUsage = {
    inputTokens: Math.max(0, prompt - (cacheRead ?? 0)),
    outputTokens: output,
  }
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead
  if (reasoning !== undefined) usage.reasoningTokens = reasoning
  return usage
}

export function mapChatUsage(wire: ChatUsageWire): TokenUsage {
  const prompt = wire.prompt_tokens ?? 0
  const cacheRead =
    wire.prompt_tokens_details?.cached_tokens ??
    wire.prompt_cache_hit_tokens ??
    (wire.prompt_cache_miss_tokens === undefined
      ? undefined
      : Math.max(0, prompt - wire.prompt_cache_miss_tokens))
  return usageOf(
    prompt,
    wire.completion_tokens ?? 0,
    cacheRead,
    wire.completion_tokens_details?.reasoning_tokens,
  )
}

export function mapResponsesUsage(wire: ResponsesUsageWire): TokenUsage {
  const prompt = wire.input_tokens ?? 0
  return usageOf(
    prompt,
    wire.output_tokens ?? 0,
    wire.input_tokens_details?.cached_tokens,
    wire.output_tokens_details?.reasoning_tokens,
  )
}

/** Text parts from the array/object content shapes some gateways emit. */
export function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (Array.isArray(value)) {
    let joined = ''
    for (const part of value) {
      if (!isRecord(part)) continue
      const kind = typeof part.type === 'string' ? part.type : undefined
      if (kind !== undefined && kind !== 'text' && kind !== 'output_text') continue
      if (typeof part.text === 'string') joined += part.text
    }
    return joined.length > 0 ? joined : undefined
  }
  if (isRecord(value) && typeof value.text === 'string' && value.text.length > 0) {
    return value.text
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const REASONING_ROOTS = ['reasoning', 'thinking', 'thought']
const PAYLOAD_ROOTS = ['content', 'text', 'delta', 'detail', 'message', 'summary', 'value']
const OPAQUE_TOKENS = ['signature', 'redacted', 'encrypted', 'binary', 'hash', 'cipher']
const DETAIL_TEXT_KEYS = ['text', 'summary', 'content', 'value', 'delta']

function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function isReasoningKey(key: string): boolean {
  const normalized = normalizeKey(key)
  if (!REASONING_ROOTS.some((root) => normalized.includes(root))) return false
  const tokens = normalized.split(' ').filter(Boolean)
  if (tokens.every((token) => REASONING_ROOTS.includes(token))) return true
  return PAYLOAD_ROOTS.some((root) => normalized.includes(root))
}

function isOpaqueReasoningKind(kind: string): boolean {
  const tokens = normalizeKey(kind).split(' ')
  return tokens.some((token) => OPAQUE_TOKENS.includes(token))
}

/** First readable text inside a structured reasoning item. */
function detailText(items: unknown[]): string | undefined {
  for (const item of items) {
    if (!isRecord(item)) continue
    const kind = typeof item.type === 'string' ? item.type : undefined
    if (kind !== undefined && isOpaqueReasoningKind(kind)) continue
    for (const key of DETAIL_TEXT_KEYS) {
      const text = item[key]
      if (typeof text === 'string' && text.length > 0) return text
    }
  }
  return undefined
}

function textFromValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (Array.isArray(value)) return detailText(value)
  if (isRecord(value)) {
    for (const key of DETAIL_TEXT_KEYS) {
      const text = value[key]
      if (typeof text === 'string' && text.length > 0) return text
    }
  }
  return undefined
}

/**
 * Reasoning text for one delta. `reasoning_content` wins; otherwise scan the
 * delta keys by semantics so `thinking`, `reasoning_details` and camelCase
 * variants from OpenAI-compatible gateways are not dropped as plain text.
 */
export function reasoningText(delta: Record<string, unknown>): string | undefined {
  const standard = delta.reasoning_content
  if (typeof standard === 'string' && standard.length > 0) return standard
  for (const [key, value] of Object.entries(delta)) {
    if (key === 'reasoning_content' || !isReasoningKey(key)) continue
    const text = textFromValue(value)
    if (text !== undefined) return text
  }
  return undefined
}

/** Map a chat-completions finish reason; unknown values fail the step. */
export function chatFinishReason(raw: string | null | undefined): FinishReason | null {
  if (!raw) return null
  switch (raw) {
    case 'stop':
      return { kind: 'stop' }
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    default:
      throw new LlmRequestError(
        `model stopped with unknown reason: ${raw}`,
        raw.toUpperCase(),
      )
  }
}

const INLINE_THINK_CLOSE = '\u003c/think\u003e'
const INLINE_THINK_LEAD_CAP = 32 * 1024

/**
 * Some chat-completions gateways inline reasoning into `content`, ending it
 * with `` while the opening tag was consumed upstream. Buffer the
 * prefix until that marker (or the cap) and split it into reasoning + text.
 *
 * A marker can also appear *inside* the reasoning as a quoted code span
 * (`` `</think` ``) or followed by a space; those are references to the tag,
 * not the upstream terminator, so they must stay in the reasoning block.
 */
export class InlineThinkSplitter {
  private buffer: string | null
  private sawIgnoredMarker = false

  constructor(enabled: boolean) {
    this.buffer = enabled ? '' : null
  }

  get active(): boolean {
    return this.buffer !== null
  }

  /** Returns null when disabled; empty parts mean "still buffering". */
  push(text: string): { reasoning: string; text: string } | null {
    if (this.buffer === null) return null
    this.buffer += text
    let searchFrom = 0
    for (;;) {
      const close = this.buffer.indexOf(INLINE_THINK_CLOSE, searchFrom)
      if (close < 0) break
      const before = this.buffer.slice(0, close)
      const after = this.buffer.slice(close + INLINE_THINK_CLOSE.length)
      // Quoted in backticks: the model is discussing the tag itself.
      if (before.endsWith('`') || after.startsWith('`')) {
        this.sawIgnoredMarker = true
        searchFrom = close + INLINE_THINK_CLOSE.length
        continue
      }
      // Followed by a space: also a reference inside the reasoning. The real
      // upstream terminator is followed by a newline or the answer's first
      // character.
      if (after.startsWith(' ')) {
        this.sawIgnoredMarker = true
        searchFrom = close + INLINE_THINK_CLOSE.length
        continue
      }
      this.buffer = null
      return { reasoning: before, text: after }
    }
    if (this.buffer.length > INLINE_THINK_LEAD_CAP) {
      const pending = this.buffer
      this.buffer = null
      return { reasoning: '', text: pending }
    }
    return { reasoning: '', text: '' }
  }

  /** A real reasoning channel (or a tool call) proves this route is not inline. */
  flushAsText(): string | null {
    if (this.buffer === null) return null
    const pending = this.buffer
    this.buffer = null
    return pending.length > 0 ? pending : null
  }

  /**
   * End of stream. If the only markers seen were quoted/tag references, the
   * buffered text is reasoning about the tag rather than an inline
   * reasoning-prefix followed by an answer.
   */
  flushAtEnd(): { reasoning: string; text: string } | null {
    if (this.buffer === null) return null
    const pending = this.buffer
    this.buffer = null
    if (pending.length === 0) return null
    return this.sawIgnoredMarker
      ? { reasoning: pending, text: '' }
      : { reasoning: '', text: pending }
  }
}

export { isRecord }