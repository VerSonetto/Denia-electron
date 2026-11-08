// Prompt composition accounting: splits the next request's text budget into
// disjoint parts — frozen system prefix, injected baseline context, skill
// catalog, tool schemas and conversation messages. Each part is estimated
// once; baseline rows are never counted again inside `messages`.

import type { ChatMessage, ChatRole, ToolSchema } from '../core/wire.ts'
import { BASELINE_CHANNELS } from './history.ts'
import type { SurfaceItem } from './history.ts'

/** Non-CJK density: four characters per token. */
export const CHARS_PER_TOKEN = 4
/** Structural overhead of a content block (JSON frame and type tag). */
export const BLOCK_OVERHEAD = 4
/** Per-message role frame overhead. */
export const ROLE_OVERHEAD = 4

const SKILL_CATALOG_CHANNEL = 'skill-catalog'
const SYSTEM_REMINDER_PREFIX = '<system-reminder>'

export type ContextUsagePartKey =
  | 'systemPrompt'
  | 'metaUserContext'
  | 'skills'
  | 'systemTools'
  | 'mcpTools'
  | 'messages'

export interface ContextUsageMetric {
  chars: number
  tokens: number
}

/** One disjoint slice of the next request's prompt. */
export interface ContextUsagePart extends ContextUsageMetric {
  key: ContextUsagePartKey
}

export interface ContextUsageRoleDetail extends ContextUsageMetric {
  role: ChatRole
  count: number
}

export interface ContextUsageToolDetail extends ContextUsageMetric {
  name: string
  source: 'system' | 'mcp'
}

export interface ContextUsageSnapshot {
  parts: ContextUsagePart[]
  totalChars: number
  totalTokens: number
  /** Conversation rows by role (`messages` part); baseline rows excluded. */
  messageRoles: ContextUsageRoleDetail[]
  /** Per-schema rows; `mcp__*` tools are attributed to the MCP slice. */
  tools: ContextUsageToolDetail[]
}

/**
 * CJK code points: radicals, punctuation, kana, hangul, unified ideographs and
 * the fullwidth forms.
 */
export function isCjkChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (
    (code >= 0x2e80 && code <= 0x2fff) ||
    (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x20000 && code <= 0x2ffff)
  )
}

/**
 * Character-class density: one token per CJK character, one per four other
 * characters. The two classes are rounded separately.
 */
export function estimateTextTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (isCjkChar(ch)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / CHARS_PER_TOKEN)
}

function textChars(text: string): number {
  return Array.from(text).length
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Provider-native reasoning payloads count too; thinking/summary are stripped first. */
function reasoningReplayText(payload: unknown): string {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const copy: Record<string, unknown> = { ...(payload as Record<string, unknown>) }
    delete copy.thinking
    delete copy.summary
    return safeJson(copy)
  }
  return safeJson(payload)
}

/**
 * One model-visible message: role frame, text, images, reasoning and tool
 * calls; tool results carry only their body.
 */
export function estimateMessageTokens(message: ChatMessage): number {
  let tokens = ROLE_OVERHEAD + estimateTextTokens(message.content)
  for (const image of message.images ?? []) {
    tokens += BLOCK_OVERHEAD + estimateTextTokens(image.mime) + estimateTextTokens(image.data)
  }
  if (message.role === 'tool') return tokens
  if (message.reasoningContent !== undefined) {
    tokens += BLOCK_OVERHEAD + estimateTextTokens(message.reasoningContent)
  }
  for (const replay of message.reasoningReplay ?? []) {
    tokens += BLOCK_OVERHEAD + estimateTextTokens(reasoningReplayText(replay.payload))
  }
  for (const call of message.toolCalls ?? []) {
    tokens +=
      BLOCK_OVERHEAD +
      estimateTextTokens(call.id) +
      estimateTextTokens(call.name) +
      estimateTextTokens(call.arguments)
  }
  return tokens
}

/** The same content pieces as {@link estimateMessageTokens}, counted in characters. */
export function estimateMessageChars(message: ChatMessage): number {
  let chars = textChars(message.content)
  for (const image of message.images ?? []) {
    chars += textChars(image.mime) + textChars(image.data)
  }
  if (message.role === 'tool') return chars
  if (message.reasoningContent !== undefined) chars += textChars(message.reasoningContent)
  for (const replay of message.reasoningReplay ?? []) {
    chars += textChars(reasoningReplayText(replay.payload))
  }
  for (const call of message.toolCalls ?? []) {
    chars += textChars(call.id) + textChars(call.name) + textChars(call.arguments)
  }
  return chars
}

