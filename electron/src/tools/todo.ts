// `todo_write`: the model's task list, persisted as a `todo-write` event so
// the UI can render the todo card and history replay stays faithful.

import type { TodoItem } from '../core/wire.ts'
import type { ToolContext } from './types.ts'
import { schema, textOutput, toolError } from './types.ts'

const STATUSES = new Set(['pending', 'in_progress', 'completed'])

function parseTodos(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value)) return null
  const todos: TodoItem[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null
    const record = item as Record<string, unknown>
    if (typeof record.content !== 'string' || record.content.trim().length === 0) return null
    if (typeof record.status !== 'string' || !STATUSES.has(record.status)) return null
    todos.push({ content: record.content, status: record.status as TodoItem['status'] })
  }
  return todos
}

export const TodoWriteTool = {
  schema: schema(
    'todo_write',
    '记录并更新当前工作的结构化任务清单。每次调用必须发送完整列表(没有部分更新)。用于规划多步工作并展示进度:开始前把每个具体步骤拆成一条 todo。同一时间最多一条 todo 处于 in_progress;任务完成的当下就标记 completed,全部完成才允许没有 in_progress 项。',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        todos: {
          type: 'array',
          description: '完整任务列表,整体替换之前的列表。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              content: { type: 'string', description: '任务内容——一句简短的祈使句。' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'pending(未开始)| in_progress(进行中)| completed(已完成)。',
              },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  ),
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const todos = parseTodos(args.todos)
    if (!todos) {
      return toolError(
        'todos 必须是数组,每项含 content(非空字符串)与 status(pending/in_progress/completed)',
        '修正 todos 后重发完整列表',
      )
    }
    const inProgress = todos.filter((todo) => todo.status === 'in_progress').length
    if (inProgress > 1) {
      return toolError(
        `同一时间只允许一条 in_progress(当前 ${inProgress} 条)`,
        '把正在做的那一条标为 in_progress,其余标为 pending 或 completed',
      )
    }
    ctx.emit({ type: 'todo-write', todos })
    const count = (status: TodoItem['status']) => todos.filter((todo) => todo.status === status).length
    return textOutput(
      `已更新任务列表:${count('pending')} 个待办、${count('in_progress')} 个进行中、${count('completed')} 个已完成。`,
    )
  },
}