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
    description: '起始字符偏移;续读同一结果时用。',
  }
  properties[fields.limit] = {
    type: 'integer',
    minimum: 1,
    maximum: MAX_PAGE_CHARS,
    default: PAGE_CHARS,
    description: `本页字符数,默认 ${PAGE_CHARS},最大 ${MAX_PAGE_CHARS}。`,
  }
  properties[fields.resultId] = {
    type: 'string',
    description: '上次输出尾部的 result_id;带上它 + 更大的 offset 续读同一结果,不会重新执行。',
  }
  schema.properties = properties
  return { schema, fields }
}

/**
 * The tool description as the model sees it. Pagination is documented once in
 * the MCP discipline section instead of repeating a paragraph on every tool:
 * with dozens of connected tools that boilerplate was itself a large share of
 * the declared surface.
 */
export function decorateDescription(description: string): string {
  return description.trim() === '' ? 'MCP 外部工具。' : description.trim()
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