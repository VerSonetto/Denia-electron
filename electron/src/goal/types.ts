// Durable session goal: one long-running objective per session.
//
// The status is owned by the host. The model can read the goal but never
// writes it; completion is decided by an independent verifier call after a
// turn closes, not by the agent's own claim.

export type GoalStatus = 'active' | 'paused' | 'budget-limited' | 'complete'

export type GoalVerificationOutcome = 'pass' | 'not-satisfied' | 'failed'

export interface GoalVerification {
  iteration: number
  outcome: GoalVerificationOutcome
  at: number
  reason?: string
  nextAction?: string
}

export interface SessionGoal {
  targetId: string
  objective: string
  summaryTitle: string | null
  status: GoalStatus
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  /** Wall-clock start of the currently running turn; null while idle. */
  activeRunStartedAtMs: number | null
  /** 1-based iteration; a new one opens after each failed verification. */
  iteration: number
  verifications: GoalVerification[]
  time: { created: number; updated: number }
}

export const MAX_GOAL_OBJECTIVE_CHARS = 4_000

/** Safety rail against a verifier loop that never converges. */
export const MAX_GOAL_ITERATIONS = 100

export function goalTokensOf(usage: {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  reasoningTokens?: number
}): number {
  return (
    Math.max(0, usage.inputTokens) +
    Math.max(0, usage.outputTokens) +
    Math.max(0, usage.cacheReadTokens ?? 0) +
    Math.max(0, usage.reasoningTokens ?? 0)
  )
}
