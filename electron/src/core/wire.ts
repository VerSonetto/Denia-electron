// Wire types shared with the existing web UI.
//
// These mirror `web/src/generated/core.ts` (which is generated from the Rust
// serde definitions). Field names and shapes are part of the HTTP contract:
// the UI folds session events directly, so they must not drift.

import type { SubagentDescriptor } from '../subagents/types.ts'

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCallRef {
  id: string
  name: string
  arguments: string
}

export interface ImageData {
  mime: string
  data: string
  path?: string
}

export interface ChatMessage {
  role: ChatRole
  content: string
  images?: ImageData[]
  reasoningContent?: string
  reasoningReplay?: Array<{ protocol: string; payload: unknown }>
  toolCalls?: ToolCallRef[]
  toolCallId?: string
}

export type BlockType = 'text' | 'reasoning' | 'tool-call'

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; replay?: { protocol: string; payload: unknown } }
  | { type: 'tool-call'; id: string; name: string; arguments: string; incomplete?: boolean }

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  reasoningTokens?: number
}

export interface LlmFailure {
  message: string
  code: string
  status?: number
  providerRetryAfterMs?: number
  requestId?: string
}

export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure }
  | { kind: 'error'; failure: LlmFailure }

export type StreamChunk =
  | { type: 'block-start'; index: number; block_type: BlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; arguments_delta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }

export type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'aborted'; cause?: AbortCause }
  | { kind: 'max-tokens' }
  | { kind: 'error'; failure: LlmFailure }
  | { kind: 'loop-detected'; repeats: number }
  | { kind: 'interrupted' }

export type AbortCause =
  | { kind: 'user' }
  | { kind: 'parent' }
  | { kind: 'hook'; reason: string }
  | { kind: 'disposed' }
  | { kind: 'legacy' }

export type PermissionMode = 'read-only' | 'auto-edit' | 'plan' | 'full'

/** How a pending approval was settled (mirrors the Rust `ApprovalOutcome`). */
export type ApprovalOutcome =
  | 'allowed-once'
  | 'allowed-session'
  | 'rejected'
  | 'cancelled'
  | 'unavailable'

/**
 * The bridge's answer to one approval request. Ordinary approvals only carry
 * `outcome`; a plan approval (`exit_plan`) may also switch the execute mode,
 * the model, and hand back user feedback.
 */
export interface PlanReviewDecision {
  outcome: ApprovalOutcome
  /** Execute mode chosen on approval (only `auto-edit` / `full`). */
  executeMode?: 'auto-edit' | 'full'
  selection?: ModelSelection
  feedback?: string
}

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface ToolSchema {
  name: string
  description: string
  parameters: unknown
}

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface RequestHeaderSnapshot {
  config: {
    provider: string
    model: string
    reasoningEffort?: string
    temperature?: number
    maxTokens?: number
    stop?: string[]
  }
  system?: string
  tools?: ToolSchema[]
}

/** Session events the TypeScript host emits (subset of the Rust union). */
export type SessionEvent =
  | { type: 'agent-inbox'; id: string; text: string; source: string }
  | { type: 'agent-delivery'; id: string; text: string; source: string }
  | { type: 'turn-start'; turn: number }
  | { type: 'turn-end'; turn: number; reason: TurnEndReason }
  | { type: 'step-start'; turn: number; step: number }
  | { type: 'step-end'; turn: number; step: number }
  | {
      type: 'user-message'
      text: string
      injected: boolean
      channel?: string
      images?: ImageData[]
    }
  | { type: 'system-prompt'; turn: number; step: number; text: string }
  | { type: 'assistant-chunk'; turn: number; step: number; chunk: StreamChunk }
  | {
      type: 'assistant-message'
      turn: number
      step: number
      blocks: ContentBlock[]
      usage?: TokenUsage
      interrupted?: boolean
      source_event_seqs?: number[]
      first_token_time?: number
    }
  | { type: 'tool-call'; turn: number; step: number; call_id: string; name: string; arguments: string }
  | {
      type: 'tool-result'
      turn: number
      step: number
      call_id: string
      content: string
      is_error: boolean
      error?: string
      error_identity?: { name: string; code: string }
      meta?: unknown
      truncation?: { total_chars: number; shown_chars: number }
    }
  | { type: 'tool-output-chunk'; call_id: string; stream: string; text: string }
  | { type: 'todo-write'; todos: TodoItem[] }
  | { type: 'permission-mode'; mode: PermissionMode }
  | {
      type: 'permission-selection'
      sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
      approval: 'untrusted' | 'on-request' | 'never' | { granular: unknown }
      reviewer: 'user' | 'auto-review'
      collaboration: 'default' | 'plan'
    }
  | {
      type: 'approval-asked'
      request_id: string
      call_id: string
      tool: string
      args_preview: string
      reason?: string
    }
  | { type: 'approval-decided'; request_id: string; outcome: ApprovalOutcome }
  | {
      type: 'auto-review'
      request_id: string
      call_id: string
      tool: string
      outcome: 'allow' | 'deny'
      risk_level: string
      user_authorization: string
      rationale: string
    }
  | { type: 'session-title'; title: string }
  | {
      type: 'compaction-summary'
      turn: number
      step: number
      summary: string
      replaces_from: number
      replaces_to: number
      keep_from: number
      pre_tokens?: number
      post_tokens?: number
    }
  | { type: 'agent-preset'; preset: string }
  | { type: 'command-run'; name: string; text: string }
  | { type: 'request-context'; turn: number; step: number; provider: string; model: string; context_window?: number }
  | {
      type: 'request-header'
      turn: number
      step: number
      header: RequestHeaderSnapshot
      reason: 'initial' | 'resume' | 'change' | 'series'
      starts_series?: boolean
    }

export interface SessionEnvelope {
  seq: number
  time: number
}

export type Envelope = SessionEnvelope & SessionEvent

export interface SessionHeader {
  type: 'session'
  version: number
  id: string
  created_at: number
  cwd: string
  sandbox: boolean
  parent_session?: string
  agent_preset?: string
  subagent?: SubagentDescriptor
}

export interface SessionSummary {
  id: string
  created_at: number
  excerpt: string | null
  title: string | null
  cwd?: string
  sandbox?: boolean
  cwd_alive?: boolean
  parent_session?: string
  subagent?: SubagentDescriptor
  agent_preset?: string
}

export interface SessionTotals {
  turnMs: number
  turns: number
  steps: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
}

export interface SessionPage {
  header: SessionHeader
  events: Envelope[]
  total: number
  hasMoreBefore: boolean
  anchors: { seq: number; text: string }[]
  totals: SessionTotals
}

export interface ToolOutput {
  content: string
  isError: boolean
  meta?: unknown
  errorIdentity?: { name: string; code: string }
  truncation?: { total_chars: number; shown_chars: number }
}

export interface ModelProviderGroup {
  id: string
  name: string
  models: {
    id: string
    name: string
    description?: string
    contextWindow?: number
    inputModalities?: string[]
    thinkingSupported?: boolean
    reasoning?: { efforts: { id: string; name: string; description?: string }[]; defaultEffort?: string }
  }[]
}

export interface ModelCatalog {
  routableProviders: string[]
  groups: ModelProviderGroup[]
  failures: { id: string; name: string; message: string }[]
}