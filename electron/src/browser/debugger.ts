// Debugger 域:脚本注册表、源码检索、断点与暂停帧。
//
// 只依赖一个 `Sender`(方法名绑定到某个 CDP 会话),不关心页面如何选中,
// 页级会话与 frame 级会话都能复用同一套状态机。

type CdpParams = Record<string, unknown>

export type Sender = (method: string, params?: CdpParams) => Promise<CdpParams>

export interface ScriptInfo {
  scriptId: string
  url: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  hash?: string
  sourceMapURL?: string
  executionContextId?: number
}

export interface BreakpointInfo {
  breakpointId: string
  url?: string
  scriptId?: string
  lineNumber: number
  columnNumber: number
  text?: string
}

export interface CallFrameInfo {
  callFrameId: string
  functionName: string
  url: string
  lineNumber: number
  columnNumber: number
  scopes: { type: string; name?: string; objectId?: string }[]
}

export interface PausedInfo {
  reason: string
  hitBreakpoints: string[]
  callFrames: CallFrameInfo[]
}

export interface SearchMatch {
  scriptId: string
  url: string
  lineNumber: number
  columnNumber: number
  lineText: string
}

export interface ScopeVariable {
  scope: string
  name: string
  value: string
}

const MAX_SOURCE_CHARS = 4_000_000

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 0-based offset → 0-based line/column. */
export function locationOfOffset(source: string, offset: number): { line: number; column: number } {
  let line = 0
  let lastNewline = -1
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1
      lastNewline = index
    }
  }
  return { line, column: offset - lastNewline - 1 }
}

export function lineOf(source: string, offset: number): string {
  const start = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  const end = source.indexOf('\n', offset)
  return source.slice(start, end === -1 ? source.length : end)
}

export function sourceOffset(source: string, line: number, column: number): number {
  let offset = 0
  let current = 0
  while (current < line) {
    const next = source.indexOf('\n', offset)
    if (next === -1) return source.length
    offset = next + 1
    current += 1
  }
  return Math.min(source.length, offset + column)
}

function remoteSummary(raw: unknown): string {
  const record = asRecord(raw)
  if (!record) return ''
  const type = text(record.type) ?? 'unknown'
  if (type === 'string') return text(record.value) ?? ''
  if (type === 'number' || type === 'boolean') return String(record.value ?? '')
  if (type === 'undefined') return 'undefined'
  return text(record.description) ?? text(record.unserializableValue) ?? type
}

export class TabDebugger {
  readonly scripts = new Map<string, ScriptInfo>()
  readonly breakpoints = new Map<string, BreakpointInfo>()
  readonly xhrBreakpoints = new Set<string>()
  readonly #sender: Sender
  readonly #sources = new Map<string, string>()
  #pauseWaiters: ((state: PausedInfo | null) => void)[] = []
  enabled = false
  paused: PausedInfo | null = null

  constructor(sender: Sender) {
    this.#sender = sender
  }

  async enable(): Promise<void> {
    if (this.enabled) return
    await this.#sender('Debugger.enable', { maxScriptsCacheSize: 100_000_000 })
    this.enabled = true
  }

  clearScripts(): void {
    this.scripts.clear()
    this.#sources.clear()
  }

  handle(method: string, params: CdpParams): void {
    if (method === 'Debugger.scriptParsed') {
      const scriptId = text(params.scriptId)
      if (!scriptId) return
      this.scripts.set(scriptId, {
        scriptId,
        url: text(params.url) ?? '',
        startLine: number(params.startLine) ?? 0,
        startColumn: number(params.startColumn) ?? 0,
        endLine: number(params.endLine) ?? 0,
        endColumn: number(params.endColumn) ?? 0,
        hash: text(params.hash),
        sourceMapURL: text(params.sourceMapURL),
        executionContextId: number(params.executionContextId),
      })
      return
    }
    if (method === 'Debugger.paused') {
      const raw = Array.isArray(params.callFrames) ? params.callFrames : []
      const callFrames: CallFrameInfo[] = []
      for (const entry of raw) {
        const frame = asRecord(entry)
        if (!frame) continue
        const location = asRecord(frame.location)
        const scopeChain = Array.isArray(frame.scopeChain) ? frame.scopeChain : []
        const scopes: CallFrameInfo['scopes'] = []
        for (const entryScope of scopeChain) {
          const scope = asRecord(entryScope)
          if (!scope) continue
          scopes.push({
            type: text(scope.type) ?? '',
            name: text(scope.name),
            objectId: text(asRecord(scope.object)?.objectId),
          })
        }
        callFrames.push({
          callFrameId: text(frame.callFrameId) ?? '',
          functionName: text(frame.functionName) || '(anonymous)',
          url: text(frame.url) ?? '',
          lineNumber: number(location?.lineNumber) ?? 0,
          columnNumber: number(location?.columnNumber) ?? 0,
          scopes,
        })
      }
      const rawHits: unknown[] = Array.isArray(params.hitBreakpoints) ? params.hitBreakpoints : []
      this.paused = {
        reason: text(params.reason) ?? 'other',
        hitBreakpoints: rawHits.filter((id): id is string => typeof id === 'string'),
        callFrames,
      }
      const waiters = this.#pauseWaiters
      this.#pauseWaiters = []
      for (const waiter of waiters) waiter(this.paused)
      return
    }
    if (method === 'Debugger.resumed') {
      this.paused = null
      return
    }
    if (method === 'Debugger.breakpointResolved') {
      const breakpointId = text(params.breakpointId)
      const current = breakpointId ? this.breakpoints.get(breakpointId) : undefined
      const location = asRecord(params.location)
      if (current && location) {
        current.scriptId = text(location.scriptId) ?? current.scriptId
        current.lineNumber = number(location.lineNumber) ?? current.lineNumber
        current.columnNumber = number(location.columnNumber) ?? current.columnNumber
      }
    }
  }

