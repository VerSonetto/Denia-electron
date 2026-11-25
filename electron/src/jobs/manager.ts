// Bounded background-command registry. Each job belongs to one session; output
// is capped from the head so the newest bytes survive a chatty process. A
// terminal job is reported exactly once: reading a settled job or killing it
// marks it reported, so the completion notice never duplicates a result the
// model already collected.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import type { PermissionState } from '../core/permission.ts'
import { bashMayWrite } from '../core/permission.ts'
import { commandEnv, killTree, shellChoice, shellInvocation } from '../tools/bash.ts'
import type { AdoptJobInput } from '../tools/types.ts'

export const DEFAULT_JOB_TIMEOUT_MS = 600_000
export const MAX_ACTIVE_JOBS = 8
export const MAX_RETAINED_JOBS = 64
export const JOB_OUTPUT_CAP = 64 * 1024

export type JobStatus = 'running' | 'stopping' | 'completed' | 'failed' | 'killed'

/** Model- and UI-facing shape; camelCase matches the Rust job snapshot. */
export interface JobSnapshot {
  id: string
  owner: string
  kind: string
  label: string
  status: JobStatus
  startedAt: number
  finishedAt?: number
  exitCode?: number
  reported: boolean
}

export interface StartJobInput {
  /** Session that owns the job; every read/kill is checked against it. */
  owner: string
  cwd: string
  /** Project directories; exposed to the child through DENIA_PROJECT_DIRS. */
  roots?: readonly string[]
  command: string
  label?: string
  /** 0 disables the timeout; omitted uses DEFAULT_JOB_TIMEOUT_MS. */
  timeoutMs?: number
  permission?: PermissionState
  /** Aborted before the spawn: the job is never created. */
  cancel?: AbortSignal
}

export interface JobManagerOptions {
  /** Called once per settled job, unless the result was already collected.
   * Returning `false` (or throwing) leaves the job unreported so a later
   * `job_output` read can still claim it. */
  onDone?(snapshot: JobSnapshot): boolean | undefined
  outputCap?: number
  maxActive?: number
  maxRetained?: number
}

interface JobRecord {
  snapshot: JobSnapshot
  output: string
  /** Model-facing read offset; advances on `read`, not on `peek`. */
  cursor: number
  child: ChildProcess | null
  timer: NodeJS.Timeout | null
  stderrSeen: boolean
  timedOut: boolean
  /** Adopted from a foreground call: its prefix was already shown to the model. */
  adopted: boolean
  /** Pending `job_output(wait)` calls; woken by new output or settlement. */
  waiters: Set<() => void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Drop the first `cut` UTF-16 units without splitting a surrogate pair.
 * Returns the new text and the adjusted read cursor.
 */
function trimHead(text: string, cut: number, cursor: number): [string, number] {
  let at = Math.max(0, Math.min(cut, text.length))
  const code = text.charCodeAt(at)
  if (at > 0 && code >= 0xdc00 && code <= 0xdfff) at += 1
  return [text.slice(at), Math.max(0, cursor - at)]
}

export class JobManager {
  private readonly records = new Map<string, JobRecord>()
  private readonly outputCap: number
  private readonly maxActive: number
  private readonly maxRetained: number
  private readonly onDone: ((snapshot: JobSnapshot) => boolean | undefined) | undefined

  constructor(options: JobManagerOptions = {}) {
    this.outputCap = options.outputCap ?? JOB_OUTPUT_CAP
    this.maxActive = options.maxActive ?? MAX_ACTIVE_JOBS
    this.maxRetained = options.maxRetained ?? MAX_RETAINED_JOBS
    this.onDone = options.onDone
  }

