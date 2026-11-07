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
  const messages: ChatMessage[] = []
  for (const event of events) {
    switch (event.type) {
      case 'user-message': {
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