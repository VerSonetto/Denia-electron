// SDK clients for the three wire protocols.
//
// The official SDKs own HTTP, SSE framing, keep-alive and error bodies; Denia
// only translates their events into the shared `StreamChunk` vocabulary. No
// retry here: the loop owns retry decisions, so the SDK must make one attempt.

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

import { resolveApiKey, type ProviderConfig } from '../config.ts'
import { LlmRequestError } from './types.ts'

function baseURLOf(provider: ProviderConfig): string {
  return provider.baseURL.replace(/\/+$/, '')
}

/**
 * Anthropic SDK appends `/v1/messages` itself; Denia's provider base URL
 * follows the Rust convention and already carries `/v1`, so drop it here.
 */
function anthropicBaseURL(provider: ProviderConfig): string {
  return baseURLOf(provider).replace(/\/v1$/, '')
}

function headersOf(provider: ProviderConfig): Record<string, string> {
  return { ...(provider.headers ?? {}) }
}

const EXTENDED_CACHE_TTL_BETA = 'extended-cache-ttl-2025-04-11'

/**
 * Beta opt-ins share one comma-separated header, so the long-cache opt-in must
 * merge with a caller-supplied list instead of replacing it.
 */
function anthropicHeaders(provider: ProviderConfig): Record<string, string> {
  const headers = headersOf(provider)
  if (provider.longCache !== true) return headers
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'anthropic-beta')
  const entries = (key === undefined ? '' : (headers[key] ?? ''))
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (entries.includes(EXTENDED_CACHE_TTL_BETA)) return headers
  headers[key ?? 'anthropic-beta'] = [...entries, EXTENDED_CACHE_TTL_BETA].join(',')
  return headers
}

export function openAiClient(provider: ProviderConfig): OpenAI {
  return new OpenAI({
    apiKey: resolveApiKey(provider) ?? 'denia-no-key',
    baseURL: baseURLOf(provider),
    defaultHeaders: headersOf(provider),
    maxRetries: 0,
  })
}

export function anthropicClient(provider: ProviderConfig): Anthropic {
  return new Anthropic({
    apiKey: resolveApiKey(provider) ?? 'denia-no-key',
    baseURL: anthropicBaseURL(provider),
    defaultHeaders: anthropicHeaders(provider),
    maxRetries: 0,
  })
}

/** True for the abort errors both SDKs raise when `signal` fires. */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return (
    error instanceof OpenAI.APIUserAbortError ||
    error instanceof Anthropic.APIUserAbortError
  )
}

/** Translate an SDK failure into the harness error shape the loop reports. */
export function toRequestError(error: unknown): LlmRequestError {
  if (error instanceof LlmRequestError) return error
  if (error instanceof OpenAI.APIError || error instanceof Anthropic.APIError) {
    // OpenAI exposes provider `code`/`type` on the error; Anthropic sets `type`
    // from `body.error.type` and keeps `errorCode` for its detail codes.
    const candidate = error as { code?: unknown; type?: unknown; errorCode?: unknown }
    const providerCode = [candidate.code, candidate.type, candidate.errorCode].find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
    const code = providerCode || (error.status ? `http-${error.status}` : 'llm-error')
    return new LlmRequestError(error.message, code, error.status)
  }
  if (error instanceof Error) return new LlmRequestError(error.message, 'llm-error')
  return new LlmRequestError(String(error), 'llm-error')
}