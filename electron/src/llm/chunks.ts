// pi assistant events -> the `StreamChunk` vocabulary the web UI already folds.
//
// pi owns protocol parsing. This module only re-groups deltas into Denia's
// stable block indexes and emits the authoritative `block-end` list at the
// end of a response. It is shared by the agent event bridge and the one-shot
// completion bridge so both paths produce identical chunks.

import type {
  BlockType,
  ContentBlock,
  FinishReason,
  StreamChunk,
  TokenUsage,
} from '../core/wire.ts'
import type { AssistantMessageEvent } from '@earendil-works/pi-ai'
import { InlineThinkSplitter } from './inline-think.ts'

interface BlockState {
  index: number
  kind: BlockType
  text: string
  id?: string
  name?: string
  arguments: string
  replay?: { protocol: string; payload: unknown }
  incomplete?: boolean
}

export class ChunkBuilder {
  private readonly states: BlockState[] = []
  private textState: BlockState | null = null
  private reasoningState: BlockState | null = null
  private readonly toolStates = new Map<string, BlockState>()
  private readonly splitter: InlineThinkSplitter

  constructor(options: { inlineThinkTags?: boolean } = {}) {
    this.splitter = new InlineThinkSplitter(options.inlineThinkTags === true)
  }

  private open(kind: BlockType, id?: string, name?: string): [BlockState, StreamChunk] {
    const state: BlockState = {
      index: this.states.length,
      kind,
      text: '',
      arguments: '',
      ...(id === undefined ? {} : { id }),
      ...(name === undefined ? {} : { name }),
    }
    this.states.push(state)
    return [state, { type: 'block-start', index: state.index, block_type: kind }]
  }

  private openText(): StreamChunk[] {
    if (this.textState) return []
    const [state, start] = this.open('text')
    this.textState = state
    return [start]
  }

  private openReasoning(): StreamChunk[] {
    if (this.reasoningState) return []
    const [state, start] = this.open('reasoning')
    this.reasoningState = state
    return [start]
  }

  private rawTextDelta(text: string): StreamChunk[] {
    const out = this.openText()
    this.textState!.text += text
    if (text.length > 0) {
      out.push({ type: 'text-delta', index: this.textState!.index, text })
    }
    return out
  }

  private rawReasoningDelta(text: string): StreamChunk[] {
    const out = this.openReasoning()
    this.reasoningState!.text += text
    if (text.length > 0) {
      out.push({ type: 'reasoning-delta', index: this.reasoningState!.index, text })
    }
    return out
  }

  /** Inline-dialect providers buffer their text until the answer starts. */
  textDelta(text: string): StreamChunk[] {
    if (text === '') return []
    if (this.splitter.active) {
      const split = this.splitter.push(text)
      if (split === null) return this.rawTextDelta(text)
      const out: StreamChunk[] = []
      if (split.reasoning !== '') out.push(...this.rawReasoningDelta(split.reasoning))
      if (split.text !== '') out.push(...this.rawTextDelta(split.text))
      return out
    }
    return this.rawTextDelta(text)
  }

  /** A native reasoning channel or a tool call proves the route is not inline. */
  private flushLeadAsText(): StreamChunk[] {
    const pending = this.splitter.flushAsText()
    return pending === null ? [] : this.rawTextDelta(pending)
  }

  reasoningDelta(text: string): StreamChunk[] {
    const out = this.flushLeadAsText()
    if (text !== '') out.push(...this.rawReasoningDelta(text))
    return out
  }

  toolCallDelta(
    key: string,
    delta: { id?: string; name?: string; arguments?: string },
  ): StreamChunk[] {
    const out = this.flushLeadAsText()
    let state = this.toolStates.get(key)
    if (!state) {
      const [created, start] = this.open('tool-call', delta.id, delta.name)
      state = created
      this.toolStates.set(key, state)
      out.push(start)
    }
    if (delta.id !== undefined) state.id = delta.id
    if (delta.name !== undefined) state.name = delta.name
    if (delta.arguments !== undefined) state.arguments += delta.arguments
    if (delta.id !== undefined || delta.name !== undefined || (delta.arguments ?? '') !== '') {
      out.push({
        type: 'tool-call-delta',
        index: state.index,
        id: state.id ?? key,
        ...(delta.name === undefined ? {} : { name: delta.name }),
        arguments_delta: delta.arguments ?? '',
      })
    }
    return out
  }

  /** Flush a buffered inline lead at the end of the stream. */
  flushInlineTail(): StreamChunk[] {
    const tail = this.splitter.flushAtEnd()
    if (tail === null) return []
    const out: StreamChunk[] = []
    if (tail.reasoning !== '') out.push(...this.rawReasoningDelta(tail.reasoning))
    if (tail.text !== '') out.push(...this.rawTextDelta(tail.text))
    return out
  }

