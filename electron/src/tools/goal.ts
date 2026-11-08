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
    'Read the current session goal and its status (objective, token budget, usage, iteration, verification history). Use it when you need to confirm what the runtime is tracking before continuing work.',
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
