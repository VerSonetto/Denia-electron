// Background-job tools: the model-facing half of the JobManager.
//
// These tools are registered through HostServices (not the static registry) so
// the manager lives with the rest of the deployment capabilities. Job ids are
// session-scoped: every call is checked against `ctx.sessionId`.

import type { JobManager } from '../jobs/manager.ts'
import type { Tool } from './types.ts'
import {
  expectString,
  optionalBoolean,
  optionalNumber,
  optionalString,
  schema,
  textOutput,
  toolError,
} from './types.ts'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Names handed to the subagent grant resolver. */
export const JOB_TOOL_NAMES = ['job_start', 'job_list', 'job_output', 'job_kill'] as const

/** Keep one job_output JSON envelope below the generic 30k tool budget. */
const JOB_OUTPUT_READ_LIMIT = 12_000

function previewJobOutput(output: string, artifactId: string | null): string {
  const head = 3_000
  const tail = JOB_OUTPUT_READ_LIMIT - head
  const body = `${output.slice(0, head)}\n…[中间部分省略]…\n${output.slice(-tail)}`
  const notice =
    artifactId === null
      ? `\n\n…[输出共 ${output.length} 字符,仅显示 ${JOB_OUTPUT_READ_LIMIT} 字符]`
      : `\n\n…[输出共 ${output.length} 字符,仅显示 ${JOB_OUTPUT_READ_LIMIT} 字符;完整内容保存为产物 ${artifactId},用 read_tool_output(output_id="${artifactId}", offset=1) 分页回读]`
  return `${body}${notice}`
}

export function createJobTools(manager: JobManager): Tool[] {
  const jobStart: Tool = {
    schema: schema(
      'job_start',
      '在会话工作目录启动后台命令,立即返回 job id。用 job_output 取输出,job_kill 停止。timeout_ms: 0 表示不超时,适合 dev server 等长驻进程。',
      {
        type: 'object',
        properties: {
          command: { type: 'string' },
          label: { type: 'string', description: '一句话说明;缺省取命令本身。' },
          timeout_ms: {
            type: 'integer',
            minimum: 0,
            description: '默认 600000;0 表示不超时。',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    ),
    async execute(args, ctx) {
      const command = expectString(args, 'command')
      const label = optionalString(args, 'label')
      const timeout = optionalNumber(args, 'timeout_ms')
      try {
        const job = manager.start({
          owner: ctx.sessionId,
          cwd: ctx.cwd,
          roots: ctx.roots,
          command,
          ...(label !== undefined ? { label } : {}),
          ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
          ...(ctx.permission ? { permission: ctx.permission } : {}),
          cancel: ctx.cancel,
        })
        return textOutput(JSON.stringify(job))
      } catch (error) {
        return toolError(errorMessage(error))
      }
    },
  }

  const jobList: Tool = {
    schema: schema('job_list', '列出当前会话拥有的后台任务。', {
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
    async execute(_args, ctx) {
      return textOutput(JSON.stringify(manager.list(ctx.sessionId)))
    },
  }

  const jobOutput: Tool = {
    schema: schema(
      'job_output',
      '读取任务当前增量输出。默认立即返回;wait_ms>0 时最多等待该时长,有新输出或任务结束会立即返回(上限 30000)。不要反复轮询;完成结果会自动送达。ready 只表示可读取,成败看 status 与 exitCode。',
      {
        type: 'object',
        properties: {
          id: { type: 'string' },
          wait_ms: {
            type: 'integer',
            minimum: 0,
            maximum: 30_000,
            description: '最多等待多少毫秒;缺省 0(立即返回)。',
          },
          wait: { type: 'boolean', description: '兼容旧请求;true 时用 timeout_ms 作为等待上限。' },
          timeout_ms: { type: 'integer', minimum: 0, description: '旧字段;配合 wait:true 使用。' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    ),
    async execute(args, ctx) {
      const id = expectString(args, 'id')
      const waitMs = Math.max(
        0,
        Math.min(
          30_000,
          Math.round(
            optionalNumber(args, 'wait_ms') ??
              (optionalBoolean(args, 'wait') === true
                ? (optionalNumber(args, 'timeout_ms') ?? 0)
                : 0),
          ),
        ),
      )
      try {
        const result = await manager.readOrWait(id, ctx.sessionId, waitMs, ctx.cancel)
        const pending = result.job.finishedAt === undefined
        const original = result.output
        let output = original
        let outputArtifact: { output_id: string; chars: number } | undefined
        let outputTruncated = false
        if (original.length > JOB_OUTPUT_READ_LIMIT) {
          outputTruncated = true
          const saved = ctx.outputStore?.save(ctx.sessionId, ctx.callId, original) ?? null
          if (saved !== null) outputArtifact = { output_id: saved, chars: original.length }
          output = previewJobOutput(original, saved)
        }
        return textOutput(
          JSON.stringify({
            ...result,
            output,
            ...(outputTruncated ? { output_truncated: true, output_chars: original.length } : {}),
            ...(outputArtifact ? { outputArtifact } : {}),
            status: pending ? 'pending' : 'ready',
            pending,
            ...(pending
              ? {
                  notification: 'automatic',
                  next_action:
                    waitMs === 0
                      ? '后台仍在执行,完成结果会自动送达本会话。不要轮询或重复等待;可以继续独立工作,或先向用户回复当前进度并结束本轮。pending 不代表执行成功。'
                      : original !== ''
                        ? '已取得增量输出,后台仍在执行;完成结果会自动送达本会话。可以继续独立工作,不必连续轮询。pending 不代表执行成功。'
                        : '等待期间没有新输出,后台仍在执行;可以先用 wait_ms 再等一次,或处理其他工作,完成结果会自动送达。pending 不代表执行成功。',
                }
              : {}),
          }),
        )
      } catch (error) {
        return toolError(errorMessage(error))
      }
    },
  }

  const jobKill: Tool = {
    schema: schema('job_kill', '请求停止当前会话的后台任务。重复停止是幂等操作。', {
      type: 'object',
      properties: { id: { type: 'string', description: 'job_start 返回的任务 id。' } },
      required: ['id'],
      additionalProperties: false,
    }),
    async execute(args, ctx) {
      const id = expectString(args, 'id')
      try {
        manager.kill(id, ctx.sessionId)
        return textOutput(JSON.stringify({ ok: true }))
      } catch (error) {
        return toolError(errorMessage(error))
      }
    },
  }

  return [jobStart, jobList, jobOutput, jobKill]
}