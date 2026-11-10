// The session driver: turn/step loop over the LLM adapter and tools.
//
// Events are appended to the session log first; the HTTP layer broadcasts the
// same envelopes to followers. A turn closes when the assistant message has no
// tool calls, when the user cancels, or when an execution failure is terminal.

import { randomUUID } from 'node:crypto'
import path from 'node:path'

import type {
  AppConfig,
  ProviderConfig,
} from '../config.ts'
import { findProvider, resolveDefault } from '../config.ts'
import { excludedPresetTools, presetForSession } from './presets.ts'
import type { ApprovalGrants, PermissionState } from '../core/permission.ts'
import { ExecPolicy } from '../core/exec-policy.ts'
import { legacyModeOf, parsePermissionState, presetState, stateFromLegacy } from '../core/permission.ts'
import type {
  ChatMessage,
  ContentBlock,
  Envelope,
  ImageData,
  ModelSelection,
  RequestHeaderSnapshot,
  SessionEvent,
  SessionHeader,
  StreamChunk,
  ToolCallRef,
  ToolSchema,
  TokenUsage,
  ToolOutput,
  TurnEndReason,
} from '../core/wire.ts'
import { errorMessage, truncateChars } from '../core/util.ts'
import { streamFor } from '../llm/index.ts'
import type { SessionStore } from '../session/store.ts'
import type { ToolRegistry } from '../tools/index.ts'
import type { ToolContext, FileHistoryBackend } from '../tools/types.ts'
import { toolError } from '../tools/types.ts'
import { ReadStateStore } from '../tools/read-state.ts'
import { applyMediaBudget } from './media-budget.ts'
import {
  SessionOutputStore,
  budgetFor,
  renderPreview,
  withOutputArtifact,
} from './tool-output.ts'
import type { PromptExtraSection, SubagentPromptContext } from './system-prompt.ts'
import type {
  ApprovalAnswer,
  ApprovalBridge,
  ApprovalRequest,
  GateResult,
} from './gate.ts'
import {
  DECLINED_ANSWER,
  argumentText,
  availableChoices,
  gateCall,
} from './gate.ts'
import type { Reviewer, ReviewTranscriptEntry, ReviewVerdict } from './reviewer.ts'
import { deriveHistory, deriveSurface, hasOpenTurn, lastTurn } from './history.ts'
import type { SurfaceItem } from './history.ts'
import { CacheWarmer } from './cache-warm.ts'
import { compactSession } from './compact.ts'
import { loadConsoleCacheSettings } from './console-settings.ts'
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
const LOOP_THRESHOLD = 5
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
  /** Intercept a call before policy/approval (MCP lazy loading). */
  intercept?(call: ToolCallRef, sessionId: string): ToolOutput | undefined
  /** Turn queued agent-inbox events into model-visible deliveries. */
  drainInbox?(sessionId: string): void
  /** Pin file state to a user message so it can be rewound to later. */
  fileSnapshot?(sessionId: string, cwd: string, messageSeq: number): void
  /** Backup handle handed to write/edit for the current turn. */
  fileHistory?(sessionId: string, cwd: string): FileHistoryBackend
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

function abortedReason(): TurnEndReason {
  return { kind: 'aborted', cause: { kind: 'user' } }
}

/**
 * Mark each wire message with its cache provenance. Only real user turns
 * (no injection channel) count as conversational turns for the historical
 * checkpoint decimation; injected reminders and tool results do not.
 */
function withCacheProvenance(surface: readonly SurfaceItem[]): ChatMessage[] {
  return surface.map(({ message, channel }) => ({
    ...message,
    cache: { conversationalUser: message.role === 'user' && channel === null },
  }))
}

