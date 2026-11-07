// Shared pagination plumbing for MCP tools (schema decoration + arg parsing).

import { MAX_PAGE_CHARS, PAGE_CHARS } from '../mcp/manager.ts'

export interface PageFields {
  offset: string
  limit: string
  resultId: string
  /** The server declared its own `offset`; `offset > 0` is then not a resume. */
  nativeOffset: boolean
}

export interface DecoratedSchema {
  schema: Record<string, unknown>
  fields: PageFields
}

/** Add denia's optional pagination fields without touching server declarations. */
export function decorateSchema(input: unknown): DecoratedSchema {
  const schema: Record<string, unknown> =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? { ...(input as Record<string, unknown>) }
      : { type: 'object', properties: {} }
  if (schema.type !== 'object') schema.type = 'object'
  const properties: Record<string, unknown> =
    typeof schema.properties === 'object' && schema.properties !== null && !Array.isArray(schema.properties)
      ? { ...(schema.properties as Record<string, unknown>) }
      : {}
  const taken = new Set<string>(Object.keys(properties))
  if (Array.isArray(schema.required)) {
    for (const name of schema.required) {
      if (typeof name === 'string') taken.add(name)
    }
  }
  const pick = (base: string): string => {
    if (!taken.has(base)) return base
    const fallback = `denia_${base}`
    if (!taken.has(fallback)) return fallback
    return `denia_page_${base}`
  }
  const fields: PageFields = {
    offset: pick('offset'),
    limit: pick('limit'),
    resultId: pick('result_id'),
    nativeOffset: taken.has('offset'),
  }
  properties[fields.offset] = {
    type: 'integer',
    minimum: 0,
    default: 0,
    description: '0-based 起始字符偏移;读某次结果的后续页时用它。默认 0。',
  }
  properties[fields.limit] = {
    type: 'integer',
    minimum: 1,
    maximum: MAX_PAGE_CHARS,
    default: PAGE_CHARS,
    description: `本页返回的字符数;默认 ${PAGE_CHARS},最大 ${MAX_PAGE_CHARS}。`,
  }
  properties[fields.resultId] = {
    type: 'string',
    description:
      '结果身份:上次输出的尾部若给了 result_id,带上它 + 更大的 offset 就能读后续页,不会重新执行工具;省略即发起一次新的真实调用。',
  }
  schema.properties = properties
  return { schema, fields }
}

export function decorateDescription(description: string): string {
  const base = description.trim() === '' ? 'MCP 外部工具。' : description.trim()
  return `${base}\n(结果较长时按字符分页返回:调用会真实执行工具,尾部给出 result_id;要继续看后面的内容,带上同一个 result_id 与提示里的 offset 再调一次本工具(读同一次结果,不会重新执行)。不带 result_id 的调用都是新调用,会重新执行工具。)`
}

export interface PageArguments {
  offset: number
  offsetExplicit: boolean
  limit: number
  resultId?: string
  error?: string
}

export function pageArguments(args: Record<string, unknown>, fields: PageFields): PageArguments {
  const number = (name: string): number | undefined | null => {
    const raw = args[name]
    if (raw === undefined || raw === null) return undefined
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return raw
    if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim())
    return null
  }
  const offset = number(fields.offset)
  if (offset === null) return { offset: 0, offsetExplicit: false, limit: PAGE_CHARS, error: `${fields.offset} 必须是不小于 0 的整数` }
  const limit = number(fields.limit)
  if (limit === null) return { offset: 0, offsetExplicit: false, limit: PAGE_CHARS, error: `${fields.limit} 必须是不小于 0 的整数` }
  const rawId = args[fields.resultId]
  let resultId: string | undefined
  if (rawId !== undefined && rawId !== null) {
    if (typeof rawId !== 'string') {
      return { offset: 0, offsetExplicit: false, limit: PAGE_CHARS, error: `${fields.resultId} 必须是字符串` }
    }
    const trimmed = rawId.trim()
    if (trimmed !== '') resultId = trimmed
  }
  return {
    offset: offset ?? 0,
    offsetExplicit: offset !== undefined,
    limit: Math.max(1, Math.min(MAX_PAGE_CHARS, limit ?? PAGE_CHARS)),
    ...(resultId ? { resultId } : {}),
  }
}