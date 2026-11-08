// Tool-result microcompaction: swap already-used tool output for a placeholder.
//
// This runs before LLM summarization and costs nothing: no model call, no log
// rewrite. The gate appends one `tool-result` event per cleared item with
// `replaces` set to the target seq, so `deriveSurface` swaps the message in
// place — the log stays append-only, the UI keeps the full history, and the
// model only sees the placeholder.
//
// Guards, each for a concrete reason:
//   - `minSavings`: rewriting perturbs the provider prefix cache, so a rewrite
//     that saves little is worse than doing nothing.
//   - error results stay: an error message is often the only clue the model has
//     for correcting itself.
//   - multimodal results stay: an image cannot be represented by a text
//     placeholder.
//   - the newest N groups stay: recent results are still being referenced.
//   - groups are assistant turns, never split: one turn's calls are cleared
//     together or not at all.

import type { SurfaceItem } from './history.ts'

/** Text a cleared tool result is reduced to. */
export const CLEARED_PLACEHOLDER = '[旧工具结果内容已清理]'

export interface MicrocompactSettings {
  /** Master switch. */
  enabled: boolean
  /** How many recent groups to keep (a group = one assistant turn's calls). */
  keepRecentGroups: number
  /** Idle minutes after which the next entry clears once. */
  idleThresholdMinutes: number
  /** Minimum saved tokens; below it the rewrite is not worth the cache churn. */
  minSavings: number
  /** Tools whose results may be cleared. */
  tools: string[]
  /**
   * Rewrite budget: a candidate whose trailing messages exceed this sits in
   * the warm, already-sent prefix, so rewriting it would make the provider
   * re-bill the whole suffix. `0` disables the guard.
   */
  cacheWarmSuffixTokens: number
  /**
   * Provider prompt-cache lookback in wire positions. A result older than this
   * window is left for compaction. `0` disables the bound.
   */
  cacheLookbackPositions: number
  /** Also clear error results. */
  clearErrorResults: boolean
}

const DEFAULT_TOOLS = [
  'read_file',
  'bash',
  'grep',
  'glob',
  'ls',
  'edit',
  'write_file',
  'browser',
]

export function defaultMicrocompactSettings(): MicrocompactSettings {
  return {
    enabled: true,
    keepRecentGroups: 5,
    idleThresholdMinutes: 60,
    minSavings: 256,
    tools: [...DEFAULT_TOOLS],
    cacheWarmSuffixTokens: 8_000,
    cacheLookbackPositions: 20,
    clearErrorResults: false,
  }
}

export type MicrocompactDecision =
  | {
      kind: 'applied'
      trigger: 'time' | 'pressure'
      /** Cleared tool call ids, in surface (chronological) order. */
      clearedToolCallIds: string[]
      /** Seq of the cleared items; the gate writes them back as `replaces`. */
      clearedSeqs: number[]
      /** Candidates that survived, in surface order. */
      keptToolCallIds: string[]
      estimatedSavings: number
    }
  | {
      kind: 'skipped'
      reason:
        | 'disabled'
        | 'not_triggered'
        | 'no_candidates'
        | 'nothing_to_clear'
        | 'warm_prefix'
        | 'below_min_savings'
    }

/** One clearable tool result. */
interface Candidate {
  /** Seq of the result on the surface (the `replaces` locator). */
  seq: number
  /** Surface index, used to bound how much a rewrite would re-bill. */
  index: number
  toolCallId: string
}

/** Same 4-chars-per-token estimate the context breakdown uses. */
function roughTokens(text: string): number {
  return Math.ceil([...text].length / 4)
}

/**
 * Prefix match, not equality: a placeholder that kept an artifact reference
 * continues with a re-read hint, so equality would clear it over and over.
 */
function alreadyCleared(content: string): boolean {
  return content.trimStart().startsWith(CLEARED_PLACEHOLDER)
}

/** Tool name of a call id, looked up on the whole surface. */
function toolNameFor(surface: SurfaceItem[], callId: string): string | undefined {
  for (const item of surface) {
    for (const call of item.message.toolCalls ?? []) {
      if (call.id === callId) return call.name
    }
  }
  return undefined
}

/**
 * Collect clearable candidates grouped by assistant turn, in surface order.
 * A group is one assistant message with tool calls plus the results that
 * follow it; results with no preceding assistant form their own group.
 */
