// Subagent runtime: dispatch, background execution, inbox delivery, control.
//
// All children are background sessions. Completion results and messages are
// persisted as `agent-inbox` events first; a step boundary turns them into
// `agent-delivery` events, which is what the model actually sees. This keeps
// delivery idempotent across crashes and never interrupts a model mid-action.

import { randomUUID } from 'node:crypto'

import type { PermissionState } from '../core/permission.ts'
import { stateFromLegacy } from '../core/permission.ts'
import type {
  Envelope,
  ModelSelection,
  SessionEvent,
  SessionHeader,
  SessionSummary,
  ToolSchema,
} from '../core/wire.ts'
import { isRecord } from '../core/util.ts'
import type { SessionStore } from '../session/store.ts'
import { ProfileStore } from './profiles.ts'
import { findProvider } from '../config.ts'
import type { AppConfig } from '../config.ts'
import { presetIdOf, resolvePreset } from '../agent/presets.ts'
import { ProfileError } from './profiles.ts'
import type { DelegateArgs } from './resolver.ts'
import {
  modeOfPermission,
  normalizeInlineSpec,
  parentGrant,
  resolveDispatch,
} from './resolver.ts'
import type {
  PermissionCeiling,
  ProfileWriteScope,
  SubagentDescriptor,
  SubagentProfile,
} from './types.ts'
import {
  SUBAGENT_CODES,
  SUBAGENT_SCHEMA_VERSION,
  SUBAGENT_SNAPSHOT_FILE,
  SUBAGENT_SNAPSHOT_VERSION,
  builtinSubagentProfiles,
  ceilingDeniedTool,
  childHardDenied,
  effectivePermissionMode,
  legacyChildTools,
  validateProfile,
} from './types.ts'

export interface SubagentDriverPort {
  startTurn(
    sessionId: string,
    prompt: string,
    options?: { continueOnly?: boolean; selection?: ModelSelection },
  ): Promise<void>
  cancel(sessionId: string): boolean
  isRunning(sessionId: string): boolean
  append(sessionId: string, event: SessionEvent): Envelope | null
  permissionStateOf(sessionId: string): PermissionState
}

export interface SubagentRuntimeOptions {
  maxConcurrentRuns?: number
  catalogMaxBytes?: number
  outputBytes?: number
  /** The child session exists; attach it before its first task is enqueued. */
  childCreated?(childId: string, parentId: string): void
  /** The child session is gone (dispatch rollback or parent cascade). */
  childRemoved?(childId: string): void
  /** Notify open settings pages after a model-created permanent definition. */
  definitionsChanged?(): void
  /** Live provider catalog for validating frozen selections. */
  config?(): AppConfig
}

interface Child {
  id: string
  parentId: string
  descriptor: SubagentDescriptor
}

export interface SubagentContext {
  name: string
  instructions: string
  effectiveTools: string[]
  permissionCeiling: PermissionCeiling
  legacy: boolean
}

export interface HandoffUsage {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
}

export interface TerminalState {
  outcome: 'completed' | 'failed' | 'needs_decision'
  basis: 'host_verified' | 'self_reported' | 'interrupted' | 'no_terminal_event'
  reason: string | null
  hostVerified: boolean
  finalized: boolean
  detail: string
}

export interface SubagentHandoff {
  id: string
  name: string
  profile: string
  terminal: TerminalState
  usage: HandoffUsage
  changedPaths: string[]
  changedPathsNote: string
  artifacts: string[]
  verification: null
  verificationNote: string
  advisories: string[]
  result: string
}

const DEFAULT_CATALOG_BYTES = 8192
const HISTORY_PROJECTION_FILE = 'history-projection.json'
const DEFAULT_OUTPUT_BYTES = 64 * 1024
/** Automatic wakes in a row before waiting for a human turn to reset the budget. */
const MAX_CONSECUTIVE_WAKES = 3
/** Startup replay window: older child completions are history, not pending work. */
const RECOVERY_WINDOW_MS = 10 * 60 * 1000
const CATALOG_HEADER = '[denia 子代理目录]'
const CATALOG_DISCIPLINE = [
  '',
  '派遣方式：profile_id 用上面的 qualifiedId；inline 在调用时给出临时定义（不落盘）；两者都省略时使用默认的 develop 定义。profile_id 与 inline 互斥。',
  '分工与等待：按不重叠的文件或模块分工，最终由你统一集成。派遣后立即返回 pending，不要轮询——继续独立工作或先向用户回复进度并结束本轮；完成结果会自动送达。执行完成前不要宣称工作已完成。',
  '结果汇报区分三种情形：成功结果、任务失败（附失败原因）、等待你决策。子代理不能再派遣子代理；子代理不会自动继承全局 AGENTS.md，只发现项目级规则。',
]

export class SubagentRuntime {
  private readonly store: SessionStore
  private readonly profiles: ProfileStore
  private readonly port: SubagentDriverPort
  private maxConcurrentRuns: number
  private readonly catalogMaxBytes: number
  private readonly outputBytes: number
  private readonly childCreated: ((childId: string, parentId: string) => void) | undefined
  private readonly childRemoved: ((childId: string) => void) | undefined
  private readonly definitionsChanged: (() => void) | undefined
  private readonly getConfig: (() => AppConfig) | undefined
  private readonly children = new Map<string, Child>()
  private readonly paused = new Set<string>()
  private readonly wakeAttempts = new Map<string, number>()
  private jobCleaner: ((sessionId: string) => string[]) | undefined

  constructor(
    store: SessionStore,
    profiles: ProfileStore,
    port: SubagentDriverPort,
    options: SubagentRuntimeOptions = {},
  ) {
    this.store = store
    this.profiles = profiles
    this.port = port
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? 8
    this.catalogMaxBytes = options.catalogMaxBytes ?? DEFAULT_CATALOG_BYTES
    this.outputBytes = options.outputBytes ?? DEFAULT_OUTPUT_BYTES
    this.childCreated = options.childCreated
    this.childRemoved = options.childRemoved
    this.definitionsChanged = options.definitionsChanged
    this.getConfig = options.config
  }

  // —— dispatch ——

