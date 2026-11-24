// Inline reasoning-tag splitter for chat-completions gateways.
//
// Some OpenAI-compatible routes inline reasoning into `content`, ending it
// with `</think>` while the opening tag was consumed upstream. The pi kernel
// does not model this dialect, so the split stays in Denia's event layer and
// never reaches the request/response contract pi owns.

const INLINE_THINK_CLOSE = '\u003c/think\u003e'
const INLINE_THINK_LEAD_CAP = 32 * 1024

export class InlineThinkSplitter {
  private buffer: string | null
  private sawIgnoredMarker = false

  constructor(enabled: boolean) {
    this.buffer = enabled ? '' : null
  }

  get active(): boolean {
    return this.buffer !== null
  }

  /** Returns null when disabled; empty parts mean "still buffering". */
  push(text: string): { reasoning: string; text: string } | null {
    if (this.buffer === null) return null
    this.buffer += text
    let searchFrom = 0
    for (;;) {
      const close = this.buffer.indexOf(INLINE_THINK_CLOSE, searchFrom)
      if (close < 0) break
      const before = this.buffer.slice(0, close)
      const after = this.buffer.slice(close + INLINE_THINK_CLOSE.length)
      // Quoted in backticks: the model is discussing the tag itself.
      if (before.endsWith('`') || after.startsWith('`')) {
        this.sawIgnoredMarker = true
        searchFrom = close + INLINE_THINK_CLOSE.length
        continue
      }
      // Followed by a space: also a reference inside the reasoning. The real
      // upstream terminator is followed by a newline or the answer's first
      // character.
      if (after.startsWith(' ')) {
        this.sawIgnoredMarker = true
        searchFrom = close + INLINE_THINK_CLOSE.length
        continue
      }
      this.buffer = null
      return { reasoning: before, text: after }
    }
    if (this.buffer.length > INLINE_THINK_LEAD_CAP) {
      const pending = this.buffer
      this.buffer = null
      return { reasoning: '', text: pending }
    }
    return { reasoning: '', text: '' }
  }

  /** A real reasoning channel (or a tool call) proves this route is not inline. */
  flushAsText(): string | null {
    if (this.buffer === null) return null
    const pending = this.buffer
    this.buffer = null
    return pending.length > 0 ? pending : null
  }

  /**
   * End of stream. If the only markers seen were quoted/tag references, the
   * buffered text is reasoning about the tag rather than an inline
   * reasoning-prefix followed by an answer.
   */
  flushAtEnd(): { reasoning: string; text: string } | null {
    if (this.buffer === null) return null
    const pending = this.buffer
    this.buffer = null
    if (pending.length === 0) return null
    return this.sawIgnoredMarker
      ? { reasoning: pending, text: '' }
      : { reasoning: '', text: pending }
  }
}

/**
 * Split a completed assistant text into reasoning + answer for providers that
 * use the inline dialect. Native reasoning blocks win: a route that emitted a
 * real reasoning channel is never treated as inline.
 */
export function splitInlineThinking(
  text: string,
  enabled: boolean,
): { reasoning: string; text: string } {
  if (!enabled || text === '') return { reasoning: '', text }
  const splitter = new InlineThinkSplitter(true)
  const split = splitter.push(text)
  const tail = splitter.flushAtEnd()
  return {
    reasoning: `${split?.reasoning ?? ''}${tail?.reasoning ?? ''}`,
    text: `${split?.text ?? ''}${tail?.text ?? ''}`,
  }
}