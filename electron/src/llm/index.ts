// LLM entry point.
//
// pi-ai owns the provider protocols. Denia only keeps the mappings between its
// settings/wire vocabulary and pi, plus a one-shot chunk stream for side calls
// that do not run an agent turn (title, compaction, review, prompt optimizer).

export {
  assistantBlocksOf,
  completeText,
  createPiStreamFn,
  meaningfulUsage,
  streamFor,
  thinkingLevelOf,
  toPiMessages,
  toPiModel,
  toPiTools,
  tokenUsageOf,
} from './pi.ts'
export type { GenerateRequest } from './types.ts'
export { LlmRequestError } from './types.ts'