  async spawn(
    owner: string,
    args: DelegateArgs,
    ctx: { cwd: string; selection?: ModelSelection },
    fork: boolean,
  ): Promise<Record<string, unknown>> {
    const parentHeader = this.store.header(owner)
    if (!parentHeader) throw new Error('缺少父会话身份')
    if (parentHeader.subagent) {
      throw new ProfileError(
        SUBAGENT_CODES.delegationForbidden,
        '子代理不能派遣子代理：请把可并行的子任务交回父代理，或在本次任务内自己完成。',
      )
    }
    if (typeof args.prompt !== 'string' || args.prompt.trim() === '') {
      throw new ProfileError(SUBAGENT_CODES.profileInvalid, '派遣参数 prompt 不能为空', 'prompt')
    }
    const parentPermission = this.port.permissionStateOf(owner)
    const parentMode = modeOfPermission(parentPermission)
    const parentSelection = ctx.selection
    if (!parentSelection) throw new Error('子代理无法继承模型选择（缺少父会话模型）')
    const projectRoot = this.projectRootOf(ctx.cwd)
    const registered = this.registeredToolNames()
    const presetId = presetIdOf(this.store.read(owner)?.events ?? [], parentHeader)
    const preset = resolvePreset(this.store.home, presetId)
    const grant = parentGrant(registered, preset.tools, parentMode, preset.features)

    let profile = undefined
    if (args.profile_id !== undefined) {
      profile = this.profiles.resolve(projectRoot, args.profile_id)
    } else if (args.inline === undefined) {
      const legacyPath = args.persona !== undefined || args.allowed_tools !== undefined
      if (!legacyPath) profile = this.profiles.resolveDefault(projectRoot)
    }
    const dispatch = resolveDispatch({
      args,
      fork,
      parent: { registered, mode: parentMode, selection: parentSelection, presetTools: preset.tools, presetFeatures: preset.features },
      ...(profile ? { profile } : {}),
      defaulted: args.profile_id === undefined && args.inline === undefined,
    })
    if (dispatch.instructions.length > 64 * 1024) {
      throw new Error('子代理角色提示词过大（超过 64 KiB）')
    }

    this.ensureConcurrency()
    const childPermission = effectivePermissionMode(dispatch.permissionCeiling, parentMode)
    const resolved = this.actualSelection(dispatch.selection, parentSelection, dispatch.modelOrigin)
    dispatch.selection = resolved.selection
    const labelSource = args.description?.trim() || dispatch.name
    const label = Array.from(labelSource).slice(0, 200).join('')
    const instructionsHash = hashText(dispatch.instructions)
    const descriptor: SubagentDescriptor = {
      label,
      depth: 1,
      mode: fork ? 'fork' : 'spawn',
      selection: dispatch.selection,
      snapshotVersion: SUBAGENT_SNAPSHOT_VERSION,
      name: dispatch.name,
      description: dispatch.description,
      profile: {
        qualifiedId: dispatch.qualifiedId,
        ...(dispatch.source ? { source: dispatch.source } : {}),
        revision: dispatch.revision,
        inline: dispatch.inline,
      },
      effectiveTools: dispatch.tools,
      permissionCeiling: dispatch.permissionCeiling,
      createdPermissionMode: parentMode,
      delegationAllowed: false,
      instructionScope: 'project-only',
      parentPreset: presetId,
      ...(preset.persona ? { parentPresetPersona: preset.persona } : {}),
      parentFeatures: preset.features,
      instructionsRef: SUBAGENT_SNAPSHOT_FILE,
      instructionsHash,
      ...(fork
        ? {
            fork: {
              sourceSession: owner,
              cutSeq: 0,
              projectionVersion: 1,
              dropped: [],
            },
          }
        : {}),
    }

    const header = this.store.create(ctx.cwd, {
      sandbox: parentHeader.sandbox,
      parentSession: owner,
      subagent: descriptor,
    })
    try {
      this.store.writeAuxiliary(
        header.id,
        SUBAGENT_SNAPSHOT_FILE,
        JSON.stringify({
          snapshotVersion: SUBAGENT_SNAPSHOT_VERSION,
          instructions: dispatch.instructions,
        }),
      )
      if (fork) {
        const seed = buildForkSeed(owner, this.store.read(owner)?.events ?? [])
        for (const event of seed.events) this.store.append(header.id, event)
        if (descriptor.fork) {
          descriptor.fork.cutSeq = seed.cutSeq
          descriptor.fork.dropped = seed.dropped
        }
        this.rewriteHeader(header.id, descriptor)
      }
      this.applyPermission(header.id, childPermission, parentPermission)
      this.children.set(header.id, { id: header.id, parentId: owner, descriptor })
      this.childCreated?.(header.id, owner)
      const messageId = randomUUID()
      this.enqueue(
        header.id,
        messageId,
        `[父代理 ${owner} 委派任务]\n${args.prompt}`,
        `agent:${owner}`,
      )

      const result: Record<string, unknown> = {
        ...(resolved.fallback ? { modelFallback: resolved.fallback } : {}),
        childId: header.id,
        messageId,
        status: 'pending',
        pending: true,
        notification: 'automatic',
        next_action:
          '后台仍在执行，完成结果会自动送达本会话。不要轮询或重复等待；可以继续独立工作，或先向用户回复当前进度并结束本轮。pending 不代表执行成功。',
        profile: {
          qualifiedId: dispatch.qualifiedId,
          name: dispatch.name,
          inline: dispatch.inline,
          tools: dispatch.tools,
          toolCount: dispatch.tools.length,
          model: dispatch.selection,
          permissionCeiling: dispatch.permissionCeiling,
          fingerprint: fingerprintOf(dispatch),
        },
      }
      if (args.run_in_background !== undefined) {
        result.deprecations = ['run_in_background 已废弃：派遣始终后台执行，该参数被忽略']
      }
      if (args.persona !== undefined || args.allowed_tools !== undefined) {
        result.deprecations = [
          ...((result.deprecations as string[] | undefined) ?? []),
          'persona/allowed_tools 是旧参数（已按保守历史上限解释）；请改用 profile_id 或 inline',
        ]
      }
      return result
    } catch (error) {
      this.store.delete(header.id)
      this.children.delete(header.id)
      this.childRemoved?.(header.id)
      throw error
    }
  }

  private rewriteHeader(id: string, descriptor: SubagentDescriptor): void {
    // The seed must carry the final fork projection; rewrite the first line.
    this.store.updateHeader(id, { subagent: descriptor })
  }

  private applyPermission(
    id: string,
    childMode: 'read-only' | 'auto-edit' | 'plan' | 'full',
    parentState: PermissionState,
  ): void {
    const state =
      childMode === 'read-only'
        ? stateFromLegacy('read-only')
        : childMode === 'plan'
          ? stateFromLegacy('plan', parentState)
          : childMode === 'full'
            ? stateFromLegacy('full')
            : parentState
    this.store.append(id, { type: 'permission-mode', mode: childMode })
    this.store.append(id, {
      type: 'permission-selection',
      sandbox: state.sandbox,
      approval: state.approval,
      reviewer: state.reviewer,
      collaboration: state.collaboration,
    })
  }

  private actualSelection(
    requested: ModelSelection,
    parent: ModelSelection,
    origin: string,
  ): { selection: ModelSelection; fallback: string | null } {
    const provider = this.getConfig ? findProvider(this.getConfig(), requested.provider) : undefined
    if (provider && provider.models.some((entry) => entry.id === requested.model)) {
      return { selection: requested, fallback: null }
    }
    if (origin === 'profile-explicit') {
      return {
        selection: { ...parent },
        fallback: `子代理定义的模型 ${requested.provider}/${requested.model} 当前不可用，已回退为跟随主会话 ${parent.provider}/${parent.model}`,
      }
    }
    if (this.getConfig) {
      throw new ProfileError('subagent/model-unavailable', `模型 ${requested.provider}/${requested.model} 当前不可用`, 'model')
    }
    return { selection: requested, fallback: null }
  }

  private ensureConcurrency(): void {
    if (this.activeCount() >= this.maxConcurrentRuns) {
      throw new ProfileError(
        SUBAGENT_CODES.concurrencyExceeded,
        `子代理并发已达上限（${this.maxConcurrentRuns}）；请等已有子代理结束，或在设置里提高 subagent-policy.maxConcurrentRuns。`,
      )
    }
  }

  private activeCount(): number {
    let count = 0
    for (const child of this.allChildren()) {
      if (this.port.isRunning(child.id) || this.hasPending(child.id)) count += 1
    }
    return count
  }

  projectRootOf(cwd: string): string | null {
    try {
      return ProfileStore.projectRoot(cwd)
    } catch {
      return null
    }
  }

  registeredToolNames(): string[] {
    // Filled by the host: capability tools + built-in registry + MCP names.
    return this.toolNames()
  }

  private toolNames: () => string[] = () => []

  setConcurrencyLimit(value: number): void {
    if (Number.isInteger(value)) this.maxConcurrentRuns = Math.max(1, Math.min(64, value))
  }

