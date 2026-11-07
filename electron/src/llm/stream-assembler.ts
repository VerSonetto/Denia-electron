// Shared block assembler: every adapter feeds deltas here, so the UI sees one
// stable chunk vocabulary regardless of the provider protocol.
//
// Block indexes are allocated on first appearance (text/reasoning at most one
// each, tool calls keyed by the protocol's own item index). Block-end chunks
// are emitted once, at finish, in index order.

import type { ContentBlock, StreamChunk } from '../core/wire.ts'

interface BlockState {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  id?: string
  name?: string
  arguments: string
}

export interface ToolDelta {
  id?: string
  name?: string
  arguments?: string
}

export class StreamAssembler {
  private readonly states: BlockState[] = []
  private textBlock: BlockState | null = null
  private reasoningBlock: BlockState | null = null
  private readonly toolBlocks = new Map<string, BlockState>()

  private open(kind: BlockState['kind'], id?: string, name?: string): [BlockState, StreamChunk] {
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

  textDelta(delta: string): StreamChunk[] {
    const out: StreamChunk[] = []
    if (!this.textBlock) {
      const [state, start] = this.open('text')
      this.textBlock = state
      out.push(start)
    }
    this.textBlock.text += delta
    out.push({ type: 'text-delta', index: this.textBlock.index, text: delta })
    return out
  }

  reasoningDelta(delta: string): StreamChunk[] {
    const out: StreamChunk[] = []
    if (!this.reasoningBlock) {
      const [state, start] = this.open('reasoning')
      this.reasoningBlock = state
      out.push(start)
    }
    this.reasoningBlock.text += delta
    out.push({ type: 'reasoning-delta', index: this.reasoningBlock.index, text: delta })
    return out
  }

  toolCallDelta(key: string, delta: ToolDelta): StreamChunk[] {
    const out: StreamChunk[] = []
    let state = this.toolBlocks.get(key)
    if (!state) {
      const [created, start] = this.open('tool-call', delta.id, delta.name)
      state = created
      this.toolBlocks.set(key, state)
      out.push(start)
    }
    if (delta.id) state.id = delta.id
    if (delta.name !== undefined) state.name = delta.name
    if (delta.arguments) state.arguments += delta.arguments
    if (delta.id || delta.name !== undefined || delta.arguments) {
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

  /** Set the complete argument string when a protocol only reveals it at the end. */
  setToolArguments(key: string, argumentsText: string): void {
    const state = this.toolBlocks.get(key)
    if (!state || state.arguments.length > 0) return
    state.arguments = argumentsText
  }

  hasToolCalls(): boolean {
    return this.toolBlocks.size > 0
  }

  blocks(): ContentBlock[] {
    return this.states.map((state): ContentBlock => {
      if (state.kind === 'text') return { type: 'text', text: state.text }
      if (state.kind === 'reasoning') return { type: 'reasoning', text: state.text }
      return {
        type: 'tool-call',
        id: state.id ?? `call_${state.index}`,
        name: state.name ?? '',
        arguments: state.arguments,
      }
    })
  }

  finishChunks(): StreamChunk[] {
    return this.states.map((state, index) => ({
      type: 'block-end',
      index,
      block: this.blocks()[index]!,
    }))
  }
}