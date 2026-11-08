// Goal runtime: command handling, run accounting, completion verification and
// automatic continuation.
//
// A turn that closes normally is followed by one verifier call. A passing
// verdict finishes the goal; a failing one opens the next iteration and starts
// a model-only continuation turn. A user turn always wins: the runtime never
// starts a continuation while the session is running.

import { randomUUID } from 'node:crypto'

import type { StartTurnOptions } from '../agent/loop.ts'
import type { AppConfig } from '../config.ts'
import type { ModelSelection, SessionEvent, TokenUsage, TurnEndReason } from '../core/wire.ts'
import {
  formatGoalCompletionVerificationPrompt,
  formatGoalContinuationPrompt,
  parseGoalCompletionVerificationText,
} from './prompts.ts'
import type { GoalStore } from './store.ts'
import {
  MAX_GOAL_ITERATIONS,
  MAX_GOAL_OBJECTIVE_CHARS,
  goalTokensOf,
  type GoalStatus,
  type SessionGoal,
} from './types.ts'

export interface GoalVerifierInput {
  sessionId: string
  prompt: string
  selection: ModelSelection
  signal: AbortSignal
}

export interface GoalRuntimeOptions {
  goalStore: GoalStore
  config: () => AppConfig
  isRunning: (sessionId: string) => boolean
  startTurn: (sessionId: string, prompt: string, options: StartTurnOptions) => void
  cancel: (sessionId: string) => void
  /** Model selection of the latest turn; the verifier and continuation reuse it. */
  selectionOf: (sessionId: string) => ModelSelection | null
  verify: (input: GoalVerifierInput) => Promise<string>
  planEnabled: (sessionId: string) => boolean
  append: (sessionId: string, event: SessionEvent) => void
}

export class GoalCommandError extends Error {
  readonly code: 'goal/empty-objective' | 'goal/bad-budget' | 'goal/plan-active' | 'goal/complete'
  readonly status: number

  constructor(
    code: GoalCommandError['code'],
    message: string,
    status: number,
  ) {
    super(message)
    this.name = 'GoalCommandError'
    this.code = code
    this.status = status
  }
}

export interface GoalView {
  goal: SessionGoal | null
  tokensUsed: number
}

/** How long a verifier may take before it is treated as failed. */
const VERIFIER_TIMEOUT_MS = 90_000

export class GoalRuntime {
  private readonly options: GoalRuntimeOptions
  private readonly advancing = new Set<string>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly selections = new Map<string, ModelSelection>()

  constructor(options: GoalRuntimeOptions) {
    this.options = options
  }

  read(sessionId: string): SessionGoal | null {
    return this.options.goalStore.read(sessionId)
  }

  view(sessionId: string): GoalView {
    const goal = this.read(sessionId)
    return { goal, tokensUsed: goal?.tokensUsed ?? 0 }
  }

  set(
    sessionId: string,
    objective: string,
    tokenBudget?: number | null,
    selection?: ModelSelection,
  ): SessionGoal {
    const text = objective.trim()
    if (text === '') {
      throw new GoalCommandError('goal/empty-objective', '目标内容不能为空', 400)
    }
    if (Array.from(text).length > MAX_GOAL_OBJECTIVE_CHARS) {
      throw new GoalCommandError(
        'goal/empty-objective',
        `目标不能超过 ${MAX_GOAL_OBJECTIVE_CHARS} 个字符`,
        400,
      )
    }
    if (tokenBudget !== undefined && tokenBudget !== null) {
      if (!Number.isFinite(tokenBudget) || tokenBudget < 0) {
        throw new GoalCommandError('goal/bad-budget', '预算必须是非负整数', 400)
      }
    }
    if (this.options.planEnabled(sessionId)) {
      throw new GoalCommandError('goal/plan-active', '计划模式与目标模式不能同时启用', 409)
    }
    const now = Date.now()
    const goal: SessionGoal = {
      targetId: randomUUID(),
      objective: text,
      summaryTitle: null,
      status: 'active',
      tokenBudget:
        tokenBudget === undefined || tokenBudget === null ? null : Math.floor(tokenBudget),
      tokensUsed: 0,
      timeUsedSeconds: 0,
      activeRunStartedAtMs: null,
      iteration: 1,
      verifications: [],
      time: { created: now, updated: now },
    }
    this.persist(sessionId, goal, 'set')
    if (selection) this.selections.set(sessionId, selection)
    void this.advance(sessionId, false)
    return goal
  }