export class SessionDriver {
  private readonly store: SessionStore
  private readonly registry: ToolRegistry
  private readonly getConfig: () => AppConfig
  private readonly onRunningChange: (sessionId: string, running: boolean) => void
  private readonly running = new Map<string, AbortController>()
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
    let state = stateFromLegacy('auto-edit')
    for (const event of this.store.read(sessionId)?.events ?? []) {
      if (event.type === 'permission-selection') {
        const parsed = parsePermissionState(event)
        if (parsed) state = parsed
      } else if (event.type === 'permission-mode') {
        state = stateFromLegacy(event.mode, state)
      }
    }
    return state
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
      const events = role?.legacy
        ? (this.services?.historyFor?.(sessionId, session.events) ?? session.events)
        : session.events
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
      // The wire keeps the frozen prefix; prompt changes travel as an injected
      // update row and are counted with the baseline context.
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
    const controller = this.running.get(sessionId)
    if (!controller) return false
    controller.abort()
    // Cache warming belongs to the cancelled turn: keep it from issuing a
    // fresh provider request after the user pressed stop.
    this.cacheWarmer.cancel(sessionId)
    return true
  }

  /**
   * Start a turn without waiting for it. The returned promise resolves once
   * the turn has closed (all events appended); it never rejects.
   */
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
    const controller = new AbortController()
    this.running.set(sessionId, controller)
    this.onRunningChange(sessionId, true)

    const config = this.getConfig()
    const frozen = options.selection ?? this.services?.selectionFor?.(sessionId)
    let selection: ModelSelection = resolveDefault(config)
    let provider: ProviderConfig | undefined
    try {
      const resolved = this.resolveSelection(config, frozen, session.header.subagent ? resolveDefault(config) : undefined)
      provider = resolved.provider
      selection = resolved.selection
    } catch {
      provider = undefined
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
    // A new turn replaces the prefix; a pending replay of the old one is stale.
    this.cacheWarmer.cancel(sessionId)
    const append = (event: Parameters<SessionStore['append']>[1]) => this.store.append(sessionId, event)
    let stepOpen = false
    let turnOpen = false
    let closedReason: TurnEndReason | null = null
    let turnUsage: TokenUsage | undefined
    const addUsage = (usage: TokenUsage | undefined) => {
      if (!usage) return
      turnUsage = {
        inputTokens: (turnUsage?.inputTokens ?? 0) + usage.inputTokens,
        outputTokens: (turnUsage?.outputTokens ?? 0) + usage.outputTokens,
        cacheReadTokens: (turnUsage?.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
        reasoningTokens: (turnUsage?.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
      }
    }

    const closeOpenStep = () => {
      if (stepOpen) {
        append({ type: 'step-end', turn, step: currentStep })
        stepOpen = false
      }
    }
    const closeTurn = (reason: TurnEndReason) => {
      closeOpenStep()
      if (turnOpen) {
        append({ type: 'turn-end', turn, reason })
        turnOpen = false
        closedReason = reason
      }
      this.store.flush(sessionId)
    }

    let currentStep = 0
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
      // Explicit selections come before the question; the `/name` gesture sits
      // right after it (closest to the answer), mirroring the Rust ordering.
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
      // Pin the pre-turn file state to this message so a rewind restores the
      // exact bytes the turn started from. Snapshot failure is logged but does
      // not abort the turn (the checkpoint simply has no file history).
      if (userEnvelope && !injectedTurn) {
        try {
          this.services?.fileSnapshot?.(sessionId, session.header.cwd, userEnvelope.seq)
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

    // The user's message is the rewind point, so it must precede `turn-start`:
    // truncating at that seq keeps no half-open turn behind, mirroring the
    // Rust event order.
    append({ type: 'turn-start', turn })
    turnOpen = true

    const signatures = new Map<string, number>()
    // One summary attempt per turn: a second pass over the same turn would
    // re-summarize history the user has not refilled yet.
    let compactionAttempted = false

    try {
      if (roleError !== null) {
        if (historyError) this.services?.notifyParent?.(sessionId, historyError)
        closeTurn({
          kind: 'error',
          failure: { code: 'subagent/snapshot-invalid', message: roleError },
        })
        return
      }
      for (let step = 1; step <= this.settings.maxSteps; step += 1) {
        currentStep = step
        if (controller.signal.aborted) {
          closeTurn(abortedReason())
          return
        }
        // Deliver queued agent messages at the step boundary, never mid-action.
        this.services?.drainInbox?.(sessionId)
        this.applyInjections(sessionId, session.header)
        append({ type: 'step-start', turn, step })
        stepOpen = true

        if (!provider) {
          closeTurn({
            kind: 'error',
            failure: { code: 'llm/not-configured', message: '没有可用的模型提供商,请先配置提供商与模型。' },
          })
          return
        }

        if (!role?.legacy) {
          this.applyMicrocompact(
            sessionId,
            turn,
            step,
            provider,
            selection.model,
            cacheSettings.microcompact,
            cacheSettings.compactionRatio,
          )
        }
        if (!role?.legacy) {
          compactionAttempted = await this.applyAutoCompact({
            sessionId,
            selection,
            provider,
            model: selection.model,
            ratio: cacheSettings.compactionRatio,
            header: session.header,
            signal: controller.signal,
            attempted: compactionAttempted,
          })
        }
        if (controller.signal.aborted) {
          closeTurn(abortedReason())
          return
        }
        let events = this.store.read(sessionId)?.events ?? []
        let modelEvents = role?.legacy ? this.services?.historyFor?.(sessionId, events) ?? events : events
        let surface = deriveSurface(modelEvents)
        let messages = withCacheProvenance(surface)
        const permission = this.permissionStateOf(sessionId)
        const schemas = this.schemasFor(permission, sessionId, session.header)
        const framedCurrent = buildSystemPrompt({
          cwd: session.header.cwd,
          sandbox: session.header.sandbox,
          tools: schemas,
          permission,
          model: selection.model,
          provider: selection.provider,
          ...(this.services?.persona ? { persona: this.services.persona() } : {}),
          ...(role ? { subagent: role } : {}),
          ...(this.services?.promptSections
            ? { extraSections: this.services.promptSections(sessionId, session.header) }
            : {}),
        })
        // The transcript shows the current prompt, not the frozen wire bytes:
        // unchanged prompts are logged once, and an update that the model
        // receives is visible as its own injected row.
        let previousSystemPrompt: string | null = null
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]!
          if (event.type === 'system-prompt') {
            previousSystemPrompt = event.text
            break
          }
        }
        if (previousSystemPrompt !== framedCurrent) {
          append({ type: 'system-prompt', turn, step, text: framedCurrent })
        }
        // Rewriting the system bytes would break the provider cache from the
        // first token. Keep the frozen prefix and append the new prompt as an
        // update at the end of the cached history.
        const frozen = frozenSystem(framedCurrent, events, surface)
        const system = frozen.system
        if (frozen.update !== null) {
          append({
            type: 'user-message',
            text: frozen.update,
            injected: true,
            channel: SYSTEM_UPDATE_CHANNEL,
          })
          events = this.store.read(sessionId)?.events ?? events
          modelEvents = role?.legacy
            ? this.services?.historyFor?.(sessionId, events) ?? events
            : events
          surface = deriveSurface(modelEvents)
          messages = withCacheProvenance(surface)
        }
        // The request header is the durable baseline the frozen system is
        // restored from after a restart; log it only when the prefix shape
        // actually changes.
        const header = buildRequestHeader(selection, system, schemas)
        const previousHeader = lastRequestHeader(events)
        if (!previousHeader || !sameRequestHeader(previousHeader.header, header)) {
          append({
            type: 'request-header',
            turn,
            step,
            header,
            reason: previousHeader ? 'change' : 'initial',
            ...(previousHeader ? { starts_series: true } : {}),
          })
        }

        append({
          type: 'request-context',
          turn,
          step,
          provider: selection.provider,
          model: selection.model,
          ...(provider.defaultContextWindow ? { context_window: provider.defaultContextWindow } : {}),
        })

        const blocks: ContentBlock[] = []
        const sourceSeqs: number[] = []
        let usage: TokenUsage | undefined
        let finishKind: string | undefined
        let firstTokenTime: number | undefined

        // A request in flight refreshes the cache itself; drop any timer armed
        // by the previous step so it cannot race this one.
        const request = {
          provider,
          model: selection.model,
          // Cap the aggregate image payload before it becomes a request.
          messages: applyMediaBudget(messages).messages,
          system,
          tools: schemas,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
          cacheKey: sessionId,
          signal: controller.signal,
        }
        this.cacheWarmer.remember(sessionId, provider, request, cacheSettings.cacheWarming.mode)
        this.cacheWarmer.cancel(sessionId)
        const stream = streamFor(request)

        for await (const chunk of stream) {
          const envelope = append({ type: 'assistant-chunk', turn, step, chunk })
          if (envelope) {
            sourceSeqs.push(envelope.seq)
            if (
              firstTokenTime === undefined &&
              (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta')
            ) {
              firstTokenTime = envelope.time
            }
          }
          if (chunk.type === 'block-end') blocks.push(chunk.block)
          else if (chunk.type === 'usage') usage = chunk.usage
          else if (chunk.type === 'finish') finishKind = chunk.reason.kind
        }

        append({
          type: 'assistant-message',
          turn,
          step,
          blocks,
          ...(usage ? { usage } : {}),
          ...(sourceSeqs.length > 0 ? { source_event_seqs: sourceSeqs } : {}),
          ...(firstTokenTime !== undefined ? { first_token_time: firstTokenTime } : {}),
        })
        addUsage(usage)
        // The prefix is hot right now; keep it warm while tools run and the
        // user reads (the phase decides whether the timer is armed at all).
        this.cacheWarmer.schedule(sessionId, 'streaming', cacheSettings.cacheWarming)

        const calls: ToolCallRef[] = blocks
          .filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call')
          .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments }))

        if (calls.length === 0) {
          append({ type: 'step-end', turn, step })
          stepOpen = false
          closeTurn(finishKind === 'max-tokens' ? { kind: 'max-tokens' } : { kind: 'completed' })
          return
        }

        for (const call of calls) {
          append({
            type: 'tool-call',
            turn,
            step,
            call_id: call.id,
            name: call.name,
            arguments: call.arguments,
          })
        }

        const batch = await this.executeCalls(calls, {
          sessionId,
          cwd: session.header.cwd,
          sandbox: session.header.sandbox,
          cancel: controller.signal,
          selection,
          permission,
          memoryRoot: this.services?.memoryRoot?.(sessionId, session.header) ?? null,
          readState: this.readStateFor(sessionId),
          outputStore: this.outputStore,
          ...(this.services?.jobs ? { jobs: this.services.jobs } : {}),
          ...(this.services?.fileHistory
            ? { fileHistory: this.services.fileHistory(sessionId, session.header.cwd) }
            : {}),
          emit: (event) => {
            append(event)
          },
        }, (next) => {
          selection = next
        })

        const outputs = batch.outputs
        if (batch.aborted) {
          for (let index = 0; index < calls.length; index += 1) {
            if (outputs[index]) continue
            outputs[index] = {
              content: '[工具错误] 命令被用户中断',
              isError: true,
              errorIdentity: { name: calls[index]!.name, code: 'cancelled' },
            }
          }
        }
        for (let index = 0; index < calls.length; index += 1) {
          const call = calls[index]!
          const output = outputs[index] ?? {
            content: '[工具错误] 工具没有返回结果',
            isError: true,
          }
          const appended = append({
            type: 'tool-result',
            turn,
            step,
            call_id: call.id,
            content: output.content,
            is_error: output.isError,
            ...(output.errorIdentity ? { error_identity: output.errorIdentity } : {}),
            ...(output.meta !== undefined ? { meta: output.meta } : {}),
            ...(output.truncation ? { truncation: output.truncation } : {}),
          })
          // Remember what this read saw, so an identical repeat can answer
          // with a pointer instead of re-sending the content.
          const stamp = output.isError ? null : readStampOf(output.meta)
          if (appended && stamp) {
            this.readStateFor(sessionId).remember(stamp.key, {
              callId: call.id,
              seq: appended.seq,
              stamp: { mtimeMs: stamp.mtimeMs, size: stamp.size },
            })
          }
          // Once the file exists, the write arguments are dead weight: archive
          // the call and its result so later requests stop paying for them.
          if (
            !output.isError &&
            (call.name === 'write_file' || call.name === 'edit') &&
            call.arguments.length >= ARGS_STUB_THRESHOLD_CHARS
          ) {
            append({
              type: 'args-cleared',
              turn,
              step,
              call_id: call.id,
              placeholder: archivedCallNote(call),
            })
          }
        }

        // A user who cancels an approval interrupts the whole turn.
        if (batch.aborted) {
          closeTurn(abortedReason())
          return
        }

        append({ type: 'step-end', turn, step })
        stepOpen = false

        // Loop guard: the same tool call repeated verbatim is a stuck loop,
        // not progress. Close the turn before burning more tokens.
        for (const call of calls) {
          const signature = `${call.name}\u0000${call.arguments}`
          const repeats = (signatures.get(signature) ?? 0) + 1
          signatures.set(signature, repeats)
          if (repeats >= LOOP_THRESHOLD) {
            closeTurn({ kind: 'loop-detected', repeats })
            return
          }
        }
      }
      closeTurn({
        kind: 'error',
        failure: { code: 'agent/max-steps', message: `本轮步骤超过上限(${this.settings.maxSteps}),已停止。` },
      })
    } catch (error) {
      if (controller.signal.aborted) {
        closeTurn(abortedReason())
      } else {
        closeTurn({
          kind: 'error',
          failure: { code: 'llm/stream', message: errorMessage(error) },
        })
      }
    } finally {
      this.running.delete(sessionId)
      this.onRunningChange(sessionId, false)
      this.store.flush(sessionId)
      this.cacheWarmer.schedule(sessionId, 'idle', cacheSettings.cacheWarming)
      try {
        this.services?.onTurnEnd?.(sessionId, closedReason ?? { kind: 'aborted' }, turnUsage)
      } catch {
        /* settlement must never mask the turn result */
      }
    }
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
   *
   * The plan guards protect the provider prefix: it clears only results whose
   * rewrite suffix is still inside the warm budget, never touching ancient
   * results outside the prompt-cache lookback window.
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
    // A cleared result is gone from the model surface, so no stub may point at it.
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
   * fraction of the window. This runs before each request, but it is a gate:
   * below the threshold it returns without calling the model.
   *
   * The pressure number is a `usage` anchor from the provider plus whatever
   * the log appended since, so it only ever trusts a real measurement. A
   * summary appended after that anchor makes it stale — the next request will
   * report a fresh size — and one attempt per turn keeps a long turn from
   * re-summarizing the same window.
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

    // A summary newer than the newest usage sample means the sample predates
    // the rewrite: compacting again would act on a stale size.
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
    // The summary moved a range out of the model surface; stamps that pointed
    // into it would send the model to content it can no longer see.
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
    // The summary rewrote the model surface; a cached replay is stale.
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

  private async executeCalls(
    calls: ToolCallRef[],
    ctx: Omit<ToolContext, 'callId' | 'confined'> & { sandbox: boolean },
    onSelectionChange: (next: ModelSelection) => void,
  ): Promise<{ outputs: ToolOutput[]; aborted: boolean }> {
    const outputs: ToolOutput[] = new Array(calls.length)
    const inFlight = new Map<number, Promise<void>>()
    let next = 0
    let aborted = false
    // Resolves the moment the user stops the turn. Every pool wait races it:
    // a tool that cannot be interrupted must never keep the turn (and the UI's
    // running state) alive after stop.
    const stopSignal = new Promise<void>((resolve) => {
      if (ctx.cancel.aborted) {
        resolve()
        return
      }
      const onAbort = () => resolve()
      ctx.cancel.addEventListener('abort', onAbort, { once: true })
    })

    const confinedFor = (state: PermissionState, call: ToolCallRef): boolean =>
      state.sandbox === 'read-only' && ctx.sandbox && !memoryAnchored(call, ctx.memoryRoot, ctx.cwd)

    const launch = (index: number, state: PermissionState): void => {
      const call = calls[index]!
      const task = this.runOne(call, {
        ...ctx,
        permission: state,
        confined: confinedFor(state, call),
        callId: call.id,
      }).then((output) => {
        outputs[index] = output
      })
      inFlight.set(index, task)
      void task.finally(() => inFlight.delete(index))
    }

    while (next < calls.length || inFlight.size > 0) {
      if (ctx.cancel.aborted) {
        aborted = true
        break
      }
      let started = false
      while (next < calls.length && inFlight.size < this.settings.maxParallel) {
        const state = this.permissionStateOf(ctx.sessionId)
        if (ctx.cancel.aborted) {
          aborted = true
          break
        }
        const call = calls[next]!
        const intercepted = this.services?.intercept?.(call, ctx.sessionId)
        if (intercepted) {
          outputs[next] = intercepted
          next += 1
          started = true
          continue
        }
        const gate = gateCall(state, ctx.cwd, call, this.policy, this.grantsOf(ctx.sessionId), ctx.memoryRoot)
        if (gate.decision.kind === 'forbid') {
          outputs[next] = toolError(gate.decision.reason)
          next += 1
          started = true
          continue
        }
        if (gate.decision.kind === 'prompt' || gate.decision.kind === 'prompt-user') {
          // Interactive reviews are serial: drain the pool first.
          if (inFlight.size > 0) break
          const outcome = await Promise.race([
            this.dispatchReviewed(call, gate, state, ctx, onSelectionChange),
            stopSignal.then(() => null),
          ])
          if (outcome === null) {
            aborted = true
            next += 1
            break
          }
          outputs[next] = outcome.output
          if (outcome.abort) aborted = true
          next += 1
          started = true
          continue
        }
        // Allow: an uncertified shell command must not overlap with the pool.
        if (call.name === 'bash' && inFlight.size > 0) break
        launch(next, state)
        next += 1
        started = true
      }
      if (inFlight.size > 0) {
        await Promise.race([...inFlight.values(), stopSignal])
        if (ctx.cancel.aborted) {
          aborted = true
          break
        }
        continue
      }
      if (next >= calls.length) break
      if (!started) break
    }
    return { outputs, aborted: aborted || ctx.cancel.aborted }
  }

  /** Record the approval, resolve it (user or automatic reviewer), then act. */
  private async dispatchReviewed(
    call: ToolCallRef,
    gate: GateResult,
    state: PermissionState,
    ctx: Omit<ToolContext, 'callId' | 'confined'> & { sandbox: boolean },
    onSelectionChange: (next: ModelSelection) => void,
  ): Promise<{ output: ToolOutput; abort: boolean }> {
    const append = ctx.emit
    const requestId = randomUUID()
    const reason = 'reason' in gate.decision ? gate.decision.reason : undefined
    const isPlan = call.name === 'exit_plan'
    const request: ApprovalRequest = {
      sessionId: ctx.sessionId,
      requestId,
      callId: call.id,
      tool: call.name,
      argsPreview: call.arguments,
      ...(reason ? { reason } : {}),
      availableDecisions: availableChoices(gate.decision, gate.proposedRule),
      ...(gate.proposedRule ? { proposedRule: gate.proposedRule } : {}),
    }
    // Automatic review is not a user prompt: it must not open the approval card.
    const isAutoReview =
      gate.decision.kind === 'prompt' && state.reviewer === 'auto-review' && this.reviewer !== undefined
    if (!isAutoReview) {
      append({
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
      // A mandatory human checkpoint is never satisfied by the auto reviewer.
      answer = this.bridge ? await this.bridge.request(request, ctx.cancel) : DECLINED_ANSWER
    } else if (isAutoReview) {
      const reviewed = await this.reviewAutomatically(call, gate, ctx)
      append({
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
      answer = this.bridge ? await this.bridge.request(request, ctx.cancel) : DECLINED_ANSWER
    }

    const outcome =
      answer.choice === 'accept'
        ? 'allowed-once'
        : answer.choice === 'accept-for-session' || answer.choice === 'accept-with-rule'
          ? 'allowed-session'
          : answer.choice === 'cancel'
            ? 'cancelled'
            : 'rejected'
    if (!isAutoReview) append({ type: 'approval-decided', request_id: requestId, outcome })

    if (ctx.cancel.aborted) {
      return { output: toolError('审批已被取消(轮次被中断)。'), abort: true }
    }
    switch (answer.choice) {
      case 'accept':
        return { output: await this.runAllowed(call, gate, ctx, answer, onSelectionChange), abort: false }
      case 'accept-for-session':
        if (gate.cacheKey) this.grantsOf(ctx.sessionId).add(gate.cacheKey)
        return { output: await this.runAllowed(call, gate, ctx, answer, onSelectionChange), abort: false }
      case 'accept-with-rule':
        if (gate.proposedRule) await this.policy.appendAllow(gate.proposedRule)
        if (gate.cacheKey) this.grantsOf(ctx.sessionId).add(gate.cacheKey)
        return { output: await this.runAllowed(call, gate, ctx, answer, onSelectionChange), abort: false }
      case 'decline':
        if (isPlan) {
          const feedback = answer.plan?.feedback?.trim()
          const text = feedback
            ? `用户拒绝了该计划。请按以下补充建议修订计划后重新提交:\n${feedback}`
            : '用户拒绝了该计划。请修订计划后重新提交;不确定用户的顾虑时,先用 ask 工具询问。'
          return { output: { content: text, isError: false }, abort: false }
        }
        return { output: toolError('用户拒绝了该操作;请改用工作区内的方案,或先询问用户。'), abort: false }
      case 'cancel':
        return { output: toolError('审批已被取消(用户中断了本轮)。'), abort: true }
    }
  }

  /**
   * Run an approved call. Permissions are re-checked first: a mode tightened
   * while the approval was pending must not be bypassed by the old approval.
   */
  private async runAllowed(
    call: ToolCallRef,
    gate: GateResult,
    ctx: Omit<ToolContext, 'callId' | 'confined'> & { sandbox: boolean },
    answer: ApprovalAnswer,
    onSelectionChange: (next: ModelSelection) => void,
  ): Promise<ToolOutput> {
    const state = this.permissionStateOf(ctx.sessionId)
    if (call.name === 'exit_plan') {
      return this.applyPlanApproval(ctx.sessionId, answer, ctx.emit, onSelectionChange)
    }
    const recheck = gateCall(state, ctx.cwd, call, this.policy, this.grantsOf(ctx.sessionId), ctx.memoryRoot)
    if (recheck.decision.kind === 'forbid') {
      return toolError(`批准后重新判权被拒绝:${recheck.decision.reason}`)
    }
    return this.runOne(call, {
      ...ctx,
      permission: state,
      confined: state.sandbox === 'read-only' && ctx.sandbox && !memoryAnchored(call, ctx.memoryRoot, ctx.cwd),
      callId: call.id,
    })
  }

  /** Plan approval: leave plan mode, switch the execute preset, maybe the model. */
  private applyPlanApproval(
    sessionId: string,
    answer: ApprovalAnswer,
    append: (event: SessionEvent) => void,
    onSelectionChange: (next: ModelSelection) => void,
  ): ToolOutput {
    const executeMode = answer.plan?.executeMode === 'full' ? 'full-access' : 'workspace-write'
    const next = presetState(executeMode, 'default')
    append({
      type: 'permission-selection',
      sandbox: next.sandbox,
      approval: next.approval,
      reviewer: next.reviewer,
      collaboration: next.collaboration,
    })
    append({ type: 'permission-mode', mode: legacyModeOf(next) })
    if (answer.plan?.selection) onSelectionChange(answer.plan.selection)
    const feedback = answer.plan?.feedback?.trim()
    const suffix = feedback ? `\n用户补充建议:${feedback}` : ''
    return {
      content: `计划已批准,会话已切换至 ${executeMode} 模式,请开始执行。${suffix}`,
      isError: false,
    }
  }

  /** Route an ordinary prompt through the automatic reviewer. */
  private async reviewAutomatically(
    call: ToolCallRef,
    gate: GateResult,
    ctx: Omit<ToolContext, 'callId' | 'confined'> & { sandbox: boolean },
  ): Promise<{ answer: ApprovalAnswer; verdict: ReviewVerdict }> {
    if (!this.reviewer) {
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
    const verdict = await this.reviewer.review(
      {
        tool: call.name,
        action: gate.facts.action,
        summary,
        cwd: ctx.cwd,
        ...(gate.decision.kind === 'prompt' && gate.decision.reason ? { reason: gate.decision.reason } : {}),
        transcript: this.transcriptOf(ctx.sessionId),
      },
      ctx.cancel,
    )
    return {
      answer: verdict.outcome === 'allow' ? { choice: 'accept' } : DECLINED_ANSWER,
      verdict,
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

  private async runOne(call: ToolCallRef, ctx: ToolContext): Promise<ToolOutput> {
    if (ctx.cancel.aborted) {
      return { content: '[工具错误] 命令被用户中断', isError: true, errorIdentity: { name: call.name, code: 'cancelled' } }
    }
    const tool = this.registry.get(call.name)
    if (!tool && !this.services?.executeExtra) {
      const available = this.registry.names().join(', ')
      return {
        content: `[工具错误] 未知工具:${call.name}\n可用工具:${available}`,
        isError: true,
        errorIdentity: { name: call.name, code: 'unknown-tool' },
      }
    }
    let args: Record<string, unknown>
    try {
      const parsed = call.arguments.trim() === '' ? {} : (JSON.parse(call.arguments) as unknown)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('参数必须是 JSON 对象')
      }
      args = parsed as Record<string, unknown>
    } catch (error) {
      return {
        content: `[工具错误] 参数解析失败:${errorMessage(error)}\n原始参数:${call.arguments.slice(0, 2000)}`,
        isError: true,
        errorIdentity: { name: call.name, code: 'bad-arguments' },
      }
    }
    try {
      const output = tool
        ? await tool.execute(args, ctx)
        : await this.services!.executeExtra!(call.name, args, ctx)
      if (!output) {
        const available = this.registry.names().join(', ')
        return {
          content: `[工具错误] 未知工具:${call.name}\n可用工具:${available}`,
          isError: true,
          errorIdentity: { name: call.name, code: 'unknown-tool' },
        }
      }
      return this.commitToolOutput(ctx.sessionId, call, output)
    } catch (error) {
      if (ctx.cancel.aborted) {
        return { content: '[工具错误] 命令被用户中断', isError: true, errorIdentity: { name: call.name, code: 'cancelled' } }
      }
      return {
        content: `[工具错误] ${errorMessage(error)}`,
        isError: true,
        errorIdentity: { name: call.name, code: 'tool-panic' },
      }
    }
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

/** A write_file/edit call whose target sits inside the project memory dir. */
function memoryAnchored(
  call: ToolCallRef,
  memoryRoot: string | null | undefined,
  cwd: string,
): boolean {
  if (!memoryRoot || (call.name !== 'write_file' && call.name !== 'edit')) return false
  const raw = argumentText(call.arguments, 'path').trim()
  if (raw === '') return false
  const target = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw)
  const relative = path.relative(memoryRoot, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export type { ToolContext }