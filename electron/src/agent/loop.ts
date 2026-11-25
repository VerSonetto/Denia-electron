// The session driver: one Denia turn on top of the pi agent kernel.
//
// pi owns the assistant/tool loop: provider streaming, tool validation,
// parallel execution, abort semantics and queueing. Denia owns the durable
// event log, permission gate, approvals, context injection and compaction.
// Every pi event is translated back into the wire vocabulary the web console
// already folds, so the session log remains the single source of truth.

import { Agent } from '@earendil-works/pi-agent-core'
import type {
  AgentEvent,
  AgentTool,
  AgentToolResult,
  AgentTurnContext,
  BeforeToolCallContext,
  PrepareRequestContext,
  ThinkingLevel,
} from '@earendil-works/pi-agent-core'
import { createInitialSystemMessage } from '@earendil-works/pi-ai'
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  ToolResultMessage,
} from '@earendil-works/pi-ai'

import type { AppConfig, ProviderConfig } from '../config.ts'
import { findProvider, resolveApiKey, resolveDefault } from '../config.ts'
import { excludedPresetTools } from './presets.ts'
import type { PermissionState } from '../core/permission.ts'
import { ExecPolicy } from '../core/exec-policy.ts'
import { legacyModeOf, permissionStateFromEvents, presetState } from '../core/permission.ts'
import type {
  ContentBlock,
  Envelope,
  ImageData,
  LlmFailure,
  ModelSelection,
  SessionEvent,
  SessionHeader,
  StreamChunk,
  TokenUsage,
  ToolCallRef,
  ToolOutput,
  ToolSchema,
  TurnEndReason,
} from '../core/wire.ts'
import { errorMessage, truncateChars } from '../core/util.ts'
import {
  assistantBlocksOf,
  createPiStreamFn,
  meaningfulUsage,
  streamFor,
  thinkingLevelOf,
  toPiMessages,
  toPiModel,
  tokenUsageOf,
} from '../llm/index.ts'
import { ChunkBuilder, chunksForAssistantEvent, finishChunk, usageChunk } from '../llm/chunks.ts'
import { normalizePromptCacheKey } from '../llm/cache-key.ts'
import type { SessionStore } from '../session/store.ts'
import type { ToolRegistry } from '../tools/index.ts'
import type { FileHistoryBackend, ToolContext } from '../tools/types.ts'
import { toolError } from '../tools/types.ts'
import { ReadStateStore } from '../tools/read-state.ts'
import { Semaphore, TurnToolRuntime, type ToolRecord } from './tool-runtime.ts'
import { applyMediaBudget } from './media-budget.ts'
import { SessionOutputStore, budgetFor, renderPreview, withOutputArtifact } from './tool-output.ts'
import type { PromptExtraSection, SubagentPromptContext } from './system-prompt.ts'
import type { ApprovalAnswer, ApprovalBridge, GateResult } from './gate.ts'
import { gateCall } from './gate.ts'
import type { Reviewer, ReviewTranscriptEntry } from './reviewer.ts'
import { deriveHistory, deriveSurface, hasOpenTurn, lastTurn } from './history.ts'
import { dispatchApproval } from './approval-dispatch.ts'
import {
  LOOP_GUARD_CHANNEL,
  LOOP_GUARD_STRONG_REMINDER,
  LOOP_GUARD_WEAK_REMINDER,
  LoopGuard,
} from './loop-guard.ts'
import { CacheWarmer } from './cache-warm.ts'
import { compactSession } from './compact.ts'
import { loadConsoleCacheSettings, type ConsoleCacheSettings } from './console-settings.ts'
import { CLEARED_PLACEHOLDER, planMicrocompact, type MicrocompactSettings } from './microcompact.ts'
import {
  buildRequestHeader,
  compactionThresholdTokens,
  contextWindowOf,
  estimatePressure,
  frozenSystem,
  lastAssistantAgeMinutes,
  lastRequestHeader,
  sameRequestHeader,
  SYSTEM_UPDATE_CHANNEL,
} from './prefix.ts'
import { buildSystemPrompt } from './system-prompt.ts'
import { buildContextUsageSnapshot } from './context-usage.ts'
import type { ContextUsageSnapshot } from './context-usage.ts'
import { isValidSkillName } from '../skills/skills.ts'
import type { JobManager } from '../jobs/manager.ts'

/** 单轮步骤默认不设上限:靠用户取消、循环检测与上下文预算收束。 */
const MAX_STEPS = Number.POSITIVE_INFINITY
const MAX_PARALLEL = 10
/** Consecutive auto-summary failures before a session stops retrying. */
const MAX_COMPACTION_FAILURES = 3
/**
 * Arguments at or above this size are archived once a write succeeds: the file
 * content now lives on disk, and keeping a second copy in history bills every
 * later request for it. Mirrors the Rust `ARGS_STUB_THRESHOLD_CHARS`.
 */
const ARGS_STUB_THRESHOLD_CHARS = 8_192

export interface StartTurnOptions {
  selection?: ModelSelection
  images?: ImageData[]
  /** Prompt origin, recorded for future trajectory tooling. */
  source?: string
  /** User-invocable skills the composer collected (`/name` tokens). */
  skills?: string[]
  /** Resume from the inbox: do not append an empty user message. */
  continueOnly?: boolean
  /** Model-only turn: the prompt is injected, never shown as a user message. */
  injected?: boolean
  /** Injection channel used when `injected` is set. */
  channel?: string
}

/**
 * Per-deployment services the loop consults outside the static registry:
 * subagent capability tools, MCP tools and the agent inbox.
 */
