// Prefix-stability helpers.
//
// Provider prompt caches match from the first byte: rewriting the system
// prompt or reordering tools invalidates the whole conversation prefix. The
// system text is therefore frozen at the first request; later prompt changes
// travel as an injected message appended after the cached history instead of
// replacing the prefix. The same module derives the request-header snapshot
// that keeps that frozen baseline across restarts.

import type {
  Envelope,
  ModelSelection,
  RequestHeaderSnapshot,
  ToolSchema,
} from '../core/wire.ts'
import type { ProviderConfig } from '../config.ts'
import type { SurfaceItem } from './history.ts'

export const SYSTEM_UPDATE_CHANNEL = 'system-prompt-update'

/** The last request-header snapshot in the log, if any. */
export function lastRequestHeader(
  events: readonly Envelope[],
): Extract<Envelope, { type: 'request-header' }> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'request-header') return event
  }
  return null
}

/** Byte-for-byte comparison of the fields that form the cache prefix. */
export function sameRequestHeader(a: RequestHeaderSnapshot, b: RequestHeaderSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function buildRequestHeader(
  selection: ModelSelection,
  system: string,
  tools: ToolSchema[],
): RequestHeaderSnapshot {
  return {
    config: {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    },
    system,
    tools,
  }
}

export function systemUpdateText(currentSystem: string): string {
  return [
    '<system-reminder>',
    '系统提示更新:以下为当前生效的完整系统指令,取代此前系统消息中的旧版本;与旧版本冲突时以本更新为准。',
    '',
    currentSystem,
    '</system-reminder>',
  ].join('\n')
}

/** The last system prompt the UI recorded (older logs have no header yet). */
function lastSystemPrompt(events: readonly Envelope[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'system-prompt') return event.text
  }
  return undefined
}

export interface FrozenSystem {
  /** Bytes the wire request must use. */
  system: string
  /** Appended message when the prompt changed; null when already current. */
  update: string | null
}

function latestSystemUpdate(surface: readonly SurfaceItem[]): string | undefined {
  for (let index = surface.length - 1; index >= 0; index -= 1) {
    const item = surface[index]!
    if (item.channel === SYSTEM_UPDATE_CHANNEL) return item.message.content
  }
  return undefined
}

/**
 * Decide the wire system for this step. A frozen baseline that differs from
 * the freshly assembled prompt stays on the wire; the new prompt is appended
 * as an update message so the provider cache still matches from token zero.
 * `surface` is the current model-visible history, which tells us whether the
 * update is already the latest one (compaction can hide it, so the raw log
 * alone is not enough).
 */
export function frozenSystem(
  currentSystem: string,
  events: readonly Envelope[],
  surface: readonly SurfaceItem[],
): FrozenSystem {
  const frozen = lastRequestHeader(events)?.header.system ?? lastSystemPrompt(events)
  if (frozen === undefined) {
    return { system: currentSystem, update: null }
  }
  const update = systemUpdateText(currentSystem)
  const latest = latestSystemUpdate(surface)
  if (frozen === currentSystem) {
    // A stale update would keep overriding the frozen text even though the
    // assembled prompt is back to the original. Restore the frozen text once.
    if (latest !== undefined && latest !== systemUpdateText(frozen)) {
      return { system: frozen, update: systemUpdateText(frozen) }
    }
    return { system: frozen, update: null }
  }
  return { system: frozen, update: latest === update ? null : update }
}

/** Minutes since the last assistant message settled; undefined before one. */
export function lastAssistantAgeMinutes(events: readonly Envelope[], now = Date.now()): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'assistant-message') {
      return Math.max(0, Math.floor((now - event.time) / 60_000))
    }
  }
  return undefined
}

function roughTokens(text: string): number {
  return Math.ceil(Array.from(text).length / 4)
}

function messageTokens(item: SurfaceItem): number {
  const calls = item.message.toolCalls
    ?.reduce((sum, call) => sum + call.arguments.length, 0) ?? 0
  return roughTokens(item.message.content) + Math.ceil(calls / 4)
}

/**
 * Token pressure at which LLM summarization runs: `window × compactRatio`.
 * Null when the model has no known window.
 */
export function compactionThresholdTokens(
  contextWindow: number | undefined,
  compactRatio: number,
): number | null {
  if (contextWindow === undefined || contextWindow <= 0) return null
  return Math.floor(contextWindow * compactRatio)
}

/** The cheap cleanup line sits 10% below summarization. */
function microcompactThresholdTokens(
  contextWindow: number | undefined,
  compactRatio: number,
): number | null {
  const compactAt = compactionThresholdTokens(contextWindow, compactRatio)
  return compactAt === null ? null : Math.floor(compactAt * 0.9)
}

export interface PressureEstimate {
  /** Provider-reported prompt size at the newest usage anchor. */
  anchorTokens: number
  /** Last billed prompt plus everything appended after it. */
  projectedTokens: number
  /** 90% of the compaction threshold: cheap cleanup runs first. */
  thresholdTokens: number | null
}

/**
 * Pressure estimate from the newest usage anchor. `thresholdTokens` is 90% of
 * the summarization threshold, so the cheap tool-result cleanup always runs
 * before an expensive summary.
 */
export function estimatePressure(
  events: readonly Envelope[],
  surface: readonly SurfaceItem[],
  contextWindow: number | undefined,
  compactRatio = 0.9,
): PressureEstimate | null {
  let anchorSeq: number | null = null
  let billed = 0
  for (const event of events) {
    if (event.type !== 'assistant-message' || !event.usage) continue
    billed = (event.usage.inputTokens ?? 0) + (event.usage.cacheReadTokens ?? 0)
    anchorSeq = event.seq
  }
  if (anchorSeq === null) return null
  const compactAt = compactionThresholdTokens(contextWindow, compactRatio)
  let trailing = 0
  for (const item of surface) {
    if (item.seq > anchorSeq) trailing += messageTokens(item)
  }
  return {
    anchorTokens: billed,
    projectedTokens: billed + trailing,
    thresholdTokens:
      compactAt === null
        ? null
        : Math.floor(compactAt * 0.9),
  }
}

export function contextWindowOf(provider: ProviderConfig, modelId: string): number | undefined {
  const model = provider.models.find((entry) => entry.id === modelId)
  return model?.contextWindow ?? provider.defaultContextWindow
}