  pause(sessionId: string): SessionGoal | null {
    const goal = this.read(sessionId)
    if (!goal || goal.status !== 'active') return goal
    const paused = this.settle(goal, null, 'paused')
    this.persist(sessionId, paused, 'paused')
    // Stopping the goal also stops the turn that is currently pursuing it,
    // and any in-flight verification whose verdict would restart it.
    this.controllers.get(sessionId)?.abort()
    this.options.cancel(sessionId)
    return paused
  }

  resume(sessionId: string, selection?: ModelSelection): SessionGoal | null {
    const goal = this.read(sessionId)
    if (!goal) return null
    if (goal.status === 'complete') {
      throw new GoalCommandError('goal/complete', '目标已完成，如需继续请设置新目标', 409)
    }
    if (this.options.planEnabled(sessionId)) {
      throw new GoalCommandError('goal/plan-active', '计划模式与目标模式不能同时启用', 409)
    }
    if (goal.status === 'active') return goal
    const resumed: SessionGoal = {
      ...goal,
      status: 'active',
      time: { ...goal.time, updated: Date.now() },
    }
    this.persist(sessionId, resumed, 'resumed')
    if (selection) this.selections.set(sessionId, selection)
    void this.advance(sessionId, false)
    return resumed
  }

  clear(sessionId: string): void {
    const goal = this.read(sessionId)
    if (!goal) return
    this.options.cancel(sessionId)
    this.options.goalStore.remove(sessionId)
    this.options.append(sessionId, {
      type: 'goal',
      op: 'cleared',
      status: goal.status,
      targetId: goal.targetId,
    })
  }

  /** A turn started: open the active run used for elapsed-time accounting. */
  onTurnStart(sessionId: string): void {
    const goal = this.read(sessionId)
    if (!goal || goal.status !== 'active' || goal.activeRunStartedAtMs !== null) return
    const started: SessionGoal = {
      ...goal,
      activeRunStartedAtMs: Date.now(),
      time: { ...goal.time, updated: Date.now() },
    }
    this.options.goalStore.write(sessionId, started)
  }

  /**
   * A turn closed. Usage and elapsed time settle first; an interrupted turn
   * pauses the goal, and a normally completed turn goes through verification.
   */
  onTurnEnd(
    sessionId: string,
    reason: TurnEndReason,
    usage: TokenUsage | undefined,
  ): void {
    const goal = this.read(sessionId)
    if (!goal || goal.status !== 'active') return
    const settled = this.settle(goal, usage, reason.kind === 'aborted' ? 'paused' : undefined)
    this.persist(sessionId, settled, reason.kind === 'aborted' ? 'paused' : 'accounted')
    if (reason.kind !== 'completed') return
    if (settled.status !== 'active') return
    if (settled.tokenBudget !== null && settled.tokensUsed >= settled.tokenBudget) {
      this.persist(sessionId, { ...settled, status: 'budget-limited' }, 'budget-limited')
      return
    }
    void this.advance(sessionId, true)
  }

  private settle(
    goal: SessionGoal,
    usage: TokenUsage | null | undefined,
    status?: GoalStatus,
  ): SessionGoal {
    const now = Date.now()
    const started = goal.activeRunStartedAtMs
    const elapsed = started === null ? 0 : Math.max(0, Math.ceil((now - started) / 1000))
    return {
      ...goal,
      status: status ?? goal.status,
      tokensUsed: goal.tokensUsed + (usage ? goalTokensOf(usage) : 0),
      timeUsedSeconds: goal.timeUsedSeconds + elapsed,
      activeRunStartedAtMs: null,
      time: { ...goal.time, updated: now },
    }
  }