  start(input: StartJobInput): JobSnapshot {
    if (input.cancel?.aborted) throw new Error('启动已取消')
    const permission = input.permission
    if (
      permission &&
      (permission.collaboration === 'plan' || permission.sandbox === 'read-only') &&
      bashMayWrite(input.command)
    ) {
      throw new Error(
        permission.collaboration === 'plan'
          ? '计划模式不允许该后台命令:后台命令有写副作用,计划模式只做只读调研。'
          : '只读权限不允许该后台命令:后台命令有写副作用,只读模式只做阅读与分析。',
      )
    }
    const active = [...this.records.values()].filter(
      (record) => record.snapshot.owner === input.owner && record.snapshot.finishedAt === undefined,
    ).length
    if (active >= this.maxActive) throw new Error('当前会话的后台任务并发已达上限')
    this.makeRoom()

    const snapshot: JobSnapshot = {
      id: `bash-${randomUUID()}`,
      owner: input.owner,
      kind: 'bash',
      label: (input.label?.trim() || input.command).slice(0, 200),
      status: 'running',
      startedAt: Date.now(),
      reported: false,
    }
    const record: JobRecord = {
      snapshot,
      output: '',
      cursor: 0,
      child: null,
      timer: null,
      stderrSeen: false,
      timedOut: false,
      adopted: false,
      waiters: new Set(),
    }
    this.records.set(snapshot.id, record)

    const shell = shellChoice()
    let child: ChildProcess
    try {
      const call = shellInvocation(shell, input.command)
      child = spawn(call.file, call.args, {
        cwd: input.cwd,
        windowsHide: true,
        windowsVerbatimArguments: shell.verbatim,
        detached: process.platform !== 'win32',
        // No stdin: a background command that reads it must see EOF instead of
        // waiting forever. The environment mirrors the foreground bash tool.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: commandEnv(input.cwd, input.roots ?? [input.cwd]),
      })
    } catch (error) {
      this.finish(record, 'failed', undefined, `后台命令启动失败:${errorMessage(error)}`)
      return snapshot
    }
    record.child = child

    // 0 means "run until killed"; dev servers and other long-lived processes
    // need that, while the default keeps ordinary jobs bounded.
    const timeoutMs =
      input.timeoutMs === 0
        ? 0
        : Math.max(1, Math.round(input.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS))
    if (timeoutMs > 0) {
      record.timer = setTimeout(() => {
        record.timedOut = true
        this.push(record, '\n后台命令超时\n')
        killTree(child)
      }, timeoutMs)
      record.timer.unref?.()
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.push(record, chunk))
    child.stderr?.on('data', (chunk: string) => this.push(record, chunk, true))
    child.on('error', (error) => {
      this.finish(record, 'failed', undefined, `后台命令启动失败:${error.message}`)
    })
    child.on('close', (code) => {
      if (record.snapshot.finishedAt !== undefined) return
      if (record.timedOut) this.finish(record, 'failed', code ?? undefined)
      else if (record.snapshot.status === 'stopping') this.finish(record, 'killed', code ?? undefined)
      else this.finish(record, code === 0 ? 'completed' : 'failed', code ?? undefined)
    })
    return snapshot
  }

  /**
   * Take over a foreground child that outlived its tool call. The caller has
   * already stopped its own capture; this record starts with that output and
   * appends everything after the handoff.
   */
  adopt(input: AdoptJobInput): JobSnapshot {
    const active = [...this.records.values()].filter(
      (record) => record.snapshot.owner === input.owner && record.snapshot.finishedAt === undefined,
    ).length
    if (active >= this.maxActive) throw new Error('当前会话的后台任务并发已达上限')
    this.makeRoom()

    const snapshot: JobSnapshot = {
      id: `bash-${randomUUID()}`,
      owner: input.owner,
      kind: 'bash',
      label: (input.label?.trim() || input.command).slice(0, 200),
      status: 'running',
      startedAt: input.startedAt ?? Date.now(),
      reported: false,
    }
    const output =
      input.output.length > this.outputCap
        ? trimHead(input.output, input.output.length - this.outputCap, 0)[0]
        : input.output
    const record: JobRecord = {
      snapshot,
      output,
      // The foreground result already showed this output; a later read should
      // only return what happened after the handoff.
      cursor: output.length,
      child: input.child,
      timer: null,
      stderrSeen: input.output.includes('\n--- stderr ---\n'),
      timedOut: false,
      adopted: true,
      waiters: new Set(),
    }
    this.records.set(snapshot.id, record)

    const child = input.child
    if (child.exitCode !== null || child.signalCode !== null) {
      const code = child.exitCode ?? undefined
      this.finish(record, code === 0 ? 'completed' : 'failed', code)
      return snapshot
    }

    const timeoutMs = input.timeoutMs === undefined ? 0 : Math.max(0, Math.round(input.timeoutMs))
    if (timeoutMs > 0) {
      record.timer = setTimeout(() => {
        record.timedOut = true
        this.push(record, '\n后台命令超时\n')
        killTree(child)
      }, timeoutMs)
      record.timer.unref?.()
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.push(record, chunk))
    child.stderr?.on('data', (chunk: string) => this.push(record, chunk, true))
    child.on('error', (error) => {
      this.finish(record, 'failed', undefined, `后台命令启动失败:${error.message}`)
    })
    child.on('close', (code) => {
      if (record.snapshot.finishedAt !== undefined) return
      if (record.timedOut) this.finish(record, 'failed', code ?? undefined)
      else if (record.snapshot.status === 'stopping') this.finish(record, 'killed', code ?? undefined)
      else this.finish(record, code === 0 ? 'completed' : 'failed', code ?? undefined)
    })
    return snapshot
  }

