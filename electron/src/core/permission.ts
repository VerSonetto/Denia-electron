// Permission policy: three orthogonal dimensions (sandbox profile, approval
// policy, reviewer) instead of a single-dimensional mode switch.
//   - a sandbox profile (`read-only` / `workspace-write` / `danger-full-access`)
//   - an approval policy (`untrusted` / `on-request` / `granular` / `never`)
//   - an approvals reviewer (`user` / `auto-review`)
//   - a collaboration mode (`default` / `plan`), which is orthogonal to the above.
//
// The five agent modes the UI exposes are just presets over those fields:
// read-only / auto / granular / guardian-approvals / full-access.
//
// Decisions are four-valued, mirroring `execpolicy::Decision`:
// allow / prompt / prompt-user / forbid. `prompt-user` can never be satisfied by
// an automated reviewer or a session grant.

import type { PermissionMode as LegacyPermissionMode } from './wire.ts'

/** How much the sandbox lets a tool touch. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** When approval prompts may reach a reviewer, and when they are refused outright. */
export type AskForApproval =
  | 'untrusted'
  | 'on-request'
  | { granular: GranularApprovalConfig }
  | 'never'

/** Per-flow switches for the fine-grained approval policy. */
export interface GranularApprovalConfig {
  sandboxApproval: boolean
  rules: boolean
  skillApproval: boolean
  requestPermissions: boolean
  mcpElicitations: boolean
}

/** Who answers an approval request. */
export type ApprovalsReviewer = 'user' | 'auto-review'

/** Plan is a collaboration mode, not a permission level. */
export type CollaborationMode = 'default' | 'plan'

/** The four presets the permission catalog exposes. */
export type AgentMode =
  | 'read-only'
  | 'workspace-write'
  | 'approve-for-me'
  | 'full-access'

/**
 * The complete permission state of one session. This is the thing that gets
 * persisted; the legacy `permission-mode` event is a projection of it.
 */
export interface PermissionState {
  sandbox: SandboxMode
  approval: AskForApproval
  reviewer: ApprovalsReviewer
  collaboration: CollaborationMode
}

export interface AgentModePreset {
  mode: AgentMode
  sandbox: SandboxMode
  approval: AskForApproval
  reviewer: ApprovalsReviewer
}

/**
 * The permission catalog: each preset is a named combination of the three
 * fields above, so the UI can expose four choices over one state model.
 */
export const AGENT_MODE_CATALOG: Record<AgentMode, AgentModePreset> = {
  'read-only': {
    mode: 'read-only',
    sandbox: 'read-only',
    approval: 'on-request',
    reviewer: 'user',
  },
  'workspace-write': {
    mode: 'workspace-write',
    sandbox: 'workspace-write',
    approval: 'on-request',
    reviewer: 'user',
  },
  'approve-for-me': {
    mode: 'approve-for-me',
    sandbox: 'workspace-write',
    approval: 'on-request',
    reviewer: 'auto-review',
  },
  'full-access': {
    mode: 'full-access',
    sandbox: 'danger-full-access',
    approval: 'never',
    reviewer: 'user',
  },
}

/** All selectable presets, in catalog order (read-only first, full access last). */
export const AGENT_MODES: AgentMode[] = [
  'read-only',
  'workspace-write',
  'approve-for-me',
  'full-access',
]

/** Recover the preset identity from the three fields (presets are the only source). */
export function modeOf(state: PermissionState): AgentMode {
  if (state.sandbox === 'read-only') return 'read-only'
  if (state.sandbox === 'danger-full-access') return 'full-access'
  return state.reviewer === 'auto-review' ? 'approve-for-me' : 'workspace-write'
}

export function presetState(mode: AgentMode, collaboration: CollaborationMode = 'default'): PermissionState {
  const preset = AGENT_MODE_CATALOG[mode]
  return {
    sandbox: preset.sandbox,
    approval: preset.approval,
    reviewer: preset.reviewer,
    collaboration,
  }
}

