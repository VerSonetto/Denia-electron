// Deterministic, per-turn loop detector for completed tool batches.
//
// The guard observes exactly one fingerprint per completed step: the full
// batch of calls plus their actual results. It never counts repeated calls
// inside one step as multiple steps, and it never reads model text. Four
// identical cycles produce one reminder; two further complete cycles of the
// same pattern close the turn. Side-effecting/opaque batches can only produce
// a single weak reminder and are never a hard-stop reason.
//
// Only hashes are retained. The recent window is fixed and the confirmation
// state is at most the current period plus its cycle count, so long turns do
// not grow this cache.

import { createHash } from 'node:crypto'

export const LOOP_GUARD_CHANNEL = 'loop-guard'

/** Strong reminder: four full cycles were observed. Never claims completion. */
export const LOOP_GUARD_STRONG_REMINDER = [
  '[循环防护] 最近多个完整步骤重复了同一组操作和相同结果，没有产生新的信息或进展。',
  '下一步请改变做法：调整参数或换用其他工具，核对当前假设并排查重复出现的错误；如果工作已接近尾声，请直接收尾并如实说明当前状态。',
  '不要为了结束而声称任务已经完成。',
].join('\n')

/** Weak reminder: repeated opaque/side-effecting work; never followed by a stop. */
export const LOOP_GUARD_WEAK_REMINDER = [
  '[循环防护] 检测到最近的操作在重复，可能没有带来新的信息或进展。',
  '请确认下一步是否应调整做法；如果仍要继续同一操作，请先确认它确实会产生新的结果。',
].join('\n')

/** Tools whose complete, successful results are deterministic read-only evidence. */
const HARD_SAFE_TOOLS = new Set([
  'read_file',
  'read_tool_output',
  'ls',
  'glob',
  'grep',
  'todo_write',
])

/**
 * Async status queries are never stall evidence: a pending job/agent may
 * complete between steps and the next step will receive the result.
 */
const STATUS_QUERY_TOOLS = new Set([
  'job_output',
  'wait_agent',
  'job_list',
  'list_agents',
])

const MAX_ARGUMENT_DEPTH = 64
/** Enough for six cycles of the longest period (3 × 6). */
const RECENT_STEP_LIMIT = 18
const REMIND_AFTER_CYCLES = 4
const STOP_AFTER_CYCLES = 6
/** Complete cycles of the locked pattern required after the strong reminder. */
const CONFIRM_AFTER_CYCLES = STOP_AFTER_CYCLES - REMIND_AFTER_CYCLES

export interface GuardCallObservation {
  name: string
  /** Raw argument text exactly as the model produced it. */
  arguments: string
  /** Complete result text (never a display preview/artifact id). */
  content: string
  isError: boolean
  errorIdentity?: { name: string; code: string }
  /** Driver-proven that the tool body never ran (unknown tool, bad args, forbid). */
  notExecuted?: boolean
  /** The complete result is unavailable (output was truncated for the model). */
  truncated?: boolean
  /** No actual result was produced for this call. */
  missing?: boolean
}

export interface GuardStepObservation {
  calls: readonly GuardCallObservation[]
}

export type LoopGuardDecision =
  | { kind: 'none' }
  | { kind: 'weak-reminder' }
  | { kind: 'strong-reminder' }
  | { kind: 'stop'; repeats: number }

interface StepRecord {
  /** Hash of the whole completed batch; no raw argument/result text is kept. */
  key: string
  hardEligible: boolean
}

interface PatternMatch {
  period: number
  cycles: number
  records: StepRecord[]
}

/**
 * Confirmation armed by a strong reminder. It pins one period of step hashes
 * plus the next expected position, so a shorter suffix (AA/BB inside a
 * period-3 pattern) can neither reset nor re-arm the reminder. Only hashes are
 * retained here as well.
 */
