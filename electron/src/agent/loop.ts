// The session driver: turn/step loop over the LLM adapter and tools.
//
// Events are appended to the session log first; the HTTP layer broadcasts the
// same envelopes to followers. A turn closes when the assistant message has no
// tool calls, when the user cancels, or when an execution failure is terminal.

import type {
  AppConfig,
  ProviderConfig,
} from '../config.ts'
import { findProvider, resolveDefault } from '../config.ts'
import type {
  ContentBlock,
  Envelope,
  ImageData,
  ModelSelection,
  StreamChunk,
  ToolCallRef,
  TokenUsage,
  ToolOutput,
  TurnEndReason,
} from '../core/wire.ts'
import { errorMessage, truncateChars } from '../core/util.ts'
import { streamFor } from '../llm/index.ts'
import type { SessionStore } from '../session/store.ts'
import type { ToolRegistry } from '../tools/index.ts'
import type { ToolContext } from '../tools/types.ts'
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
}

export interface DriverSettings {
  maxSteps: number
  maxParallel: number
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
  readonly settings: DriverSettings

  constructor(
    store: SessionStore,
    registry: ToolRegistry,
    getConfig: () => AppConfig,
    settings?: Partial<DriverSettings>,
    onRunningChange?: (sessionId: string, running: boolean) => void,
  ) {
    this.store = store
    this.registry = registry
    this.getConfig = getConfig
    this.onRunningChange = onRunningChange ?? (() => {})
    this.settings = {
      maxSteps: settings?.maxSteps ?? MAX_STEPS,
      maxParallel: Math.max(1, settings?.maxParallel ?? MAX_PARALLEL),
    }
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
    let selection: ModelSelection = resolveDefault(config)
    let provider: ProviderConfig | undefined
    try {
      const resolved = this.resolveSelection(config, options.selection)
      provider = resolved.provider
      selection = resolved.selection
    } catch {
      provider = undefined
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
    append({
      type: 'user-message',
      text: prompt,
      injected: false,
      ...(options.images && options.images.length > 0 ? { images: options.images } : {}),
    })

    const signatures = new Map<string, number>()

    try {
      for (let step = 1; step <= this.settings.maxSteps; step += 1) {
        currentStep = step
        if (controller.signal.aborted) {
          closeTurn(abortedReason())
          return
        }
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
        const system = buildSystemPrompt({
          cwd: session.header.cwd,
          sandbox: session.header.sandbox,
          tools: this.registry.schemas(),
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
          tools: this.registry.schemas(),
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

        const outputs = await this.executeCalls(calls, {
          sessionId,
          cwd: session.header.cwd,
          confined: session.header.sandbox,
          cancel: controller.signal,
          emit: (event) => {
            append(event)
          },
        })

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
    }
  }

  private async executeCalls(calls: ToolCallRef[], ctx: Omit<ToolContext, 'callId'>): Promise<ToolOutput[]> {
    const outputs: ToolOutput[] = new Array(calls.length)
    const inFlight = new Set<Promise<void>>()
    let next = 0

    const launch = (index: number): void => {
      const call = calls[index]!
      const promise = (async () => {
        outputs[index] = await this.runOne(call, { ...ctx, callId: call.id })
      })()
      inFlight.add(promise)
      promise.finally(() => {
        inFlight.delete(promise)
      })
      next += 1
    }

    while (next < calls.length || inFlight.size > 0) {
      while (next < calls.length && inFlight.size < this.settings.maxParallel) {
        const call = calls[next]!
        // Unproven shell commands run alone: interleaving them with reads or
        // writes would make side effects order-dependent.
        if (call.name === 'bash' && inFlight.size > 0) break
        launch(next)
      }
      if (inFlight.size === 0 && next < calls.length) {
        launch(next)
        continue
      }
      await Promise.race(inFlight)
    }
    return outputs
  }

  private async runOne(call: ToolCallRef, ctx: ToolContext): Promise<ToolOutput> {
    if (ctx.cancel.aborted) {
      return { content: '[工具错误] 命令被用户中断', isError: true, errorIdentity: { name: call.name, code: 'cancelled' } }
    }
    const tool = this.registry.get(call.name)
    if (!tool) {
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
      const output = await tool.execute(args, ctx)
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

export type { ToolContext }