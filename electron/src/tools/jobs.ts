// Background-job tools: the model-facing half of the JobManager.
//
// These tools are registered through HostServices (not the static registry) so
// the manager lives with the rest of the deployment capabilities. Job ids are
// session-scoped: every call is checked against `ctx.sessionId`.

import type { JobManager } from '../jobs/manager.ts'
import type { Tool } from './types.ts'
import { expectString, optionalNumber, optionalString, schema, textOutput, toolError } from './types.ts'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Names handed to the subagent grant resolver. */
export const JOB_TOOL_NAMES = ['job_start', 'job_list', 'job_output', 'job_kill'] as const

export function createJobTools(manager: JobManager): Tool[] {
  const jobStart: Tool = {
    schema: schema(
      'job_start',
      '在会话工作目录启动后台命令，立即返回 job id。用 job_output 领取输出，job_kill 停止。',
      {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令。' },
          label: { type: 'string', description: '一句话说明这个任务做什么（缺省取命令本身）。' },
          timeout_ms: { type: 'integer', minimum: 1, description: '任务超时(毫秒)。' },
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
      '立即读取任务当前增量输出，不在前台等待。未完成返回 pending，结束后结果自动送达当前会话；不要反复轮询，可以继续独立工作或先回复用户进度并结束本轮。结束后重复读取返回完整保留结果；ready 只表示结果可读取，执行成败见 job.status 和 exitCode。',
      {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'job_start 返回的任务 id。' },
          wait: {
            type: 'boolean',
            description: '兼容旧请求；true 也立即返回当前输出，未完成时由后台完成通知回传结果。',
          },
          timeout_ms: {
            type: 'integer',
            minimum: 1,
            description: '兼容旧请求；不改变后台命令的执行超时。',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
    ),
    async execute(args, ctx) {
      const id = expectString(args, 'id')
      try {
        const result = manager.read(id, ctx.sessionId)
        const pending = result.job.finishedAt === undefined
        return textOutput(
          JSON.stringify({
            ...result,
            status: pending ? 'pending' : 'ready',
            pending,
            ...(pending
              ? {
                  notification: 'automatic',
                  next_action:
                    '后台仍在执行，完成结果会自动送达本会话。不要轮询或重复等待；可以继续独立工作，或先向用户回复当前进度并结束本轮。pending 不代表执行成功。',
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