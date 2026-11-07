// Manual compaction: summarize older history and insert one replacement event.
//
// The log stays append-only; `compaction-summary` declares the seq range that
// no longer reaches the model, plus the summary text and the keep window.

import type { AppConfig } from '../config.ts'
import { findProvider, resolveDefault } from '../config.ts'
import type { ContentBlock, Envelope, ModelSelection, SessionEvent } from '../core/wire.ts'
import { streamFor } from '../llm/index.ts'
import type { SessionStore } from '../session/store.ts'

const KEEP_TURNS = 2
const MIN_MESSAGES = 4
const MAX_TRANSCRIPT_CHARS = 60_000
const MAX_ENTRY_CHARS = 2_000
const TIMEOUT_MS = 120_000
const SYSTEM_PROMPT =
  '你是编码会话的上下文压缩器。把给定的历史压缩成一段事实性摘要:保留用户目标与约束、已做出的决策、改动过的文件与关键结果、验证结论、未完成事项与下一步。不编造、不评价、不写客套话。输出纯文本摘要。'

export interface CompactOptions {
  store: SessionStore
  config: AppConfig
  sessionId: string
  selection?: ModelSelection
  onFailed?: (message: string) => void
  onUpdated?: () => void
}

interface MessageEvent {
  seq: number
  kind: 'user' | 'assistant' | 'tool'
  text: string
}

/** Fire and forget; returns the promise for tests. */
export async function compactSession(options: CompactOptions): Promise<void> {
  const session = options.store.read(options.sessionId)
  if (!session) return
  const turns = turnRanges(session.events)
  if (turns.length <= KEEP_TURNS) {
    options.onFailed?.('当前会话没有足够的可压缩历史')
    return
  }
  const summarizedTurns = turns.slice(0, -KEEP_TURNS)
  const summarized = summarizedTurns.flatMap((turn) => turn.messages)
  if (summarized.length < MIN_MESSAGES) {
    options.onFailed?.('当前会话没有足够的可压缩历史')
    return
  }
  const firstKept = turns[turns.length - KEEP_TURNS]!
  const replacesFrom = summarized[0]!.seq
  const replacesTo = firstKept.startSeq - 1
  const keepFrom = firstKept.startSeq
  const selection =
    options.selection ?? lastSelectionOf(session.events) ?? resolveDefault(options.config)
  const provider = findProvider(options.config, selection.provider) ?? options.config.providers[0]
  if (!provider) {
    options.onFailed?.('没有可用的模型提供商')
    return
  }
  const transcript = renderTranscript(summarized)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  timer.unref?.()
  try {
    const parts: string[] = []
    for await (const chunk of streamFor({
      provider,
      model: selection.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: transcript }],
      tools: [],
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      signal: controller.signal,
    })) {
      if (chunk.type === 'text-delta') parts.push(chunk.text)
    }
    const summary = parts.join('').trim()
    if (summary === '') {
      options.onFailed?.('压缩摘要为空')
      return
    }
    const preTokens = estimateTokens(transcript)
    const postTokens = estimateTokens(summary)
    const turn = lastTurn(session.events)
    options.store.append(options.sessionId, {
      type: 'compaction-summary',
      turn,
      step: 0,
      summary,
      replaces_from: replacesFrom,
      replaces_to: replacesTo,
      keep_from: keepFrom,
      pre_tokens: preTokens,
      post_tokens: postTokens,
    } satisfies SessionEvent)
    options.store.flush(options.sessionId)
    options.onUpdated?.()
  } catch (error) {
    options.onFailed?.(
      controller.signal.aborted
        ? '压缩超时'
        : error instanceof Error
          ? error.message
          : String(error),
    )
  } finally {
    clearTimeout(timer)
  }
}

interface TurnRange {
  startSeq: number
  messages: MessageEvent[]
}

function messageEventOf(event: Envelope): MessageEvent | null {
  if (event.type === 'user-message') {
    return { seq: event.seq, kind: 'user', text: event.text }
  }
  if (event.type === 'assistant-message') {
    const text = event.blocks
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
    const calls = event.blocks
      .filter((block) => block.type === 'tool-call')
      .map((block) => (block.type === 'tool-call' ? `[调用 ${block.name} ${block.arguments}]` : ''))
      .join('\n')
    return {
      seq: event.seq,
      kind: 'assistant',
      text: [text, calls].filter((part) => part !== '').join('\n'),
    }
  }
  if (event.type === 'tool-result') {
    return { seq: event.seq, kind: 'tool', text: event.content }
  }
  return null
}

/** Split the log at turn boundaries so tool calls stay with their results. */
function turnRanges(events: Envelope[]): TurnRange[] {
  const out: TurnRange[] = []
  let current: TurnRange | null = null
  for (const event of events) {
    if (event.type === 'turn-start') {
      if (current) out.push(current)
      current = { startSeq: event.seq, messages: [] }
      continue
    }
    if (!current) current = { startSeq: 0, messages: [] }
    const message = messageEventOf(event)
    if (message) current.messages.push(message)
  }
  if (current) out.push(current)
  return out.filter((turn) => turn.messages.length > 0)
}

function renderTranscript(messages: MessageEvent[]): string {
  const lines: string[] = []
  let size = 0
  for (const message of messages) {
    const label = message.kind === 'user' ? '用户' : message.kind === 'assistant' ? '助手' : '工具结果'
    const text = truncateChars(message.text, MAX_ENTRY_CHARS)
    const block = `[${message.seq}] ${label}:\n${text}`
    if (size + block.length > MAX_TRANSCRIPT_CHARS) {
      lines.push('…（更早的历史已省略）')
      break
    }
    lines.push(block)
    size += block.length
  }
  return lines.join('\n\n')
}

function lastSelectionOf(events: Envelope[]): ModelSelection | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'request-context') {
      return { provider: event.provider, model: event.model }
    }
    if (event.type === 'request-header') {
      return {
        provider: event.header.config.provider,
        model: event.header.config.model,
        ...(event.header.config.reasoningEffort
          ? { reasoningEffort: event.header.config.reasoningEffort }
          : {}),
      }
    }
  }
  return null
}

function lastTurn(events: Envelope[]): number {
  let turn = 0
  for (const event of events) {
    if ((event.type === 'turn-start' || event.type === 'turn-end') && typeof event.turn === 'number') {
      turn = Math.max(turn, event.turn)
    }
  }
  return turn
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function truncateChars(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return chars.slice(0, max).join('') + '…'
}