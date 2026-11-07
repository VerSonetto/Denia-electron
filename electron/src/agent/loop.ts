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
import type { ApprovalGrants, PermissionState } from '../core/permission.ts'
import { ExecPolicy } from '../core/exec-policy.ts'
import { legacyModeOf, parsePermissionState, presetState, stateFromLegacy } from '../core/permission.ts'
import type {
  ContentBlock,
  Envelope,
  ImageData,
  ModelSelection,
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
import type { ToolContext } from '../tools/types.ts'
import { toolError } from '../tools/types.ts'
import type { SubagentPromptContext } from './system-prompt.ts'
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
import { deriveHistory, hasOpenTurn, lastTurn } from './history.ts'
import { buildSystemPrompt } from './system-prompt.ts'

const MAX_STEPS = 100
const MAX_PARALLEL = 10
const LOOP_THRESHOLD = 5
/** One authoritative character budget for every tool result (mirrors Rust). */
const OUTPUT_BUDGET_CHARS = 32_000

export interface StartTurnOptions {
  selection?: ModelSelection
  images?: ImageData[]
  /** Prompt origin, recorded for future trajectory tooling. */
  source?: string
  /** Resume from the inbox: do not append an empty user message. */
  continueOnly?: boolean
}

/**
 * Per-deployment services the loop consults outside the static registry:
 * subagent capability tools, MCP tools and the agent inbox.
 */
export interface SessionServices {
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
  /** A turn closed; settle subagents and wake pending inboxes. */
  onTurnEnd?(sessionId: string): void
  /** Extra system prompt sections (catalog, MCP discipline, memory). */
  promptSections?(sessionId: string, header: SessionHeader): string[]
  /** User-message injections applied at step boundaries (idempotent by channel). */
  injections?(sessionId: string, header: SessionHeader): { channel: string; text: string }[]
  /** Memory directory of this session, used by the permission gate. */
  memoryRoot?(sessionId: string, header: SessionHeader): string | null
  /** Subagent role additions, when this session is a child. */
  context?(sessionId: string): SubagentPromptContext | null
  /** Frozen selection for resumed child sessions. */
  selectionFor?(sessionId: string): ModelSelection | undefined
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

function budgetOf(content: string): [string, { total_chars: number; shown_chars: number } | null] {
  const total = Array.from(content).length
  if (total <= OUTPUT_BUDGET_CHARS) return [content, null]
  const marker = `\n\n…[输出已截断:共 ${total} 字符,仅显示前 ${OUTPUT_BUDGET_CHARS} 字符。请缩小范围(更精确的 pattern/path),或用 offset/limit 分页获取剩余内容]`
  const shownChars = OUTPUT_BUDGET_CHARS - Array.from(marker).length
  const shown = Array.from(content).slice(0, Math.max(0, shownChars)).join('')
  return [shown + marker, { total_chars: total, shown_chars: Math.max(0, shownChars) }]
}

function abortedReason(): TurnEndReason {
  return { kind: 'aborted', cause: { kind: 'user' } }
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

  /** Install host services after both runtimes exist (breaks the cycle). */
  attachServices(services: SessionServices): void {
    this.services = services
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

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  runningIds(): string[] {
    return [...this.running.keys()]
  }

  /** Idempotent cancel: keeps the token like the Rust backend does. */
  cancel(sessionId: string): boolean {
    const controller = this.running.get(sessionId)
    if (!controller) return false
    controller.abort()
    return true
  }

  /**
   * Start a turn without waiting for it. The returned promise resolves once
   * the turn has closed (all events appended); it never rejects.
   */
  startTurn(sessionId: string, prompt: string, options: StartTurnOptions = {}): Promise<void> {
    return this.runTurn(sessionId, prompt, options)
  }

  private resolveSelection(config: AppConfig, requested?: ModelSelection): { provider: ProviderConfig; selection: ModelSelection } {
    const fallback = resolveDefault(config)
    const providerId = requested?.provider || fallback.provider
    const provider = findProvider(config, providerId)
    if (!provider) {
      const first = config.providers[0]
      if (!first) throw new Error('没有配置任何模型提供商')
      return { provider: first, selection: { provider: first.id, model: first.models[0]?.id ?? 'default' } }
    }
    const model = requested?.model && provider.models.some((entry) => entry.id === requested.model)
      ? requested.model
      : provider.models[0]?.id ?? 'default'
    return {
      provider,
      selection: {
        provider: provider.id,
        model,
        ...(requested?.reasoningEffort ? { reasoningEffort: requested.reasoningEffort } : {}),
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
      const resolved = this.resolveSelection(config, frozen)
      provider = resolved.provider
      selection = resolved.selection
    } catch {
      provider = undefined
    }

    let role: SubagentPromptContext | null = null
    let roleError: string | null = null
    try {
      role = this.services?.context?.(sessionId) ?? null
    } catch (error) {
      roleError = errorMessage(error)
    }

    const turn = lastTurn(session.events) + 1
    const append = (event: Parameters<SessionStore['append']>[1]) => this.store.append(sessionId, event)
    let stepOpen = false
    let turnOpen = false

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
      }
      this.store.flush(sessionId)
    }

    let currentStep = 0
    append({ type: 'turn-start', turn })
    turnOpen = true
    if (!options.continueOnly) {
      append({
        type: 'user-message',
        text: prompt,
        injected: false,
        ...(options.images && options.images.length > 0 ? { images: options.images } : {}),
      })
    }

    const signatures = new Map<string, number>()

    try {
      if (roleError !== null) {
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

        const events = this.store.read(sessionId)?.events ?? []
        const messages = deriveHistory(events)
        const permission = this.permissionStateOf(sessionId)
        const schemas = this.schemasFor(permission, sessionId, session.header)
        const system = buildSystemPrompt({
          cwd: session.header.cwd,
          sandbox: session.header.sandbox,
          tools: schemas,
          permission,
          ...(role ? { subagent: role } : {}),
          ...(this.services?.promptSections
            ? { extraSections: this.services.promptSections(sessionId, session.header) }
            : {}),
        })
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

        const stream = streamFor({
          provider,
          model: selection.model,
          messages,
          system,
          tools: schemas,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
          signal: controller.signal,
        })

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
          emit: (event) => {
            append(event)
          },
        }, (next) => {
          selection = next
        })

        const outputs = batch.outputs
        for (let index = 0; index < calls.length; index += 1) {
          const call = calls[index]!
          const output = outputs[index] ?? {
            content: '[工具错误] 工具没有返回结果',
            isError: true,
          }
          append({
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
      try {
        this.services?.onTurnEnd?.(sessionId)
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
    const allowed = role
      ? new Set(role.effectiveTools ?? [])
      : null
    const filtered = all.filter((schema) => {
      if (blocked.has(schema.name)) return false
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
      let started = false
      while (next < calls.length && inFlight.size < this.settings.maxParallel) {
        const state = this.permissionStateOf(ctx.sessionId)
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
          const outcome = await this.dispatchReviewed(call, gate, state, ctx, onSelectionChange)
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
        await Promise.race(inFlight.values())
        continue
      }
      if (next >= calls.length) break
      if (!started) break
    }
    return { outputs, aborted }
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
      const [content, truncation] = budgetOf(output.content)
      return {
        ...output,
        content,
        ...(truncation ? { truncation } : {}),
      }
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