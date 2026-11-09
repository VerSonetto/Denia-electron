// Page through a tool result that was too large for the request.
//
// The agent saves oversized output as a session artifact and shows the model a
// bounded preview plus the artifact id. This tool turns that id back into text
// one page at a time, so a large command output never has to be re-run just to
// read the middle of it.

import { toolError, textOutput, expectString, optionalNumber, schema } from './types.ts'
import type { Tool, ToolContext } from './types.ts'

const DEFAULT_PAGE_LINES = 400
const MAX_PAGE_LINES = 2_000
const PAGE_CHARS = 20_000
const MAX_LINE_CHARS = 4_000

function guardLine(line: string): string {
  return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS)}…[本行超长,已截断]`
}

export const ReadToolOutputTool: Tool = {
  schema: schema(
    'read_tool_output',
    '分页回读被截断的工具输出全文。工具结果因体积被截断时会给出 output_id,用本工具按行分页读取完整内容;不要为了看完整输出而重跑同一条命令。',
    {
      type: 'object',
      properties: {
        output_id: { type: 'string', description: '产物 id,由被截断的工具结果给出。' },
        offset: { type: 'integer', minimum: 1, default: 1, description: '1-based 起始行号,默认 1。' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_PAGE_LINES,
          default: DEFAULT_PAGE_LINES,
          description: `本页最多行数,默认 ${DEFAULT_PAGE_LINES},最大 ${MAX_PAGE_LINES}。`,
        },
      },
      required: ['output_id'],
    },
  ),
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = expectString(args, 'output_id').trim()
    if (ctx.cancel.aborted) {
      return { content: '[工具错误] 命令被用户中断', isError: true }
    }
    if (!ctx.outputStore) {
      return toolError(
        '当前会话没有产物存储',
        '该结果无法回读;如需内容请缩小范围重新执行命令',
      )
    }
    const text = ctx.outputStore.read(ctx.sessionId, id)
    if (text === null) {
      return toolError(
        `找不到产物 ${id}`,
        '产物只保留在产生它的会话里;确认 output_id 来自本会话的工具结果',
      )
    }
    const offset = Math.max(1, Math.round(optionalNumber(args, 'offset') ?? 1))
    const limit = Math.min(MAX_PAGE_LINES, Math.max(1, Math.round(optionalNumber(args, 'limit') ?? DEFAULT_PAGE_LINES)))
    const lines = text.split('\n')
    const total = lines.length
    if (total === 0 || (offset > total && total > 0)) {
      return toolError(
        `offset=${offset} 超出范围(产物共 ${total} 行)`,
        `用 offset=1..${total} 之间的值`,
      )
    }

    const page: string[] = []
    let chars = 0
    let index = offset - 1
    for (; index < total && page.length < limit; index += 1) {
      const line = guardLine(lines[index] ?? '')
      if (page.length > 0 && chars + line.length > PAGE_CHARS) break
      page.push(line)
      chars += line.length + 1
    }
    const firstLine = offset
    const lastLine = firstLine + page.length - 1
    let content = `产物 ${id} 第 ${firstLine}-${lastLine} 行（共 ${total} 行）:\n${page.join('\n')}`
    const remaining = total - lastLine
    if (remaining > 0) {
      content += `\n\n(还有 ${remaining} 行;用 offset=${lastLine + 1} 继续读取)`
    }
    return textOutput(content)
  },
}