  /** The host installs the deployed tool registry here. */
  setToolNames(names: () => string[]): void {
    this.toolNames = names
  }

  /**
   * Host hook used when a child settles or is stopped: every background job it
   * started is shut down, and the cancelled labels are reported to the parent.
   */
  setJobCleaner(cleaner: (sessionId: string) => string[]): void {
    this.jobCleaner = cleaner
  }

  // —— inbox / delivery ——

  enqueue(target: string, id: string, text: string, source: string): string {
    const session = this.store.read(target)
    if (!session) throw new Error(`目标会话不存在：${target}`)
    if (text.length > this.outputBytes * 2) throw new Error('代理消息超过配置的体积上限')
    const delivered = new Set<string>()
    for (const event of session.events) {
      if (event.type === 'agent-inbox' || event.type === 'agent-delivery') delivered.add(event.id)
    }
    if (delivered.has(id)) return id
    if (source.startsWith('agent:')) this.paused.delete(target)
    this.wakeAttempts.delete(target)
    this.store.append(target, { type: 'agent-inbox', id, text, source })
    this.store.flush(target)
    this.wake(target)
    return id
  }

  /** Move pending inbox entries into model-visible deliveries (step boundary). */
  drainInbox(sessionId: string): void {
    const session = this.store.read(sessionId)
    if (!session) return
    const delivered = new Set<string>()
    for (const event of session.events) {
      if (event.type === 'agent-delivery') delivered.add(event.id)
    }
    for (const event of session.events) {
      if (event.type !== 'agent-inbox' || delivered.has(event.id)) continue
      delivered.add(event.id)
      this.store.append(sessionId, {
        type: 'agent-delivery',
        id: event.id,
        text: event.text,
        source: event.source,
      })
    }
    this.store.flush(sessionId)
  }

  hasPending(sessionId: string): boolean {
    const session = this.store.read(sessionId)
    if (!session) return false
    const delivered = new Set<string>()
    for (const event of session.events) {
      if (event.type === 'agent-delivery') delivered.add(event.id)
    }
    return session.events.some(
      (event) => event.type === 'agent-inbox' && !delivered.has(event.id),
    )
  }

  wake(sessionId: string): void {
    if (this.paused.has(sessionId) || this.port.isRunning(sessionId)) return
    if (!this.hasPending(sessionId)) return
    // A pending result that keeps failing to drain must not spin forever; the
    // budget resets on the next human turn (or the next explicit message).
    const attempts = this.wakeAttempts.get(sessionId) ?? 0
    if (attempts >= MAX_CONSECUTIVE_WAKES) return
    this.wakeAttempts.set(sessionId, attempts + 1)
    void this.port
      .startTurn(sessionId, '', { continueOnly: true })
      .then(() => this.onIdle(sessionId))
      .catch(() => {
        /* the driver records turn failures in the log */
      })
  }

  onTurnStart(sessionId: string): void {
    this.wakeAttempts.delete(sessionId)
    if (this.store.header(sessionId)?.subagent) this.paused.delete(sessionId)
  }

  /**
   * A physical log truncation invalidated the removed branch's queued work:
   * drop the pause mark and auto-wake budget that were accounted against it.
   * Pending inbox entries need no reset — they are re-scanned from the log.
   */
  onSessionRewound(sessionId: string): void {
    this.paused.delete(sessionId)
    this.wakeAttempts.delete(sessionId)
  }

  onTurnEnd(sessionId: string): void {
    const header = this.store.header(sessionId)
    if (!header) return
    if (header.subagent) this.captureCompletion(sessionId)
    this.onIdle(sessionId)
  }

  onIdle(sessionId: string): void {
    if (this.port.isRunning(sessionId)) return
    if (this.hasPending(sessionId)) this.wake(sessionId)
  }

  /**
   * Startup recovery: replay a recent child completion and wake any session
   * whose inbox still holds undelivered results. Older history is left alone
   * so a restart never re-announces stale subagents.
   */
  recover(sessionId: string): void {
    const header = this.store.header(sessionId)
    if (!header) return
    if (header.subagent) {
      const session = this.store.read(sessionId)
      const lastEnd = session ? this.lastTurnEnd(session.events) : null
      if (lastEnd && Date.now() - lastEnd.time <= RECOVERY_WINDOW_MS) {
        this.captureCompletion(sessionId)
      }
    }
    if (this.hasPending(sessionId)) this.wake(sessionId)
  }

  // —— completion capture ——

