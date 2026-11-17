// Unified completion lifecycle for subagents and background jobs.
//
// Producers only publish a result. This module decides when it becomes
// model-visible:
//
//   - model streaming or executing tools -> hold the result; it is promoted at
//     the next step boundary, never in the middle of an action;
//   - model idle -> deliver immediately and wake a model-only turn.
//
// The delivery fact still lives in the session log (`agent-inbox` ->
// `agent-delivery`), so retries, rewinds and restarts stay idempotent.

import type { Envelope, TurnEndReason } from '../core/wire.ts'
import type { SessionStore } from '../session/store.ts'

/** One settled subagent turn or one finished background job. */
export interface Completion {
  /** Stable identity; pushing the same id again is a no-op. */
  id: string
  /** Session that should receive the result. */
  target: string
  text: string
  /** `subagent-settled` / `job-completed` / `agent:<id>` / ... */
  source: string
}

export interface CompletionLifecycleOptions {
  store: SessionStore
  /** Start a model-only turn so the loop can drain the inbox. */
  startTurn(sessionId: string): Promise<void>
  isRunning(sessionId: string): boolean
  /** Auto-wake budget for ordinary agent messages. Completion results bypass it. */
  maxConsecutiveWakes?: number
  /** Same message-size limit as SubagentRuntime. */
  outputBytes?: number
}

type Activity = 'idle' | 'busy'

interface PendingEntry {
  seq: number
  text: string
  source: string
}

interface Ledger {
  /** Undelivered `agent-inbox` entries, in log order. */
  pending: Map<string, PendingEntry>
  /** Every id that already has an `agent-delivery` event. */
  delivered: Set<string>
  /** Seq of the newest pending inbox entry (wake-budget bookkeeping). */
  lastPendingSeq: number
}

const DEFAULT_OUTPUT_BYTES = 64 * 1024
const DEFAULT_MAX_CONSECUTIVE_WAKES = 3

/** Results are execution outcomes, not ordinary chat messages: they may use
 * the wake budget of a fresh batch even after a previous batch exhausted it. */
export function isCompletionSource(source: string): boolean {
  return source === 'subagent-settled' || source === 'job-completed'
}

export class CompletionLifecycle {
  private readonly store: SessionStore
  private readonly startTurn: (sessionId: string) => Promise<void>
  private readonly isRunning: (sessionId: string) => boolean
  private readonly maxConsecutiveWakes: number
  private readonly outputBytes: number
  private readonly ledgers = new Map<string, Ledger>()
  private readonly activity = new Map<string, Activity>()
  private readonly paused = new Set<string>()
  private readonly wakeAttempts = new Map<string, number>()
  private readonly completionMarks = new Map<string, number>()
  private readonly waking = new Set<string>()
  private readonly wakeAgain = new Set<string>()
  private closed = false

  constructor(options: CompletionLifecycleOptions) {
    this.store = options.store
    this.startTurn = options.startTurn
    this.isRunning = options.isRunning
    this.maxConsecutiveWakes = options.maxConsecutiveWakes ?? DEFAULT_MAX_CONSECUTIVE_WAKES
    this.outputBytes = options.outputBytes ?? DEFAULT_OUTPUT_BYTES
    this.store.events.on('session-event', this.onSessionEvent)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.store.events.off('session-event', this.onSessionEvent)
    this.waking.clear()
    this.wakeAgain.clear()
  }

  // —— producer API ——

