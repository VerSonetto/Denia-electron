// History derivation: session events → model-facing messages.
//
// Only settled message events participate. Streaming chunks, transient
// tool-output increments and UI state events stay out of the model surface.

import type { ChatMessage, ContentBlock, Envelope } from '../core/wire.ts'

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function reasoningOf(blocks: ContentBlock[]): string | undefined {
  const text = blocks
    .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
    .map((block) => block.text)
    .join('')
  return text.length > 0 ? text : undefined
}

/** Provider-native reasoning blocks (signature / encrypted item) for replay. */
function reasoningReplayOf(blocks: ContentBlock[]): Array<{ protocol: string; payload: unknown }> {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
    .map((block) => block.replay)
    .filter((replay): replay is { protocol: string; payload: unknown } => replay !== undefined)
}

function toolCallsOf(blocks: ContentBlock[]) {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call')
    .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments }))
}

/**
 * One model-facing message plus the log provenance it came from.
 *
 * `seq` is the event seq that owns the message in the log; a tool-result with
 * `replaces` rewrites the item found by that seq instead of appending, which
 * is how microcompaction shrinks the surface while the log stays append-only.
 * `channel` is the injection channel of a user message (null for ordinary
 * messages and for everything that is not a user message); `isError` mirrors
 * the tool-result flag.
 */
export interface SurfaceItem {
  seq: number
  message: ChatMessage
  isError: boolean
  channel: string | null
}

export function deriveSurface(events: readonly Envelope[]): SurfaceItem[] {
  type Compaction = {
    from: number
    to: number
    keepFrom: number
    summary: string
  }
  const compactions: Compaction[] = []
  for (const event of events) {
    if (event.type === 'compaction-summary') {
      compactions.push({
        from: event.replaces_from,
        to: event.replaces_to,
        keepFrom: event.keep_from,
        summary: event.summary,
      })
    }
  }
  const skipped = (seq: number): boolean =>
    compactions.some((item) => seq >= item.from && seq <= item.to)
  // A newer compaction may cover an older summary; only the surviving ones
  // may be inserted, otherwise the model sees two contradictory summaries.
  const activeCompactions = compactions.filter(
    (item) =>
      !compactions.some(
        (other) => other !== item && item.keepFrom >= other.from && item.keepFrom <= other.to,
      ),
  )
  const summaryBefore = (seq: number): string | null => {
    for (let index = activeCompactions.length - 1; index >= 0; index -= 1) {
      const item = activeCompactions[index]!
      if (item.keepFrom === seq) return item.summary
    }
    return null
  }
  // Baseline channels keep only their latest text on the model surface; the
  // log itself stays append-only. Old logs without a channel fall back to the
  // reminder prefixes.
  const lastBaseline = new Map<string, number>()
  for (const event of events) {
    if (event.type !== 'user-message' || skipped(event.seq)) continue
    const channel = injectionChannelOf(event)
    if (channel !== null && BASELINE_CHANNELS.has(channel)) lastBaseline.set(channel, event.seq)
  }
  const surface: SurfaceItem[] = []
  for (const event of events) {
    const summary = summaryBefore(event.seq)
    if (summary !== null) {
      // The summary occupies the log position just before the kept window, so
      // later rewrites can still locate it by seq.
      surface.push({
        seq: Math.max(0, event.seq - 1),
        message: { role: 'user', content: summary },
        isError: false,
        channel: null,
      })
    }
    if (skipped(event.seq)) continue
    switch (event.type) {
      case 'agent-delivery': {
        // Delivery is the model-visible half of the agent inbox; the inbox
        // event itself stays out of the model surface.
        surface.push({
          seq: event.seq,
          message: { role: 'user', content: event.text },
          isError: false,
          channel: null,
        })
        break
      }
      case 'user-message': {
        const channel = injectionChannelOf(event)
        const baseline = channel !== null && BASELINE_CHANNELS.has(channel) ? channel : null
        if (baseline !== null && lastBaseline.get(baseline) !== event.seq) break
        surface.push({
          seq: event.seq,
          message: {
            role: 'user',
            content: event.text,
            ...(event.images && event.images.length > 0 ? { images: event.images } : {}),
          },
          isError: false,
          channel,
        })
        break
      }
      case 'assistant-message': {
        const calls = toolCallsOf(event.blocks)
        const reasoning = reasoningOf(event.blocks)
        const replay = reasoningReplayOf(event.blocks)
        surface.push({
          seq: event.seq,
          message: {
            role: 'assistant',
            content: textOf(event.blocks),
            ...(reasoning ? { reasoningContent: reasoning } : {}),
            ...(replay.length > 0 ? { reasoningReplay: replay } : {}),
            ...(calls.length > 0 ? { toolCalls: calls } : {}),
          },
          isError: false,
          channel: null,
        })
        break
      }
      case 'tool-result': {
        // A replacement keeps the original item (and its seq) and only swaps
        // the content: the model sees the cleared text where the result used
        // to be, in the same position, so no orphan tool message is created.
        const replaced =
          event.replaces === undefined
            ? undefined
            : surface.find((item) => item.seq === event.replaces)
        if (replaced !== undefined) {
          replaced.message = {
            role: 'tool',
            content: event.content,
            toolCallId: event.call_id,
          }
          replaced.isError = event.is_error
          break
        }
        surface.push({
          seq: event.seq,
          message: {
            role: 'tool',
            content: event.content,
            toolCallId: event.call_id,
          },
          isError: event.is_error,
          channel: null,
        })
        break
      }
      default:
        break
    }
  }
  return surface
}

export function deriveHistory(events: readonly Envelope[]): ChatMessage[] {
  return deriveSurface(events).map((item) => item.message)
}

/**
 * Source channel of an injected user message (null for ordinary messages).
 *
 * The channel field wins; old logs without one fall back to the injection
 * prefixes. Only [`BASELINE_CHANNELS`] fold by "newest wins"; a channel in
 * this field is provenance, not a folding decision.
 */
function injectionChannelOf(event: Extract<Envelope, { type: 'user-message' }>): string | null {
  if (event.channel) return event.channel
  if (!event.injected) return null
  if (event.text.startsWith('<system-reminder>\n工作区指令:')) return 'workspace-instructions'
  if (event.text.startsWith('<system-reminder>\n技能目录:')) return 'skill-catalog'
  if (
    event.text.startsWith('<system-reminder>\n') &&
    event.text.includes('/MEMORY.md 的内容')
  ) {
    return 'project-memory'
  }
  return null
}

/** Baseline channels: only the newest occurrence is model-visible. */

const BASELINE_CHANNELS = new Set([
  'workspace-instructions',
  'capability',
  'skill-catalog',
  'project-memory',
  'goal',
  'subagent-catalog',
  'system-prompt-update',
  'runtime-context',
  'coding-workbench',
])

/** Last turn number in the log (0 when no turn has started). */
export function lastTurn(events: Envelope[]): number {
  let turn = 0
  for (const event of events) {
    if (event.type === 'turn-start' || event.type === 'turn-end') {
      turn = Math.max(turn, event.turn)
    }
  }
  return turn
}

/** True when the log ends inside an open turn (crash or in-flight run). */
export function hasOpenTurn(events: Envelope[]): boolean {
  let open = false
  for (const event of events) {
    if (event.type === 'turn-start') open = true
    else if (event.type === 'turn-end') open = false
  }
  return open
}