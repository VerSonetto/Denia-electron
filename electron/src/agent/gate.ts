// Dispatch-time permission gate.
//
// Mirrors Codex's approval pipeline:
//   1. classify the call (read / write / delete / network / plan-submit);
//   2. let the execpolicy rules speak first, then fall back to the sandbox
//      profile + approval policy (`decideAction` in `core/permission.ts`);
//   3. route prompts to the configured reviewer (`user` or `auto-review`),
//      with `prompt-user` bypassing automatic review entirely.
//
// Approval requests carry the decisions the UI may offer, so the host never has
// to guess which choices make sense for a given action.

import path from 'node:path'

import type { ExecPolicy } from '../core/exec-policy.ts'
import { commandTokens, normalizeProgram } from '../core/exec-policy.ts'
import type {
  ActionClass,
  ApprovalGrants,
  Decision,
  PermissionState,
} from '../core/permission.ts'
import {
  bashMayDelete,
  bashMayNetwork,
  bashMayWrite,
  certifiedReadonlyCommand,
  decideAction,
  grantedBySession,
} from '../core/permission.ts'
import type { PlanReviewDecision, ToolCallRef } from '../core/wire.ts'

/** One tool call's policy-relevant facts. */
export interface CallFacts {
  action: ActionClass
  insideWorkspace: boolean
  shell?: {
    command: string
    certifiedReadonly: boolean
    isDelete: boolean
    mayWrite: boolean
    mayNetwork: boolean
  }
}

export interface GateResult {
  facts: CallFacts
  decision: Decision
  /** Session-cache key; only set for ordinary prompts. */
  cacheKey?: string
  /** Prefix an `accept-with-rule` approval would persist. */
  proposedRule?: string[]
}

/** Read one string field out of raw tool arguments; missing or invalid → ''. */
export function argumentText(raw: string, key: string): string {
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return ''
    const field = (value as Record<string, unknown>)[key]
    return typeof field === 'string' ? field : ''
  } catch {
    return ''
  }
}

/** Resolve the `path` argument against cwd; undefined when absent or unparsable. */
function touchedPath(cwd: string, call: ToolCallRef): string | undefined {
  const raw = argumentText(call.arguments, 'path').trim()
  if (raw === '') return undefined
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw)
}

/** Component-wise containment (Rust `Path::starts_with`, not a string prefix). */
function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const FILE_WRITE_TOOLS = new Set(['write_file', 'edit'])

/**
 * Classify one call. Classification is lenient: unreadable arguments fall back
 * to the permissive class so the tool's own validation reports the problem
 * instead of disguising it as a permission failure.
 */
export function classifyCall(cwd: string, call: ToolCallRef, sandboxRestricted: boolean): CallFacts {
  if (call.name === 'exit_plan') {
    return { action: 'plan-submit', insideWorkspace: true }
  }
  if (FILE_WRITE_TOOLS.has(call.name)) {
    const target = touchedPath(cwd, call)
    if (target === undefined) return { action: 'write', insideWorkspace: true }
    return { action: 'write', insideWorkspace: isInside(cwd, target) }
  }
  if (call.name === 'bash' || call.name === 'job_start') {
    const command = argumentText(call.arguments, 'command')
    const isDelete = bashMayDelete(command)
    const mayWrite = bashMayWrite(command)
    const mayNetwork = bashMayNetwork(command)
    return {
      action: isDelete ? 'delete' : mayWrite ? 'write' : mayNetwork ? 'network' : 'read',
      insideWorkspace: true,
      shell: {
        command,
        // In a restricted sandbox an unprovable command counts as a write.
        certifiedReadonly: sandboxRestricted ? certifiedReadonlyCommand(command) : true,
        isDelete,
        mayWrite,
        mayNetwork,
      },
    }
  }
  if (call.name === 'run_checks') {
    return { action: 'write', insideWorkspace: true }
  }
  return { action: 'read', insideWorkspace: true }
}