  /**
   * Publish a completion. The result is persisted immediately (crash-safe) but
   * stays model-invisible until `drainInbox` promotes it at an action boundary.
   */
  push(completion: Completion): boolean {
    if (this.closed) throw new Error('完成结果生命周期已关闭')
    if (completion.text.length > this.outputBytes * 2) {
      throw new Error('代理消息超过配置的体积上限')
    }
    const ledger = this.ledgerOf(completion.target)
    if (ledger.delivered.has(completion.id) || ledger.pending.has(completion.id)) return false
    // A message from another agent is a direct instruction, not a completion
    // to retry: it resumes a paused child and starts a fresh wake budget.
    if (completion.source.startsWith('agent:')) {
      this.paused.delete(completion.target)
      this.wakeAttempts.delete(completion.target)
      this.completionMarks.delete(completion.target)
    }
    const envelope = this.store.append(completion.target, {
      type: 'agent-inbox',
      id: completion.id,
      text: completion.text,
      source: completion.source,
    })
    if (!envelope) {
      this.ledgers.delete(completion.target)
      throw new Error(`目标会话不存在：${completion.target}`)
    }
    this.store.flush(completion.target)
    this.pump(completion.target)
    return true
  }

  // —— loop hooks ——

  /** Promote pending inbox entries to model-visible deliveries (step boundary). */
  drainInbox(sessionId: string): void {
    const ledger = this.ledgerOf(sessionId)
    if (ledger.pending.size === 0) return
    // The step loop calls this before `step-start`, when no action is open.
    // Keep the guard for external callers: never inject between chunk and
    // tool-result.
    if (this.isRunning(sessionId) && (this.activity.get(sessionId) ?? 'idle') === 'busy') return
    for (const [id, entry] of [...ledger.pending]) {
      this.store.append(sessionId, {
        type: 'agent-delivery',
        id,
        text: entry.text,
        source: entry.source,
      })
    }
    this.store.flush(sessionId)
  }

  hasPending(sessionId: string): boolean {
    return this.ledgerOf(sessionId).pending.size > 0
  }

  /** A human-initiated turn started: clear the pause flag and wake budget. */
  onTurnStart(sessionId: string): void {
    this.paused.delete(sessionId)
    this.wakeAttempts.delete(sessionId)
    this.completionMarks.delete(sessionId)
  }

  /** A turn closed. `aborted` means the human asked to stop: hold auto-wakes
   * until the next human turn, but keep the results durable. */
  onTurnEnd(sessionId: string, reason: TurnEndReason): void {
    this.activity.set(sessionId, 'idle')
    if (reason.kind === 'aborted' && (reason.cause === undefined || reason.cause.kind === 'user')) {
      this.paused.add(sessionId)
      return
    }
    this.pump(sessionId)
  }

  /** A rewind removed the branch that owned the queued work. */
  onSessionRewound(sessionId: string): void {
    this.ledgers.delete(sessionId)
    this.activity.delete(sessionId)
    this.paused.delete(sessionId)
    this.wakeAttempts.delete(sessionId)
    this.completionMarks.delete(sessionId)
  }

  /** Startup recovery: wake sessions whose inbox still holds undelivered data. */
  recover(sessionId: string): void {
    if (!this.store.header(sessionId)) return
    this.pump(sessionId)
  }

  /** Stop automatic wakes for a subagent (used by interrupt_agent). */
  pause(sessionId: string): void {
    this.paused.add(sessionId)
  }

  /** Allow automatic wakes again (used by send_message and human turns). */
  resume(sessionId: string): void {
    this.paused.delete(sessionId)
    this.wakeAttempts.delete(sessionId)
    this.completionMarks.delete(sessionId)
    this.pump(sessionId)
  }

  /** Re-evaluate a session after an external state change. */
  kick(sessionId: string): void {
    this.pump(sessionId)
  }

  /** Drop all in-memory state for a deleted session. */
  forget(sessionId: string): void {
    this.ledgers.delete(sessionId)
    this.activity.delete(sessionId)
    this.paused.delete(sessionId)
    this.wakeAttempts.delete(sessionId)
    this.completionMarks.delete(sessionId)
    this.waking.delete(sessionId)
    this.wakeAgain.delete(sessionId)
  }

  // —— internals ——

  private readonly onSessionEvent = (sessionId: string, event: Envelope): void => {
    if (event.type === 'agent-inbox' || event.type === 'agent-delivery') {
      const ledger = this.ledgerOf(sessionId)
      if (event.type === 'agent-inbox') {
        if (!ledger.delivered.has(event.id)) {
          ledger.pending.set(event.id, {
            seq: event.seq,
            text: event.text,
            source: event.source,
          })
          if (event.seq > ledger.lastPendingSeq) ledger.lastPendingSeq = event.seq
        }
      } else {
        ledger.delivered.add(event.id)
        ledger.pending.delete(event.id)
      }
    }
    this.observeActivity(sessionId, event)
  }

