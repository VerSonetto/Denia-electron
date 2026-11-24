// Shared request vocabulary for one-shot completions.
//
// pi-ai owns the provider protocols; this shape is only used by side calls
// that do not run an agent turn (title, compaction, review, prompt optimizer,
// cache warming, goal verification).

import type { ChatMessage, ToolSchema } from '../core/wire.ts'
import type { ProviderConfig } from '../config.ts'

export interface GenerateRequest {
  provider: ProviderConfig
  model: string
  messages: ChatMessage[]
  system?: string
  tools: ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  reasoningEffort?: string
  /** Session-scoped provider cache identity (`prompt_cache_key`). */
  cacheKey?: string
  signal?: AbortSignal
}

export class LlmRequestError extends Error {
  readonly code: string
  readonly status?: number

  constructor(message: string, code: string, status?: number) {
    super(message)
    this.name = 'LlmRequestError'
    this.code = code
    this.status = status
  }
}