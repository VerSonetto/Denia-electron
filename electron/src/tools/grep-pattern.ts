// Conservative regex analysis for grep's no-index fast path.
//
// The analyzer returns a literal string that MUST occur in any line the regex
// matches. That literal lets the scanner reject files with a raw byte search
// instead of decoding them. Being conservative is mandatory: returning no
// literal only costs speed, while returning a wrong literal silently drops
// matches. Anything the parser does not understand is therefore treated as an
// opaque atom with no required text.

export interface GrepPlan {
  /** Original pattern source; the worker rebuilds the real regex from it. */
  source: string
  flags: string
  /** Mandatory literal usable as a raw-byte prefilter (source case). */
  literal: string | null
  /** Exact literal text when the whole regex is one plain literal. */
  pure: string | null
  ignoreCase: boolean
}

interface Node {
  /** Mandatory literal runs that cannot merge with siblings. */
  required: string[]
  /** Trailing literal run that may merge with the following sibling. */
  run: string | null
  /** The node matches exactly this text (plain literal sequence). */
  pure: string | null
}

const OPAQUE: Node = { required: [], run: null, pure: null }

function literalNode(text: string): Node {
  return { required: [], run: text, pure: text }
}

function dedupe(values: string[]): string[] {
  return values.length <= 1 ? values : [...new Set(values)]
}

function allRequired(node: Node): string[] {
  return node.run === null ? node.required : [...node.required, node.run]
}

/**
 * Combine a concatenation. Consecutive plain literals merge into one run so
 * `foobar?` still yields `fooba` instead of six one-character runs.
 */
function sequence(nodes: Node[]): Node {
  let run = ''
  let pure = ''
  let allPure = true
  const required: string[] = []
  for (const node of nodes) {
    if (node.pure !== null) {
      run += node.pure
      if (allPure) pure += node.pure
      continue
    }
    allPure = false
    if (run !== '') {
      required.push(run)
      run = ''
    }
    required.push(...node.required)
    // A child that already flushed its trailing run cannot merge with the
    // next sibling, so keep it as its own mandatory literal.
    if (node.run !== null) required.push(node.run)
  }
  return {
    required: dedupe(required),
    run: run === '' ? null : run,
    // One opaque child makes the whole sequence non-exact; trailing literals
    // must not masquerade as the node's full match.
    pure: allPure && pure !== '' ? pure : null,
  }
}

/** Only literals required by every branch may survive an alternation. */
function alternation(branches: Node[]): Node {
  if (branches.length === 0) return OPAQUE
  let common = allRequired(branches[0]!)
  for (let index = 1; index < branches.length; index += 1) {
    const present = new Set(allRequired(branches[index]!))
    common = common.filter((text) => present.has(text))
    if (common.length === 0) return OPAQUE
  }
  return { required: dedupe(common), run: null, pure: null }
}

function quantified(node: Node, min: number): Node {
  if (min < 1) return OPAQUE
  // Repeating a node at least once keeps its required literals, but the
  // boundary with the next sibling is no longer contiguous.
  return { required: dedupe(allRequired(node)), run: null, pure: null }
}

function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) return false
  }
  return true
}

class Parser {
  private readonly source: string
  private index = 0

  constructor(source: string) {
    this.source = source
  }

  parse(): Node {
    const node = this.parseAlternation()
    // The regex already compiled, so the parser should consume everything.
    // If it did not, an unknown construct may hide a branch: give up instead
    // of trusting a partial analysis.
    if (this.index < this.source.length) return OPAQUE
    return node
  }

  private parseAlternation(): Node {
    const branches = [this.parseSequence()]
    while (this.source[this.index] === '|') {
      this.index += 1
      branches.push(this.parseSequence())
    }
    return branches.length === 1 ? branches[0]! : alternation(branches)
  }

  private parseSequence(): Node {
    const nodes: Node[] = []
    while (this.index < this.source.length) {
      const char = this.source[this.index]!
      if (char === ')' || char === '|') break
      nodes.push(this.parseQuantified())
    }
    return sequence(nodes)
  }

  private parseQuantified(): Node {
    const atom = this.parseAtom()
    const min = this.readQuantifier()
    return min === null ? atom : quantified(atom, min)
  }

  /** Consume one quantifier and return its minimum repetition count. */
  private readQuantifier(): number | null {
    const char = this.source[this.index]
    if (char === '*') {
      this.index += 1
      if (this.source[this.index] === '?') this.index += 1
      return 0
    }
    if (char === '+') {
      this.index += 1
      if (this.source[this.index] === '?') this.index += 1
      return 1
    }
    if (char === '?') {
      this.index += 1
      if (this.source[this.index] === '?') this.index += 1
      return 0
    }
    if (char === '{') {
      const match = /^\{(\d+)(?:,(\d*))?\}/.exec(this.source.slice(this.index))
      if (match === null) return null
      this.index += match[0].length
      if (this.source[this.index] === '?') this.index += 1
      return Number(match[1])
    }
    return null
  }

  private parseAtom(): Node {
    const char = this.source[this.index]!
    if (char === '(') return this.parseGroup()
    if (char === '[') {
      this.skipClass()
      return OPAQUE
    }
    if (char === '.') {
      this.index += 1
      return OPAQUE
    }
    if (char === '^' || char === '$') {
      this.index += 1
      return OPAQUE
    }
    if (char === '\\') return this.parseEscape()
    // Stray quantifiers/braces are not literal atoms we are willing to trust.
    if (char === '*' || char === '+' || char === '?' || char === '{' || char === '}') {
      this.index += 1
      return OPAQUE
    }
    this.index += 1
    return literalNode(char)
  }