/** Session-cache key: the normalized action, not just its coarse class. */
export function approvalCacheKey(facts: CallFacts, call: ToolCallRef, cwd: string): string {
  if (facts.shell) {
    const tokens = commandTokens(facts.shell.command).map((segment) =>
      segment.map((token, index) => (index === 0 ? normalizeProgram(token) : token)).join(' '),
    )
    return `shell:${tokens.join(' | ')}`
  }
  if (facts.action === 'write' || facts.action === 'delete') {
    const target = touchedPath(cwd, call)
    return `${facts.action}:${target ?? call.name}`
  }
  return call.name
}

/**
 * The policy stage for one call: execpolicy rules first, then the sandbox +
 * approval matrix. A rule `allow` removes the approval requirement but never
 * widens the sandbox — that is decided by `decideAction` alone.
 */
export function gateCall(
  state: PermissionState,
  cwd: string,
  call: ToolCallRef,
  policy: ExecPolicy,
  grants: ApprovalGrants,
): GateResult {
  const restricted = state.sandbox !== 'danger-full-access'
  const facts = classifyCall(cwd, call, restricted)
  const rule = facts.shell ? policy.evaluate(facts.shell.command) : undefined
  const decision = decideAction({
    state,
    action: facts.action,
    insideWorkspace: facts.insideWorkspace,
    ...(facts.shell ? { shell: facts.shell } : {}),
    ...(rule ? { rule } : {}),
  })

  // A rule-forbidden action never reaches a reviewer, even if the sandbox would
  // have allowed it (rules can only tighten, never loosen).
  if (rule?.kind === 'forbid' && decision.kind !== 'forbid') {
    return { facts, decision: rule }
  }

  if (decision.kind !== 'prompt') return { facts, decision }

  const cacheKey = approvalCacheKey(facts, call, cwd)
  if (grantedBySession(state, cacheKey, grants, decision)) {
    return { facts, decision: { kind: 'allow' }, cacheKey }
  }
  const proposedRule =
    facts.shell && state.sandbox !== 'read-only'
      ? commandTokens(facts.shell.command)[0]?.slice(0, 3).map((token, index) =>
          index === 0 ? normalizeProgram(token) : token,
        )
      : undefined
  return {
    facts,
    decision,
    cacheKey,
    ...(proposedRule && proposedRule.length > 0 ? { proposedRule } : {}),
  }
}

// ---------------------------------------------------------------------------
// Approval bridge (host → user / automatic reviewer)
// ---------------------------------------------------------------------------

export type ApprovalChoice =
  | 'accept'
  | 'accept-for-session'
  | 'accept-with-rule'
  | 'decline'
  | 'cancel'

export interface ApprovalRequest {
  sessionId: string
  requestId: string
  callId: string
  tool: string
  argsPreview: string
  reason?: string
  /** Choices the client may offer, in display order. */
  availableDecisions: ApprovalChoice[]
  /** Prefix an `accept-with-rule` decision would persist (shell only). */
  proposedRule?: string[]
}

export interface ApprovalAnswer {
  choice: ApprovalChoice
  /** Plan approvals may carry the execute mode, model and user feedback. */
  plan?: PlanReviewDecision
}

/**
 * Host channel that surfaces an approval and resolves with the user's (or the
 * automatic reviewer's) decision. `signal` aborts when the turn is cancelled.
 */
export interface ApprovalBridge {
  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer>
}

export const CANCELLED_ANSWER: ApprovalAnswer = { choice: 'cancel' }
export const DECLINED_ANSWER: ApprovalAnswer = { choice: 'decline' }

/** Choices offered for an ordinary prompt (subject to the action type). */
export function availableChoices(decision: Decision, proposedRule?: string[]): ApprovalChoice[] {
  if (decision.kind === 'prompt-user') return ['accept', 'decline', 'cancel']
  const choices: ApprovalChoice[] = ['accept', 'accept-for-session']
  if (proposedRule && proposedRule.length > 0) choices.push('accept-with-rule')
  choices.push('decline', 'cancel')
  return choices
}