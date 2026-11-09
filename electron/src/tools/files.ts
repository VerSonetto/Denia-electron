// File tools: read_file, write_file, edit.
//
// Path resolution and the sandbox boundary live in `resolvePath`; tools never
// touch a path the model supplied without going through it.

import fs from 'node:fs'
import path from 'node:path'

import type { ToolContext } from './types.ts'
import type { ToolOutput } from '../core/wire.ts'
import { readViewKey } from './read-state.ts'
import {
  expectString,
  optionalBoolean,
  optionalNumber,
  resolvePath,
  schema,
  textOutput,
  toolError,
} from './types.ts'

const DEFAULT_READ_LIMIT = 400
const MAX_LINE_CHARS = 4000

function cancelled(tool: string) {
  return {
    content: '[工具错误] 命令被用户中断',
    isError: true,
    errorIdentity: { name: tool, code: 'cancelled' },
  }
}

function guardLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line
  return line.slice(0, MAX_LINE_CHARS) + '…[本行超长,已截断]'
}

/**
 * Back up the file before a write tool changes it. A failed backup aborts the
 * write: proceeding would leave the rewind history unable to restore the file.
 */
function backupBeforeWrite(file: string, ctx: ToolContext): ToolOutput | null {
  if (!ctx.fileHistory) return null
  try {
    ctx.fileHistory.trackBeforeWrite(file)
    return null
  } catch (error) {
    return toolError(
      `文件历史备份失败:${error instanceof Error ? error.message : String(error)}`,
      '备份失败时不会写入;可重试一次,持续失败请报告',
    )
  }
}

export const ReadFileTool = {
  schema: schema(
    'read_file',
    '读取会话工作区中的一个 UTF-8 文本文件。相对路径锚定会话工作区;大文件用 offset/limit 分页读取。',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径;相对路径锚定会话工作区。' },
        offset: { type: 'integer', minimum: 1, default: 1, description: '1-based 起始行号,默认 1。' },
        limit: { type: 'integer', minimum: 1, default: DEFAULT_READ_LIMIT, description: '本次最多读取的行数,默认 400。' },
      },
      required: ['path'],
    },
  ),
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const raw = expectString(args, 'path')
    if (ctx.cancel.aborted) return cancelled('read_file')
    const offset = Math.max(1, Math.round(optionalNumber(args, 'offset') ?? 1))
    const limit = Math.max(1, Math.round(optionalNumber(args, 'limit') ?? DEFAULT_READ_LIMIT))
    let file: string
    try {
      file = resolvePath(ctx.cwd, raw, ctx.confined)
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error), '相对路径锚定会话工作区')
    }
    // A repeat read of an unchanged view is a wasted call: the earlier result is
    // still on the model surface, so only a pointer to it is worth the tokens.
    let stamp: { mtimeMs: number; size: number } | null = null
    try {
      const stat = await fs.promises.stat(file)
      stamp = { mtimeMs: stat.mtimeMs, size: stat.size }
    } catch {
      // No stat → no de-dup; the read below reports the real failure.
    }
    const viewKey = readViewKey(file, offset, limit)
    if (stamp !== null && ctx.readState?.isUnchanged(viewKey, stamp) === true) {
      return textOutput(
        `${raw} 第 ${offset} 行起（limit=${limit}）自上次读取以来未变更,内容同上一条读取结果,无需重复读取。若确实需要重看,请先改 offset/limit,或改动文件后重试。`,
      )
    }
    let text: string
    try {
      text = await fs.promises.readFile(file, 'utf8')
    } catch (error) {
      return toolError(
        `读取 ${raw} 失败:${error instanceof Error ? error.message : String(error)}`,
        '确认文件存在、是文本文件,且当前权限允许读取',
      )
    }
    const allLines = text.split('\n')
    const startIndex = offset - 1
    const slice = allLines.slice(startIndex, startIndex + limit).map(guardLine)
    const count = slice.length
    const end = count === 0 ? offset : offset + count - 1
    let content = `${raw} 第 ${offset}-${end} 行（${count} 行）:\n${slice.join('\n')}`
    if (count < limit) {
      content += ''
    } else {
      content += `\n\n(已达 limit=${limit};文件可能还有更多行,用 offset=${end + 1} 继续读取)`
    }
    return textOutput(
      content,
      stamp === null ? undefined : { readStamp: { key: viewKey, ...stamp } },
    )
  },
}

export const WriteFileTool = {
  schema: schema(
    'write_file',
    '在会话工作区写入一个 UTF-8 文本文件:自动创建父目录,已存在的文件会被整体覆盖。新建文件或全量重写用本工具;对现有文件做局部修改请优先用 edit。',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件路径;相对路径锚定会话工作区。' },
        content: { type: 'string', description: '完整文件内容(整体覆盖写入)。' },
      },
      required: ['path', 'content'],
    },
  ),
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const raw = expectString(args, 'path')
    if (ctx.cancel.aborted) return cancelled('write_file')
    const content = expectString(args, 'content')
    let file: string
    try {
      file = resolvePath(ctx.cwd, raw, ctx.confined)
    } catch (error) {
      return toolError(
        error instanceof Error ? error.message : String(error),
        '相对路径锚定会话工作区;沙箱开启时不能写工作区之外的路径',
      )
    }
    const backupError = backupBeforeWrite(file, ctx)
    if (backupError) return backupError
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content, 'utf8')
    } catch (error) {
      return toolError(`写入 ${raw} 失败:${error instanceof Error ? error.message : String(error)}`)
    }
    // The bytes changed: every cached view of this path is stale.
    ctx.readState?.forgetPath(file)
    return textOutput(`已写入 ${raw}（${Buffer.byteLength(content, 'utf8')} 字节）。`)
  },
}

