// The `bash` tool: one shell command per call.
//
// Windows prefers Git Bash (`bash.exe`) when present, otherwise falls back to
// cmd.exe. macOS/Linux use `bash -c`. DENIA_SHELL overrides the executable.
// Output is streamed as `tool-output-chunk` events for the live bash card and
// returned with the same `退出码 / --- stderr ---` layout the UI parses.

import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

import type { ToolContext } from './types.ts'
import { expectString, optionalNumber, schema, textOutput, toolError } from './types.ts'

export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 600_000
/** Live output is batched so a fast command does not flood the session log. */
const STREAM_INTERVAL_MS = 60
const MAX_CAPTURE_CHARS = 500_000

interface ShellChoice {
  file: string
  args: string[]
  label: string
}

let cachedShell: ShellChoice | null | undefined

function findOnPath(name: string): string | null {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (probe.status !== 0) return null
  const line = probe.stdout.split(/\r?\n/).find((entry) => entry.trim().length > 0)
  return line ? line.trim() : null
}

export function shellChoice(): ShellChoice {
  if (cachedShell !== undefined) {
    if (cachedShell === null) {
      // Resolve lazily again after a failed probe; the environment may change.
      cachedShell = undefined
    } else {
      return cachedShell
    }
  }
  const override = process.env.DENIA_SHELL?.trim()
  if (override) {
    const file = override.includes('/') || override.includes('\\') ? override : (findOnPath(override) ?? override)
    cachedShell = { file, args: ['-c'], label: file }
    return cachedShell
  }
  if (process.platform === 'win32') {
    const bash = findOnPath('bash.exe') ?? findOnPath('bash')
    if (bash) {
      cachedShell = { file: bash, args: ['-c'], label: 'bash' }
      return cachedShell
    }
    const comspec = process.env.ComSpec?.trim() || 'cmd.exe'
    cachedShell = { file: comspec, args: ['/d', '/s', '/c'], label: 'cmd' }
    return cachedShell
  }
  const bash = findOnPath('bash') ?? (existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh')
  cachedShell = { file: bash, args: ['-c'], label: bash }
  return cachedShell
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    return
  }
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

export const BashTool = {
  schema: schema(
    'bash',
    'Run one shell command in the session workspace and return its output. Commands run through bash when available (Git Bash on Windows), otherwise cmd.exe. Prefer non-interactive commands; long-running work should be split into smaller commands.',
    {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令。' },
        timeout_ms: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_TIMEOUT_MS,
          description: '超时时间(毫秒),默认 120000,最大 600000。',
        },
      },
      required: ['command'],
    },
  ),
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const command = expectString(args, 'command')
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(1, Math.round(optionalNumber(args, 'timeout_ms') ?? DEFAULT_TIMEOUT_MS)),
    )
    const shell = shellChoice()
    const started = Date.now()

    return await new Promise<ReturnType<typeof textOutput>>((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      let ended = 'completed'
      let error: string | null = null
      const pendingStream: { stream: string; text: string }[] = []
      let flushTimer: NodeJS.Timeout | null = null
      let timer: NodeJS.Timeout | null = null

      const flushStream = () => {
        flushTimer = null
        if (pendingStream.length === 0) return
        const merged = pendingStream.splice(0)
        for (const part of merged) {
          try {
            ctx.emit({ type: 'tool-output-chunk', call_id: ctx.callId, stream: part.stream, text: part.text })
          } catch {
            /* live output is observational only */
          }
        }
      }

      const append = (stream: 'stdout' | 'stderr', text: string) => {
        if (stdout.length + stderr.length > MAX_CAPTURE_CHARS) return
        if (stream === 'stdout') stdout += text
        else stderr += text
        const last = pendingStream[pendingStream.length - 1]
        if (last && last.stream === stream) last.text += text
        else pendingStream.push({ stream, text })
        if (!flushTimer) flushTimer = setTimeout(flushStream, STREAM_INTERVAL_MS)
        flushTimer.unref?.()
      }

      const finish = (exitCode: number | null) => {
        if (settled) return
        settled = true
        if (flushTimer) {
          clearTimeout(flushTimer)
          flushTimer = null
        }
        flushStream()
        if (timer) clearTimeout(timer)
        ctx.cancel.removeEventListener('abort', onAbort)
        const durationMs = Date.now() - started
        let content = ''
        if (error) content += `[工具错误] ${error}\n`
        content += `退出码: ${exitCode ?? -1}\n${stdout}`
        if (stderr) content += `\n--- stderr ---\n${stderr}`
        const meta = {
          exit_code: exitCode,
          end_reason: ended,
          files: [],
          duration_ms: durationMs,
          evidence_complete: true,
        }
        if (error && ended !== 'completed') {
          resolve({ content, isError: true, meta, errorIdentity: { name: 'bash', code: ended } })
        } else {
          resolve(textOutput(content, meta))
        }
      }

      let child: ChildProcess
      try {
        child = spawn(shell.file, [...shell.args, command], {
          cwd: ctx.cwd,
          windowsHide: true,
          detached: process.platform !== 'win32',
          env: { ...process.env },
        })
      } catch (spawnError) {
        error = `命令没能启动:${spawnError instanceof Error ? spawnError.message : String(spawnError)}`
        ended = 'spawn_failed'
        finish(null)
        return
      }

      const onAbort = () => {
        ended = 'cancelled'
        error = '命令被用户中断'
        killTree(child)
      }
      ctx.cancel.addEventListener('abort', onAbort, { once: true })

      timer = setTimeout(() => {
        ended = 'timeout'
        error = `命令超时(${timeoutMs} ms 未结束)`
        killTree(child)
      }, timeoutMs)
      timer.unref?.()

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => append('stdout', chunk))
      child.stderr?.on('data', (chunk: string) => append('stderr', chunk))
      child.on('error', (spawnError) => {
        error = `命令没能启动:${spawnError.message}`
        ended = 'spawn_failed'
        finish(null)
      })
      child.on('close', (code) => {
        finish(code)
      })
    })
  },
}