  /**
   * Emit the authoritative block list. Deltas created indexes first; final
   * blocks are matched to those states by kind and tool id, so a provider that
   * only reveals arguments at the end still reaches the UI.
   */
  finish(finalBlocks: readonly ContentBlock[]): StreamChunk[] {
    const out: StreamChunk[] = []
    const claimed = new Set<BlockState>()
    const textStates: BlockState[] = []
    const reasoningStates: BlockState[] = []
    const toolStates: BlockState[] = []
    for (const state of this.states) {
      if (state.kind === 'text') textStates.push(state)
      else if (state.kind === 'reasoning') reasoningStates.push(state)
      else toolStates.push(state)
    }

    const claim = (kind: BlockType, block: ContentBlock): BlockState | undefined => {
      const pool = kind === 'text' ? textStates : kind === 'reasoning' ? reasoningStates : toolStates
      if (kind === 'tool-call' && block.type === 'tool-call' && block.id !== '') {
        const byId = pool.find((state) => !claimed.has(state) && state.id === block.id)
        if (byId) return byId
      }
      return pool.find((state) => !claimed.has(state))
    }

    for (const block of finalBlocks) {
      let state = claim(block.type, block)
      if (!state) {
        const [created, start] = this.open(
          block.type,
          block.type === 'tool-call' ? block.id : undefined,
          block.type === 'tool-call' ? block.name : undefined,
        )
        state = created
        out.push(start)
        if (block.type === 'text') textStates.push(created)
        else if (block.type === 'reasoning') reasoningStates.push(created)
        else toolStates.push(created)
      }
      claimed.add(state)
      if (block.type === 'text') {
        state.text = block.text
      } else if (block.type === 'reasoning') {
        state.text = block.text
        state.replay = block.replay
      } else {
        state.id = block.id
        state.name = block.name
        state.arguments = block.arguments
        state.incomplete = block.incomplete
      }
    }

    for (const state of [...this.states].sort((a, b) => a.index - b.index)) {
      out.push({ type: 'block-end', index: state.index, block: this.blockOf(state) })
    }
    return out
  }

  private blockOf(state: BlockState): ContentBlock {
    if (state.kind === 'text') return { type: 'text', text: state.text }
    if (state.kind === 'reasoning') {
      return {
        type: 'reasoning',
        text: state.text,
        ...(state.replay ? { replay: state.replay } : {}),
      }
    }
    return {
      type: 'tool-call',
      id: state.id ?? `call_${state.index}`,
      name: state.name ?? '',
      arguments: state.arguments,
      ...(state.incomplete ? { incomplete: true } : {}),
    }
  }
}

export function usageChunk(usage: TokenUsage | undefined): StreamChunk[] {
  return usage === undefined ? [] : [{ type: 'usage', usage }]
}

export function finishChunk(reason: FinishReason): StreamChunk {
  return { type: 'finish', reason }
}

/**
 * Translate one pi assistant event into Denia chunks. The same helper drives
 * the agent event bridge and the one-shot stream, so chunk ordering cannot
 * drift between the two paths.
 */
export function chunksForAssistantEvent(
  builder: ChunkBuilder,
  event: AssistantMessageEvent,
  seenToolDeltas: Set<number>,
): StreamChunk[] {
  switch (event.type) {
    case 'text_delta':
      return builder.textDelta(event.delta)
    case 'thinking_delta':
      return builder.reasoningDelta(event.delta)
    case 'toolcall_start': {
      const call = event.partial.content[event.contentIndex]
      if (call?.type !== 'toolCall') return []
      return builder.toolCallDelta(String(event.contentIndex), {
        id: call.id,
        name: call.name,
      })
    }
    case 'toolcall_delta': {
      const call = event.partial.content[event.contentIndex]
      const id = call?.type === 'toolCall' ? call.id : undefined
      const name = call?.type === 'toolCall' ? call.name : undefined
      seenToolDeltas.add(event.contentIndex)
      return builder.toolCallDelta(String(event.contentIndex), {
        ...(id === undefined ? {} : { id }),
        ...(name === undefined ? {} : { name }),
        arguments: event.delta,
      })
    }
    case 'toolcall_end':
      if (seenToolDeltas.has(event.contentIndex)) return []
      return builder.toolCallDelta(String(event.contentIndex), {
        id: event.toolCall.id,
        name: event.toolCall.name,
        arguments: JSON.stringify(event.toolCall.arguments),
      })
    default:
      return []
  }
}