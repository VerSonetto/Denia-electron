// The `exit_plan` tool: the plan-mode submission entry point.
//
// The approval flow itself is orchestrated by the dispatcher (classify →
// approval bridge → decision event). This tool only owns the model-facing
// schema, the argument validation, and the no-bridge fallback.

import type { Tool } from './types.ts'
import { schema, ToolArgumentError, toolError } from './types.ts'

export interface ExitPlanArgs {
  plan: string
  title?: string
}

/** Parse and validate plan arguments; empty plans never reach the user. */
export function parseExitPlanArgs(raw: string): ExitPlanArgs {
  let parsed: unknown
  try {
    parsed = raw.trim() === '' ? {} : JSON.parse(raw)
  } catch {
    throw new ToolArgumentError('plan 必须是非空的计划正文(markdown)')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ToolArgumentError('plan 必须是非空的计划正文(markdown)')
  }
  const record = parsed as Record<string, unknown>
  const plan = typeof record.plan === 'string' ? record.plan.trim() : ''
  if (plan === '') throw new ToolArgumentError('plan 必须是非空的计划正文(markdown)')
  const title = typeof record.title === 'string' ? record.title : undefined
  return { plan, ...(title === undefined ? {} : { title }) }
}

export const ExitPlanTool: Tool = {
  schema: schema(
    'exit_plan',
    '计划模式专用:把完整执行计划交用户审批。适用于跨多文件、多方案待定、需求含糊、架构级选择;小改动与纯问答不要用。提交后阻塞等待,期间不调其他工具;被拒且附建议时按建议修订后重提。',
    {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '一句话短标题。',
        },
        plan: {
          type: 'string',
          description: 'markdown:目标、分步方案、涉及文件、风险、验证方式。',
        },
      },
      required: ['plan'],
    },
  ),

  // Execution fallback: the normal path synthesises the result after the
  // approval decision, so reaching this means no approval orchestration was
  // wired up (bare registry without the dispatcher).
  async execute(args) {
    const plan = typeof args.plan === 'string' ? args.plan.trim() : ''
    if (plan === '') {
      return toolError('参数解析失败:plan 必须是非空的计划正文(markdown)', 'plan 必填,为非空的 markdown 计划正文;title 可选')
    }
    return toolError(
      '计划审批需要宿主审批通道;当前部署未接入 exit_plan 的审批编排,本次调用未生效。',
    )
  },
}