  private parseGroup(): Node {
    this.index += 1 // (
    if (this.source[this.index] !== '?') {
      const child = this.parseAlternation()
      if (this.source[this.index] === ')') this.index += 1
      return child
    }
    this.index += 1 // ?
    const kind = this.source[this.index]
    if (kind === ':') {
      this.index += 1
      const child = this.parseAlternation()
      if (this.source[this.index] === ')') this.index += 1
      return child
    }
    if (kind === '=' || kind === '!') {
      this.skipToGroupEnd()
      return OPAQUE
    }
    if (kind === '<') {
      const next = this.source[this.index + 1]
      if (next === '=' || next === '!') {
        this.skipToGroupEnd()
        return OPAQUE
      }
      // Named capturing group: (?<name> ... )
      const end = this.source.indexOf('>', this.index + 1)
      this.index = end >= 0 ? end + 1 : this.index + 1
      const child = this.parseAlternation()
      if (this.source[this.index] === ')') this.index += 1
      return child
    }
    // Unknown (?...) construct: skip it entirely rather than guessing.
    this.skipToGroupEnd()
    return OPAQUE
  }

  /** Skip the rest of the current group, including its closing `)`. */
  private skipToGroupEnd(): void {
    let depth = 1
    while (this.index < this.source.length) {
      const char = this.source[this.index]!
      if (char === '\\') {
        this.index += 2
        continue
      }
      if (char === '[') {
        this.skipClass()
        continue
      }
      if (char === '(') {
        depth += 1
        this.index += 1
        continue
      }
      if (char === ')') {
        depth -= 1
        this.index += 1
        if (depth === 0) return
        continue
      }
      this.index += 1
    }
  }

  private skipClass(): void {
    this.index += 1 // [
    if (this.source[this.index] === '^') this.index += 1
    if (this.source[this.index] === ']') this.index += 1
    while (this.index < this.source.length) {
      const char = this.source[this.index]!
      if (char === '\\') {
        this.index += 2
        continue
      }
      this.index += 1
      if (char === ']') return
    }
  }

  private parseEscape(): Node {
    this.index += 1 // backslash
    if (this.index >= this.source.length) return OPAQUE
    const char = this.source[this.index]!
    this.index += 1
    if ('dDsSwW'.includes(char)) return OPAQUE
    // \b / \B are word boundaries here (outside a class).
    if (char === 'b' || char === 'B') return OPAQUE
    if (char === 'p' || char === 'P') {
      if (this.source[this.index] === '{') {
        const end = this.source.indexOf('}', this.index + 1)
        this.index = end >= 0 ? end + 1 : this.source.length
      }
      return OPAQUE
    }
    if (char === 'k') {
      if (this.source[this.index] === '<') {
        const end = this.source.indexOf('>', this.index + 1)
        this.index = end >= 0 ? end + 1 : this.source.length
      }
      return OPAQUE
    }
    if (char >= '1' && char <= '9') {
      while (this.source[this.index] !== undefined && /[0-9]/.test(this.source[this.index]!)) {
        this.index += 1
      }
      return OPAQUE
    }
    if (char === 'x') {
      const hex = this.source.slice(this.index, this.index + 2)
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        this.index += 2
        return literalNode(String.fromCharCode(Number.parseInt(hex, 16)))
      }
      return OPAQUE
    }
    if (char === 'u') {
      if (this.source[this.index] === '{') {
        const end = this.source.indexOf('}', this.index + 1)
        if (end < 0) return OPAQUE
        const hex = this.source.slice(this.index + 1, end)
        this.index = end + 1
        if (!/^[0-9a-fA-F]+$/.test(hex)) return OPAQUE
        const code = Number.parseInt(hex, 16)
        return code <= 0x10ffff ? literalNode(String.fromCodePoint(code)) : OPAQUE
      }
      const hex = this.source.slice(this.index, this.index + 4)
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        this.index += 4
        return literalNode(String.fromCharCode(Number.parseInt(hex, 16)))
      }
      return OPAQUE
    }
    if (char === 'c') {
      if (this.source[this.index] !== undefined) this.index += 1
      return OPAQUE
    }
    // Control escapes and octal escapes can span line boundaries or are too
    // easy to get subtly wrong; they never contribute a prefilter literal.
    if ('nrtfv0'.includes(char)) return OPAQUE
    // An escaped metacharacter (\. \* \\ ...) is an ordinary character.
    return literalNode(char)
  }
}

export function planGrep(pattern: string, ignoreCase: boolean): GrepPlan {
  let root = OPAQUE
  try {
    root = new Parser(pattern).parse()
  } catch {
    root = OPAQUE
  }
  const flags = ignoreCase ? 'i' : ''
  let literal: string | null = null
  for (const text of allRequired(root)) {
    if (text.includes('\n') || text.includes('\r')) continue
    if (ignoreCase && !isAscii(text)) continue
    if (Buffer.byteLength(text, 'utf8') < 3) continue
    if (literal === null || Buffer.byteLength(text, 'utf8') > Buffer.byteLength(literal, 'utf8')) {
      literal = text
    }
  }
  let pure: string | null = root.pure
  if (
    pure !== null &&
    (pure === '' ||
      pure.includes('\n') ||
      pure.includes('\r') ||
      (ignoreCase && !isAscii(pure)))
  ) {
    pure = null
  }
  if (pure !== null) literal = pure
  return { source: pattern, flags, literal, pure, ignoreCase }
}