interface LockedConfirmation {
  cycle: StepRecord[]
  /** 0-based position in `cycle` expected for the next step. */
  nextIndex: number
  /** Complete cycles observed after the reminder. */
  cycles: number
  /** Total complete cycles when the reminder was emitted. */
  cyclesAtReminder: number
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Canonical JSON for an argument object: keys recursively sorted, array order
 * and every value preserved. Returns null when the structure is too deep to
 * compare safely (the caller then breaks the trajectory, i.e. fails open).
 */
function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_ARGUMENT_DEPTH) throw new RangeError('arguments too deep')
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
    case 'boolean':
      return JSON.stringify(value)
    case 'object': {
      const record = value as Record<string, unknown>
      const keys = Object.keys(record).sort()
      return `{${keys
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`)
        .join(',')}}`
    }
    default:
      // JSON.parse cannot produce these, but stay deterministic if hand-built
      // observations reach the guard in tests.
      return JSON.stringify(value) ?? 'null'
  }
}

/**
 * Runtime-equivalent argument normalization: blank/whitespace text is `{}`
 * because the tool driver parses it that way. Invalid JSON (and valid
 * non-objects, which the driver rejects as bad arguments) is compared by its
 * exact raw text. null means the value cannot be compared safely.
 */
function normalizedArguments(raw: string): string | null {
  if (raw.trim() === '') return '{}'
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return raw
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return raw
  try {
    return canonicalJson(parsed)
  } catch {
    return null
  }
}

function callFingerprint(call: GuardCallObservation): string | null {
  const args = normalizedArguments(call.arguments)
  if (args === null) return null
  return hashText(
    JSON.stringify([
      call.name,
      call.isError ? 'error' : 'ok',
      call.errorIdentity?.name ?? '',
      call.errorIdentity?.code ?? '',
      args,
      call.content,
    ]),
  )
}

/**
 * One completed step → one hash. Evidence that cannot be compared safely
 * (truncated/missing result, async status query) returns null and breaks the
 * trajectory instead of risking a false positive.
 *
 * Read-only/not-executed batches are order-independent and use a sorted
 * multiset of call hashes (duplicates preserved). Any potentially
 * side-effecting call makes the whole batch order-sensitive.
 */
function buildStepRecord(step: GuardStepObservation): StepRecord | null {
  if (step.calls.length === 0) return null
  const fingerprints: string[] = []
  let hardEligible = true
  for (const call of step.calls) {
    if (call.missing === true || call.truncated === true) return null
    if (STATUS_QUERY_TOOLS.has(call.name) && !call.isError) return null
    const fingerprint = callFingerprint(call)
    if (fingerprint === null) return null
    fingerprints.push(fingerprint)
    if (call.notExecuted !== true && !HARD_SAFE_TOOLS.has(call.name)) hardEligible = false
  }
  if (hardEligible) fingerprints.sort()
  return {
    key: hashText(JSON.stringify({ hardEligible, calls: fingerprints })),
    hardEligible,
  }
}

export class LoopGuard {
  private recent: StepRecord[] = []
  /** Armed only by a strong reminder; cleared by any deviation or reset. */
  private confirmation: LockedConfirmation | null = null
  /** At most one weak reminder per turn, independent of strong evidence. */
  private weakReminded = false

  /**
   * Invalidate the current trajectory (new turn is a new instance; use this
   * for real user/agent input, request-header changes, approvals/permission
   * changes). The per-turn weak-reminder budget survives.
   */
  reset(): void {
    this.recent = []
    this.confirmation = null
  }

  observe(step: GuardStepObservation): LoopGuardDecision {
    const record = buildStepRecord(step)
    if (record === null) {
      // Insufficient evidence: the whole step breaks the consecutive run.
      this.reset()
      return { kind: 'none' }
    }
    this.recent.push(record)
    if (this.recent.length > RECENT_STEP_LIMIT) {
      this.recent.splice(0, this.recent.length - RECENT_STEP_LIMIT)
    }

    if (this.confirmation !== null) {
      const confirmation = this.confirmation
      const expected = confirmation.cycle[confirmation.nextIndex]!
      if (record.key !== expected.key) {
        // A deviation invalidates the reminder immediately. The old reminder
        // is never transferred to the new pattern; this step starts fresh
        // evidence, so do not look for a replacement pattern on it.
        this.confirmation = null
        return { kind: 'none' }
      }
      confirmation.nextIndex += 1
      if (confirmation.nextIndex < confirmation.cycle.length) {
        return { kind: 'none' }
      }
      confirmation.nextIndex = 0
      confirmation.cycles += 1
      if (confirmation.cycles < CONFIRM_AFTER_CYCLES) return { kind: 'none' }
      const repeats = confirmation.cyclesAtReminder + confirmation.cycles
      this.confirmation = null
      return { kind: 'stop', repeats }
    }

    const match = this.findPattern()
    if (match === null) return { kind: 'none' }

    const hardCapable = match.records.every((item) => item.hardEligible)
    if (!hardCapable) {
      if (!this.weakReminded) {
        this.weakReminded = true
        return { kind: 'weak-reminder' }
      }
      return { kind: 'none' }
    }

    // Lock the cycle that earned this reminder and how far into it the latest
    // step sits. Continuations then count whole cycles from the reminder
    // itself, rather than re-deriving the shortest period from the window.
    this.confirmation = {
      cycle: match.records.slice(0, match.period),
      nextIndex: match.records.length % match.period,
      cycles: 0,
      cyclesAtReminder: match.cycles,
    }
    return { kind: 'strong-reminder' }
  }

  /**
   * Shortest period 1–3 whose suffix already contains enough complete cycles.
   * The evidence threshold keeps a low-evidence AA/BB suffix from hiding a
   * longer period that has already earned a reminder.
   */
  private findPattern(): PatternMatch | null {
    for (let period = 1; period <= 3; period += 1) {
      const match = this.matchPeriod(period)
      if (match === null) continue
      const cycles = Math.floor(match.length / period)
      if (cycles < REMIND_AFTER_CYCLES) continue
      return {
        period,
        cycles,
        records: this.recent.slice(match.start),
      }
    }
    return null
  }

  /**
   * Longest suffix with the given period. A trailing partial cycle is fine:
   * only complete cycles count (`floor(length / period)`), so a reminder fires
   * exactly when the fourth full cycle settles.
   */
  private matchPeriod(period: number): { start: number; length: number } | null {
    const count = this.recent.length
    if (count < period * 2) return null
    let start = count - period
    while (start > 0 && this.recent[start - 1]!.key === this.recent[start - 1 + period]!.key) {
      start -= 1
    }
    const length = count - start
    if (length < period * 2) return null
    return { start, length }
  }
}

export const LOOP_GUARD_LIMITS = {
  remindAfterCycles: REMIND_AFTER_CYCLES,
  stopAfterCycles: STOP_AFTER_CYCLES,
  recentSteps: RECENT_STEP_LIMIT,
} as const
