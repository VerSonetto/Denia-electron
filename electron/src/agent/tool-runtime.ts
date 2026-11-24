// Per-turn tool runtime: pi AgentTool wrappers around Denia's tools.
//
// pi validates arguments and decides when to execute. This adapter supplies
// the Denia ToolContext snapshot, enforces the bounded parallel budget, commits
// truncated output artifacts, and records every result for the session log and
// loop guard.

import path from 'node:path'

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'

import type { PermissionState } from '../core/permission.ts'
import type { ModelSelection, SessionEvent, SessionHeader, ToolCallRef, ToolOutput, ToolSchema } from '../core/wire.ts'
import { errorMessage } from '../core/util.ts'
import type { JobManager } from '../jobs/manager.ts'
import type { OutputStore } from './tool-output.ts'
import type { ReadStateStore } from '../tools/read-state.ts'
import type { ToolRegistry } from '../tools/index.ts'
import type { FileHistoryBackend, Tool, ToolContext } from '../tools/types.ts'

export interface ToolRecord {
  call: ToolCallRef
  output: ToolOutput
  notExecuted: boolean
}

/** Bounded concurrency for pi's parallel tool batch (Denia's maxParallel). */
export class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new Error('aborted')
    if (this.active < this.limit) {
      this.active += 1
      return () => this.release()
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(new Error('aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      })
    })
    this.active += 1
    return () => this.release()
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1)
    const next = this.waiters.shift()
    if (next) next()
  }
}

export interface ToolRuntimePort {
  sessionId: string
  header: SessionHeader
  registry: ToolRegistry
  /** Results settled before execution (MCP intercept, plan approval, blocks). */
  preResults: Map<string, ToolOutput>
  records: Map<string, ToolRecord>
  notExecuted: Set<string>
  permissions: Map<string, PermissionState>
  slots: Semaphore
  readState: ReadStateStore
  outputStore: OutputStore
  selection(): ModelSelection
  permissionState(): PermissionState
  roots(): string[]
  memoryRoot(): string | null
  jobs?: JobManager
  executeExtra?(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolOutput | undefined>
  fileHistory?(scope: string | readonly string[]): FileHistoryBackend
  commitOutput(call: ToolCallRef, output: ToolOutput): ToolOutput
  append(event: SessionEvent): unknown
  markApprovalBoundary(): void
  cancelRequested(): boolean
  agentSignal(): AbortSignal | undefined
}

export class TurnToolRuntime {
  private readonly port: ToolRuntimePort

  constructor(port: ToolRuntimePort) {
    this.port = port
  }

  toolsFor(schemas: readonly ToolSchema[]): AgentTool[] {
    return schemas.map((schema) => this.toolFor(schema))
  }

  private toolFor(schema: ToolSchema): AgentTool {
    return {
      name: schema.name,
      label: schema.name,
      description: schema.description,
      parameters:
        typeof schema.parameters === 'object' &&
        schema.parameters !== null &&
        !Array.isArray(schema.parameters)
          ? (schema.parameters as Record<string, unknown>)
          : { type: 'object', properties: {} },
      executionMode:
        schema.name === 'bash' || schema.name === 'job_start' ? 'sequential' : 'parallel',
      execute: async (toolCallId, params, signal) =>
        this.execute(schema, toolCallId, params, signal),
    }
  }

  private async execute(
    schema: ToolSchema,
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<any>> {
    const call: ToolCallRef = {
      id: toolCallId,
      name: schema.name,
      arguments: JSON.stringify(params ?? {}),
    }
    const pre = this.port.preResults.get(toolCallId)
    if (pre) return this.resultOf(pre)

    const tool: Tool | undefined = this.port.registry.get(schema.name)
    const ctx = this.contextFor(call, signal)
    const state = this.port.permissions.get(toolCallId) ?? this.port.permissionState()
    ctx.permission = state
    ctx.confined =
      state.sandbox === 'read-only' &&
      this.port.header.sandbox &&
      !memoryAnchored(call, ctx.memoryRoot, this.port.header.cwd)

    const abortSignal = signal ?? this.port.agentSignal() ?? new AbortController().signal
    let release: () => void
    try {
      release = await this.port.slots.acquire(abortSignal)
    } catch {
      return this.cancelled(call, toolCallId, true)
    }
    try {
      if (signal?.aborted || this.port.cancelRequested()) {
        return this.cancelled(call, toolCallId, true)
      }
      let raw: ToolOutput | undefined
      if (tool) {
        raw = await tool.execute((params ?? {}) as Record<string, unknown>, ctx)
      } else {
        raw = await this.port.executeExtra?.(
          schema.name,
          (params ?? {}) as Record<string, unknown>,
          ctx,
        )
      }
      if (!raw) throw new Error(`未知工具:${schema.name}`)
      const output = this.port.commitOutput(call, raw)
      this.port.records.set(toolCallId, { call, output, notExecuted: false })
      return this.resultOf(output)
    } catch (error) {
      if (signal?.aborted || this.port.cancelRequested()) {
        return this.cancelled(call, toolCallId, true)
      }
      const output = errorOutput(errorMessage(error), call.name)
      this.port.records.set(toolCallId, { call, output, notExecuted: false })
      return this.resultOf(output)
    } finally {
      release()
    }
  }

  private cancelled(call: ToolCallRef, toolCallId: string, notExecuted: boolean): AgentToolResult<any> {
    const output = cancelledOutput(call.name)
    this.port.records.set(toolCallId, { call, output, notExecuted })
    return this.resultOf(output)
  }

  private contextFor(call: ToolCallRef, signal?: AbortSignal): ToolContext {
    const roots = this.port.roots()
    return {
      sessionId: this.port.sessionId,
      callId: call.id,
      cwd: this.port.header.cwd,
      roots,
      confined: false,
      cancel: signal ?? this.port.agentSignal() ?? new AbortController().signal,
      selection: this.port.selection(),
      permission: this.port.permissions.get(call.id) ?? this.port.permissionState(),
      memoryRoot: this.port.memoryRoot(),
      ...(this.port.jobs ? { jobs: this.port.jobs } : {}),
      ...(this.port.fileHistory ? { fileHistory: this.port.fileHistory(roots) } : {}),
      emit: (event) => {
        if (
          event.type === 'approval-decided' ||
          event.type === 'permission-selection' ||
          event.type === 'permission-mode'
        ) {
          this.port.markApprovalBoundary()
        }
        this.port.append(event)
      },
      readState: this.port.readState,
      outputStore: this.port.outputStore,
    }
  }

  private resultOf(output: ToolOutput): AgentToolResult<any> {
    return {
      content: [{ type: 'text', text: output.content }],
      details: {
        ...(output.meta === undefined ? {} : { meta: output.meta }),
        ...(output.errorIdentity ? { errorIdentity: output.errorIdentity } : {}),
        ...(output.truncation ? { truncation: output.truncation } : {}),
      },
      isError: output.isError,
    }
  }
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

/** A write_file/edit call whose target sits inside the project memory dir. */
function memoryAnchored(
  call: ToolCallRef,
  memoryRoot: string | null | undefined,
  cwd: string,
): boolean {
  if (!memoryRoot || (call.name !== 'write_file' && call.name !== 'edit')) return false
  const raw = argumentPath(call.arguments).trim()
  if (raw === '') return false
  const target = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw)
  const relative = path.relative(memoryRoot, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function argumentPath(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { path?: unknown }
    return typeof parsed?.path === 'string' ? parsed.path : ''
  } catch {
    return ''
  }
}