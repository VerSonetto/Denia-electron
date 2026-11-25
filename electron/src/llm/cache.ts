// Prompt-cache plumbing shared by the wire adapters.
//
// Providers cache request prefixes on their side; these helpers decide which
// blocks carry a breakpoint and keep the cache identity inside the limits the
// wire accepts.

import type { MessageCache } from '../core/wire.ts'
import { isRecord } from '../core/util.ts'

/** Anthropic accepts at most four `cache_control` breakpoints per request. */
export const ANTHROPIC_MAX_BREAKPOINTS = 4

/** A historical checkpoint lands every this many real user turns. */
export const ANTHROPIC_DECIMATION_INTERVAL = 15

/** Prompt-cache provenance carried alongside one encoded wire message. */
export interface WireCacheMeta {
  perCall: boolean
  conversationalUser: boolean
}

export interface AnthropicCacheControl {
  type: 'ephemeral'
  ttl?: '1h'
}

/** One entry of the Messages request `messages` array. */
export interface AnthropicWireMessage {
  role: string
  content: unknown[]
}

/**
 * The provider caches an explicit cache tier only when asked: the long tier
 * costs more to write and keeps a breakpoint valid for an hour instead of the
 * default five minutes.
 */
export function anthropicCacheControl(longCache: boolean): AnthropicCacheControl {
  return longCache ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
}

/** Fold one wire message's provenance into the message it merged into. */
export function mergeCacheMeta(target: WireCacheMeta, source: WireCacheMeta): void {
  target.perCall = target.perCall || source.perCall
  target.conversationalUser = target.conversationalUser || source.conversationalUser
}

/** Read the cache flags off a chat message, defaulting to "not cacheable". */
export function cacheMetaOf(message: { cache?: MessageCache }): WireCacheMeta {
  return {
    perCall: message.cache?.perCall === true,
    conversationalUser: message.cache?.conversationalUser === true,
  }
}

/**
 * Normalize a prompt-cache identity to the 64-character limit OpenAI accepts.
 * Session ids fit verbatim; longer identities get a stable FNV-1a digest so a
 * restart does not remint the key and drop the provider's cache.
 */
export function normalizePromptCacheKey(value: string): string | undefined {
  const key = value.trim()
  if (key === '') return undefined
  if ([...key].length <= 64) return key
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = (1n << 64n) - 1n
  for (const byte of new TextEncoder().encode(key)) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & mask
  }
  return `pc_${hash.toString(16).padStart(16, '0')}`
}

/**
 * Generated reasoning, fallback boundaries and mid-conversation tool-control
 * blocks cannot carry a breakpoint: the provider rejects `cache_control` there
 * or would never replay them identically.
 */
function isUncacheableAnthropicBlock(block: Record<string, unknown>): boolean {
  switch (block.type) {
    case 'thinking':
    case 'redacted_thinking':
    case 'fallback':
    case 'tool_addition':
    case 'tool_removal':
      return true
    default:
      return false
  }
}

/**
 * Put one ephemeral breakpoint on the last eligible block of a wire message.
 * Reports false when the message has no eligible block or already carries a
 * breakpoint, so the caller can spend the slot somewhere else.
 */
function applyAnthropicCacheControl(
  message: AnthropicWireMessage,
  cacheControl: AnthropicCacheControl,
): boolean {
  const blocks = Array.isArray(message.content) ? message.content : []
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (!isRecord(block) || isUncacheableAnthropicBlock(block)) continue
    if (block.cache_control !== undefined) return false
    block.cache_control = cacheControl
    return true
  }
  return false
}

/**
 * Spend the breakpoint budget the head anchors left over on the message tail
 * and periodic historical checkpoints.
 *
 * Priority mirrors what actually extends a reusable prefix: the newest tail,
 * then a checkpoint every 15 real user turns, then the newest message before
 * the first per-call block, then a second tail candidate. Only successful
 * decorations consume budget.
 */
export function applyAnthropicMessageCaching(
  messages: AnthropicWireMessage[],
  metas: readonly WireCacheMeta[],
  headBreakpoints: number,
  cacheControl: AnthropicCacheControl,
): void {
  const budget = ANTHROPIC_MAX_BREAKPOINTS - headBreakpoints
  if (budget <= 0 || messages.length === 0 || metas.length !== messages.length) return
  const end = messages.length - 1
  let markIndex: number | null = null
  let stableUserTurns = 0
  const trailing: number[] = []
  for (let index = end; index >= 0; index -= 1) {
    const meta = metas[index]!
    if (meta.perCall) {
      // Rebuilt for the next request, so a prefix spanning it can never match:
      // it is the reusable-prefix boundary, not an anchor.
      markIndex = index
      stableUserTurns = 0
      continue
    }
    if (trailing.length < 2) trailing.push(index)
    if (meta.conversationalUser) stableUserTurns += 1
  }
  const stableEnd = markIndex === null ? end : markIndex === 0 ? null : markIndex - 1
  let applied = 0
  const newest = trailing[0]
  if (newest !== undefined && applyAnthropicCacheControl(messages[newest]!, cacheControl)) {
    applied += 1
  }
  if (stableUserTurns >= ANTHROPIC_DECIMATION_INTERVAL && stableEnd !== null) {
    // The newest checkpoint sits `stableUserTurns % 15` turns back from the
    // stable prefix end; every 15th turn precedes it.
    let turnsSinceCheckpoint = stableUserTurns % ANTHROPIC_DECIMATION_INTERVAL
    for (let index = stableEnd; index >= 0; index -= 1) {
      if (applied >= budget) break
      if (!metas[index]!.conversationalUser) continue
      if (turnsSinceCheckpoint > 0) {
        turnsSinceCheckpoint -= 1
        continue
      }
      turnsSinceCheckpoint = ANTHROPIC_DECIMATION_INTERVAL - 1
      if (applyAnthropicCacheControl(messages[index]!, cacheControl)) applied += 1
    }
  }
  if (applied < budget && stableEnd !== null && stableEnd < end) {
    if (applyAnthropicCacheControl(messages[stableEnd]!, cacheControl)) applied += 1
  }
  const second = trailing[1]
  if (applied < budget && second !== undefined) {
    if (applyAnthropicCacheControl(messages[second]!, cacheControl)) applied += 1
  }
}