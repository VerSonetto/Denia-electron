// Approval dispatch: one gated tool call, user or automatic reviewer.
//
// The driver decides *whether* a call needs approval (sandbox × policy ×
// grants). This module owns the settlement path: persist the request, ask the
// configured reviewer, record the decision, and translate the answer into
// either an allow, a Denia-shaped tool result, or an aborted turn.

import { randomUUID } from 'node:crypto'

import type { PermissionState } from '../core/permission.ts'
import type { ExecPolicy } from '../core/exec-policy.ts'
import type { SessionEvent, ToolCallRef, ToolOutput } from '../core/wire.ts'
import { toolError } from '../tools/types.ts'
import type { ApprovalAnswer, ApprovalBridge, ApprovalRequest, GateResult } from './gate.ts'
import { DECLINED_ANSWER, argumentText, availableChoices } from './gate.ts'
import type { Reviewer, ReviewTranscriptEntry, ReviewVerdict } from './reviewer.ts'

export interface ApprovalDispatchPort {
  sessionId: string
  cwd: string
  bridge?: ApprovalBridge
  reviewer?: Reviewer
  policy: ExecPolicy
  /** Session-scoped "allow for this window" cache. */
  grants: Set<string>
  append(event: SessionEvent): unknown
  /** Recent conversation, trimmed for the reviewer prompt. */
  transcript(): ReviewTranscriptEntry[]
  /** Apply an accepted plan: leave plan mode, switch preset, maybe model. */
  applyPlan(answer: ApprovalAnswer): ToolOutput
  /** Cancel the whole turn (approval cancellation). */
  abort(): void
  /** A decision is a business boundary for repetition detection. */
  markApprovalBoundary(): void
}

export interface ApprovalDecision {
  abort: boolean
  /** A settled output that replaces tool execution (plan accept/decline). */
  output?: ToolOutput
}

/**
 * Ask the human or the automatic reviewer, record the outcome, then act.
 *
 * `prompt-user` actions always reach the human bridge; automatic review only
 * answers ordinary `prompt` decisions. A cancellation aborts the run, and a
 * rejection becomes a normal Denia tool error unless it is a plan submission.
 */
export async function dispatchApproval(
  port: ApprovalDispatchPort,
  call: ToolCallRef,
  gate: GateResult,
  state: PermissionState,
  signal?: AbortSignal,
): Promise<ApprovalDecision> {
  const requestId = randomUUID()
  const reason = 'reason' in gate.decision ? gate.decision.reason : undefined
  const isPlan = call.name === 'exit_plan'
  const approvalSignal = signal ?? new AbortController().signal
  const request: ApprovalRequest = {
    sessionId: port.sessionId,
    requestId,
    callId: call.id,
    tool: call.name,
    argsPreview: call.arguments,
    ...(reason ? { reason } : {}),
    availableDecisions: availableChoices(gate.decision, gate.proposedRule),
    ...(gate.proposedRule ? { proposedRule: gate.proposedRule } : {}),
  }
  const isAutoReview =
    gate.decision.kind === 'prompt' && state.reviewer === 'auto-review' && port.reviewer !== undefined
  if (!isAutoReview) {
    port.append({
      type: 'approval-asked',
      request_id: requestId,
      call_id: call.id,
      tool: call.name,
      args_preview: call.arguments,
      ...(reason ? { reason } : {}),
    })
  }

  let answer: ApprovalAnswer
  if (gate.decision.kind === 'prompt-user') {
    answer = port.bridge
      ? await port.bridge.request(request, approvalSignal)
      : DECLINED_ANSWER
  } else if (isAutoReview) {
    const reviewed = await reviewAutomatically(port, call, gate, signal)
    port.append({
      type: 'auto-review',
      request_id: requestId,
      call_id: call.id,
      tool: call.name,
      outcome: reviewed.verdict.outcome,
      risk_level: reviewed.verdict.riskLevel,
      user_authorization: reviewed.verdict.userAuthorization,
      rationale: reviewed.verdict.rationale,
    })
    answer = reviewed.answer
  } else {
    answer = port.bridge
      ? await port.bridge.request(request, approvalSignal)
      : DECLINED_ANSWER
  }

  const outcome =
    answer.choice === 'accept'
      ? 'allowed-once'
      : answer.choice === 'accept-for-session' || answer.choice === 'accept-with-rule'
        ? 'allowed-session'
        : answer.choice === 'cancel'
          ? 'cancelled'
          : 'rejected'
  if (!isAutoReview) {
    port.append({
      type: 'approval-decided',
      request_id: requestId,
      outcome,
    })
    port.markApprovalBoundary()
  }

  if (signal?.aborted) return { abort: true }
  switch (answer.choice) {
    case 'accept':
      if (isPlan) return { abort: false, output: port.applyPlan(answer) }
      return { abort: false }
    case 'accept-for-session':
      if (gate.cacheKey) port.grants.add(gate.cacheKey)
      if (isPlan) return { abort: false, output: port.applyPlan(answer) }
      return { abort: false }
    case 'accept-with-rule':
      if (gate.proposedRule) await port.policy.appendAllow(gate.proposedRule)
      if (gate.cacheKey) port.grants.add(gate.cacheKey)
      if (isPlan) return { abort: false, output: port.applyPlan(answer) }
      return { abort: false }
    case 'decline':
      if (isPlan) {
        const feedback = answer.plan?.feedback?.trim()
        const text = feedback
          ? `用户拒绝了该计划。请按以下补充建议修订计划后重新提交:\n${feedback}`
          : '用户拒绝了该计划。请修订计划后重新提交;不确定用户的顾虑时,先用 ask 工具询问。'
        return { abort: false, output: { content: text, isError: false } }
      }
      return {
        abort: false,
        output: toolError('用户拒绝了该操作;请改用项目目录内的方案,或先询问用户。'),
      }
    case 'cancel':
      port.abort()
      return { abort: true }
  }
}

/** Route an ordinary prompt through the automatic reviewer. */
async function reviewAutomatically(
  port: ApprovalDispatchPort,
  call: ToolCallRef,
  gate: GateResult,
  signal?: AbortSignal,
): Promise<{ answer: ApprovalAnswer; verdict: ReviewVerdict }> {
  if (!port.reviewer) {
    return {
      answer: DECLINED_ANSWER,
      verdict: {
        outcome: 'deny',
        riskLevel: 'high',
        userAuthorization: 'unknown',
        rationale: 'automatic approval review is unavailable',
      },
    }
  }
  const summary = gate.facts.shell
    ? gate.facts.shell.command
    : argumentText(call.arguments, 'path') || call.arguments.slice(0, 2000)
  const verdict = await port.reviewer.review(
    {
      tool: call.name,
      action: gate.facts.action,
      summary,
      cwd: port.cwd,
      ...(gate.decision.kind === 'prompt' && gate.decision.reason
        ? { reason: gate.decision.reason }
        : {}),
      transcript: port.transcript(),
    },
    signal ?? new AbortController().signal,
  )
  return {
    answer: verdict.outcome === 'allow' ? { choice: 'accept' } : DECLINED_ANSWER,
    verdict,
  }
}