/**
 * Map a state back to the four legacy levels the existing web UI understands.
 * `plan` is the only collaboration projection; approve-for-me looks like
 * `auto-edit` to the old selector, which is acceptable — the full state is
 * persisted separately and the UI never needs to know more today.
 */
export function legacyModeOf(state: PermissionState): LegacyPermissionMode {
  if (state.collaboration === 'plan') return 'plan'
  if (state.sandbox === 'read-only') return 'read-only'
  if (state.sandbox === 'danger-full-access') return 'full'
  return 'auto-edit'
}

/** Map one legacy level onto a full state (old logs, old UI writes). */
export function stateFromLegacy(mode: LegacyPermissionMode, current?: PermissionState): PermissionState {
  const collaboration: CollaborationMode = mode === 'plan' ? 'plan' : 'default'
  if (mode === 'plan') {
    // Leaving plan mode restores the previous sandbox/approval/reviewer fields.
    return {
      sandbox: current?.sandbox ?? 'workspace-write',
      approval: current?.approval ?? 'on-request',
      reviewer: current?.reviewer ?? 'user',
      collaboration,
    }
  }
  if (mode === 'read-only') return presetState('read-only', collaboration)
  if (mode === 'full') return presetState('full-access', collaboration)
  // `auto-edit` means workspace-write; keep the automatic reviewer if the
  // session was already in approve-for-me, otherwise fall back to the user.
  const keepAutoReview = current?.sandbox === 'workspace-write' && current.reviewer === 'auto-review'
  return {
    sandbox: 'workspace-write',
    approval: 'on-request',
    reviewer: keepAutoReview ? 'auto-review' : 'user',
    collaboration,
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSandboxMode(value: unknown): value is SandboxMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
}

function isReviewer(value: unknown): value is ApprovalsReviewer {
  return value === 'user' || value === 'auto-review'
}

function isGranular(value: unknown): value is GranularApprovalConfig {
  if (!isRecord(value)) return false
  return (
    typeof value.sandboxApproval === 'boolean' &&
    typeof value.rules === 'boolean' &&
    typeof value.skillApproval === 'boolean' &&
    typeof value.requestPermissions === 'boolean' &&
    typeof value.mcpElicitations === 'boolean'
  )
}

function isApproval(value: unknown): value is AskForApproval {
  if (value === 'untrusted' || value === 'on-request' || value === 'never') return true
  return isRecord(value) && isGranular(value.granular)
}

/** Parse one persisted/request-provided permission state; null when malformed. */
export function parsePermissionState(value: unknown): PermissionState | null {
  if (!isRecord(value)) return null
  const { sandbox, approval, reviewer, collaboration } = value
  if (!isSandboxMode(sandbox) || !isApproval(approval) || !isReviewer(reviewer)) return null
  return {
    sandbox,
    approval,
    reviewer,
    collaboration: collaboration === 'plan' ? 'plan' : 'default',
  }
}

/** Action class of one tool call, decided before the policy stage. */
export type ActionClass = 'read' | 'write' | 'delete' | 'network' | 'plan-submit' | 'memory-write'

/** Four-valued decision: run, ask a reviewer, force a human, or refuse. */
export type Decision =
  | { kind: 'allow' }
  | { kind: 'prompt'; reason?: string; rulePrompt?: boolean; proposedRule?: string[] }
  | { kind: 'prompt-user'; reason?: string }
  | { kind: 'forbid'; reason: string }

export const ALLOW: Decision = { kind: 'allow' }

export function promptDecision(reason?: string, proposedRule?: string[]): Decision {
  return { kind: 'prompt', ...(reason === undefined ? {} : { reason }), ...(proposedRule ? { proposedRule } : {}) }
}

export function forbid(reason: string): Decision {
  return { kind: 'forbid', reason }
}

/** Rank for "most restrictive wins" merging; declaration order is the severity order. */
export function decisionRank(decision: Decision): number {
  switch (decision.kind) {
    case 'allow':
      return 0
    case 'prompt':
      return 1
    case 'prompt-user':
      return 2
    case 'forbid':
      return 3
  }
}

export function strictest(decisions: readonly Decision[]): Decision {
  let worst: Decision = ALLOW
  for (const decision of decisions) {
    if (decisionRank(decision) > decisionRank(worst)) worst = decision
  }
  return worst
}

/** One session's reusable approvals: normalized action key → kind. */
export type ApprovalGrants = ReadonlySet<string>

/** The policy question for one tool call. */
export interface PolicyInput {
  state: PermissionState
  action: ActionClass
  /** True when the target path sits inside the session workspace. */
  insideWorkspace: boolean
  /** Shell-specific refinements (only meaningful for `bash`). */
  shell?: {
    command: string
    /** Statically provable read-only; false also covers "cannot prove". */
    certifiedReadonly: boolean
    isDelete: boolean
    mayWrite: boolean
    mayNetwork: boolean
  }
  /** Result of the execpolicy prefix rules, when one matched. */
  rule?: Decision
}

/**
 * Approval-policy gate: may a prompt of this kind reach its reviewer?
 * The approval policy can turn a prompt into a hard refusal.
 */
function promptGate(approval: AskForApproval, promptIsRule: boolean): string | null {
  if (approval === 'never') return '审批策略为 never:该操作不会询问用户,已被拒绝。'
  if (approval === 'on-request' || approval === 'untrusted') return null
  if (promptIsRule) {
    return approval.granular.rules ? null : '审批策略的 rules 开关已关闭:规则触发的审批被拒绝。'
  }
  return approval.granular.sandboxApproval
    ? null
    : '审批策略的 sandbox_approval 开关已关闭:沙箱升级审批被拒绝。'
}

function gated(decision: Decision, approval: AskForApproval): Decision {
  if (decision.kind !== 'prompt') return decision
  const rejection = promptGate(approval, decision.rulePrompt === true)
  return rejection === null ? decision : forbid(rejection)
}

/**
 * The policy stage: action class × sandbox profile × approval policy.
 *
 * The sandbox profile is what the action runs under. An allow rule from the
 * execpolicy only removes the approval requirement; it never widens the
 * sandbox: an allow rule only removes the approval requirement.
 */
export function decideAction(input: PolicyInput): Decision {
  const { state, action } = input
  const { sandbox, approval } = state

  // Plan submission is only available in plan mode, and always needs a human.
  if (action === 'plan-submit') {
    return state.collaboration === 'plan'
      ? { kind: 'prompt-user' }
      : forbid('当前不在计划模式,exit_plan 工具不可用;请按当前权限模式直接执行任务。')
  }

  // Project-memory writes are harness behavior: allowed in every mode.
  if (action === 'memory-write') return ALLOW

  // Plan collaboration mode forbids every write, regardless of sandbox.
  if (state.collaboration === 'plan' && action !== 'read') {
    return forbid(
      '当前处于计划模式:禁止一切写操作与有写副作用的命令;请完成调研后调用 exit_plan 提交计划,等待用户批准后再执行。',
    )
  }

  // Read-only sandbox: commands are only allowed when statically provable read-only.
  if (sandbox === 'read-only') {
    if (action === 'read') {
      if (input.shell && !input.shell.certifiedReadonly) {
        return forbid(
          '当前为只读沙箱:无法证明该命令只读,已被拒绝;请只使用能证明只读的命令(ls/cat/git status 等),或请用户切换权限模式。',
        )
      }
      return ALLOW
    }
    return forbid(
      action === 'network'
        ? '当前为只读沙箱:网络访问不可用;请改为本地只读操作,或请用户切换权限模式。'
        : '当前为只读沙箱:写操作与有写副作用的命令已被拒绝;请只做阅读与分析,或请用户切换权限模式。',
    )
  }

  // Danger-full-access: everything is allowed, prompts are off by policy.
  if (sandbox === 'danger-full-access') {
    if (input.rule?.kind === 'forbid') return input.rule
    return ALLOW
  }

  // workspace-write: in-workspace writes run directly; the rest needs review.
  const base: Decision = (() => {
    switch (action) {
      case 'read':
        return ALLOW
      case 'write':
        return input.insideWorkspace ? ALLOW : promptDecision('该操作要写工作区之外的路径,需要用户确认')
      case 'delete':
        return promptDecision('该操作要删除文件(删除不可逆),需要用户确认')
      case 'network':
        return promptDecision('该命令要访问网络,需要用户确认')
      default:
        return ALLOW
    }
  })()

  // Shell heuristics refine the base decision: an unprovable command with write
  // or delete side effects must be reviewed even though `bash` itself is "read".
  let decision = base
  if (input.shell) {
    const shell = input.shell
    if (shell.isDelete) {
      decision = promptDecision('该命令会删除文件(删除不可逆),需要用户确认')
    } else if (shell.mayWrite) {
      decision = promptDecision('该命令会增删改写文件,需要用户确认')
    } else if (shell.mayNetwork) {
      decision = promptDecision('该命令要访问网络,需要用户确认')
    }
  }

  // Explicit execpolicy rules are strictest-wins against the heuristic result.
  if (input.rule) decision = strictest([decision, input.rule])

  return gated(decision, approval)
}

/**
 * Whether a call may skip the approval step because the user already allowed
 * the same normalized action for this session ("本窗口放行").
 */
export function grantedBySession(
  state: PermissionState,
  key: string,
  grants: ApprovalGrants,
  decision: Decision,
): boolean {
  // Only ordinary prompts are cacheable; a mandatory human checkpoint is not.
  if (decision.kind !== 'prompt') return false
  // Read-only sandbox never reaches here with a prompt (it forbids instead).
  if (state.sandbox === 'read-only') return false
  return grants.has(key)
}

// ---------------------------------------------------------------------------
// Shell heuristics: write / delete / network side effects.
// ---------------------------------------------------------------------------

/** Files touched by a tool call, for workspace-boundary checks. */
export function bashMayWrite(command: string): boolean {
  const lower = command.toLowerCase()
  const markers = [
    ' > ',
    ' >> ',
    ' 2> ',
    ' &> ',
    '>|',
    'rm ',
    'rmdir ',
    'mv ',
    'cp ',
    'mkdir ',
    'touch ',
    'tee ',
    'sed -i',
    'perl -i',
    'truncate ',
    'install ',
    'ln -',
    'chmod ',
    'chown ',
  ]
  return markers.some((marker) => lower.includes(marker))
}

const DELETE_PROGRAMS = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'del',
  'erase',
  'rd',
  'remove-item',
  '-delete',
])