  /**
   * One advancement step. `verifyFirst` runs the completion verifier before
   * deciding whether to continue; a freshly set or resumed goal skips it so the
   * first continuation starts immediately instead of verifying empty work.
   */
  private async advance(sessionId: string, verifyFirst: boolean): Promise<void> {
    if (this.advancing.has(sessionId)) return
    this.advancing.add(sessionId)
    try {
      const goal = this.read(sessionId)
      if (!goal || goal.status !== 'active') return
      if (this.options.planEnabled(sessionId)) return
      if (this.options.isRunning(sessionId)) return
      if (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) {
        this.persist(sessionId, { ...goal, status: 'budget-limited' }, 'budget-limited')
        return
      }
      const selection =
        this.selections.get(sessionId) ?? this.options.selectionOf(sessionId)
      if (!selection) return

      let recorded = goal
      let verdict: { reason?: string; nextAction?: string } | undefined
      if (verifyFirst) {
        const verification = await this.verify(sessionId, goal, selection)
        const latest = this.read(sessionId)
        if (!latest || latest.targetId !== goal.targetId || latest.status !== 'active') return
        recorded = {
          ...latest,
          verifications: [
            ...latest.verifications,
            {
              iteration: latest.iteration,
              outcome: verification.outcome,
              at: Date.now(),
              ...(verification.reason ? { reason: verification.reason } : {}),
              ...(verification.nextAction ? { nextAction: verification.nextAction } : {}),
            },
          ].slice(-50),
          time: { ...latest.time, updated: Date.now() },
        }
        if (verification.outcome === 'pass') {
          this.persist(sessionId, { ...recorded, status: 'complete' }, 'verified')
          return
        }
        // A verifier infrastructure failure is not a product verdict; keep the
        // goal active and let the next user turn retry instead of looping.
        if (verification.outcome === 'failed') {
          this.persist(sessionId, recorded, 'verification-failed')
          return
        }
        verdict = {
          ...(verification.reason ? { reason: verification.reason } : {}),
          ...(verification.nextAction ? { nextAction: verification.nextAction } : {}),
        }
      }
      if (recorded.tokenBudget !== null && recorded.tokensUsed >= recorded.tokenBudget) {
        this.persist(sessionId, { ...recorded, status: 'budget-limited' }, 'budget-limited')
        return
      }
      if (recorded.iteration >= MAX_GOAL_ITERATIONS) {
        this.persist(sessionId, { ...recorded, status: 'paused' }, 'paused')
        return
      }
      if (this.options.isRunning(sessionId)) return
      const next: SessionGoal = {
        ...recorded,
        iteration: recorded.iteration + (verifyFirst ? 1 : 0),
        time: { ...recorded.time, updated: Date.now() },
      }
      this.options.goalStore.write(sessionId, next)
      this.options.append(sessionId, {
        type: 'goal',
        op: 'continued',
        status: next.status,
        targetId: next.targetId,
      })
      this.options.startTurn(sessionId, formatGoalContinuationPrompt(next, verdict), {
        source: 'goal-continuation',
        injected: true,
        channel: 'goal-continuation',
        selection,
      })
    } finally {
      this.advancing.delete(sessionId)
    }
  }

  private async verify(
    sessionId: string,
    goal: SessionGoal,
    selection: ModelSelection,
  ): Promise<{
    outcome: 'pass' | 'not-satisfied' | 'failed'
    reason?: string
    nextAction?: string
  }> {
    const controller = new AbortController()
    this.controllers.set(sessionId, controller)
    const timer = setTimeout(() => controller.abort(), VERIFIER_TIMEOUT_MS)
    timer.unref?.()
    try {
      const text = await this.options.verify({
        sessionId,
        prompt: formatGoalCompletionVerificationPrompt(goal),
        selection,
        signal: controller.signal,
      })
      const parsed = parseGoalCompletionVerificationText(text)
      return {
        outcome: parsed.passed ? 'pass' : 'not-satisfied',
        reason: parsed.reason,
        ...(parsed.nextAction ? { nextAction: parsed.nextAction } : {}),
      }
    } catch (error) {
      return {
        outcome: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      }
    } finally {
      clearTimeout(timer)
      this.controllers.delete(sessionId)
    }
  }

  private persist(sessionId: string, goal: SessionGoal, op: string): void {
    this.options.goalStore.write(sessionId, goal)
    this.options.append(sessionId, {
      type: 'goal',
      op,
      status: goal.status,
      targetId: goal.targetId,
    })
  }
}