interface EditSpec {
  old_string: string
  new_string: string
  replace_all?: boolean
}

function parseEditSpecs(args: Record<string, unknown>): EditSpec[] {
  const edits = args.edits
  if (Array.isArray(edits) && edits.length > 0) {
    return edits.map((item) => {
      if (typeof item !== 'object' || item === null) throw new Error('edits 的每一项必须是对象')
      const record = item as Record<string, unknown>
      if (typeof record.old_string !== 'string' || typeof record.new_string !== 'string') {
        throw new Error('edits 的每一项都必须包含 old_string 与 new_string 字符串')
      }
      return {
        old_string: record.old_string,
        new_string: record.new_string,
        replace_all: record.replace_all === true,
      }
    })
  }
  const oldString = args.old_string
  const newString = args.new_string
  if (typeof oldString !== 'string' || typeof newString !== 'string') {
    throw new Error('单处编辑需要 old_string 与 new_string;多处编辑用 edits 数组')
  }
  return [{ old_string: oldString, new_string: newString, replace_all: args.replace_all === true }]
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

function lineOfIndex(text: string, index: number): number {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

export const EditTool = {
  schema: schema(
    'edit',
    '对工作区内的一个 UTF-8 文本文件做精确字符串替换。推荐两种参数形式之一:只改一处时给 old_string + new_string,可选 replace_all;同一文件改多处时只给 edits 数组。old_string 必须与文件原文完全一致(空白与换行都算),默认只能出现一次。多处编辑按数组顺序应用,任一项失败则整次不写入。',
    {
      type: 'object',
      required: ['path'],
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '要编辑的文件路径;相对路径锚定会话工作区。' },
        old_string: { type: 'string', minLength: 1, description: '要被替换的原文,必须与文件内容逐字符一致。' },
        new_string: { type: 'string', description: '替换成的新文本;删除内容时给空串。' },
        replace_all: { type: 'boolean', description: 'true 时替换 old_string 的全部出现,默认只允许恰好出现一次。' },
        edits: {
          type: 'array',
          minItems: 1,
          description: '多处编辑:按顺序原子应用同一文件的多个替换。',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', minLength: 1, description: '要被替换的原文。' },
              new_string: { type: 'string', description: '替换成的新文本。' },
              replace_all: { type: 'boolean', description: '可选;true 时替换全部出现。' },
            },
            required: ['old_string', 'new_string'],
            additionalProperties: false,
          },
        },
      },
    },
  ),
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const raw = expectString(args, 'path')
    if (ctx.cancel.aborted) return cancelled('edit')
    let specs: EditSpec[]
    try {
      specs = parseEditSpecs(args)
    } catch (error) {
      return toolError(
        error instanceof Error ? error.message : String(error),
        '单处编辑:{"path":"...","old_string":"...","new_string":"..."};多处编辑:{"path":"...","edits":[...]}',
      )
    }
    if (specs.length === 0) return toolError('至少需要一个编辑项')
    let file: string
    try {
      file = resolvePath(ctx.cwd, raw, ctx.confined)
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error))
    }
    let text: string
    try {
      text = await fs.promises.readFile(file, 'utf8')
    } catch (error) {
      return toolError(`读取 ${raw} 失败:${error instanceof Error ? error.message : String(error)}`)
    }

    let working = text
    let firstLine: number | null = null
    for (const spec of specs) {
      if (spec.old_string.length === 0) return toolError('old_string 不能为空')
      const occurrences = countOccurrences(working, spec.old_string)
      if (occurrences === 0) {
        return toolError(
          `在 ${raw} 中找不到 old_string 的精确匹配`,
          '先用 read_file 确认原文(空白与换行都要一致),或缩小 old_string 的范围',
        )
      }
      if (occurrences > 1 && spec.replace_all !== true) {
        return toolError(
          `old_string 在 ${raw} 中出现了 ${occurrences} 次`,
          '补充上下文使匹配唯一,或设置 replace_all=true 替换全部',
        )
      }
      const index = working.indexOf(spec.old_string)
      if (firstLine === null && index >= 0) firstLine = lineOfIndex(working, index)
      working =
        spec.replace_all === true
          ? working.split(spec.old_string).join(spec.new_string)
          : working.slice(0, index) + spec.new_string + working.slice(index + spec.old_string.length)
    }
    const backupError = backupBeforeWrite(file, ctx)
    if (backupError) return backupError
    try {
      fs.writeFileSync(file, working, 'utf8')
    } catch (error) {
      return toolError(`写入 ${raw} 失败:${error instanceof Error ? error.message : String(error)}`)
    }
    ctx.readState?.forgetPath(file)
    return textOutput(`已在 ${raw} 应用 ${specs.length} 处替换(首次替换发生在第 ${firstLine ?? 1} 行)。`)
  },
}

export const fileTools = [ReadFileTool, WriteFileTool, EditTool]

// Kept for future callers that need the same argument coercion.
export { optionalBoolean }