export interface SessionServices {
  /** Background-job registry handed to the `bash` tool (`run_in_background`). */
  jobs?: JobManager
  /** Load a user-invocable skill body (`/skill-name`); null when unknown. */
  userSkill?(sessionId: string, name: string): { name: string; source: string; body: string } | null
  extraSchemas(sessionId: string, header: SessionHeader, state: PermissionState): ToolSchema[]
  executeExtra(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolOutput | undefined>
  /**
   * Settle a call before policy/approval. Returning an output skips execution
   * and records that result; undefined lets the call run normally.
   */
  intercept?(call: ToolCallRef, sessionId: string): ToolOutput | undefined
  /** Turn queued agent-inbox events into model-visible deliveries. */
  drainInbox?(sessionId: string): void
  /** Pin file state to a user message so it can be rewound to later. */
  fileSnapshot?(sessionId: string, scope: string | readonly string[], messageSeq: number): void
  /** Backup handle handed to write/edit for the current turn. */
  fileHistory?(sessionId: string, scope: string | readonly string[]): FileHistoryBackend
  /** Every directory of the session's project (primary first). */
  projectRoots?(sessionId: string, header: SessionHeader): string[]
  /** A human-initiated turn started: reset completion-wake budgets. */
  onTurnStart?(sessionId: string): void
  /** A turn closed; settle subagents, goal accounting and pending inboxes. */
  onTurnEnd?(sessionId: string, reason: TurnEndReason, usage?: TokenUsage): void
  /** Extra system prompt sections; they land at their fixed slots. */
  promptSections?(sessionId: string, header: SessionHeader): PromptExtraSection[]
  /** Deployment persona text (SYSTEM.md override or the factory default). */
  persona?(): string
  /** User-message injections applied at step boundaries (idempotent by channel). */
  injections?(sessionId: string, header: SessionHeader): { channel: string; text: string }[]
  /** Memory directory of this session, used by the permission gate. */
  memoryRoot?(sessionId: string, header: SessionHeader): string | null
  /** Subagent role additions, when this session is a child. */
  context?(sessionId: string): SubagentPromptContext | null
  /** Frozen selection for resumed child sessions. */
  selectionFor?(sessionId: string): ModelSelection | undefined
  /** Legacy children need a persisted model-history projection before resume. */
  historyFor?(sessionId: string, events: Envelope[]): Envelope[]
  /** Active preset, used to keep schema and execution grants identical. */
  presetFor?(sessionId: string, header: SessionHeader): { tools?: string[]; features: import('./presets.ts').PresetFeatures }
  /** Surface an unrecoverable legacy child to its parent. */
  notifyParent?(sessionId: string, message: string): void
}

export interface DriverSettings {
  maxSteps: number
  maxParallel: number
}

/** Optional permission plumbing; the loop still runs without any of it. */
export interface DriverPermissions {
  /** Human approval channel (the HTTP host plugs one in). */
  bridge?: ApprovalBridge
  /** Automatic reviewer used by the `approve-for-me` preset. */
  reviewer?: Reviewer
  /** Command rules (`execpolicy.json`). */
  policy: ExecPolicy
}

/** One in-flight Denia turn. pi's Agent is scoped to it. */
interface TurnRun {
  sessionId: string
  header: SessionHeader
  turn: number
  step: number
  agent: Agent
  unsubscribe: () => void
  cacheSettings: ConsoleCacheSettings
  cancelRequested: boolean
  loopStop: { repeats: number } | null
  maxStepsHit: boolean
  failure: LlmFailure | null
  lastAssistant: AssistantMessage | null
  turnUsage: TokenUsage | undefined
  stepOpen: boolean
  turnOpen: boolean
  records: Map<string, ToolRecord>
  preResults: Map<string, ToolOutput>
  notExecuted: Set<string>
  callRefs: Map<string, ToolCallRef>
  permissions: Map<string, PermissionState>
  selection: ModelSelection
  provider: ProviderConfig
  role: SubagentPromptContext | null
  chunkBuilder: ChunkBuilder | null
  sawToolDeltas: Set<number>
  stepChunkSeqs: number[]
  firstTokenTime: number | undefined
  requestSeq: number
  approvalBoundary: boolean
  loopGuard: LoopGuard
  loopGuardInboundSeq: number
  loopGuardPermissionSeq: number
  compactionAttempted: boolean
  slots: Semaphore
  toolRuntime: TurnToolRuntime
}

function abortedReason(): TurnEndReason {
  return { kind: 'aborted', cause: { kind: 'user' } }
}

/** Latest real user/agent message after an already-processed boundary. */
function latestInboundSeq(events: readonly Envelope[], afterSeq = 0): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.seq <= afterSeq) break
    if (event.type === 'agent-delivery') return event.seq
    if (event.type === 'user-message' && !event.injected) return event.seq
  }
  return afterSeq
}

/** Latest permission change after an already-processed boundary. */
function latestPermissionSeq(events: readonly Envelope[], afterSeq = 0): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.seq <= afterSeq) break
    if (event.type === 'permission-mode' || event.type === 'permission-selection') return event.seq
  }
  return afterSeq
}

/** Real input or a permission change since the request deserves one more step. */
function hasNewInputSince(events: readonly Envelope[], afterSeq: number): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.seq <= afterSeq) break
    if (
      event.type === 'agent-inbox' ||
      event.type === 'agent-delivery' ||
      event.type === 'permission-mode' ||
      event.type === 'permission-selection' ||
      (event.type === 'user-message' && !event.injected)
    ) {
      return true
    }
  }
  return false
}

/** Read de-dup stamp the read tool attaches to its result meta. */
function readStampOf(meta: unknown): { key: string; mtimeMs: number; size: number } | null {
  if (typeof meta !== 'object' || meta === null) return null
  const stamp = (meta as { readStamp?: unknown }).readStamp
  if (typeof stamp !== 'object' || stamp === null) return null
  const { key, mtimeMs, size } = stamp as { key?: unknown; mtimeMs?: unknown; size?: unknown }
  if (typeof key !== 'string' || typeof mtimeMs !== 'number' || typeof size !== 'number') return null
  return { key, mtimeMs, size }
}

/** Note left where an archived write call used to be (path only). */
function archivedCallNote(call: ToolCallRef): string {
  let target = ''
  try {
    const parsed = JSON.parse(call.arguments) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const value = (parsed as { path?: unknown }).path
      if (typeof value === 'string') target = value
    }
  } catch {
    target = ''
  }
  return `[工具调用归档] ${target || '写入'} 已成功写入;调用参数与结果因体积过大已移出上下文,文件内容以磁盘为准,需要时用 read_file 回读。`
}

function textOfPiMessage(message: { content: readonly { type: string; text?: string }[] }): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

function cancelledOutput(tool: string): ToolOutput {
  return {
    content: '[工具错误] 命令被用户中断',
    isError: true,
    errorIdentity: { name: tool, code: 'cancelled' },
  }
}

function errorOutput(message: string, tool: string): ToolOutput {
  const text = message.startsWith('[工具错误]') ? message : `[工具错误] ${message}`
  return { content: text, isError: true, errorIdentity: { name: tool, code: 'tool-error' } }
}

function isLlmMessage(message: { role: string }): message is Message {
  return (
    message.role === 'system' ||
    message.role === 'user' ||
    message.role === 'assistant' ||
    message.role === 'toolResult'
  )
}