function collectCandidates(surface: SurfaceItem[], settings: MicrocompactSettings): Candidate[][] {
  const allowed = new Set(settings.tools)
  const groups: Candidate[][] = []
  let current: Candidate[] | null = null
  const close = (): void => {
    if (current !== null && current.length > 0) groups.push(current)
    current = null
  }

  surface.forEach((item, index) => {
    const message = item.message
    if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
      close()
      current = []
      return
    }
    if (message.role !== 'tool' || typeof message.toolCallId !== 'string') return
    // Error results are the model's own correction clue; keep them unless asked.
    if (item.isError && !settings.clearErrorResults) return
    // Idempotence: never clear an already cleared result.
    if (alreadyCleared(message.content)) return
    // Multimodal content cannot be replaced by text.
    if ((message.images?.length ?? 0) > 0) return
    // Clear only whitelisted tools; without a matching call the tool is
    // unknown, so stay conservative and skip.
    const toolName = toolNameFor(surface, message.toolCallId)
    if (toolName === undefined || !allowed.has(toolName)) return
    const candidate: Candidate = { seq: item.seq, index, toolCallId: message.toolCallId }
    if (current !== null) current.push(candidate)
    else groups.push([candidate])
  })
  close()
  return groups
}

/**
 * Tokens after `index`: the suffix a rewrite there would force the provider to
 * re-bill. Content only and conservative — tool-call arguments only add to it.
 */
function suffixTokens(surface: SurfaceItem[], index: number): number {
  let total = 0
  for (let position = index + 1; position < surface.length; position += 1) {
    total += roughTokens(surface[position]!.message.content)
  }
  return total
}

/**
 * Plan one microcompaction pass.
 *
 * `idleMinutes` is the time-based trigger, `pressureTokens` / `thresholdTokens`
 * the token-pressure one. Without either the decision is `not_triggered`.
 */
export function planMicrocompact(
  surface: SurfaceItem[],
  settings: MicrocompactSettings,
  idleMinutes: number | undefined,
  pressureTokens: number | undefined,
  thresholdTokens: number | undefined,
): MicrocompactDecision {
  if (!settings.enabled) return { kind: 'skipped', reason: 'disabled' }

  // Idle wins over pressure: leaving the session is the stronger "done" signal.
  let trigger: 'time' | 'pressure'
  if (idleMinutes !== undefined && idleMinutes > settings.idleThresholdMinutes) {
    trigger = 'time'
  } else if (
    pressureTokens !== undefined &&
    thresholdTokens !== undefined &&
    thresholdTokens > 0 &&
    pressureTokens >= thresholdTokens
  ) {
    trigger = 'pressure'
  } else {
    return { kind: 'skipped', reason: 'not_triggered' }
  }

  const groups = collectCandidates(surface, settings)
  if (groups.length === 0) return { kind: 'skipped', reason: 'no_candidates' }

  // Keep the newest N groups. Among the older ones, rewrite newest-first while
  // the suffix a rewrite would re-bill stays inside the budget; older groups
  // have a larger suffix, so the first group over budget ends the scan and is
  // left for compaction.
  const keep = Math.max(1, settings.keepRecentGroups)
  const clearCount = Math.max(0, groups.length - keep)
  if (clearCount === 0) return { kind: 'skipped', reason: 'nothing_to_clear' }

  const selected = new Set<string>()
  const toClear: Candidate[] = []
  for (let groupIndex = clearCount - 1; groupIndex >= 0; groupIndex -= 1) {
    const group = groups[groupIndex]!
    if (group.length === 0) continue
    const first = Math.min(...group.map((candidate) => candidate.index))
    if (
      settings.cacheLookbackPositions > 0 &&
      surface.length - first + 6 > settings.cacheLookbackPositions
    ) {
      break
    }
    if (
      settings.cacheWarmSuffixTokens > 0 &&
      suffixTokens(surface, first) > settings.cacheWarmSuffixTokens
    ) {
      break
    }
    for (const candidate of group) {
      selected.add(candidate.toolCallId)
      toClear.push(candidate)
    }
  }
  if (toClear.length === 0) return { kind: 'skipped', reason: 'warm_prefix' }

  const keptToolCallIds: string[] = []
  for (const candidate of groups.flat()) {
    if (!selected.has(candidate.toolCallId)) keptToolCallIds.push(candidate.toolCallId)
  }

  // Selection walks newest-first to minimize the rewrite suffix; report in
  // chronological order so logs and `replaces` consumers stay deterministic.
  toClear.sort((left, right) => left.index - right.index)

  const clearedIds = new Set(toClear.map((candidate) => candidate.toolCallId))
  let estimatedSavings = 0
  for (const item of surface) {
    const toolCallId = item.message.role === 'tool' ? item.message.toolCallId : undefined
    if (toolCallId === undefined || !clearedIds.has(toolCallId)) continue
    estimatedSavings += Math.max(
      0,
      roughTokens(item.message.content) - roughTokens(CLEARED_PLACEHOLDER),
    )
  }
  if (estimatedSavings < settings.minSavings) {
    return { kind: 'skipped', reason: 'below_min_savings' }
  }

  return {
    kind: 'applied',
    trigger,
    clearedToolCallIds: toClear.map((candidate) => candidate.toolCallId),
    clearedSeqs: toClear.map((candidate) => candidate.seq),
    keptToolCallIds,
    estimatedSavings,
  }
}