  waitForPaused(timeoutMs = 10_000): Promise<PausedInfo | null> {
    if (this.paused) return Promise.resolve(this.paused)
    return new Promise((resolve) => {
      const done = (state: PausedInfo | null): void => {
        clearTimeout(timer)
        resolve(state)
      }
      const timer = setTimeout(() => {
        this.#pauseWaiters = this.#pauseWaiters.filter((waiter) => waiter !== done)
        resolve(null)
      }, timeoutMs)
      timer.unref?.()
      this.#pauseWaiters.push(done)
    })
  }

  async source(scriptId: string): Promise<string> {
    const cached = this.#sources.get(scriptId)
    if (cached !== undefined) return cached
    const result = await this.#sender('Debugger.getScriptSource', { scriptId })
    const source = typeof result.scriptSource === 'string' ? result.scriptSource : ''
    if (source.length <= MAX_SOURCE_CHARS) this.#sources.set(scriptId, source)
    return source
  }

  scriptByUrl(url: string): ScriptInfo | undefined {
    for (const script of this.scripts.values()) if (script.url === url) return script
    return undefined
  }

  /** All scripts whose URL contains `filter`, most recently parsed last. */
  filterScripts(filter?: string): ScriptInfo[] {
    const needle = filter?.trim().toLowerCase() ?? ''
    const out: ScriptInfo[] = []
    for (const script of this.scripts.values()) {
      if (needle !== '' && !script.url.toLowerCase().includes(needle)) continue
      out.push(script)
    }
    return out
  }

  async search(
    query: string,
    options: { isRegex?: boolean; caseSensitive?: boolean; urlFilter?: string; max?: number },
  ): Promise<{ matches: SearchMatch[]; scanned: number; failed: number }> {
    const max = Math.max(1, Math.min(options.max ?? 50, 200))
    const flags = options.caseSensitive ? 'g' : 'gi'
    let pattern: RegExp
    try {
      pattern = options.isRegex ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
    } catch (error) {
      throw new Error(`搜索表达式无效:${error instanceof Error ? error.message : String(error)}`)
    }
    const matches: SearchMatch[] = []
    let scanned = 0
    let failed = 0
    for (const script of this.filterScripts(options.urlFilter)) {
      let source: string
      try {
        source = await this.source(script.scriptId)
      } catch {
        failed += 1
        continue
      }
      scanned += 1
      pattern.lastIndex = 0
      let hit = pattern.exec(source)
      while (hit !== null && matches.length < max) {
        const location = locationOfOffset(source, hit.index)
        matches.push({
          scriptId: script.scriptId,
          url: script.url,
          lineNumber: location.line,
          columnNumber: location.column,
          lineText: lineOf(source, hit.index).slice(0, 240),
        })
        hit = hit[0] === '' ? null : pattern.exec(source)
      }
      if (matches.length >= max) break
    }
    return { matches, scanned, failed }
  }

