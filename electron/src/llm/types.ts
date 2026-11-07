// Shared LLM request vocabulary and errors.
//
// Adapters own their wire protocol; everything above them (agent loop, tests,
// future retry policy) only sees this shape.

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