  list(owner: string): JobSnapshot[] {
    return [...this.records.values()]
      .filter((record) => record.snapshot.owner === owner)
      .map((record) => ({ ...record.snapshot }))
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  /** Advance the model-facing cursor and return only news since the last read. */
  read(id: string, owner: string): { job: JobSnapshot; output: string } {
    const record = this.owned(id, owner)
    const terminal = record.snapshot.finishedAt !== undefined
    // An adopted job's prefix was already in the foreground bash result. Even
    // on a terminal read, return only the part the model has not seen.
    const output = terminal && !record.adopted ? record.output : record.output.slice(record.cursor)
    record.cursor = record.output.length
    if (terminal) record.snapshot.reported = true
    return { job: { ...record.snapshot }, output }
  }

  /**
   * `job_output(wait)`: block until new output arrives, the job settles, the
   * wait expires, or the turn is cancelled. A timeout still returns the normal
   * incremental read, so the caller can report `pending` with what it has.
   */
  async readOrWait(
    id: string,
    owner: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<{ job: JobSnapshot; output: string }> {
    if (waitMs <= 0) return this.read(id, owner)
    const record = this.owned(id, owner)
    if (record.snapshot.finishedAt !== undefined) return this.read(id, owner)
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | null = null
      let done = false
      const wake = () => {
        if (done) return
        done = true
        record.waiters.delete(wake)
        if (timer !== null) clearTimeout(timer)
        signal?.removeEventListener('abort', wake)
        resolve()
      }
      record.waiters.add(wake)
      timer = setTimeout(wake, Math.max(0, waitMs))
      timer.unref?.()
      if (signal?.aborted) wake()
      else signal?.addEventListener('abort', wake, { once: true })
    })
    return this.read(id, owner)
  }

  /** GUI preview: neither the model cursor nor the notice state move. */
  peek(id: string, owner: string): { job: JobSnapshot; output: string } {
    const record = this.owned(id, owner)
    return { job: { ...record.snapshot }, output: record.output }
  }

  kill(id: string, owner: string): void {
    const record = this.owned(id, owner)
    if (record.snapshot.finishedAt !== undefined) return
    record.snapshot.status = 'stopping'
    record.snapshot.reported = true
    if (record.child) killTree(record.child)
  }

  /** Kill every job owned by a session that is going away; return cancelled labels. */
  removeOwner(owner: string): string[] {
    const cancelled: string[] = []
    for (const [id, record] of [...this.records]) {
      if (record.snapshot.owner !== owner) continue
      if (record.snapshot.finishedAt === undefined) {
        cancelled.push(record.snapshot.label)
        this.kill(id, owner)
      }
      // Wake pending readers before the record disappears; their read will
      // surface the ownership error instead of hanging until the timeout.
      this.notify(record)
      this.records.delete(id)
    }
    return cancelled
  }

  private owned(id: string, owner: string): JobRecord {
    const record = this.records.get(id)
    if (!record || record.snapshot.owner !== owner) throw new Error('任务不存在或不属于当前会话')
    return record
  }

  private makeRoom(): void {
    if (this.records.size < this.maxRetained) return
    const oldest = [...this.records.values()]
      .filter((record) => record.snapshot.finishedAt !== undefined && record.snapshot.reported)
      .sort((a, b) => a.snapshot.startedAt - b.snapshot.startedAt)[0]
    if (!oldest) throw new Error('后台任务记录已满，请领取已有结果后重试')
    this.records.delete(oldest.snapshot.id)
  }

  private push(record: JobRecord, text: string, stderr = false): void {
    if (text === '') return
    if (stderr && !record.stderrSeen) {
      record.stderrSeen = true
      text = `\n--- stderr ---\n${text}`
    }
    record.output += text
    if (record.output.length > this.outputCap) {
      const [trimmed, cursor] = trimHead(
        record.output,
        record.output.length - this.outputCap,
        record.cursor,
      )
      record.output = trimmed
      record.cursor = cursor
    }
    this.notify(record)
  }

  private notify(record: JobRecord): void {
    if (record.waiters.size === 0) return
    const waiters = [...record.waiters]
    record.waiters.clear()
    for (const wake of waiters) wake()
  }

  private finish(record: JobRecord, status: JobStatus, exitCode?: number, note?: string): void {
    if (record.snapshot.finishedAt !== undefined) return
    if (record.timer) {
      clearTimeout(record.timer)
      record.timer = null
    }
    if (note) this.push(record, `\n${note}\n`)
    const label = status === 'completed' ? '完成' : status === 'killed' ? '已停止' : '失败'
    this.push(
      record,
      `\n[后台任务${label}: ${status}${exitCode === undefined ? '' : `, 退出码: ${exitCode}`}]\n`,
    )
    record.snapshot.status = status
    if (exitCode !== undefined) record.snapshot.exitCode = exitCode
    record.snapshot.finishedAt = Date.now()
    record.child = null
    this.notify(record)
    if (record.snapshot.reported) return
    record.snapshot.reported = true
    if (!this.onDone) return
    try {
      if (this.onDone(record.snapshot) === false) record.snapshot.reported = false
    } catch {
      // The notice could not be published; keep the result readable through
      // `job_output` instead of pretending it was reported.
      record.snapshot.reported = false
    }
  }
}
