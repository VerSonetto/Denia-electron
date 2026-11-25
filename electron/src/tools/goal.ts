// `goal_read`: read-only access to the session goal.
//
// The model never writes the goal. It can inspect the objective, status,
// budget and iteration so it knows what the runtime is tracking.

import type { GoalRuntime } from '../goal/runtime.ts'
import type { Tool, ToolContext } from './types.ts'
import { schema, textOutput } from './types.ts'

export class GoalReadTool implements Tool {
  readonly schema = schema(
    'goal_read',
    '读取当前会话目标与状态(目标、预算、用量、轮次、校验历史)。',
    {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  )

  private readonly runtime: GoalRuntime

  constructor(runtime: GoalRuntime) {
    this.runtime = runtime
  }

  async execute(_args: Record<string, unknown>, ctx: ToolContext) {
    const goal = this.runtime.read(ctx.sessionId)
    return textOutput(JSON.stringify({ goal }, null, 2))
  }
}
