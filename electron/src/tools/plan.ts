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
    '计划模式专用:把完整执行计划呈交给用户审批。适用:改动会跨多个文件或模块;存在多个可行方案需要用户拍板;需求含糊,需先调研再设计;涉及架构或接口层面的选择。不适用:单行修复、错别字等小改动;需求明确且只有一种显然做法;纯问答或检索类请求(那属于研究,不属于计划)。仅当当前处于计划模式且调研完成后调用;提交后阻塞等待用户决策,等待期间不要继续其他操作;计划被拒绝且附带建议时,按建议修订后重新提交。',
    {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '可选的计划短标题(一句话概括要做什么)。',
        },
        plan: {
          type: 'string',
          description: '计划正文(markdown):目标、分步方案、涉及文件、风险与验证方式。',
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