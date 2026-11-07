// Protocol dispatch: one adapter per wire protocol.
//
// Each adapter only translates its own request/stream shapes; the shared
// `StreamAssembler` keeps the emitted `StreamChunk` vocabulary identical so
// the UI never needs to know which provider produced a turn.

import type { StreamChunk } from '../core/wire.ts'
import { streamAnthropic } from './anthropic-messages.ts'
import { streamOpenAi } from './openai-completions.ts'
import { streamOpenAiResponses } from './openai-responses.ts'
import { LlmRequestError, type GenerateRequest } from './types.ts'

export type { GenerateRequest } from './types.ts'
export { LlmRequestError } from './types.ts'

export function streamFor(request: GenerateRequest): AsyncGenerator<StreamChunk> {
  switch (request.provider.protocol ?? 'openai-completions') {
    case 'openai-completions':
      return streamOpenAi(request)
    case 'openai-responses':
      return streamOpenAiResponses(request)
    case 'anthropic-messages':
      return streamAnthropic(request)
    default:
      throw new LlmRequestError(
        `未知协议:${String(request.provider.protocol)}`,
        'unsupported-protocol',
      )
  }
}