  private lastTurnEnd(events: Envelope[]): Extract<Envelope, { type: 'turn-end' }> | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!
      if (event.type === 'turn-end') return event
    }
    return null
  }

  /** Cancel jobs the child left running; returns their labels for the notice. */
  private cleanJobs(sessionId: string): string[] {
    try {
      return this.jobCleaner?.(sessionId) ?? []
    } catch {
      return []
    }
  }

  private captureCompletion(childId: string): void {
    const child = this.childOf(childId)
    if (!child) return
    let session = this.store.read(childId)
    if (!session || this.port.isRunning(childId)) return
    let events = session.events
    let lastEnd = this.lastTurnEnd(events)
    if (!lastEnd) {
      // A child can stop without a closing turn-end (host shutdown, killed
      // process). Record one so the parent still receives the result.
      const open = openTurnOf(events)
      if (open === null) return
      this.store.append(childId, { type: 'turn-end', turn: open, reason: { kind: 'interrupted' } })
      this.store.flush(childId)
      session = this.store.read(childId)
      if (!session) return
      events = session.events
      lastEnd = this.lastTurnEnd(events)
      if (!lastEnd) return
    }
    const cancelled = this.cleanJobs(childId)
    const handoff = this.handoffOf(child, events, false)
    const body = this.lastAssistantText(events, lastEnd.turn)
    const notice = this.noticeText(handoff, body, cancelled)
    const noticeId = `settled:${childId}:turn:${lastEnd.turn}:seq:${lastEnd.seq}`
    try {
      this.enqueue(child.parentId, noticeId, notice, 'subagent-settled')
    } catch {
      // The parent may have been deleted; the child result is still in its log.
    }
  }

  private lastAssistantText(events: Envelope[], turn: number): string {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!
      if (event.type === 'assistant-message' && event.turn === turn) {
        return event.blocks
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('\n')
      }
    }
    return ''
  }

  // —— control / listing ——

  descendants(owner: string): Child[] {
    const parents = new Map<string, string[]>()
    for (const summary of this.store.list()) {
      if (!summary.parent_session) continue
      const list = parents.get(summary.parent_session) ?? []
      list.push(summary.id)
      parents.set(summary.parent_session, list)
    }
    const out: Child[] = []
    const seen = new Set<string>([owner])
    const queue = [owner]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const id of parents.get(current) ?? []) {
        if (seen.has(id)) continue
        seen.add(id)
        const header = this.store.header(id)
        if (header?.subagent) {
          out.push({ id, parentId: current, descriptor: header.subagent })
          queue.push(id)
        }
      }
    }
    return out
  }

  private allChildren(): Child[] {
    const out: Child[] = []
    for (const summary of this.store.list()) {
      const header = this.store.header(summary.id)
      if (header?.subagent && summary.parent_session) {
        out.push({ id: summary.id, parentId: summary.parent_session, descriptor: header.subagent })
      }
    }
    return out
  }

  childOf(id: string): Child | null {
    const header = this.store.header(id)
    if (!header?.subagent) return null
    const parent = header.parent_session ?? this.children.get(id)?.parentId ?? ''
    return { id, parentId: parent, descriptor: header.subagent }
  }

  list(owner: string): Record<string, unknown>[] {
    return this.descendants(owner).map((child) => {
      const session = this.store.read(child.id)
      const running = this.port.isRunning(child.id)
      const waitingChild = this.descendants(child.id).some((descendant) =>
        this.port.isRunning(descendant.id),
      )
      const pending = session ? pendingInteractions(session.events) : { approvals: 0, asks: 0, result: null }
      const status = running ? 'running' : waitingChild ? 'waiting' : 'settled'
      const descriptor = child.descriptor
      const tools =
        descriptor.effectiveTools ??
        legacyChildTools(descriptor.allowedTools)
      return {
        id: child.id,
        parentId: child.parentId,
        label: descriptor.label,
        depth: descriptor.depth,
        mode: descriptor.mode,
        selection: descriptor.selection,
        status,
        profile: descriptor.profile ?? null,
        name: descriptor.name ?? null,
        description: descriptor.description ?? null,
        toolCount: tools.length,
        tools,
        permissionCeiling: descriptor.permissionCeiling,
        createdPermissionMode: descriptor.createdPermissionMode ?? null,
        instructionScope: descriptor.instructionScope ?? null,
        delegationAllowed: false,
        pendingApprovals: pending.approvals,
        pendingAsks: pending.asks,
        waitingInteraction: pending.approvals > 0 || pending.asks > 0,
        result: pending.result,
        migration: null,
      }
    })
  }

  canControl(owner: string, target: string, ancestor: boolean): boolean {
    if (owner === target) return false
    const targetHeader = this.store.header(target)
    if (targetHeader?.subagent) {
      if (targetHeader.parent_session === owner) return true
      const ownerHeader = this.store.header(owner)
      if (!ancestor && ownerHeader?.parent_session === target) return true
      if (ancestor && this.descendants(owner).some((child) => child.id === target)) return true
    }
    return false
  }

  /** Trace visibility: self, direct parent, or direct/descendant child. */
  canView(owner: string, target: string): boolean {
    if (owner === target) return true
    const ownerHeader = this.store.header(owner)
    const targetHeader = this.store.header(target)
    if (ownerHeader?.parent_session === target) return true
    if (targetHeader?.parent_session === owner) return true
    return this.descendants(owner).some((child) => child.id === target)
  }

  send(owner: string, target: string, message: string): { messageId: string; target: string } {
    if (!this.canControl(owner, target, false)) {
      throw new Error('目标不在当前代理允许控制的谱系范围内')
    }
    const id = randomUUID()
    this.enqueue(target, id, `[代理 ${owner} 发来消息]\n${message}`, `agent:${owner}`)
    return { messageId: id, target }
  }

  interrupt(owner: string, target: string): void {
    if (!this.canControl(owner, target, true)) {
      throw new Error('目标不在当前代理允许控制的谱系范围内')
    }
    this.paused.add(target)
    this.port.cancel(target)
    this.cleanJobs(target)
  }

  ensureRemovable(owner: string): void {
    if (this.descendants(owner).some((child) => this.port.isRunning(child.id))) {
      throw new Error('仍有运行中或待处理的子代理，请先停止后再删除会话')
    }
  }

  removeOwner(owner: string): void {
    const descendants = this.descendants(owner).reverse()
    for (const child of descendants) {
      this.cleanJobs(child.id)
      this.paused.delete(child.id)
      this.store.delete(child.id)
      this.children.delete(child.id)
      this.childRemoved?.(child.id)
    }
  }

  close(): void {
    for (const child of this.allChildren()) this.port.cancel(child.id)
  }

  /** Frozen tools of a child session; null for ordinary sessions. */
  /** Frozen selection recorded on the child descriptor. */
  selectionOf(sessionId: string): ModelSelection | undefined {
    return this.store.header(sessionId)?.subagent?.selection
  }

  /** Old children resume through a persisted projection, not the mixed legacy log. */
  historyFor(sessionId: string, events: Envelope[]): Envelope[] {
    const descriptor = this.store.header(sessionId)?.subagent
    if (!descriptor || descriptor.snapshotVersion >= SUBAGENT_SNAPSHOT_VERSION) return events
    if (this.store.readAuxiliary(sessionId, HISTORY_PROJECTION_FILE) === null) {
      this.store.writeAuxiliary(
        sessionId,
        HISTORY_PROJECTION_FILE,
        JSON.stringify({ version: 1, events: legacyProjection(events) }),
      )
    }
    const raw = this.store.readAuxiliary(sessionId, HISTORY_PROJECTION_FILE)
    if (!raw) throw new Error(SUBAGENT_CODES.legacyResumeUnsupported)
    try {
      const parsed: unknown = JSON.parse(raw)
      if (isRecord(parsed) && Array.isArray(parsed.events)) return parsed.events as Envelope[]
    } catch {
      // The caller records the failed turn before any provider request.
    }
    throw new Error(SUBAGENT_CODES.legacyResumeUnsupported)
  }

  grantOf(sessionId: string): string[] | null {
    const header = this.store.header(sessionId)
    if (!header?.subagent) return null
    return header.subagent.effectiveTools ?? legacyChildTools(header.subagent.allowedTools)
  }

  contextOf(sessionId: string): SubagentContext | null {
    const header = this.store.header(sessionId)
    const descriptor = header?.subagent
    if (!descriptor) return null
    if (descriptor.snapshotVersion < SUBAGENT_SNAPSHOT_VERSION) {
      return {
        name: descriptor.name ?? descriptor.label,
        instructions: descriptor.persona ?? '',
        effectiveTools: legacyChildTools(descriptor.allowedTools),
        permissionCeiling: descriptor.permissionCeiling,
        ...(descriptor.parentPresetPersona ? { parentPersona: descriptor.parentPresetPersona } : {}),
        legacy: true,
      }
    }
    if (descriptor.instructionsRef !== SUBAGENT_SNAPSHOT_FILE) {
      throw new Error(
        `子代理快照引用了未知文件 \`${descriptor.instructionsRef ?? ''}\`（${SUBAGENT_CODES.snapshotInvalid}）`,
      )
    }
    const raw = this.store.readAuxiliary(sessionId, SUBAGENT_SNAPSHOT_FILE)
    if (raw === null) {
      throw new Error(
        `子代理快照文件不可读（${sessionId}/${SUBAGENT_SNAPSHOT_FILE}）（${SUBAGENT_CODES.snapshotInvalid}）`,
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      throw new Error(`子代理快照文件格式无效（${SUBAGENT_CODES.snapshotInvalid}）`)
    }
    const instructions = isRecord(parsed) && typeof parsed.instructions === 'string'
      ? parsed.instructions
      : null
    if (instructions === null) {
      throw new Error(`子代理快照文件格式无效（${SUBAGENT_CODES.snapshotInvalid}）`)
    }
    if (descriptor.instructionsHash && descriptor.instructionsHash !== hashText(instructions)) {
      throw new Error(
        `子代理快照与 header 记录的 hash 不一致（${SUBAGENT_CODES.snapshotInvalid}）：拒绝启动，不回退默认角色`,
      )
    }
    return {
      name: descriptor.name ?? descriptor.label,
      instructions,
      effectiveTools: descriptor.effectiveTools ?? legacyChildTools(descriptor.allowedTools),
      permissionCeiling: descriptor.permissionCeiling,
      ...(descriptor.parentPresetPersona ? { parentPersona: descriptor.parentPresetPersona } : {}),
      legacy: false,
    }
  }

  // —— catalog / schemas ——

  catalogText(sessionId: string): string | null {
    const header = this.store.header(sessionId)
    if (!header || header.subagent) return null
    const root = this.projectRootOf(header.cwd)
    const entries = this.profiles.catalogEntries(root)
    if (entries.length === 0) return null
    const lines = [
      CATALOG_HEADER,
      '可用子代理类型（qualifiedId｜名称｜用途｜工具｜模型）：',
      ...entries.map(
        (entry) =>
          `- ${entry.qualifiedId}｜${entry.name}｜${entry.description}｜${entry.tools}｜${entry.model}`,
      ),
      ...CATALOG_DISCIPLINE,
    ]
    let text = lines.join('\n')
    if (Buffer.byteLength(text, 'utf8') > this.catalogMaxBytes) {
      text = truncateUtf8(text, this.catalogMaxBytes)
      text += `\n（目录已按 ${this.catalogMaxBytes} 字节预算截断，部分定义未列出；未列出的定义仍可直接用 profile_id 指定。）`
    }
    return text
  }

  toolSchemas(sessionId: string): ToolSchema[] {
    const isChild = this.store.header(sessionId)?.subagent !== undefined
    const schemas = isChild ? CHILD_TOOL_SCHEMAS : PARENT_TOOL_SCHEMAS
    return schemas.filter((schema) => {
      const tools = this.grantOf(sessionId)
      if (tools === null) {
        const header = this.store.header(sessionId)
        if (header && !header.subagent) {
          const presetId = presetIdOf(this.store.read(sessionId)?.events ?? [], header)
          const preset = resolvePreset(this.store.home, presetId)
          const grant = new Set(parentGrant(this.registeredToolNames(), preset.tools, undefined, preset.features))
          return grant.has(schema.name)
        }
      }
      return tools === null || tools.includes(schema.name) || schema.name === 'send_message' || schema.name === 'session_trace'
    })
  }

  async executeTool(
    name: string,
    args: Record<string, unknown>,
    ctx: { sessionId: string; cwd: string; selection?: ModelSelection },
  ): Promise<{ content: string; isError: boolean } | null> {
    try {
      switch (name) {
        case 'spawn_agent':
        case 'fork_agent': {
          const result = await this.spawn(
            ctx.sessionId,
            delegateArgsOf(args),
            { cwd: ctx.cwd, ...(ctx.selection ? { selection: ctx.selection } : {}) },
            name === 'fork_agent',
          )
          return { content: JSON.stringify(result), isError: false }
        }
        case 'create_subagent': {
          const result = this.defineSubagent(ctx.sessionId, args, ctx.cwd)
          return { content: JSON.stringify(result), isError: false }
        }
        case 'send_message': {
          const target = expectText(args, 'target')
          const message = expectText(args, 'message')
          return {
            content: JSON.stringify(this.send(ctx.sessionId, target, message)),
            isError: false,
          }
        }
        case 'interrupt_agent': {
          this.interrupt(ctx.sessionId, expectText(args, 'target'))
          return { content: JSON.stringify({ ok: true }), isError: false }
        }
        case 'list_agents': {
          return { content: JSON.stringify(this.list(ctx.sessionId)), isError: false }
        }
        case 'wait_agent': {
          const target = expectText(args, 'target')
          if (!this.canControl(ctx.sessionId, target, true)) {
            throw new Error('目标不在当前代理允许控制的谱系范围内')
          }
          const handoff = this.handoff(target)
          const running = this.port.isRunning(target)
          return {
            content: JSON.stringify({
              ...handoff,
              id: target,
              running,
              messages: [],
              status: running ? 'pending' : 'ready',
              pending: running,
              ...(running
                ? {
                    notification: 'automatic',
                    next_action:
                      '后台仍在执行，完成结果会自动送达本会话。不要轮询或重复等待；可以继续独立工作，或先向用户回复当前进度并结束本轮。pending 不代表执行成功。',
                  }
                : {}),
            }),
            isError: false,
          }
        }
        case 'session_trace':
          return { content: this.sessionTrace(ctx.sessionId, args), isError: false }
        default:
          return null
      }
    } catch (error) {
      return {
        content: error instanceof ProfileError ? error.render() : error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  }

  /** A failed legacy migration must reach the parent, not remain a silent failed child. */
  notifyParent(childId: string, message: string): void {
    const child = this.childOf(childId)
    if (!child) return
    this.enqueue(child.parentId, `legacy-resume:${childId}`, message, 'subagent-legacy')
  }

  private defineSubagent(
    owner: string,
    args: Record<string, unknown>,
    cwd: string,
  ): Record<string, unknown> {
    if (this.store.header(owner)?.subagent) {
      throw new ProfileError(
        'subagent/host-administration',
        '子代理不能创建或修改子代理定义；请把需求交回主代理',
      )
    }
    const id = expectText(args, 'id').trim()
    const name = expectText(args, 'name').trim()
    const description = expectText(args, 'description').trim()
    const instructions = typeof args.instructions === 'string' ? args.instructions : ''
    const scope: ProfileWriteScope = args.scope === 'project' ? 'project' : 'user'
    const projectRoot = this.projectRootOf(cwd)
    if (scope === 'project' && projectRoot === null) {
      throw new ProfileError(
        'subagent/scope-forbidden',
        `项目级定义需要有效的工作目录，当前 ${cwd} 不可用`,
      )
    }
    const tools = parseToolSelection(args.tools)
    if (tools.mode === 'allowlist') {
      const registered = new Set(this.registeredToolNames())
      const unknown = tools.names.filter((tool) => !registered.has(tool))
      if (unknown.length > 0) {
        throw new ProfileError(SUBAGENT_CODES.toolUnknown, `工具未注册：${unknown.join('、')}`, 'tools')
      }
      const denied = tools.names.filter((tool) => childHardDenied(tool))
      if (denied.length > 0) {
        throw new ProfileError(
          SUBAGENT_CODES.toolHardDenied,
          `这些工具子代理永远不能使用：${denied.join('、')}`,
          'tools',
        )
      }
    }
    const model = parseModelChoice(args.model)
    const warnings: string[] = []
    if (model.mode === 'explicit' && this.getConfig) {
      const provider = findProvider(this.getConfig(), model.selection.provider)
      if (!provider || !provider.models.some((entry) => entry.id === model.selection.model)) {
        warnings.push(`模型 ${model.selection.provider}/${model.selection.model} 当前不可用；派遣时会回退为跟随主会话`)
      }
    }
    const profile: SubagentProfile = {
      schemaVersion: SUBAGENT_SCHEMA_VERSION,
      id,
      name,
      description,
      instructions,
      enabled: true,
      tools,
      model,
      permissionCeiling: args.permissionCeiling === 'read-only' ? 'read-only' : 'inherit',
    }
    const issues = validateProfile(profile)
    if (issues.length > 0) {
      throw new ProfileError(
        SUBAGENT_CODES.profileInvalid,
        issues.map((issue) => issue.message).join('；'),
        issues[0]?.field,
      )
    }
    const existing = this.profiles
      .catalog(projectRoot)
      .effective.find((view) => view.profile.id === id)
    let view
    let action: 'created' | 'updated'
    if (existing) {
      if (args.overwrite !== true) {
        throw new ProfileError(
          SUBAGENT_CODES.profileExists,
          `${existing.qualifiedId} 已存在（${existing.qualifiedId}）；如确实要覆盖，请显式传 overwrite=true`,
        )
      }
      view = this.profiles.update(projectRoot, existing.qualifiedId, profile, instructions, existing.revision)
      action = 'updated'
    } else {
      view = this.profiles.create(scope, projectRoot, profile, instructions)
      action = 'created'
    }
    this.definitionsChanged?.()
    return {
      action,
      qualifiedId: view.qualifiedId,
      source: view.source,
      revision: view.revision,
      editable: view.editable,
      profile: view.profile,
      warnings,
      note: '永久定义已写入子代理管理页；用户可查看、编辑或删除。',
    }
  }

  private sessionTrace(owner: string, args: Record<string, unknown>): string {
    const requested = typeof args.session === 'string' && args.session !== 'current' ? args.session : owner
    if (requested !== owner && !this.canView(owner, requested)) {
      throw new Error('只能查看当前会话或直接父/子代理会话')
    }
    const session = this.store.read(requested)
    if (!session) throw new Error(`会话不存在：${requested}`)
    const kinds = Array.isArray(args.kind)
      ? new Set(args.kind.filter((kind): kind is string => typeof kind === 'string'))
      : null
    const level = args.level === 'error' ? 'error' : 'all'
    const query = typeof args.query === 'string' ? args.query.toLowerCase() : ''
    const since = typeof args.since === 'number' ? args.since : 0
    const limit = Math.max(1, Math.min(200, typeof args.limit === 'number' ? args.limit : 50))
    const textLimit = Math.max(120, Math.min(4000, typeof args.textLimit === 'number' ? args.textLimit : 600))
    const rows: string[] = []
    for (const event of session.events) {
      if (event.time < since) continue
      const mapped = traceKindOf(event)
      if (!mapped) continue
      if (kinds && !kinds.has(mapped.kind)) continue
      const isError = mapped.error
      if (level === 'error' && !isError) continue
      const text = truncateText(mapped.text, textLimit)
      if (query !== '' && !text.toLowerCase().includes(query) && !mapped.kind.includes(query)) continue
      rows.push(
        `[${event.seq}] ${new Date(event.time).toISOString()} ${mapped.kind}${isError ? ' ERROR' : ''}: ${text.replace(/\n/g, ' ')}`,
      )
    }
    return rows.slice(-limit).join('\n') || '（没有匹配的轨迹记录）'
  }

  handoff(target: string): SubagentHandoff {
    const header = this.store.header(target)
    if (!header?.subagent) throw new Error(`目标不是子代理会话：${target}`)
    const session = this.store.read(target)
    if (!session) throw new Error(`会话不存在：${target}`)
    const child = this.childOf(target)
    return this.handoffOf(child!, session.events, this.port.isRunning(target))
  }

  private handoffOf(child: Child, events: Envelope[], running: boolean): SubagentHandoff {
    const descriptor = child.descriptor
    const id = child.id
    let lastEnd: Extract<Envelope, { type: 'turn-end' }> | null = null
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!
      if (event.type === 'turn-end') {
        lastEnd = event
        break
      }
    }
    const terminal = terminalOf(lastEnd?.reason, running)
    const usage = usageOf(events)
    const changed = changedPathsOf(events)
    const body = lastEnd ? this.lastAssistantText(events, lastEnd.turn) : ''
    const advisories: string[] = []
    if (terminal.outcome !== 'completed') {
      advisories.push('[未验证] 子代理未产生可核验的验证结论；请自行核验（读回改动 / 跑测试 / 看子会话日志）。')
    } else if (terminal.basis === 'self_reported') {
      advisories.push('[未验证] 子代理自称完成，宿主没有可核验的验证结论——父代理不得据此判定完成，请自行核验。')
    }
    return {
      id,
      name: descriptor.name ?? descriptor.label,
      profile: descriptor.profile?.qualifiedId ?? '-',
      terminal,
      usage,
      changedPaths: changed,
      changedPathsNote:
        '口径：只统计执行成功的 write_file / edit 调用；bash 的重定向 / 删除 / 脚本写入推断不出来，不计入。本字段为空 = 没有可识别的落盘改动，不是读取失败。',
      artifacts: [],
      verification: null,
      verificationNote:
        '无：该子代理没有任务账本（内置的 develop / explore / verify 授权里都不含 run_checks），天然不会产生验证结论。',
      advisories,
      result: truncateText(body, 4000),
    }
  }

  private noticeText(handoff: SubagentHandoff, body: string, cancelled: string[] = []): string {
    const changed = handoff.changedPaths.length === 0 ? '（无）' : handoff.changedPaths.join('、')
    const reason = handoff.terminal.reason ?? '未知（没有终态事件）'
    const lines = [
      `[子代理执行结束] ${handoff.name}`,
      `子代理：${handoff.id}（${handoff.profile}）`,
      `结果：${reason}`,
      `终态：${handoff.terminal.outcome}（依据 ${handoff.terminal.basis}，宿主验证 ${handoff.terminal.hostVerified ? '有' : '无'}${handoff.terminal.finalized ? '' : '，非最终'}）—— ${handoff.terminal.detail}`,
      `本次子代理用量：${handoff.usage.totalTokens} tokens（输入 ${handoff.usage.uncachedInputTokens} / 输出 ${handoff.usage.outputTokens} / 缓存读 ${handoff.usage.cacheReadTokens} / 推理 ${handoff.usage.reasoningTokens}）`,
      `变更文件：${changed}`,
      '产物：（无）',
      `验证：${handoff.verificationNote}`,
      ...(cancelled.length > 0
        ? [
            `[已取消的子代理后台工作] 共 ${cancelled.length} 项未完成，宿主已要求终止并清理（长时间服务应交回主代理启动）：${cancelled.join('、')}`,
          ]
        : []),
      `结果引用：会话 ${handoff.id} 的日志与产物（read_tool_output 只能读本会话，父代理需要全文时用 wait_agent 查看该子代理）`,
      ...handoff.advisories,
      `变更文件口径：${handoff.changedPathsNote}`,
      '',
      truncateText(body, Math.max(512, Math.floor(this.outputBytes / 4))),
    ]
    return lines.join('\n')
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function delegateArgsOf(args: Record<string, unknown>): DelegateArgs {
  const out: DelegateArgs = {
    prompt: typeof args.prompt === 'string' ? args.prompt : '',
  }
  if (typeof args.description === 'string') out.description = args.description
  if (typeof args.profile_id === 'string') out.profile_id = args.profile_id
  if (args.inline !== undefined) out.inline = args.inline
  if (typeof args.provider === 'string') out.provider = args.provider
  if (typeof args.model === 'string') out.model = args.model
  if (typeof args.reasoning_effort === 'string') out.reasoning_effort = args.reasoning_effort
  if (Array.isArray(args.allowed_tools)) {
    out.allowed_tools = args.allowed_tools.filter((name): name is string => typeof name === 'string')
  }
  if (typeof args.run_in_background === 'boolean') out.run_in_background = args.run_in_background
  if (typeof args.persona === 'string') out.persona = args.persona
  if (args.max_depth !== undefined) out.max_depth = args.max_depth
  return out
}

function expectText(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== 'string' || (args[key] as string).trim() === '') {
    throw new Error(`${key} 必须是非空字符串`)
  }
  return args[key] as string
}

function parseToolSelection(raw: unknown): SubagentProfile['tools'] {
  if (raw === undefined) return { mode: 'inherit' }
  if (!isRecord(raw)) throw new Error('tools 必须是对象')
  if (raw.mode === 'inherit') return { mode: 'inherit' }
  if (raw.mode !== 'allowlist') throw new Error('tools.mode 只支持 inherit / allowlist')
  const names = Array.isArray(raw.names)
    ? raw.names.filter((name): name is string => typeof name === 'string')
    : []
  return { mode: 'allowlist', names }
}

function parseModelChoice(raw: unknown): SubagentProfile['model'] {
  if (raw === undefined) return { mode: 'inherit' }
  if (!isRecord(raw)) throw new Error('model 必须是对象')
  if (raw.mode === 'inherit') return { mode: 'inherit' }
  if (raw.mode !== 'explicit' || !isRecord(raw.selection)) {
    throw new Error('model 必须是 {mode:"inherit"} 或 {mode:"explicit",selection:{provider,model}}')
  }
  const selection = raw.selection
  return {
    mode: 'explicit',
    selection: {
      provider: typeof selection.provider === 'string' ? selection.provider : '',
      model: typeof selection.model === 'string' ? selection.model : '',
      ...(typeof selection.reasoningEffort === 'string'
        ? { reasoningEffort: selection.reasoningEffort }
        : {}),
    },
  }
}

/** Turn number of the last unclosed turn-start, or null when everything closed. */
function openTurnOf(events: Envelope[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'turn-end') return null
    if (event.type === 'turn-start') return event.turn
  }
  return null
}

function terminalOf(
  reason: Extract<Envelope, { type: 'turn-end' }>['reason'] | undefined,
  running: boolean,
): TerminalState {
  const detail = (text: string): string => (running ? `[进行中，非最终] ${text}` : text)
  if (!reason) {
    return {
      outcome: 'needs_decision',
      basis: 'no_terminal_event',
      reason: null,
      hostVerified: false,
      finalized: !running,
      detail: detail('子会话里没有终态事件，无法判定子代理是否真的结束，需要父代理确认。'),
    }
  }
  switch (reason.kind) {
    case 'completed':
      return {
        outcome: 'completed',
        basis: 'self_reported',
        reason: '已完成',
        hostVerified: false,
        finalized: !running,
        detail: detail(
          '子代理自称完成（本轮正常结束），宿主没有可核验的验证结论——这个"完成"只来自它自己的最后发言。',
        ),
      }
    case 'max-tokens':
      return {
        outcome: 'failed',
        basis: 'self_reported',
        reason: '输出预算耗尽',
        hostVerified: false,
        finalized: !running,
        detail: detail('子代理输出预算耗尽，本轮没有正常结束。'),
      }
    case 'loop-detected':
      return {
        outcome: 'failed',
        basis: 'self_reported',
        reason: '死循环保护',
        hostVerified: false,
        finalized: !running,
        detail: detail(`宿主检测到死循环（连续 ${reason.repeats} 次重复）后强制中断本轮。`),
      }
    case 'error':
      return {
        outcome: 'failed',
        basis: 'self_reported',
        reason: '执行失败',
        hostVerified: false,
        finalized: !running,
        detail: detail(`子代理本轮失败：${reason.failure.message}（${reason.failure.code}）。`),
      }
    case 'aborted':
    case 'interrupted':
      return {
        outcome: 'needs_decision',
        basis: 'interrupted',
        reason: '已中断',
        hostVerified: false,
        finalized: !running,
        detail: detail('子代理本轮被取消 / 中断，没有正常终态，需要父代理决定是否继续。'),
      }
    default:
      return {
        outcome: 'needs_decision',
        basis: 'no_terminal_event',
        reason: null,
        hostVerified: false,
        finalized: !running,
        detail: detail('子会话里没有终态事件，无法判定子代理是否真的结束，需要父代理确认。'),
      }
  }
}

function usageOf(events: Envelope[]): HandoffUsage {
  const usage: HandoffUsage = {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }
  for (const event of events) {
    if (event.type !== 'assistant-message' || !event.usage) continue
    usage.uncachedInputTokens += event.usage.inputTokens ?? 0
    usage.outputTokens += event.usage.outputTokens ?? 0
    usage.cacheReadTokens += event.usage.cacheReadTokens ?? 0
    usage.reasoningTokens += event.usage.reasoningTokens ?? 0
  }
  usage.totalTokens =
    usage.uncachedInputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens +
    usage.reasoningTokens
  return usage
}

function changedPathsOf(events: Envelope[]): string[] {
  const calls = new Map<string, { name: string; path: string }>()
  const changed: string[] = []
  for (const event of events) {
    if (event.type === 'tool-call' && (event.name === 'write_file' || event.name === 'edit')) {
      try {
        const args = JSON.parse(event.arguments) as unknown
        if (isRecord(args) && typeof args.path === 'string') {
          calls.set(event.call_id, { name: event.name, path: args.path })
        }
      } catch {
        /* unparsable arguments are not evidence of a write */
      }
    } else if (event.type === 'tool-result' && event.is_error === false) {
      const call = calls.get(event.call_id)
      if (call && !changed.includes(call.path)) changed.push(call.path)
    }
  }
  return changed
}

function pendingInteractions(events: Envelope[]): {
  approvals: number
  asks: number
  result: string | null
} {
  const approvals = new Set<string>()
  const asks = new Set<string>()
  let result: string | null = null
  const start = Math.max(0, events.length - 2000)
  for (const event of events.slice(start)) {
    if (event.type === 'approval-asked') approvals.add(event.request_id)
    else if (event.type === 'approval-decided') approvals.delete(event.request_id)
    else if (event.type === 'turn-end') result = event.reason.kind
  }
  return { approvals: approvals.size, asks: asks.size, result }
}

function traceKindOf(event: Envelope): { kind: string; text: string; error: boolean } | null {
  switch (event.type) {
    case 'user-message':
      return { kind: 'user', text: event.text, error: false }
    case 'assistant-message':
      return {
        kind: 'assistant',
        text: event.blocks
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('\n'),
        error: false,
      }
    case 'tool-call':
      return { kind: 'tool_call', text: `${event.name} ${event.arguments}`, error: false }
    case 'tool-result':
      return { kind: 'tool_result', text: event.content, error: event.is_error }
    case 'turn-start':
      return { kind: 'turn', text: `turn ${event.turn} started`, error: false }
    case 'turn-end':
      return {
        kind: 'turn',
        text: `turn ${event.turn} ended: ${event.reason.kind}`,
        error: event.reason.kind === 'error',
      }
    case 'agent-inbox':
      return { kind: 'subagent', text: `inbox ${event.source}: ${event.text}`, error: false }
    case 'agent-delivery':
      return { kind: 'subagent', text: `delivery ${event.source}: ${event.text}`, error: false }
    case 'permission-mode':
    case 'permission-selection':
      return { kind: 'state', text: JSON.stringify(event), error: false }
    default:
      return null
  }
}

function buildForkSeed(
  sourceSession: string,
  events: Envelope[],
): { events: SessionEvent[]; cutSeq: number; dropped: string[] } {
  let cut = events.length
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.type === 'turn-end') {
      cut = index + 1
      break
    }
  }
  const closed = events.slice(0, cut)
  const out: SessionEvent[] = []
  const dropped: string[] = []
  const mark = (name: string): void => {
    if (!dropped.includes(name)) dropped.push(name)
  }
  for (const event of closed) {
    switch (event.type) {
      case 'user-message':
        if (event.injected) {
          mark('workspace-and-runtime-injections')
          continue
        }
        out.push({ type: 'user-message', text: event.text, injected: false })
        break
      case 'assistant-message':
        out.push({
          type: 'assistant-message',
          turn: 0,
          step: 0,
          blocks: event.blocks.filter((block) => block.type !== 'reasoning'),
        })
        break
      case 'tool-result':
        out.push({
          type: 'tool-result',
          turn: 0,
          step: 0,
          call_id: event.call_id,
          content: event.content,
          is_error: event.is_error,
          ...(event.error_identity ? { error_identity: event.error_identity } : {}),
          ...(event.meta !== undefined ? { meta: event.meta } : {}),
          ...(event.truncation ? { truncation: event.truncation } : {}),
        })
        break
      case 'agent-inbox':
      case 'agent-delivery':
        mark('agent-inbox')
        break
      case 'permission-mode':
      case 'permission-selection':
        mark('permission-state')
        break
      default:
        break
    }
  }
  return {
    events: out,
    cutSeq: closed[closed.length - 1]?.seq ?? 0,
    dropped,
  }
}