  /**
   * Set a breakpoint by locating literal text in the script source.
   * Returns the CDP breakpoint plus the resolved location so the model can step.
   */
  async setBreakpointOnText(
    needle: string,
    options: { urlFilter?: string; occurrence?: number },
  ): Promise<{ breakpointId: string; url: string; lineNumber: number; columnNumber: number }> {
    const wanted = Math.max(1, options.occurrence ?? 1)
    let seen = 0
    const errors: string[] = []
    for (const script of this.filterScripts(options.urlFilter)) {
      if (script.url === '') continue
      let source: string
      try {
        source = await this.source(script.scriptId)
      } catch (error) {
        errors.push(`${script.url}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      let index = source.indexOf(needle)
      while (index !== -1) {
        seen += 1
        if (seen < wanted) {
          index = source.indexOf(needle, index + Math.max(1, needle.length))
          continue
        }
        const location = locationOfOffset(source, index)
        const result = script.scriptId
          ? await this.#sender('Debugger.setBreakpoint', {
              location: {
                scriptId: script.scriptId,
                lineNumber: location.line,
                columnNumber: location.column,
              },
            })
          : await this.#sender('Debugger.setBreakpointByUrl', {
              url: script.url,
              lineNumber: location.line,
              columnNumber: location.column,
            })
        const breakpointId = text(result.breakpointId)
        if (!breakpointId) throw new Error('CDP 未返回 breakpointId')
        const actual = asRecord(result.actualLocation)
        const lineNumber = number(actual?.lineNumber) ?? location.line
        const columnNumber = number(actual?.columnNumber) ?? location.column
        this.breakpoints.set(breakpointId, {
          breakpointId,
          url: script.url,
          scriptId: text(actual?.scriptId) ?? script.scriptId,
          lineNumber,
          columnNumber,
          text: needle,
        })
        return { breakpointId, url: script.url, lineNumber, columnNumber }
      }
    }
    if (seen > 0) throw new Error(`文本出现了 ${seen} 次,但 occurrence=${wanted} 超出范围`)
    const hint = errors.length > 0 ? `;部分脚本源码读取失败:${errors.slice(0, 3).join(';')}` : ''
    throw new Error(`没有在已加载脚本中找到文本:${needle}${hint}`)
  }

  async setXhrBreakpoint(url: string): Promise<void> {
    await this.#sender('DOMDebugger.setXHRBreakpoint', { url })
    this.xhrBreakpoints.add(url)
  }

  async removeXhrBreakpoint(url: string): Promise<void> {
    await this.#sender('DOMDebugger.removeXHRBreakpoint', { url })
    this.xhrBreakpoints.delete(url)
  }

  async restoreXhrBreakpoints(): Promise<void> {
    for (const url of this.xhrBreakpoints) {
      await this.#sender('DOMDebugger.setXHRBreakpoint', { url }).catch(() => undefined)
    }
  }

  async removeBreakpoint(breakpointId: string): Promise<void> {
    await this.#sender('Debugger.removeBreakpoint', { breakpointId })
    this.breakpoints.delete(breakpointId)
  }

  async removeAllBreakpoints(): Promise<number> {
    const ids = [...this.breakpoints.keys()]
    for (const id of ids) await this.removeBreakpoint(id).catch(() => undefined)
    for (const url of [...this.xhrBreakpoints]) await this.removeXhrBreakpoint(url).catch(() => undefined)
    return ids.length
  }

  async resume(): Promise<void> {
    await this.#sender('Debugger.resume')
    this.paused = null
  }

  async pause(): Promise<PausedInfo | null> {
    await this.#sender('Debugger.pause')
    return this.waitForPaused(8000)
  }

  async step(kind: 'over' | 'into' | 'out'): Promise<PausedInfo | null> {
    const method = kind === 'into' ? 'Debugger.stepInto' : kind === 'out' ? 'Debugger.stepOut' : 'Debugger.stepOver'
    await this.#sender(method)
    return this.waitForPaused(8000)
  }

  /** Expand one frame's scopes into flat name/value pairs (one level). */
  async scopeVariables(frameIndex = 0, maxPerScope = 40): Promise<ScopeVariable[]> {
    const frame = this.paused?.callFrames[frameIndex]
    if (!frame) return []
    const out: ScopeVariable[] = []
    for (const scope of frame.scopes) {
      if (!scope.objectId) continue
      try {
        const result = await this.#sender('Runtime.getProperties', {
          objectId: scope.objectId,
          ownProperties: true,
        })
        const properties = Array.isArray(result.result) ? result.result : []
        let count = 0
        for (const entry of properties) {
          const property = asRecord(entry)
          if (!property) continue
          const name = text(property.name)
          if (!name || name === '__proto__') continue
          out.push({ scope: scope.type, name, value: remoteSummary(property.value) })
          count += 1
          if (count >= maxPerScope) break
        }
      } catch {
        /* scope 已被回收:跳过 */
      }
    }
    return out
  }

  async evaluateOnCallFrame(callFrameId: string, expression: string): Promise<unknown> {
    const result = await this.#sender('Debugger.evaluateOnCallFrame', {
      callFrameId,
      expression,
      returnByValue: true,
      awaitPromise: true,
      generatePreview: false,
    })
    const details = asRecord(result.exceptionDetails)
    if (details) {
      const exception = asRecord(details.exception)
      throw new Error(text(exception?.description) ?? text(details.text) ?? '求值失败')
    }
    const remote = asRecord(result.result)
    if (!remote) return undefined
    if ('value' in remote) return remote.value
    return remoteSummary(remote)
  }

  formatPaused(snapshot: PausedInfo | null, maxFrames = 10): string {
    if (!snapshot) return '当前没有暂停中的执行'
    const lines = [
      `暂停原因:${snapshot.reason}${snapshot.hitBreakpoints.length > 0 ? `;命中断点:${snapshot.hitBreakpoints.join(', ')}` : ''}`,
    ]
    const frames = snapshot.callFrames.slice(0, maxFrames)
    frames.forEach((frame, index) => {
      lines.push(
        `#${index} ${frame.functionName} (${frame.url || '<anonymous>'}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`,
      )
    })
    if (snapshot.callFrames.length > maxFrames) {
      lines.push(`...(共 ${snapshot.callFrames.length} 帧,只显示前 ${maxFrames} 帧)`)
    }
    return lines.join('\n')
  }
}