/**
 * Which slice owns this surface row. The skill catalog gets its own row even
 * though it travels on the baseline injection channel; every other baseline
 * channel is runtime context. Reminder rows without a channel are classified
 * by their prefix.
 */
export function contextUsagePartOf(item: SurfaceItem): ContextUsagePartKey {
  if (item.channel === SKILL_CATALOG_CHANNEL) return 'skills'
  if (item.channel !== null && BASELINE_CHANNELS.has(item.channel)) return 'metaUserContext'
  if (
    item.channel === null &&
    item.message.role === 'user' &&
    item.message.content.startsWith(SYSTEM_REMINDER_PREFIX)
  ) {
    return 'metaUserContext'
  }
  return 'messages'
}

function toolDetail(schema: ToolSchema): ContextUsageToolDetail {
  const json = safeJson({
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
  })
  return {
    name: schema.name,
    source: schema.name.startsWith('mcp__') ? 'mcp' : 'system',
    chars: textChars(json),
    tokens: BLOCK_OVERHEAD + estimateTextTokens(json),
  }
}

const PART_KEYS: readonly ContextUsagePartKey[] = [
  'systemPrompt',
  'metaUserContext',
  'skills',
  'systemTools',
  'mcpTools',
  'messages',
]

/**
 * Split the next request into disjoint parts. `system` must be the bytes the
 * wire will send (the frozen prefix, not the freshly assembled prompt);
 * `surface` must be `deriveSurface` of the model-visible history.
 */
export function buildContextUsageSnapshot(input: {
  system: string
  tools: readonly ToolSchema[]
  surface: readonly SurfaceItem[]
  /** Full prompt copy the next request will append because the prefix is frozen. */
  pendingSystemUpdate?: string
}): ContextUsageSnapshot {
  const parts = new Map<ContextUsagePartKey, ContextUsageMetric>()
  for (const key of PART_KEYS) parts.set(key, { chars: 0, tokens: 0 })

  const add = (key: ContextUsagePartKey, chars: number, tokens: number): void => {
    const current = parts.get(key)!
    current.chars += chars
    current.tokens += tokens
  }

  add('systemPrompt', textChars(input.system), estimateTextTokens(input.system))
  // Count the pending update row that will follow the cached prefix.
  if (input.pendingSystemUpdate !== undefined && input.pendingSystemUpdate !== '') {
    const update = { role: 'user' as const, content: input.pendingSystemUpdate }
    add('metaUserContext', estimateMessageChars(update), estimateMessageTokens(update))
  }

  const tools = input.tools.map(toolDetail)
  for (const tool of tools) {
    add(tool.source === 'mcp' ? 'mcpTools' : 'systemTools', tool.chars, tool.tokens)
  }

  const roles = new Map<ChatRole, ContextUsageRoleDetail>()
  for (const item of input.surface) {
    const key = contextUsagePartOf(item)
    const chars = estimateMessageChars(item.message)
    const tokens = estimateMessageTokens(item.message)
    add(key, chars, tokens)
    if (key !== 'messages') continue
    const role = roles.get(item.message.role) ?? {
      role: item.message.role,
      count: 0,
      chars: 0,
      tokens: 0,
    }
    role.count += 1
    role.chars += chars
    role.tokens += tokens
    roles.set(item.message.role, role)
  }

  const ordered = PART_KEYS.map((key) => ({ key, ...parts.get(key)! }))
  return {
    parts: ordered,
    totalChars: ordered.reduce((sum, part) => sum + part.chars, 0),
    totalTokens: ordered.reduce((sum, part) => sum + part.tokens, 0),
    messageRoles: [...roles.values()],
    tools,
  }
}

/**
 * Collapse the parts into the three panel rows: fixed injected text joins the
 * system row; both tool sources join the tools row.
 */
export function summarizeContextUsage(parts: readonly ContextUsagePart[]): {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
} {
  const tokensOf = (key: ContextUsagePartKey): number =>
    parts.find((part) => part.key === key)?.tokens ?? 0
  return {
    systemTokens:
      tokensOf('systemPrompt') + tokensOf('metaUserContext') + tokensOf('skills'),
    toolsTokens: tokensOf('systemTools') + tokensOf('mcpTools'),
    messageTokens: tokensOf('messages'),
  }
}