function legacyProjection(events: Envelope[]): Envelope[] {
  const taskIndex = events.findIndex(
    (event) => event.type === 'agent-delivery' && event.source.startsWith('agent:'),
  )
  const projected: Envelope[] = []
  for (const event of taskIndex < 0 ? [] : events.slice(taskIndex)) {
    // An old injected event without a channel cannot be classified safely;
    // retain it only as a non-model-visible marker in the projection.
    if (event.type === 'user-message' && event.injected && !event.channel) {
      projected.push({ ...event, channel: 'legacy-injected' })
    } else {
      projected.push(event)
    }
  }
  return projected
}

function fingerprintOf(dispatch: {
  qualifiedId: string
  tools: string[]
  instructions: string
}): string {
  return hashText(`${dispatch.qualifiedId}\x01${dispatch.tools.join(',')}\x01${dispatch.instructions}`)
}

function hashText(text: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (const byte of Buffer.from(text, 'utf8')) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

function truncateText(text: string, limit: number): string {
  const chars = Array.from(text)
  if (chars.length <= limit) return text
  return chars.slice(0, limit).join('') + '…'
}

function truncateUtf8(text: string, bytes: number): string {
  let size = 0
  let out = ''
  for (const char of text) {
    const width = Buffer.byteLength(char, 'utf8')
    if (size + width > bytes) break
    size += width
    out += char
  }
  return out
}

const SPAWN_SCHEMA: ToolSchema = {
  name: 'spawn_agent',
  description:
    '创建独立子代理会话：继承工作目录、权限上限、父系统提示基础与模型默认值；角色提示是追加，不替换父 persona。始终后台执行，立即返回 childId 与 pending，完成结果自动通知父会话；pending 后不要轮询或重复等待，可以继续独立工作。派遣方式三选一：profile_id 用已保存的定义；inline 在调用时给出临时定义；两者都省略时使用默认的 develop 定义。profile_id 与 inline 互斥，也不与旧参数 persona/allowed_tools 混用。子代理禁止派遣子代理，也不能使用宿主配置与会话主控工具，且不会自动继承全局 AGENTS.md。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      prompt: { type: 'string', description: '交给子代理的完整任务说明（自包含：目标、范围、验收条件）。' },
      description: { type: 'string', description: '一句话说明这次派遣做什么，用于父会话列表与结果通知。' },
      profile_id: { type: 'string', description: '已保存定义的限定 id，如 builtin:explore / builtin:develop / builtin:verify / user:<id> / project:<id>。' },
      inline: {
        type: 'object',
        description: '调用时创建的临时子代理定义（不落盘、不进管理目录）。',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          instructions: { type: 'string' },
          tools: { type: 'object' },
          model: { type: 'object' },
          permissionCeiling: { type: 'string', enum: ['inherit', 'read-only'] },
        },
        required: ['name', 'description', 'tools'],
        additionalProperties: false,
      },
      provider: { type: 'string' },
      model: { type: 'string' },
      reasoning_effort: { type: 'string' },
      allowed_tools: { type: 'array', items: { type: 'string' } },
      run_in_background: { type: 'boolean' },
      persona: { type: 'string' },
    },
    required: ['prompt'],
  },
}

