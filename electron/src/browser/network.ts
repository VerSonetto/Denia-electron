// 网络与 WebSocket 采集。
//
// 列表与状态来自 Playwright 的页面事件(不触碰 Network 域,避免导航期间的
// CDP 痕迹);请求 initiator 需要 CDP,由 manager 在首次用到时懒启用,并按
// url+method 回填到同一条记录。

export interface InitiatorFrame {
  functionName?: string
  url?: string
  lineNumber?: number
  columnNumber?: number
}

export interface NetworkEntry {
  id: number
  url: string
  method: string
  resourceType: string
  status?: number
  statusText?: string
  mimeType?: string
  postData?: string
  initiator?: { type?: string; frames: InitiatorFrame[] }
  startedAt: number
  endedAt?: number
  encodedDataLength?: number
  failed?: string
  pending: boolean
  frameUrl?: string
}

export interface SocketFrame {
  direction: 'sent' | 'received'
  opcode?: number
  payload: string
  time: number
}

export interface SocketEntry {
  id: number
  url: string
  createdAt: number
  closedAt?: number
  frames: SocketFrame[]
  truncatedFrames: number
}

const MAX_ENTRIES = 200
const MAX_SOCKETS = 20
const MAX_FRAMES = 200
const MAX_BODY = 200_000

function keyOf(url: string, method: string): string {
  return `${method} ${url}`
}

export function initiatorFrames(raw: unknown): InitiatorFrame[] {
  if (typeof raw !== 'object' || raw === null) return []
  const stack = (raw as Record<string, unknown>).stack
  if (typeof stack !== 'object' || stack === null) return []
  const frames = (stack as Record<string, unknown>).callFrames
  if (!Array.isArray(frames)) return []
  const out: InitiatorFrame[] = []
  for (const entry of frames) {
    if (typeof entry !== 'object' || entry === null) continue
    const frame = entry as Record<string, unknown>
    out.push({
      functionName: typeof frame.functionName === 'string' ? frame.functionName : undefined,
      url: typeof frame.url === 'string' ? frame.url : undefined,
      lineNumber: typeof frame.lineNumber === 'number' ? frame.lineNumber : undefined,
      columnNumber: typeof frame.columnNumber === 'number' ? frame.columnNumber : undefined,
    })
  }
  return out
}

export class NetworkRecorder {
  readonly #entries: NetworkEntry[] = []
  readonly #nextId = { value: 1 }
  readonly #byKey = new Map<string, number>()
  readonly #initiators = new Map<string, { initiator: { type?: string; frames: InitiatorFrame[] }; at: number }>()
  #byUrlMethodPending = new Map<string, number>()

  start(input: {
    url: string
    method: string
    resourceType: string
    postData?: string
    frameUrl?: string
  }): number {
    const id = this.#nextId.value++
    const entry: NetworkEntry = {
      id,
      url: input.url,
      method: input.method,
      resourceType: input.resourceType,
      postData: input.postData,
      frameUrl: input.frameUrl,
      startedAt: Date.now(),
      pending: true,
    }
    this.#entries.push(entry)
    this.#byUrlMethodPending.set(keyOf(input.url, input.method), id)
    const known = this.#initiators.get(keyOf(input.url, input.method))
    if (known) entry.initiator = known.initiator
    while (this.#entries.length > MAX_ENTRIES) this.#entries.shift()
    return id
  }

  response(
    id: number,
    input: { status?: number; statusText?: string; mimeType?: string },
  ): void {
    const entry = this.#entries.find((item) => item.id === id)
    if (!entry) return
    entry.status = input.status
    entry.statusText = input.statusText
    entry.mimeType = input.mimeType
  }

  finish(id: number, input: { failed?: string; encodedDataLength?: number } = {}): void {
    const entry = this.#entries.find((item) => item.id === id)
    if (!entry) return
    entry.pending = false
    entry.endedAt = Date.now()
    entry.failed = input.failed
    entry.encodedDataLength = input.encodedDataLength
  }

  /** CDP initiator arrives after the Playwright request; merge by url+method. */
  recordInitiator(url: string, method: string, initiator: { type?: string; frames: InitiatorFrame[] }): void {
    const key = keyOf(url, method)
    this.#initiators.set(key, { initiator, at: Date.now() })
    while (this.#initiators.size > MAX_ENTRIES) {
      const oldest = this.#initiators.keys().next().value
      if (oldest === undefined) break
      this.#initiators.delete(oldest)
    }
    const id = this.#byUrlMethodPending.get(key)
    if (id === undefined) return
    const entry = this.#entries.find((item) => item.id === id)
    if (entry) entry.initiator = initiator
    this.#byKey.set(key, id)
  }

  initiatorOf(id: number): NetworkEntry['initiator'] {
    return this.#entries.find((item) => item.id === id)?.initiator
  }

  /** Initiator for an entry, falling back to the url+method cache. */
  initiatorFor(entry: NetworkEntry): NetworkEntry['initiator'] {
    if (entry.initiator) return entry.initiator
    return this.#initiators.get(keyOf(entry.url, entry.method))?.initiator
  }

  list(filter?: string, max = 50): NetworkEntry[] {
    const needle = filter?.trim().toLowerCase() ?? ''
    const out: NetworkEntry[] = []
    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      const entry = this.#entries[index]
      if (!entry) continue
      if (needle !== '' && !entry.url.toLowerCase().includes(needle)) continue
      out.push(entry)
      if (out.length >= max) break
    }
    return out
  }

  get(id: number): NetworkEntry | undefined {
    return this.#entries.find((entry) => entry.id === id)
  }

  clear(): number {
    const count = this.#entries.length
    this.#entries.length = 0
    this.#byKey.clear()
    this.#byUrlMethodPending.clear()
    this.#initiators.clear()
    return count
  }

  pendingCount(): number {
    let count = 0
    for (const entry of this.#entries) if (entry.pending) count += 1
    return count
  }

  truncateBody(text: string): string {
    return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n...(已截断,共 ${text.length} 字符)` : text
  }
}

export class SocketRecorder {
  readonly #sockets: SocketEntry[] = []
  readonly #nextId = { value: 1 }

  create(url: string): number {
    const id = this.#nextId.value++
    this.#sockets.push({ id, url, createdAt: Date.now(), frames: [], truncatedFrames: 0 })
    while (this.#sockets.length > MAX_SOCKETS) this.#sockets.shift()
    return id
  }

  frame(id: number, direction: 'sent' | 'received', payload: string, opcode?: number): void {
    const socket = this.#sockets.find((entry) => entry.id === id)
    if (!socket) return
    socket.frames.push({
      direction,
      opcode,
      payload: payload.length > MAX_BODY ? payload.slice(0, MAX_BODY) : payload,
      time: Date.now(),
    })
    while (socket.frames.length > MAX_FRAMES) {
      socket.frames.shift()
      socket.truncatedFrames += 1
    }
  }

  close(id: number): void {
    const socket = this.#sockets.find((entry) => entry.id === id)
    if (socket) socket.closedAt = Date.now()
  }

  list(): SocketEntry[] {
    return [...this.#sockets]
  }

  get(id: number): SocketEntry | undefined {
    return this.#sockets.find((entry) => entry.id === id)
  }
}