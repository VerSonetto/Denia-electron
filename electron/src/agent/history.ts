// History derivation: session events → model-facing messages.
//
// Only settled message events participate. Streaming chunks, transient
// tool-output increments and UI state events stay out of the model surface,
// exactly like the Rust `derive_surface`.

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

function toolCallsOf(blocks: ContentBlock[]) {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call')
    .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments }))
}

export function deriveHistory(events: Envelope[]): ChatMessage[] {
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
    const channel = baselineChannelOf(event)
    if (channel) lastBaseline.set(channel, event.seq)
  }
  const messages: ChatMessage[] = []
  for (const event of events) {
    const summary = summaryBefore(event.seq)
    if (summary !== null) messages.push({ role: 'user', content: summary })
    if (skipped(event.seq)) continue
    switch (event.type) {
      case 'agent-delivery': {
        // Delivery is the model-visible half of the agent inbox; the inbox
        // event itself stays out of the model surface.
        messages.push({ role: 'user', content: event.text })
        break
      }
      case 'user-message': {
        const channel = baselineChannelOf(event)
        if (channel && lastBaseline.get(channel) !== event.seq) break
        messages.push({
          role: 'user',
          content: event.text,
          ...(event.images && event.images.length > 0 ? { images: event.images } : {}),
        })
        break
      }
      case 'assistant-message': {
        const calls = toolCallsOf(event.blocks)
        const reasoning = reasoningOf(event.blocks)
        messages.push({
          role: 'assistant',
          content: textOf(event.blocks),
          ...(reasoning ? { reasoningContent: reasoning } : {}),
          ...(calls.length > 0 ? { toolCalls: calls } : {}),
        })
        break
      }
      case 'tool-result': {
        messages.push({
          role: 'tool',
          content: event.content,
          toolCallId: event.call_id,
        })
        break
      }
      default:
        break
    }
  }
  return messages
}

/** Baseline channels: only the newest occurrence is model-visible. */
function baselineChannelOf(
  event: Extract<Envelope, { type: 'user-message' }>,
): string | null {
  if (event.channel) {
    return BASELINE_CHANNELS.has(event.channel) ? event.channel : null
  }
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