/** Word-level program match so `confirm` is not read as `rm`. */
function bashInvokes(command: string, names: ReadonlySet<string>): boolean {
  return command
    .split(/[\s|;&()]+/)
    .some((token) => names.has(commandName(token.replace(/^["']+|["']+$/g, ''))))
}

/** Heuristic: is this shell command a deletion? */
export function bashMayDelete(command: string): boolean {
  return bashInvokes(command, DELETE_PROGRAMS)
}

const NETWORK_PROGRAMS = new Set([
  'curl',
  'wget',
  'nc',
  'ncat',
  'ssh',
  'scp',
  'sftp',
  'ftp',
  'telnet',
  'invoke-webrequest',
  'invoke-restmethod',
  'iwr',
  'irm',
])

/** Heuristic: does this shell command reach the network? */
export function bashMayNetwork(command: string): boolean {
  if (bashInvokes(command, NETWORK_PROGRAMS)) return true
  // `git` over the network (push/fetch/clone) and package managers writing to registries.
  return (
    /\bgit\s+(push|fetch|pull|clone|ls-remote)\b/i.test(command) ||
    /\b(npm|pnpm|yarn|pip|cargo|go)\s+(install|add|publish|update|get)\b/i.test(command)
  )
}

/**
 * Strict read-only certification: prove the command cannot write, or say no.
 * Fail-closed — anything not on the whitelist is "not proven read-only".
 */
export function certifiedReadonlyCommand(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed === '' || trimmed.includes('>') || trimmed.includes('$(') || trimmed.includes('`')) {
    return false
  }
  let segments = 0
  for (const raw of trimmed.split(/[|;&\n]/)) {
    const segment = raw.trim()
    if (segment === '') continue
    segments += 1
    if (!readonlySegment(segment)) return false
  }
  return segments > 0
}

const WRITE_COMMANDS = new Set([
  'sed',
  'find',
  'chmod',
  'chown',
  'chgrp',
  'mv',
  'dd',
  'tee',
  'truncate',
  'mkdir',
  'touch',
  'cp',
  'rm',
  'rmdir',
  'shred',
  'unlink',
  'install',
  'ln',
  'patch',
  'del',
  'erase',
  'rd',
  'remove-item',
  'set-content',
  'add-content',
  'out-file',
  'new-item',
  'move-item',
  'copy-item',
  'rename-item',
])

const BASIC_READONLY = new Set([
  'echo',
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'which',
  'where',
  'uniq',
  'diff',
  'stat',
  'file',
  'get-childitem',
  'get-content',
  'get-item',
  'get-process',
  'get-location',
  'test-path',
  'select-string',
  'resolve-path',
])

const GIT_READONLY_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'rev-list',
  'blame',
  'describe',
  'shortlog',
  'ls-files',
  'ls-tree',
  'cat-file',
  'grep',
  'whatchanged',
  'merge-base',
  'name-rev',
  'for-each-ref',
])

const GIT_BRANCH_READONLY_ARGS = new Set([
  '-a',
  '-r',
  '-v',
  '-vv',
  '--all',
  '--remotes',
  '--verbose',
  '--list',
  '--show-current',
  '--contains',
  '--merged',
  '--no-merged',
  '--points-at',
  '--format',
])

/** `-o`/`--output*` are "write a file" flags (sort, some git subcommands). */
function isOutputFlag(arg: string): boolean {
  return arg === '-o' || (arg.startsWith('-o') && arg.length > 2) || arg.startsWith('--output')
}

function shellTokens(segment: string): string[] {
  return segment
    .split(/\s+/)
    .filter((token) => token !== '')
    .map((token) => token.replace(/^["']+|["']+$/g, ''))
}

/** Last path segment of a command token, `.exe` stripped, ASCII lowercased. */
export function commandName(token: string): string {
  const parts = token.split(/[/\\]/)
  const last = parts[parts.length - 1] ?? token
  const lower = last.replace(/[A-Z]/g, (char) => char.toLowerCase())
  return lower.endsWith('.exe') ? lower.slice(0, -4) : lower
}

function readonlySegment(segment: string): boolean {
  const tokens = shellTokens(segment)
  const head = tokens[0]
  if (!head) return false
  const program = commandName(head)
  if (WRITE_COMMANDS.has(program)) return false
  const args = tokens.slice(1)
  if (BASIC_READONLY.has(program)) return true
  if (program === 'sort') return !args.some(isOutputFlag)
  if (program === 'node') return args.length === 1 && (args[0] === '--version' || args[0] === '-v')
  if (program === 'git') return gitIsReadonly(args)
  return false
}

function gitIsReadonly(args: string[]): boolean {
  const subcommand = args[0]
  if (!subcommand) return false
  const rest = args.slice(1)
  if (rest.some(isOutputFlag)) return false
  if (GIT_READONLY_SUBCOMMANDS.has(subcommand)) return true
  if (subcommand === 'branch') return rest.every((arg) => GIT_BRANCH_READONLY_ARGS.has(arg))
  return false
}