  /** Convert a durable event into the model activity it implies. */
  private observeActivity(sessionId: string, event: Envelope): void {
    let next: Activity | null = null
    switch (event.type) {
      case 'assistant-chunk':
        // Any streamed block (text, reasoning or tool-call delta) means the
        // model is producing; do not interrupt this step.
        next = 'busy'
        break
      case 'assistant-message':
        // A message with tool calls keeps the step open until its tool results
        // and `step-end`; a text-only message ends the model's action here.
        next = event.blocks.some((block) => block.type === 'tool-call') ? 'busy' : 'idle'
        break
      case 'tool-call':
        next = 'busy'
        break
      case 'turn-start':
      case 'step-end':
      case 'turn-end':
        next = 'idle'
        break
      default:
        return
    }
    const previous = this.activity.get(sessionId) ?? 'idle'
    this.activity.set(sessionId, next)
    if (previous === 'busy' && next === 'idle') this.pump(sessionId)
  }

  private ledgerOf(sessionId: string): Ledger {
    const cached = this.ledgers.get(sessionId)
    if (cached) return cached
    const ledger: Ledger = { pending: new Map(), delivered: new Set(), lastPendingSeq: 0 }
    const session = this.store.read(sessionId)
    if (session) {
      for (const event of session.events) {
        if (event.type === 'agent-inbox') {
          if (!ledger.delivered.has(event.id)) {
            ledger.pending.set(event.id, {
              seq: event.seq,
              text: event.text,
              source: event.source,
            })
            if (event.seq > ledger.lastPendingSeq) ledger.lastPendingSeq = event.seq
          }
        } else if (event.type === 'agent-delivery') {
          ledger.delivered.add(event.id)
          ledger.pending.delete(event.id)
        }
      }
    }
    this.ledgers.set(sessionId, ledger)
    return ledger
  }

  private pump(sessionId: string): void {
    if (this.closed || this.paused.has(sessionId)) return
    if (!this.hasPending(sessionId)) return
    // While a turn is open the loop drains at the next step boundary; only an
    // idle session needs a wake.
    if (this.isRunning(sessionId)) return
    this.wake(sessionId)
  }

  private wake(sessionId: string): void {
    if (this.closed || this.paused.has(sessionId) || this.isRunning(sessionId)) return
    if (!this.hasPending(sessionId)) return
    if (this.waking.has(sessionId)) {
      // A turn is already starting/finishing; keep the idle edge so the
      // result cannot be stranded between wake and drain.
      this.wakeAgain.add(sessionId)
      return
    }

    const ledger = this.ledgerOf(sessionId)
    const completion = [...ledger.pending.values()].some((entry) =>
      isCompletionSource(entry.source),
    )
    const freshCompletion =
      completion && this.completionMarks.get(sessionId) !== ledger.lastPendingSeq
    const attempts = this.wakeAttempts.get(sessionId) ?? 0
    // Completion results are outcomes the model must receive; they bypass the
    // ordinary message-loop guard once per fresh batch. Ordinary agent
    // messages still stop after `maxConsecutiveWakes`.
    if (!freshCompletion && attempts >= this.maxConsecutiveWakes) return
    if (freshCompletion) this.completionMarks.set(sessionId, ledger.lastPendingSeq)
    else this.wakeAttempts.set(sessionId, attempts + 1)

    this.waking.add(sessionId)
    void this.startTurn(sessionId)
      .catch(() => {
        /* the driver records turn failures in the log */
      })
      .finally(() => {
        this.waking.delete(sessionId)
        const again = this.wakeAgain.delete(sessionId)
        if (again || this.hasPending(sessionId)) this.pump(sessionId)
      })
  }
}
