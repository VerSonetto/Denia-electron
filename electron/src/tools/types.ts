// Tool protocol shared by every model-facing tool.

import path from 'node:path'

import type { ModelSelection, SessionEvent, ToolOutput, ToolSchema } from '../core/wire.ts'
import type { PermissionState } from '../core/permission.ts'
import type { ReadStateStore } from './read-state.ts'
import type { OutputStore } from '../agent/tool-output.ts'

/** The slice of the job manager the `bash` tool needs for background runs. */
export interface BackgroundJobs {
  start(input: {
    owner: string
    cwd: string
    command: string
    label?: string
    timeoutMs?: number
    permission?: PermissionState
    cancel?: AbortSignal
  }): unknown
}

/** Backups taken by the host right before a write tool overwrites a file. */
export interface FileHistoryBackend {
  /** Throws when the original file could not be backed up; the write must not proceed. */
  trackBeforeWrite(file: string): void
}

export interface ToolContext {
  sessionId: string
  /** The model call this execution belongs to (used by live output events). */
  callId: string
  /** Session workspace; relative paths anchor here. */
  cwd: string
  /** Confine file access to `cwd` (mirrors the Rust `confined` flag). */
  confined: boolean
  cancel: AbortSignal
  /** Model selection of the current turn (subagent dispatch inherits it). */
  selection?: ModelSelection
  /** Permission state the call was judged under. */
  permission?: PermissionState
  /** Project memory directory (writes here are harness behavior). */
  memoryRoot?: string | null
  /** Background-job manager, when the deployment has one. */
  jobs?: BackgroundJobs
  /** File-history backend: back up the original bytes before a write tool runs. */
  fileHistory?: FileHistoryBackend
  /** Log-only event sink (todo snapshots, live bash output). */
  emit(event: SessionEvent): void
  /** Session-wide read de-duplication state (absent in tests without a driver). */
  readState?: ReadStateStore
  /** Artifacts of oversized tool output, pageable with `read_tool_output`. */
  outputStore?: OutputStore
}

export interface Tool {
  schema: ToolSchema
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>
}

export class ToolArgumentError extends Error {}

export function toolError(message: string, hint?: string): ToolOutput {
  return {
    content: `[工具错误] ${message}${hint ? `\n建议:${hint}` : ''}`,
    isError: true,
    errorIdentity: { name: 'tool-error', code: 'tool-error' },
  }
}

export function textOutput(text: string, meta?: unknown): ToolOutput {
  return { content: text, isError: false, ...(meta === undefined ? {} : { meta }) }
}

/** Resolve a model-provided path and enforce the sandbox boundary. */
export function resolvePath(cwd: string, raw: string, confined: boolean): string {
  if (!raw || raw.trim().length === 0) {
    throw new ToolArgumentError('path 不能为空')
  }
  const resolved = path.resolve(cwd, raw)
  if (!confined) return resolved
  const relative = path.relative(cwd, resolved)
  if (relative === '') return resolved
  const escapes =
    relative.startsWith('..' + path.sep) ||
    relative === '..' ||
    path.isAbsolute(relative) ||
    (process.platform === 'win32' && relative.startsWith('../'))
  if (escapes) {
    throw new ToolArgumentError('沙箱开启时路径必须落在会话工作区内')
  }
  return resolved
}

export function expectString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string') throw new ToolArgumentError(`${key} 必须是字符串`)
  return value
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  return typeof value === 'boolean' ? value : undefined
}

/** Pretty-print a JSON schema object for the model. */
export function schema(name: string, description: string, parameters: unknown): ToolSchema {
  return { name, description, parameters }
}