function addUsage(target: TokenUsage | undefined, usage: TokenUsage | undefined): TokenUsage | undefined {
  if (!usage) return target
  return {
    inputTokens: (target?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (target?.outputTokens ?? 0) + usage.outputTokens,
    cacheReadTokens: (target?.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
    reasoningTokens: (target?.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
  }
}

export class SessionDriver {
  private readonly store: SessionStore
  private readonly registry: ToolRegistry
  private readonly getConfig: () => AppConfig
  private readonly onRunningChange: (sessionId: string, running: boolean) => void
  private readonly running = new Map<string, TurnRun>()
  private readonly bridge?: ApprovalBridge
  private readonly reviewer?: Reviewer
  private readonly policy: ExecPolicy
  /** Session-scoped "allow for this window" cache, keyed by normalized action. */
  private readonly grants = new Map<string, Set<string>>()
  private readonly cacheWarmer = new CacheWarmer()
  /** Consecutive auto-compaction failures per session; reset on success. */
  private readonly compactionFailures = new Map<string, number>()
  /** Per-session read de-dup stamps (dropped when their result leaves the surface). */
  private readonly readStates = new Map<string, ReadStateStore>()
  /** Full text of oversized tool results, pageable by the model. */
  private readonly outputStore: SessionOutputStore
  private services?: SessionServices
  readonly settings: DriverSettings

  constructor(
    store: SessionStore,
    registry: ToolRegistry,
    getConfig: () => AppConfig,
    settings?: Partial<DriverSettings>,
    onRunningChange?: (sessionId: string, running: boolean) => void,
    permissions?: DriverPermissions,
  ) {
    this.store = store
    this.outputStore = new SessionOutputStore(store)
    this.registry = registry
    this.getConfig = getConfig
    this.onRunningChange = onRunningChange ?? (() => {})
    this.bridge = permissions?.bridge
    this.reviewer = permissions?.reviewer
    this.policy = permissions?.policy ?? new ExecPolicy()
    this.settings = {
      maxSteps: settings?.maxSteps ?? MAX_STEPS,
      maxParallel: Math.max(1, settings?.maxParallel ?? MAX_PARALLEL),
    }
  }

  /**
   * Commit one tool result inside the tool's own budget. Over budget, the full
   * text is saved as a session artifact and the model gets a bounded preview
   * plus the artifact id it can page through with `read_tool_output`.
   */
  private commitToolOutput(sessionId: string, call: ToolCallRef, output: ToolOutput): ToolOutput {
    const budget = budgetFor(call.name)
    const total = Array.from(output.content).length
    if (total <= budget.max) return output
    const artifactId = this.outputStore.save(sessionId, call.id, output.content)
    const preview = renderPreview(output.content, budget, artifactId)
    return {
      ...output,
      content: preview.content,
      truncation: { total_chars: total, shown_chars: preview.shownChars },
      ...(artifactId === null
        ? {}
        : { meta: withOutputArtifact(output.meta, { output_id: artifactId, chars: total }) }),
    }
  }

  /** Read de-dup state for one session (created on first use). */
  private readStateFor(sessionId: string): ReadStateStore {
    let state = this.readStates.get(sessionId)
    if (state === undefined) {
      state = new ReadStateStore()
      this.readStates.set(sessionId, state)
    }
    return state
  }

  /** Install host services after both runtimes exist (breaks the cycle). */
  attachServices(services: SessionServices): void {
    this.services = services
  }

  /** Drop a pending cache-warming replay (new request, compaction, shutdown). */
  cancelCacheWarm(sessionId: string): void {
    this.cacheWarmer.cancel(sessionId)
  }

  /** Release every armed warming timer (host shutdown). */
  dispose(): void {
    this.cacheWarmer.dispose()
  }

  /** Drop a session's warmer state (delete or rewind). */
  forgetCacheWarm(sessionId: string): void {
    this.cacheWarmer.forget(sessionId)
  }

  /** The session's permission state, projected from its event log. */
  permissionStateOf(sessionId: string): PermissionState {
    return permissionStateFromEvents(this.store.read(sessionId)?.events ?? [])
  }

  /** Project directories for a session; hosts without projects use the cwd. */
  private rootsOf(sessionId: string, header: SessionHeader): string[] {
    const roots = this.services?.projectRoots?.(sessionId, header)
    return roots && roots.length > 0 ? roots : [header.cwd]
  }

  /** Session-level grants for approval-free reruns of the same action. */
  private grantsOf(sessionId: string): Set<string> {
    let grants = this.grants.get(sessionId)
    if (!grants) {
      grants = new Set()
      this.grants.set(sessionId, grants)
    }
    return grants
  }

  /**
   * Events that form the model-visible transcript. Legacy children resume
   * from a frozen projection; a loop-guard reminder created during the
   * current turn is appended to that projection so the next request is
   * guaranteed to carry it (the projection itself is not rewritten).
   */
  private modelEventsFor(
    sessionId: string,
    events: Envelope[],
    role: SubagentPromptContext | null,
  ): Envelope[] {
    if (!role?.legacy) return events
    const projected = this.services?.historyFor?.(sessionId, events) ?? events
    const seen = new Set(projected.map((event) => event.seq))
    let turnStartSeq = 0
    for (const event of events) {
      if (event.type === 'turn-start') turnStartSeq = event.seq
    }
    const reminders = events.filter(
      (event) =>
        event.type === 'user-message' &&
        event.channel === LOOP_GUARD_CHANNEL &&
        event.seq > turnStartSeq &&
        !seen.has(event.seq),
    )
    if (reminders.length === 0) return projected
    return [...projected, ...reminders].sort((a, b) => a.seq - b.seq)
  }

  /**
   * Current prompt composition for the context panel: the same inputs the
   * next request will use (frozen system prefix, effective tool schemas and
   * the model-visible surface), split by source. Pure estimate — the total
   * meter still comes from provider usage.
   */
  contextUsage(sessionId: string): ContextUsageSnapshot | null {
    const session = this.store.read(sessionId)
    if (!session) return null
    try {
      let selection: ModelSelection | null = null
      try {
        const requested = this.selectionOf(sessionId) ?? undefined
        selection = this.resolveSelection(this.getConfig(), requested).selection
      } catch {
        selection = null
      }
      let role: SubagentPromptContext | null = null
      try {
        role = this.services?.context?.(sessionId) ?? null
      } catch {
        role = null
      }
      const events = this.modelEventsFor(sessionId, session.events, role)
      const surface = deriveSurface(events)
      const permission = this.permissionStateOf(sessionId)
      const schemas = this.schemasFor(permission, sessionId, session.header)
      const framed = buildSystemPrompt({
        cwd: session.header.cwd,
        sandbox: session.header.sandbox,
        tools: schemas,
        permission,
        ...(selection ? { model: selection.model, provider: selection.provider } : {}),
        ...(this.services?.persona ? { persona: this.services.persona() } : {}),
        ...(role ? { subagent: role } : {}),
        ...(this.services?.promptSections
          ? { extraSections: this.services.promptSections(sessionId, session.header) }
          : {}),
      })
      const frozen = frozenSystem(framed, session.events, surface)
      return buildContextUsageSnapshot({
        system: frozen.system,
        tools: schemas,
        surface,
        ...(frozen.update !== null ? { pendingSystemUpdate: frozen.update } : {}),
      })
    } catch {
      return null
    }
  }

  /** True while a turn owns this session. */
  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  /** Latest model selection recorded by a turn; goal continuation reuses it. */
  selectionOf(sessionId: string): ModelSelection | null {
    const events = this.store.read(sessionId)?.events ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!
      if (event.type !== 'request-context') continue
      return { provider: event.provider, model: event.model }
    }
    return null
  }

  /**
   * One tool-less model call over the full transcript. Used by the goal
   * completion verifier; it never appends events to the session log.
   */
  async runGoalVerification(input: {
    sessionId: string
    prompt: string
    selection: ModelSelection
    signal: AbortSignal
  }): Promise<string> {
    const session = this.store.read(input.sessionId)
    if (!session) throw new Error('session not found')
    const { provider, selection } = this.resolveSelection(this.getConfig(), input.selection)
    const messages = [
      ...deriveHistory(session.events),
      { role: 'user' as const, content: input.prompt },
    ]
    const system = buildSystemPrompt({
      cwd: session.header.cwd,
      sandbox: session.header.sandbox,
      tools: [],
      permission: this.permissionStateOf(input.sessionId),
      ...(this.services?.persona ? { persona: this.services.persona() } : {}),
    })
    let text = ''
    const stream = streamFor({
      provider,
      model: selection.model,
      messages,
      system,
      tools: [],
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      signal: input.signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'block-end' && chunk.block.type === 'text') text += chunk.block.text
    }
    return text
  }

  runningIds(): string[] {
    return [...this.running.keys()]
  }

  /** Idempotent cancel: keeps the token like the Rust backend does. */
  cancel(sessionId: string): boolean {
    const run = this.running.get(sessionId)
    if (!run) return false
    run.cancelRequested = true
    run.agent.abort()
    this.cacheWarmer.cancel(sessionId)
    return true
  }

  /** Start a turn without waiting for it. The returned promise resolves once the turn closes. */
  startTurn(sessionId: string, prompt: string, options: StartTurnOptions = {}): Promise<void> {
    return this.runTurn(sessionId, prompt, options)
  }

  private resolveSelection(
    config: AppConfig,
    requested?: ModelSelection,
    inherit?: ModelSelection,
  ): { provider: ProviderConfig; selection: ModelSelection } {
    const fallback = inherit ?? resolveDefault(config)
    const provider = requested ? findProvider(config, requested.provider) : findProvider(config, fallback.provider)
    if (!provider) {
      if (requested) {
        if (inherit) return this.resolveSelection(config, undefined, inherit)
        throw new Error(`模型提供商 ${requested.provider} 当前不可用`)
      }
      const first = config.providers[0]
      if (!first) throw new Error('没有配置任何模型提供商')
      return { provider: first, selection: { provider: first.id, model: first.models[0]?.id ?? 'default' } }
    }
    const requestedModel = requested?.model ?? fallback.model
    const model = provider.models.some((entry) => entry.id === requestedModel)
      ? requestedModel
      : requested
        ? undefined
        : provider.models[0]?.id ?? 'default'
    if (!model) {
      if (inherit) return this.resolveSelection(config, undefined, inherit)
      throw new Error(`模型 ${requestedModel} 当前不可用`)
    }
    return {
      provider,
      selection: {
        provider: provider.id,
        model,
        ...(requested?.reasoningEffort ?? fallback.reasoningEffort
          ? { reasoningEffort: requested?.reasoningEffort ?? fallback.reasoningEffort }
          : {}),
      },
    }
  }

  private async runTurn(sessionId: string, prompt: string, options: StartTurnOptions): Promise<void> {
    const session = this.store.read(sessionId)
    if (!session) return
    if (this.running.has(sessionId)) return

    const config = this.getConfig()
    const frozen = options.selection ?? this.services?.selectionFor?.(sessionId)
    let selection: ModelSelection = resolveDefault(config)
    let provider: ProviderConfig | undefined
    let selectionError: string | null = null
    try {
      const resolved = this.resolveSelection(
        config,
        frozen,
        session.header.subagent ? resolveDefault(config) : undefined,
      )
      provider = resolved.provider
      selection = resolved.selection
    } catch (error) {
      selectionError = errorMessage(error)
    }

    let role: SubagentPromptContext | null = null
    let roleError: string | null = null
    let historyError: string | null = null
    try {
      role = this.services?.context?.(sessionId) ?? null
      if (options.continueOnly && role?.legacy) this.services?.historyFor?.(sessionId, session.events)
    } catch (error) {
      roleError = errorMessage(error)
      if (roleError.includes('legacy-resume-unsupported')) {
        roleError = '旧子代理无法建立安全的历史投影，请查看日志后用 spawn_agent 重新派遣'
        historyError = roleError
      }
    }

    const turn = lastTurn(session.events) + 1
    const cacheSettings = loadConsoleCacheSettings(this.store.home)
    this.cacheWarmer.cancel(sessionId)
    const append = (event: SessionEvent): Envelope | null => this.store.append(sessionId, event)

    const baseline = this.store.read(sessionId)?.events ?? []
    const baselineSeq = baseline[baseline.length - 1]?.seq ?? 0

    const placeholder: Message = { role: 'user', content: '', timestamp: Date.now() }
    const model = provider
      ? toPiModel(provider, selection.model, {
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        })
      : null

    const run: TurnRun = {
      sessionId,
      header: session.header,
      turn,
      step: 0,
      agent: undefined as unknown as Agent,
      unsubscribe: () => {},
      cacheSettings,
      cancelRequested: false,
      loopStop: null,
      maxStepsHit: false,
      failure: null,
      lastAssistant: null,
      turnUsage: undefined,
      stepOpen: false,
      turnOpen: false,
      records: new Map(),
      preResults: new Map(),
      notExecuted: new Set(),
      callRefs: new Map(),
      permissions: new Map(),
      selection,
      provider: provider as ProviderConfig,
      role,
      chunkBuilder: null,
      sawToolDeltas: new Set(),
      stepChunkSeqs: [],
      firstTokenTime: undefined,
      requestSeq: 0,
      approvalBoundary: false,
      loopGuard: new LoopGuard(),
      loopGuardInboundSeq: baselineSeq,
      loopGuardPermissionSeq: baselineSeq,
      compactionAttempted: false,
      slots: new Semaphore(this.settings.maxParallel),
      toolRuntime: undefined as unknown as TurnToolRuntime,
    }

    run.toolRuntime = new TurnToolRuntime({
      sessionId,
      header: run.header,
      registry: this.registry,
      preResults: run.preResults,
      records: run.records,
      notExecuted: run.notExecuted,
      permissions: run.permissions,
      slots: run.slots,
      readState: this.readStateFor(sessionId),
      outputStore: this.outputStore,
      selection: () => run.selection,
      permissionState: () => this.permissionStateOf(run.sessionId),
      roots: () => this.rootsOf(run.sessionId, run.header),
      memoryRoot: () => this.services?.memoryRoot?.(run.sessionId, run.header) ?? null,
      ...(this.services?.jobs ? { jobs: this.services.jobs } : {}),
      ...(this.services?.executeExtra
        ? { executeExtra: this.services.executeExtra.bind(this.services) }
        : {}),
      ...(this.services?.fileHistory
        ? { fileHistory: (scope: string | readonly string[]) => this.services!.fileHistory!(run.sessionId, scope) }
        : {}),
      commitOutput: (call, output) => this.commitToolOutput(run.sessionId, call, output),
      append: (event) => this.store.append(run.sessionId, event),
      markApprovalBoundary: () => {
        run.approvalBoundary = true
      },
      cancelRequested: () => run.cancelRequested,
      agentSignal: () => run.agent.signal,
    })

    const closeTurn = (reason: TurnEndReason): void => {
      if (!run.turnOpen) return
      this.closeStep(run)
      append({ type: 'turn-end', turn: run.turn, reason })
      run.turnOpen = false
      this.store.flush(sessionId)
    }

    this.running.set(sessionId, run)
    this.onRunningChange(sessionId, true)

    try {
      if (!options.continueOnly) this.services?.onTurnStart?.(sessionId)
      if (!options.continueOnly) {
        const explicitSkills = [
          ...new Set((options.skills ?? []).filter((name) => isValidSkillName(name))),
        ]
        const gesture = skillGesture(prompt)
        const injected: { name: string; source: string; body: string; gesture: boolean }[] = []
        for (const name of explicitSkills) {
          const skill = this.services?.userSkill?.(sessionId, name)
          if (skill) injected.push({ ...skill, gesture: false })
        }
        if (gesture !== null && !explicitSkills.includes(gesture)) {
          const skill = this.services?.userSkill?.(sessionId, gesture)
          if (skill) injected.push({ ...skill, gesture: true })
        }
        for (const skill of injected) {
          if (skill.gesture) continue
          append({
            type: 'user-message',
            text: `[用户显式调用技能：${skill.name}（来源：${skill.source}）]\n${skill.body}`,
            injected: true,
            channel: 'skill-invocation',
          })
        }
        const injectedTurn = options.injected === true
        const userEnvelope = append({
          type: 'user-message',
          text: prompt,
          injected: injectedTurn,
          ...(injectedTurn && options.channel ? { channel: options.channel } : {}),
          ...(options.images && options.images.length > 0 ? { images: options.images } : {}),
        })
        if (userEnvelope && !injectedTurn) {
          try {
            this.services?.fileSnapshot?.(
              sessionId,
              this.rootsOf(sessionId, session.header),
              userEnvelope.seq,
            )
          } catch (error) {
            console.warn('[denia] 文件历史快照失败:', errorMessage(error))
          }
        }
        for (const skill of injected) {
          if (!skill.gesture) continue
          append({
            type: 'user-message',
            text: `[技能正文 ${skill.name}（来源：${skill.source}）]\n${skill.body}`,
            injected: true,
            channel: 'gesture-skill',
          })
        }
      }

      append({ type: 'turn-start', turn })
      run.turnOpen = true

      if (roleError !== null) {
        if (historyError) this.services?.notifyParent?.(sessionId, historyError)
        closeTurn({
          kind: 'error',
          failure: { code: 'subagent/snapshot-invalid', message: roleError },
        })
        return
      }
      if (!provider || !model || selectionError !== null) {
        run.step = 1
        run.stepOpen = true
        append({ type: 'step-start', turn, step: 1 })
        closeTurn({
          kind: 'error',
          failure: {
            code: 'llm/not-configured',
            message: selectionError ?? '没有可用的模型提供商,请先配置提供商与模型。',
          },
        })
        return
      }

      const agent = new Agent({
        initialState: {
          model,
          thinkingLevel: thinkingLevelOf(selection.reasoningEffort),
          tools: [],
          messages: [placeholder],
        },
        streamFn: createPiStreamFn(() => run.provider),
        sessionId:
          provider.supportsPromptCacheKey === false ? undefined : normalizePromptCacheKey(sessionId),
        getApiKey: () => resolveApiKey(run.provider),
        identity: { attribution: null },
        toolExecution: 'parallel',
        convertToLlm: (messages) => messages.filter(isLlmMessage),
        beforeToolCall: (context, signal) => this.beforeToolCall(run, context, signal),
        prepareRequest: (context, signal) => this.prepareRequest(run, context, signal),
        finishTurn: (context) => this.finishTurn(run, context),
      })
      run.agent = agent
      run.unsubscribe = agent.subscribe((event) => this.onAgentEvent(run, event))

      await agent.continue()
      closeTurn(this.turnReason(run))
    } catch (error) {
      if (run.cancelRequested || run.agent?.signal?.aborted) {
        closeTurn(abortedReason())
      } else {
        closeTurn({
          kind: 'error',
          failure: { code: 'llm/stream', message: errorMessage(error) },
        })
      }
    } finally {
      run.unsubscribe()
      closeTurn(this.turnReason(run))
      this.running.delete(sessionId)
      this.onRunningChange(sessionId, false)
      this.store.flush(sessionId)
      this.cacheWarmer.schedule(sessionId, 'idle', cacheSettings.cacheWarming)
      try {
        this.services?.onTurnEnd?.(sessionId, this.turnReason(run), run.turnUsage)
      } catch {
        /* settlement must never mask the turn result */
      }
    }
  }

  private turnReason(run: TurnRun): TurnEndReason {
    if (run.maxStepsHit) {
      return {
        kind: 'error',
        failure: {
          code: 'agent/max-steps',
          message: `本轮步骤超过上限(${this.settings.maxSteps}),已停止。`,
        },
      }
    }
    if (run.cancelRequested) return abortedReason()
    if (run.loopStop) return { kind: 'loop-detected', repeats: run.loopStop.repeats }
    if (run.failure) return { kind: 'error', failure: run.failure }
    const message = run.lastAssistant
    if (!message) return { kind: 'completed' }
    switch (message.stopReason) {
      case 'error':
        return {
          kind: 'error',
          failure: { code: 'llm/stream', message: message.errorMessage ?? 'provider error' },
        }
      case 'aborted':
        return abortedReason()
      case 'length':
        return { kind: 'max-tokens' }
      default:
        return { kind: 'completed' }
    }
  }

  private onAgentEvent(run: TurnRun, event: AgentEvent): void {
    switch (event.type) {
      case 'turn_start': {
        if (run.cancelRequested) return
        run.step += 1
        run.stepOpen = true
        run.stepChunkSeqs = []
        run.firstTokenTime = undefined
        run.sawToolDeltas.clear()
        this.store.append(run.sessionId, { type: 'step-start', turn: run.turn, step: run.step })
        return
      }
      case 'turn_end': {
        if (run.cancelRequested) return
        this.closeStep(run)
        return
      }
      case 'message_start': {
        if (event.message.role !== 'assistant' || run.cancelRequested) return
        run.chunkBuilder = new ChunkBuilder({
          ...(run.provider.inlineThinkTags ? { inlineThinkTags: true } : {}),
        })
        run.sawToolDeltas.clear()
        run.stepChunkSeqs = []
        run.firstTokenTime = undefined
        return
      }
      case 'message_update': {
        if (run.cancelRequested || event.message.role !== 'assistant') return
        const builder = run.chunkBuilder
        if (!builder) return
        const chunks = chunksForAssistantEvent(builder, event.assistantMessageEvent, run.sawToolDeltas)
        for (const chunk of chunks) {
          const envelope = this.store.append(run.sessionId, {
            type: 'assistant-chunk',
            turn: run.turn,
            step: run.step,
            chunk,
          })
          if (!envelope) continue
          run.stepChunkSeqs.push(envelope.seq)
          if (
            run.firstTokenTime === undefined &&
            (chunk.type === 'text-delta' ||
              chunk.type === 'reasoning-delta' ||
              chunk.type === 'tool-call-delta')
          ) {
            run.firstTokenTime = envelope.time
          }
        }
        return
      }
      case 'message_end': {
        if (event.message.role === 'assistant') {
          this.onAssistantEnd(run, event.message)
        } else if (event.message.role === 'toolResult') {
          this.onToolResult(run, event.message)
        }
        return
      }
      case 'tool_execution_start': {
        const call: ToolCallRef = {
          id: event.toolCallId,
          name: event.toolName,
          arguments: JSON.stringify(event.args ?? {}),
        }
        run.callRefs.set(event.toolCallId, call)
        this.store.append(run.sessionId, {
          type: 'tool-call',
          turn: run.turn,
          step: run.step,
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        })
        return
      }
      default:
        return
    }
  }

  private closeStep(run: TurnRun): void {
    if (!run.stepOpen) return
    this.store.append(run.sessionId, { type: 'step-end', turn: run.turn, step: run.step })
    run.stepOpen = false
  }

  private onAssistantEnd(run: TurnRun, message: AssistantMessage): void {
    run.lastAssistant = message
    if (message.stopReason === 'error') {
      run.failure = { code: 'llm/stream', message: message.errorMessage ?? 'provider error' }
      return
    }
    if (message.stopReason === 'aborted' || run.cancelRequested) return
    const builder = run.chunkBuilder
    if (!builder) return
    const blocks = assistantBlocksOf(message, run.provider)
    const usage = tokenUsageOf(message.usage)
    const trailing: StreamChunk[] = [
      ...builder.flushInlineTail(),
      ...builder.finish(blocks),
      ...usageChunk(usage),
      finishChunk(
        message.stopReason === 'length'
          ? { kind: 'max-tokens' }
          : message.stopReason === 'toolUse'
            ? { kind: 'tool-calls' }
            : { kind: 'stop' },
      ),
    ]
    for (const chunk of trailing) {
      const envelope = this.store.append(run.sessionId, {
        type: 'assistant-chunk',
        turn: run.turn,
        step: run.step,
        chunk,
      })
      if (envelope) run.stepChunkSeqs.push(envelope.seq)
    }
    this.store.append(run.sessionId, {
      type: 'assistant-message',
      turn: run.turn,
      step: run.step,
      blocks,
      usage,
      ...(run.stepChunkSeqs.length > 0 ? { source_event_seqs: run.stepChunkSeqs } : {}),
      ...(run.firstTokenTime !== undefined ? { first_token_time: run.firstTokenTime } : {}),
    })
    run.turnUsage = addUsage(run.turnUsage, usage)
    this.cacheWarmer.schedule(run.sessionId, 'streaming', run.cacheSettings.cacheWarming)
  }

  private onToolResult(run: TurnRun, message: ToolResultMessage): void {
    const callId = message.toolCallId
    const call = run.callRefs.get(callId) ?? {
      id: callId,
      name: message.toolName,
      arguments: '{}',
    }
    const record = run.records.get(callId)
    const pre = run.preResults.get(callId)
    let output: ToolOutput
    if (record) {
      output = record.output
    } else if (pre) {
      output = pre
    } else if (message.isError) {
      output = run.cancelRequested
        ? cancelledOutput(call.name)
        : errorOutput(textOfPiMessage(message), call.name)
    } else {
      output = { content: textOfPiMessage(message), isError: false }
    }
    const appended = this.store.append(run.sessionId, {
      type: 'tool-result',
      turn: run.turn,
      step: run.step,
      call_id: callId,
      content: output.content,
      is_error: output.isError,
      ...(output.errorIdentity ? { error_identity: output.errorIdentity } : {}),
      ...(output.meta !== undefined ? { meta: output.meta } : {}),
      ...(output.truncation ? { truncation: output.truncation } : {}),
    })
    if (appended && !output.isError) {
      const stamp = readStampOf(output.meta)
      if (stamp) {
        this.readStateFor(run.sessionId).remember(stamp.key, {
          callId,
          seq: appended.seq,
          stamp: { mtimeMs: stamp.mtimeMs, size: stamp.size },
        })
      }
      if (
        (call.name === 'write_file' || call.name === 'edit') &&
        call.arguments.length >= ARGS_STUB_THRESHOLD_CHARS
      ) {
        this.store.append(run.sessionId, {
          type: 'args-cleared',
          turn: run.turn,
          step: run.step,
          call_id: callId,
          placeholder: archivedCallNote(call),
        })
      }
    }
  }

  private async beforeToolCall(
    run: TurnRun,
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<{ block?: boolean; reason?: string; terminate?: boolean } | undefined> {
    const toolCall = context.toolCall
    const args = (context.args ?? {}) as Record<string, unknown>
    const call: ToolCallRef = {
      id: toolCall.id,
      name: toolCall.name,
      arguments: JSON.stringify(args),
    }
    if (signal?.aborted) {
      const output = cancelledOutput(call.name)
      run.preResults.set(call.id, output)
      run.notExecuted.add(call.id)
      return { block: true, reason: output.content }
    }

    const intercepted = this.services?.intercept?.(call, run.sessionId)
    if (intercepted) {
      run.preResults.set(call.id, intercepted)
      run.notExecuted.add(call.id)
      return undefined
    }

    const state = this.permissionStateOf(run.sessionId)
    const roots = this.rootsOf(run.sessionId, run.header)
    const memoryRoot = this.services?.memoryRoot?.(run.sessionId, run.header) ?? null
    const gate = gateCall(
      state,
      run.header.cwd,
      call,
      this.policy,
      this.grantsOf(run.sessionId),
      memoryRoot,
      roots,
    )

    if (gate.decision.kind === 'forbid') {
      const output = errorOutput(gate.decision.reason, call.name)
      run.preResults.set(call.id, output)
      run.notExecuted.add(call.id)
      return { block: true, reason: output.content }
    }
    if (gate.decision.kind === 'allow') {
      run.permissions.set(call.id, state)
      return undefined
    }

    const decision = await dispatchApproval(
      {
        sessionId: run.sessionId,
        cwd: run.header.cwd,
        ...(this.bridge ? { bridge: this.bridge } : {}),
        ...(this.reviewer ? { reviewer: this.reviewer } : {}),
        policy: this.policy,
        grants: this.grantsOf(run.sessionId),
        append: (event) => this.store.append(run.sessionId, event),
        transcript: () => this.transcriptOf(run.sessionId),
        applyPlan: (answer) => this.applyPlanApproval(run, answer),
        abort: () => {
          run.cancelRequested = true
          run.agent.abort()
        },
        markApprovalBoundary: () => {
          run.approvalBoundary = true
        },
      },
      call,
      gate,
      state,
      signal,
    )
    if (decision.abort) {
      run.cancelRequested = true
      run.agent.abort()
      const output = cancelledOutput(call.name)
      run.preResults.set(call.id, output)
      run.notExecuted.add(call.id)
      return { block: true, reason: output.content }
    }
    if (decision.output) {
      run.preResults.set(call.id, decision.output)
      run.notExecuted.add(call.id)
      return undefined
    }

    const current = this.permissionStateOf(run.sessionId)
    const recheck = gateCall(
      current,
      run.header.cwd,
      call,
      this.policy,
      this.grantsOf(run.sessionId),
      memoryRoot,
      roots,
    )
    if (recheck.decision.kind === 'forbid') {
      const output = errorOutput(`批准后重新判权被拒绝:${recheck.decision.reason}`, call.name)
      run.preResults.set(call.id, output)
      run.notExecuted.add(call.id)
      return { block: true, reason: output.content }
    }
    run.permissions.set(call.id, current)
    return undefined
  }

  /** Plan approval: leave plan mode, switch the execute preset, maybe the model. */
  private applyPlanApproval(run: TurnRun, answer: ApprovalAnswer): ToolOutput {
    const executeMode = answer.plan?.executeMode === 'full' ? 'full-access' : 'project-write'
    const next = presetState(executeMode, 'default')
    this.store.append(run.sessionId, {
      type: 'permission-selection',
      sandbox: next.sandbox,
      approval: next.approval,
      reviewer: next.reviewer,
      collaboration: next.collaboration,
    })
    this.store.append(run.sessionId, {
      type: 'permission-mode',
      mode: legacyModeOf(next),
    })
    if (answer.plan?.selection) run.selection = answer.plan.selection
    const feedback = answer.plan?.feedback?.trim()
    const suffix = feedback ? `\n用户补充建议:${feedback}` : ''
    return {
      content: `计划已批准,会话已切换至 ${executeMode} 模式,请开始执行。${suffix}`,
      isError: false,
    }
  }

  /** Recent conversation, trimmed for the reviewer prompt. */
  private transcriptOf(sessionId: string): ReviewTranscriptEntry[] {
    const entries: ReviewTranscriptEntry[] = []
    for (const event of this.store.read(sessionId)?.events ?? []) {
      if (event.type === 'user-message' && !event.injected) {
        entries.push({ role: 'user', text: truncateChars(event.text, 2000, '…')[0] })
      } else if (event.type === 'assistant-message') {
        const text = event.blocks
          .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        if (text.trim() !== '') {
          entries.push({ role: 'assistant', text: truncateChars(text, 2000, '…')[0] })
        }
      }
    }
    return entries.slice(-12)
  }

  /**
   * Rebuild the request context immediately before every provider request.
   * This is where injections, microcompaction, auto-summary and the frozen
   * system prefix run — all of them append to the log, then the canonical
   * surface is converted to pi messages.
   */
  private async prepareRequest(
    run: TurnRun,
    _context: PrepareRequestContext,
    signal?: AbortSignal,
  ): Promise<{
    context?: { messages: Message[]; tools?: AgentTool[] }
    model?: Model<Api>
    thinkingLevel?: ThinkingLevel
  } | undefined> {
    this.services?.drainInbox?.(run.sessionId)
    this.applyInjections(run.sessionId, run.header)

    const config = this.getConfig()
    const resolved = this.resolveSelection(config, run.selection)
    run.provider = resolved.provider
    run.selection = resolved.selection
    const provider = resolved.provider
    const selection = resolved.selection
    const cacheSettings = run.cacheSettings

    if (!run.role?.legacy && !signal?.aborted) {
      this.applyMicrocompact(
        run.sessionId,
        run.turn,
        run.step,
        provider,
        selection.model,
        cacheSettings.microcompact,
        cacheSettings.compactionRatio,
      )
    }
    if (!run.role?.legacy && !signal?.aborted) {
      run.compactionAttempted = await this.applyAutoCompact({
        sessionId: run.sessionId,
        selection,
        provider,
        model: selection.model,
        ratio: cacheSettings.compactionRatio,
        header: run.header,
        signal: signal ?? new AbortController().signal,
        attempted: run.compactionAttempted,
      })
    }
    if (signal?.aborted) throw new Error('aborted')

    let events = this.store.read(run.sessionId)?.events ?? []
    let modelEvents = this.modelEventsFor(run.sessionId, events, run.role)
    let surface = deriveSurface(modelEvents)
    let messages = surface.map((item) => item.message)
    const permission = this.permissionStateOf(run.sessionId)
    const schemas = this.schemasFor(permission, run.sessionId, run.header)

    const framedCurrent = buildSystemPrompt({
      cwd: run.header.cwd,
      sandbox: run.header.sandbox,
      tools: schemas,
      permission,
      model: selection.model,
      provider: selection.provider,
      ...(this.services?.persona ? { persona: this.services.persona() } : {}),
      ...(run.role ? { subagent: run.role } : {}),
      ...(this.services?.promptSections
        ? { extraSections: this.services.promptSections(run.sessionId, run.header) }
        : {}),
    })

    let previousSystemPrompt: string | null = null
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!
      if (event.type === 'system-prompt') {
        previousSystemPrompt = event.text
        break
      }
    }
    if (previousSystemPrompt !== framedCurrent) {
      this.store.append(run.sessionId, {
        type: 'system-prompt',
        turn: run.turn,
        step: run.step,
        text: framedCurrent,
      })
    }

    const frozen = frozenSystem(framedCurrent, events, surface)
    if (frozen.update !== null) {
      run.loopGuard.reset()
      this.store.append(run.sessionId, {
        type: 'user-message',
        text: frozen.update,
        injected: true,
        channel: SYSTEM_UPDATE_CHANNEL,
      })
      events = this.store.read(run.sessionId)?.events ?? events
      modelEvents = this.modelEventsFor(run.sessionId, events, run.role)
      surface = deriveSurface(modelEvents)
      messages = surface.map((item) => item.message)
    }

    const header = buildRequestHeader(selection, frozen.system, schemas)
    const previousHeader = lastRequestHeader(events)
    const headerChanged = previousHeader !== null && !sameRequestHeader(previousHeader.header, header)
    if (headerChanged) run.loopGuard.reset()
    if (!previousHeader || headerChanged) {
      this.store.append(run.sessionId, {
        type: 'request-header',
        turn: run.turn,
        step: run.step,
        header,
        reason: previousHeader ? 'change' : 'initial',
        ...(previousHeader ? { starts_series: true } : {}),
      })
    }

    const requestContext = this.store.append(run.sessionId, {
      type: 'request-context',
      turn: run.turn,
      step: run.step,
      provider: selection.provider,
      model: selection.model,
      ...(provider.defaultContextWindow ? { context_window: provider.defaultContextWindow } : {}),
    })
    if (requestContext) run.requestSeq = requestContext.seq

    const budget = applyMediaBudget(messages)
    const piMessages = toPiMessages(budget.messages, provider, selection.model)
    // Declare only the schemas this permission state may use, but keep every
    // executable tool in the runtime loadout: pi validates and executes calls
    // against `context.tools`, so a hidden write tool must still reach the
    // permission gate and be refused with a readable reason instead of
    // "Tool not found". Provider requests only see the declared system tools.
    const visibleTools = run.toolRuntime.toolsFor(schemas)
    const executableTools = run.toolRuntime.toolsFor(
      this.executableSchemas(run.sessionId, run.header, permission),
    )
    const systemMessage = createInitialSystemMessage(frozen.system, visibleTools)
    const model = toPiModel(provider, selection.model, {
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    })

    this.cacheWarmer.remember(
      run.sessionId,
      provider,
      {
        provider,
        model: selection.model,
        messages: budget.messages,
        system: frozen.system,
        tools: schemas,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        ...(provider.supportsPromptCacheKey === false ? {} : { cacheKey: run.sessionId }),
      },
      cacheSettings.cacheWarming.mode,
    )
    this.cacheWarmer.cancel(run.sessionId)

    return {
      context: {
        messages: systemMessage ? [systemMessage, ...piMessages] : piMessages,
        tools: executableTools,
      },
      model,
      thinkingLevel: thinkingLevelOf(selection.reasoningEffort),
    }
  }

  private finishTurn(run: TurnRun, turn: AgentTurnContext): { action: 'end' } | undefined {
    const message = turn.message
    if (message.stopReason === 'error' || message.stopReason === 'aborted') return undefined
    if (turn.toolResults.length > 0) {
      const latest = this.store.read(run.sessionId)?.events ?? []
      const scannedToSeq = latest[latest.length - 1]?.seq ?? 0
      const inboundSeq = latestInboundSeq(latest, run.loopGuardInboundSeq)
      if (inboundSeq > run.loopGuardInboundSeq) run.loopGuard.reset()
      run.loopGuardInboundSeq = Math.max(run.loopGuardInboundSeq, scannedToSeq)
      const permissionSeq = latestPermissionSeq(latest, run.loopGuardPermissionSeq)
      if (permissionSeq > run.loopGuardPermissionSeq) run.loopGuard.reset()
      run.loopGuardPermissionSeq = Math.max(run.loopGuardPermissionSeq, scannedToSeq)

      let decision: ReturnType<LoopGuard['observe']> | null = null
      if (run.approvalBoundary) {
        run.approvalBoundary = false
        run.loopGuard.reset()
      } else {
        decision = run.loopGuard.observe({
          calls: turn.toolResults.map((result) => {
            const call = run.callRefs.get(result.toolCallId) ?? {
              id: result.toolCallId,
              name: result.toolName,
              arguments: '{}',
            }
            const record = run.records.get(result.toolCallId)
            const pre = run.preResults.get(result.toolCallId)
            const output = record?.output ?? pre
            return {
              name: call.name,
              arguments: call.arguments,
              content: output?.content ?? textOfPiMessage(result),
              isError: result.isError,
              ...(output?.errorIdentity ? { errorIdentity: output.errorIdentity } : {}),
              notExecuted: run.notExecuted.has(result.toolCallId) || (!record && !pre),
              truncated: output?.truncation !== undefined,
              missing: false,
            }
          }),
        })
      }

      if (decision?.kind === 'strong-reminder' || decision?.kind === 'weak-reminder') {
        if (hasNewInputSince(latest, run.requestSeq)) {
          run.loopGuard.reset()
        } else {
          this.store.append(run.sessionId, {
            type: 'user-message',
            text:
              decision.kind === 'strong-reminder'
                ? LOOP_GUARD_STRONG_REMINDER
                : LOOP_GUARD_WEAK_REMINDER,
            injected: true,
            channel: LOOP_GUARD_CHANNEL,
          })
        }
      } else if (decision?.kind === 'stop') {
        if (hasNewInputSince(latest, run.requestSeq)) {
          run.loopGuard.reset()
        } else {
          run.loopStop = { repeats: decision.repeats }
          return { action: 'end' }
        }
      }
    }

    if (run.step >= this.settings.maxSteps) {
      run.maxStepsHit = true
      return { action: 'end' }
    }
    return undefined
  }

  /** Append an injected user message only when its channel content changed. */
  private applyInjections(sessionId: string, header: SessionHeader): void {
    const injections = this.services?.injections?.(sessionId, header)
    if (!injections || injections.length === 0) return
    const events = this.store.read(sessionId)?.events ?? []
    for (const injection of injections) {
      let previous: string | null = null
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]!
        if (event.type === 'user-message' && event.channel === injection.channel) {
          previous = event.text
          break
        }
      }
      if (previous === injection.text) continue
      this.store.append(sessionId, {
        type: 'user-message',
        text: injection.text,
        injected: true,
        channel: injection.channel,
      })
    }
  }

  /**
   * Cheap cleanup before an expensive summary: old tool-result contents are
   * replaced in place via `replaces` events. The log stays append-only and the
   * UI keeps the full history; only the model surface shrinks.
   */
  private applyMicrocompact(
    sessionId: string,
    turn: number,
    step: number,
    provider: ProviderConfig,
    model: string,
    settings: MicrocompactSettings,
    compactionRatio: number,
  ): void {
    if (!settings.enabled) return
    const header = this.store.header(sessionId)
    const preset = header ? this.services?.presetFor?.(sessionId, header) : undefined
    if (preset && !preset.features.compaction) return
    const events = this.store.read(sessionId)?.events ?? []
    if (events.length === 0) return
    const surface = deriveSurface(events)
    if (surface.length === 0) return
    const pressure = estimatePressure(
      events,
      surface,
      contextWindowOf(provider, model),
      compactionRatio,
    )
    const decision = planMicrocompact(
      surface,
      settings,
      lastAssistantAgeMinutes(events),
      pressure?.projectedTokens,
      pressure?.thresholdTokens ?? undefined,
    )
    if (decision.kind !== 'applied') return
    this.readStateFor(sessionId).forgetCalls(decision.clearedToolCallIds)
    const originals = new Map(
      events
        .filter((event): event is Extract<Envelope, { type: 'tool-result' }> => event.type === 'tool-result')
        .map((event) => [event.seq, event]),
    )
    for (const seq of decision.clearedSeqs) {
      const item = surface.find((entry) => entry.seq === seq)
      const original = originals.get(seq)
      const callId = item?.message.toolCallId
      if (!callId || !original) continue
      this.store.append(sessionId, {
        type: 'tool-result',
        turn,
        step,
        call_id: callId,
        content: CLEARED_PLACEHOLDER,
        is_error: original.is_error,
        ...(original.error !== undefined ? { error: original.error } : {}),
        ...(original.error_identity !== undefined ? { error_identity: original.error_identity } : {}),
        ...(original.meta !== undefined ? { meta: original.meta } : {}),
        ...(original.truncation !== undefined ? { truncation: original.truncation } : {}),
        replaces: seq,
      })
    }
  }

  /**
   * Summarize older history once the projected prompt reaches the configured
   * fraction of the window. This runs before each request, but it is a gate.
   */
  private async applyAutoCompact(options: {
    sessionId: string
    selection: ModelSelection
    provider: ProviderConfig
    model: string
    ratio: number
    header: SessionHeader
    signal: AbortSignal
    attempted: boolean
  }): Promise<boolean> {
    if (options.attempted || options.signal.aborted) return true
    if ((this.compactionFailures.get(options.sessionId) ?? 0) >= MAX_COMPACTION_FAILURES) {
      return false
    }
    const preset = this.services?.presetFor?.(options.sessionId, options.header)
    if (preset && !preset.features.compaction) return false

    const events = this.store.read(options.sessionId)?.events ?? []
    if (events.length === 0) return false
    const surface = deriveSurface(events)
    if (surface.length === 0) return false
    const window = contextWindowOf(options.provider, options.model)
    const threshold = compactionThresholdTokens(window, options.ratio)
    if (threshold === null || threshold <= 0) return false
    const pressure = estimatePressure(events, surface, window, options.ratio)
    if (!pressure || pressure.projectedTokens < threshold) return false

    let anchorSeq = -1
    let compactionSeq = -1
    for (const event of events) {
      if (event.type === 'assistant-message' && event.usage) anchorSeq = event.seq
      else if (event.type === 'compaction-summary') compactionSeq = event.seq
    }
    if (compactionSeq > anchorSeq) return false

    let failure: string | null = null
    const outcome = await compactSession({
      store: this.store,
      config: this.getConfig(),
      sessionId: options.sessionId,
      selection: options.selection,
      signal: options.signal,
      onFailed: (message) => {
        failure = message
      },
    })
    if (options.signal.aborted) return true
    if (outcome === 'nothing-to-compact') return true
    if (outcome === 'failed') {
      this.compactionFailures.set(
        options.sessionId,
        (this.compactionFailures.get(options.sessionId) ?? 0) + 1,
      )
      console.warn('[denia] 自动压缩失败:', failure)
      return true
    }
    this.compactionFailures.delete(options.sessionId)
    let compactedFrom = -1
    let compactedTo = -1
    for (const event of this.store.read(options.sessionId)?.events ?? []) {
      if (event.type !== 'compaction-summary') continue
      compactedFrom = event.replaces_from
      compactedTo = event.replaces_to
    }
    if (compactedFrom >= 0) {
      this.readStateFor(options.sessionId).forgetSeqRange(compactedFrom, compactedTo)
    }
    this.cacheWarmer.cancel(options.sessionId)
    return true
  }

  /** Tool schemas visible under the current permission state. */
  private schemasFor(
    state: PermissionState,
    sessionId?: string,
    header?: SessionHeader,
  ): ToolSchema[] {
    const all = this.registry.schemas()
    const blocked = new Set<string>()
    if (state.sandbox === 'read-only') {
      blocked.add('write_file')
      blocked.add('edit')
      blocked.add('bash')
    }
    const role = header?.subagent
    const preset = sessionId && header && !role ? this.services?.presetFor?.(sessionId, header) : undefined
    const excluded = preset ? new Set(excludedPresetTools(preset.features)) : new Set<string>()
    const presetTools = preset?.tools ? new Set(preset.tools) : null
    const allowed = role ? new Set(role.effectiveTools ?? []) : null
    const filtered = all.filter((schema) => {
      if (blocked.has(schema.name) || excluded.has(schema.name)) return false
      if (presetTools && !presetTools.has(schema.name)) return false
      if (allowed && !allowed.has(schema.name)) return false
      return true
    })
    if (sessionId && header && this.services?.extraSchemas) {
      const seen = new Set(filtered.map((schema) => schema.name))
      for (const schema of this.services.extraSchemas(sessionId, header, state)) {
        if (seen.has(schema.name)) continue
        seen.add(schema.name)
        filtered.push(schema)
      }
    }
    return filtered
  }

  /**
   * Every tool pi may execute for this session, regardless of whether its
   * schema is visible. Hidden tools stay executable so the permission gate can
   * return Denia's actionable refusal instead of pi's "Tool not found".
   */
  private executableSchemas(
    sessionId: string,
    header: SessionHeader,
    state: PermissionState,
  ): ToolSchema[] {
    const all = [...this.registry.schemas()]
    if (this.services?.extraSchemas) {
      const seen = new Set(all.map((schema) => schema.name))
      for (const schema of this.services.extraSchemas(sessionId, header, state)) {
        if (seen.has(schema.name)) continue
        seen.add(schema.name)
        all.push(schema)
      }
    }
    return all
  }
}

export function isSessionBusy(events: Envelope[]): boolean {
  return hasOpenTurn(events)
}

/** First-line `/skill-name` gesture; only kebab-case names count. */
function skillGesture(prompt: string): string | null {
  const first = prompt.split('\n', 1)[0]?.trim() ?? ''
  if (!first.startsWith('/')) return null
  const name = first.slice(1)
  return isValidSkillName(name) ? name : null
}
