// Model-facing MCP tools: one thin wrapper per server tool, plus `mcp_list`.
//
// Hard rules:
// - results are paginated by character; continuing a result requires the
//   `result_id` token so an external tool with side effects is never re-run by
//   accident;
// - the server's own schema and parameters are forwarded untouched; denia's
//   pagination fields fall back to `denia_*` when the server owns those names;
// - failures are actionable text results, not thrown exceptions.

import type { ToolSchema } from '../core/wire.ts'
import type { PageFields } from './mcp-page.ts'
import { decorateDescription, decorateSchema, pageArguments } from './mcp-page.ts'
import type { McpManager } from '../mcp/manager.ts'
import { PagedFailure, renderToolCatalog } from '../mcp/manager.ts'
import type { Tool, ToolContext } from './types.ts'
import { toolError } from './types.ts'

export class McpTool implements Tool {
  readonly schema: ToolSchema
  private readonly manager: McpManager
  private readonly fields: PageFields

  constructor(qualified: string, description: string, inputSchema: unknown, manager: McpManager) {
    const decorated = decorateSchema(inputSchema)
    this.schema = {
      name: qualified,
      description: decorateDescription(description),
      parameters: decorated.schema,
    }
    this.fields = decorated.fields
    this.manager = manager
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<{
    content: string
    isError: boolean
  }> {
    const page = pageArguments(args, this.fields)
    if (page.error) {
      return toolError(
        page.error,
        `${this.fields.offset} / ${this.fields.limit} 是 denia 的分页字段,请传整数;${this.fields.resultId} 是结果身份令牌(字符串)`,
      )
    }
    const forwarded = { ...args }
    delete forwarded[this.fields.offset]
    delete forwarded[this.fields.limit]
    delete forwarded[this.fields.resultId]
    try {
      const result = await this.manager.callPaged({
        qualified: this.schema.name,
        arguments: forwarded,
        offset: page.offset,
        limit: page.limit,
        ...(page.resultId ? { resultId: page.resultId } : {}),
        legacyResume: page.offsetExplicit && page.offset > 0 && !this.fields.nativeOffset,
        session: ctx.sessionId,
        signal: ctx.cancel,
      })
      const text = renderPaged(
        result.text,
        result.totalChars,
        result.offset,
        result.shownChars,
        result.hasMore,
        result.uncached,
        result.resultId,
        this.fields,
      )
      return { content: text, isError: result.isError }
    } catch (error) {
      if (ctx.cancel.aborted) {
        return { content: '[工具错误] 命令被用户中断', isError: true }
      }
      if (error instanceof PagedFailure) {
        return pagedErrorOutput(error)
      }
      return toolError(
        error instanceof Error ? error.message : String(error),
        '这是 MCP 外部服务器的调用失败;可到设置 → MCP 检查该服务器状态,或换用其它工具完成任务',
      )
    }
  }
}

export class McpListTool implements Tool {
  readonly schema: ToolSchema = {
    name: 'mcp_list',
    description:
      '列出已接入的 MCP 外部工具清单(名称与用途)。需要 denia 内置能力之外的外部能力时,先用本工具查看有哪些 MCP 工具可用,再按清单里的名称直接调用。',
    parameters: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          description: '只列出这个服务器的工具;省略则列出全部已连接服务器的工具。',
        },
      },
    },
  }
  private readonly manager: McpManager
  private readonly grants?: (sessionId: string) => string[] | null

  constructor(manager: McpManager, grants?: (sessionId: string) => string[] | null) {
    this.manager = manager
    this.grants = grants
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<{
    content: string
    isError: boolean
  }> {
    const only = typeof args.server === 'string' && args.server.trim() !== '' ? args.server.trim() : undefined
    const granted = this.grants ? this.grants(ctx.sessionId) : null
    return {
      content: renderToolCatalog(this.manager.snapshot().servers, only, granted),
      isError: false,
    }
  }
}

function renderPaged(
  text: string,
  totalChars: number,
  offset: number,
  shownChars: number,
  hasMore: boolean,
  uncached: boolean,
  resultId: string | null,
  fields: PageFields,
): string {
  let content = text
  if (totalChars > shownChars) {
    const end = offset + shownChars
    let hint = ''
    if (resultId) {
      hint = hasMore
        ? `;还有后续内容,带上 ${fields.resultId}=${resultId} 和 ${fields.offset}=${end} 再调一次本工具(读同一次结果,不会重新执行)`
        : `;这是最后一页(结果身份 ${fields.resultId}=${resultId})`
    }
    content += `\n\n[第 ${offset}-${end} 字符 / 共 ${totalChars} 字符${hint}]`
  }
  if (uncached) {
    content += '\n\n(结果超过 1MB,未缓存翻页;请缩小查询范围,例如收窄关键词或分页参数)'
  }
  return content
}

function pagedErrorOutput(error: PagedFailure): { content: string; isError: boolean } {
  switch (error.kind) {
    case 'unknown-result':
      return toolError(
        error.message,
        '去掉 result_id 与 offset 重新调用本工具会真实重新执行一次(外部工具可能有副作用);也可以缩小查询范围,一次读完',
      )
    case 'foreign-session':
      return toolError(error.message, 'result_id 只在产生它的那次会话里有效;请在本会话里重新调用工具获取新结果')
    case 'lost-result':
      return toolError(
        error.message,
        '续读要带上上次输出尾部的 result_id;若没有,请去掉 offset 重新调用本工具(会真实执行一次),或在参数里限定更小的范围一次读完',
      )
    default:
      return toolError(
        error.message,
        '这是 MCP 外部服务器的调用失败;可到设置 → MCP 检查该服务器状态,或换用其它工具完成任务',
      )
  }
}