const FORK_SCHEMA: ToolSchema = {
  ...SPAWN_SCHEMA,
  name: 'fork_agent',
  description:
    '以父会话已闭合的历史为种子创建子代理（工具调用与结果成对，不含全局指令与旧摘要注入）；沿用父模型（跨模型 fork 会被拒绝），其余行为同 spawn_agent。始终后台执行并立即返回 pending，完成结果自动通知父会话。',
}

const CREATE_SCHEMA: ToolSchema = {
  name: 'create_subagent',
  description:
    '创建一个永久子代理定义，写入用户级或项目级定义目录，会出现在设置 → 子代理管理页，用户可查看、编辑、删除。只应在用户明确要求固化一个长期角色时使用；一次性任务优先用 spawn_agent 的 inline 临时定义（不落盘）。同 id 默认拒绝覆盖，需显式 overwrite=true。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      instructions: { type: 'string' },
      tools: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['inherit', 'allowlist'] },
          names: { type: 'array', items: { type: 'string' } },
        },
      },
      model: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['inherit', 'explicit'] },
          selection: {
            type: 'object',
            properties: {
              provider: { type: 'string' },
              model: { type: 'string' },
              reasoningEffort: { type: 'string' },
            },
          },
        },
      },
      permissionCeiling: { type: 'string', enum: ['inherit', 'read-only'] },
      scope: { type: 'string', enum: ['user', 'project'] },
      overwrite: { type: 'boolean' },
    },
    required: ['id', 'name', 'description'],
  },
}

const SEND_SCHEMA: ToolSchema = {
  name: 'send_message',
  description: '向直接父代理或直接子代理发消息；运行中在下一步接收，空闲时恢复会话。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { target: { type: 'string' }, message: { type: 'string' } },
    required: ['target', 'message'],
  },
}

const INTERRUPT_SCHEMA: ToolSchema = {
  name: 'interrupt_agent',
  description: '中断后代代理当前轮次，保留会话以便继续。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { target: { type: 'string' } },
    required: ['target'],
  },
}

const LIST_SCHEMA: ToolSchema = {
  name: 'list_agents',
  description: '列出当前会话的子代理及后代的持久化身份和运行状态。',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
}

const WAIT_SCHEMA: ToolSchema = {
  name: 'wait_agent',
  description:
    '立即查看子代理结果，不在前台等待。未完成返回 pending，完成结果会自动送达父会话；不要循环调用，可以继续独立工作或先向用户回复进度并结束本轮。已结束则直接返回结果；ready 只表示结果可读取，不代表执行成功。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      target: { type: 'string' },
      timeout_ms: { type: 'integer', minimum: 1 },
    },
    required: ['target'],
  },
}

const TRACE_SCHEMA: ToolSchema = {
  name: 'session_trace',
  description:
    '查看当前会话或直接父/子代理会话的结构化轨迹、日志与错误记录，用于自我审查和故障定位。默认只返回最近 50 条，可用 kind/level/query/since/limit 收窄。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      session: { type: 'string' },
      kind: { type: 'array', items: { type: 'string' } },
      level: { type: 'string', enum: ['all', 'error'] },
      query: { type: 'string' },
      since: { type: 'integer' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      textLimit: { type: 'integer', minimum: 120, maximum: 4000 },
    },
  },
}

const PARENT_TOOL_SCHEMAS: ToolSchema[] = [
  SPAWN_SCHEMA,
  FORK_SCHEMA,
  CREATE_SCHEMA,
  TRACE_SCHEMA,
  SEND_SCHEMA,
  INTERRUPT_SCHEMA,
  LIST_SCHEMA,
  WAIT_SCHEMA,
]

const CHILD_TOOL_SCHEMAS: ToolSchema[] = [SEND_SCHEMA, TRACE_SCHEMA]

/** Every capability tool name the subagent system can expose. */
export function subagentCapabilityNames(): string[] {
  return [...new Set([...PARENT_TOOL_SCHEMAS, ...CHILD_TOOL_SCHEMAS].map((schema) => schema.name))]
}