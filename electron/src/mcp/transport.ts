// MCP transports: stdio (newline-delimited JSON), Streamable HTTP (POST), and
// HTTP+SSE (POST for requests, a long-lived event stream for responses).
//
// The protocol choreography lives in `client.ts`; a transport only sends one
// JSON-RPC frame and returns the matching response.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

import type { McpServerConfig } from './config.ts'
import {
  ACCEPT_JSON_OR_SSE,
  ACCEPT_SSE,
  HEADER_PROTOCOL_VERSION,
  HEADER_SESSION_ID,
  PROTOCOL_VERSION,
  notificationFrame,
  parseSseData,
  requestFrame,
  splitSseEvents,
} from './protocol.ts'
import type { JsonRpcResponse } from './protocol.ts'

export interface McpTransport {
  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown>
  notify(method: string, params?: unknown): Promise<void>
  shutdown(): Promise<void>
}

/** Serialize async sections (one request in flight per connection). */
class Mutex {
  private tail: Promise<void> = Promise.resolve()

  /** Queue like `run`, but drop the work if the turn was cancelled while queued. */
  async runSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      if (signal?.aborted) throw abortError()
      return await fn()
    } finally {
      release()
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

/** A signal that aborts on timeout or when the caller cancels the turn. */
function withCancel(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  if (signal) {
    const onAbort = () => {
      clearTimeout(timer)
      controller.abort()
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return controller.signal
}

function abortError(): Error {
  return new Error('请求已被取消')
}

function rpcError(error: { message: string; code: number }): Error {
  return new Error(`${error.message} (code ${error.code})`)
}

export function decodeResponseValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    throw new Error('响应不是 JSON-RPC 对象')
  }
  const response = value as JsonRpcResponse
  if (response.error) throw rpcError(response.error)
  return response.result ?? null
}

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

interface PendingStdio {
  signal?: AbortSignal
  onAbort?: () => void
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

class StdioTransport implements McpTransport {
  private readonly name: string
  private readonly child: ChildProcess
  private readonly pending = new Map<number, PendingStdio>()
  private readonly mutex = new Mutex()
  private nextId = 1
  private closed = false
  private stderrTail = ''

  constructor(name: string, child: ChildProcess) {
    this.name = name
    this.child = child
    const stdout = child.stdout
    if (!stdout) throw new Error('MCP 服务器 stdout 管道不可用')
    const lines = readline.createInterface({ input: stdout })
    lines.on('line', (line) => this.onLine(line))
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-8192)
    })
    child.once('exit', (code, signal) => {
      const reason = `服务器进程已退出(code=${code ?? 'null'}, signal=${signal ?? 'null'})${this.stderrTail.trim() ? `: ${this.stderrTail.trim().slice(-500)}` : ''}`
      this.failAll(new Error(reason))
    })
    child.once('error', (error) => this.failAll(error))
    child.stdin?.on('error', (error) => this.failAll(error))
  }

  static async connect(
    name: string,
    command: string,
    args: string[],
    env: Record<string, string>,
    cwd: string | null,
  ): Promise<StdioTransport> {
    const resolved = resolveProgram(command)
    const child = spawn(resolved.program, args, {
      cwd: cwd ?? undefined,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: resolved.consoleShim,
      detached: false,
    })
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off('error', onError)
        resolve()
      }
      const onError = (error: Error): void => {
        child.off('spawn', onSpawn)
        reject(new Error(`启动 MCP 服务器进程失败:${command}: ${error.message}`))
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
    return new StdioTransport(name, child)
  }

  private onLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed === '') return
    let value: unknown
    try {
      value = JSON.parse(trimmed) as unknown
    } catch {
      // Server logs mistakenly written to stdout must not poison the channel.
      return
    }
    if (typeof value !== 'object' || value === null) return
    const id = (value as { id?: unknown }).id
    if (typeof id !== 'number') return
    const waiter = this.pending.get(id)
    if (!waiter) return
    this.pending.delete(id)
    clearTimeout(waiter.timer)
    if (waiter.onAbort && waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort)
    waiter.resolve(value)
  }

  private failAll(error: Error): void {
    this.closed = true
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }

  private write(frame: unknown): void {
    if (this.closed) throw new Error(`MCP 服务器 ${this.name} 连接已断开`)
    const stdin = this.child.stdin
    if (!stdin || stdin.destroyed) throw new Error(`MCP 服务器 ${this.name} 的 stdin 不可用`)
    stdin.write(JSON.stringify(frame) + '\n')
  }

  async request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    return this.mutex.runSignal(signal, async () => {
      if (this.closed) throw new Error(`MCP 服务器 ${this.name} 连接已断开`)
      const id = this.nextId
      this.nextId += 1
      const response = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`MCP 请求超时(${method})`))
        }, timeoutMs)
        timer.unref?.()
        const waiter: PendingStdio = { resolve, reject, timer }
        this.pending.set(id, waiter)
        if (signal) {
          const onAbort = () => {
            if (this.pending.get(id) !== waiter) return
            this.pending.delete(id)
            clearTimeout(timer)
            reject(abortError())
          }
          waiter.signal = signal
          waiter.onAbort = onAbort
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
      })
      try {
        this.write(requestFrame(id, method, params))
      } catch (error) {
        const waiter = this.pending.get(id)
        if (waiter) {
          this.pending.delete(id)
          clearTimeout(waiter.timer)
        }
        throw error
      }
      const raw = await response
      return decodeResponseValue(raw)
    })
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.write(notificationFrame(method, params))
  }

  async shutdown(): Promise<void> {
    this.closed = true
    this.failAll(new Error(`MCP 服务器 ${this.name} 已关闭`))
    const pid = this.child.pid
    try {
      this.child.kill()
    } catch {
      /* already gone */
    }
    if (process.platform === 'win32' && typeof pid === 'number') {
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        }).unref()
      } catch {
        /* best effort */
      }
    }
  }
}

/** Windows resolves bare names through PATHEXT; CreateProcess does not. */
function resolveProgram(command: string): { program: string; consoleShim: boolean } {
  const isShim = (name: string): boolean => /\.(cmd|bat)$/i.test(name)
  if (process.platform !== 'win32') return { program: command, consoleShim: false }
  if (command.includes('/') || command.includes('\\')) {
    return { program: command, consoleShim: isShim(command) }
  }
  const exts = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'
  const lower = command.toLowerCase()
  if (exts.split(';').some((ext) => ext !== '' && lower.endsWith(ext.toLowerCase()))) {
    return { program: command, consoleShim: isShim(command) }
  }
  const pathVar = process.env.PATH ?? ''
  for (const dir of pathVar.split(path.delimiter)) {
    if (dir === '') continue
    for (const ext of exts.split(';')) {
      if (ext === '') continue
      const candidate = path.join(dir, `${command}${ext.toLowerCase()}`)
      try {
        if (fs.statSync(candidate).isFile()) {
          return { program: candidate, consoleShim: isShim(candidate) }
        }
      } catch {
        /* keep looking */
      }
    }
  }
  return { program: command, consoleShim: false }
}

// ---------------------------------------------------------------------------
// Streamable HTTP
// ---------------------------------------------------------------------------

class HttpTransport implements McpTransport {
  private readonly name: string
  private readonly url: string
  private readonly headers: Record<string, string>
  private sessionId: string | null = null
  private nextId = 1
  private readonly mutex = new Mutex()

  constructor(name: string, url: string, headers: Record<string, string>) {
    this.name = name
    this.url = url
    this.headers = headers
  }

  private requestHeaders(accept = ACCEPT_JSON_OR_SSE): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept,
      [HEADER_PROTOCOL_VERSION]: PROTOCOL_VERSION,
      ...this.headers,
      ...(this.sessionId ? { [HEADER_SESSION_ID]: this.sessionId } : {}),
    }
  }

  private async post(frame: unknown, timeoutMs: number, expectBody: boolean, signal?: AbortSignal): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: this.requestHeaders(),
        body: JSON.stringify(frame),
        signal: withCancel(timeoutMs, signal),
      })
    } catch (error) {
      throw new Error(`请求 ${this.url} 失败:${errorMessage(error)}`)
    }
    const session = response.headers.get(HEADER_SESSION_ID)
    if (session && session.trim() !== '') this.sessionId = session
    if (!response.ok) {
      throw new Error(`MCP 服务器 ${this.name} 返回 HTTP ${response.status}`)
    }
    if (!expectBody) return null
    const text = await response.text()
    const contentType = response.headers.get('content-type') ?? ''
    let jsonText = text
    if (contentType.includes('text/event-stream')) {
      const data = parseSseData(text)
      if (data === null) throw new Error('SSE 响应里没有 data 报文')
      jsonText = data
    }
    try {
      return JSON.parse(jsonText.trim()) as unknown
    } catch (error) {
      throw new Error(`响应不是合法 JSON:${errorMessage(error)}`)
    }
  }

  async request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    return this.mutex.runSignal(signal, async () => {
      const id = this.nextId
      this.nextId += 1
      const raw = await this.post(requestFrame(id, method, params), timeoutMs, true, signal)
      return decodeResponseValue(raw)
    })
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.post(notificationFrame(method, params), 10_000, false)
  }

  async shutdown(): Promise<void> {
    if (!this.sessionId) return
    try {
      await fetch(this.url, {
        method: 'DELETE',
        headers: this.requestHeaders(),
        signal: AbortSignal.timeout(5_000),
      })
    } catch {
      /* best effort */
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP + SSE
// ---------------------------------------------------------------------------

interface SseWaiter {
  signal?: AbortSignal
  onAbort?: () => void
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

class SseTransport implements McpTransport {
  private readonly name: string
  private readonly headers: Record<string, string>
  private readonly controller = new AbortController()
  private readonly waiters = new Map<number, SseWaiter>()
  private readonly mutex = new Mutex()
  private postUrl: string
  private nextId = 1
  private closed = false

  private constructor(name: string, url: string, headers: Record<string, string>) {
    this.name = name
    this.postUrl = url
    this.headers = headers
  }

  static async connect(
    name: string,
    url: string,
    headers: Record<string, string>,
    waitMs: number,
  ): Promise<SseTransport> {
    const transport = new SseTransport(name, url, headers)
    const response = await fetch(url, {
      headers: {
        accept: ACCEPT_SSE,
        [HEADER_PROTOCOL_VERSION]: PROTOCOL_VERSION,
        ...headers,
      },
      signal: transport.controller.signal,
    })
    if (!response.ok) {
      throw new Error(`MCP 服务器 ${name} 的 SSE 端点返回 HTTP ${response.status}`)
    }
    if (!response.body) throw new Error('SSE 流没有响应体')
    const endpoint = new Promise<string>((resolve) => {
      transport.endpointResolve = resolve
    })
    void transport.readLoop(response.body)
    const timeout = new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), waitMs)
      timer.unref?.()
    })
    const resolved = await Promise.race([endpoint, timeout])
    if (resolved !== null) transport.postUrl = resolved
    return transport
  }

  private endpointResolve: ((url: string) => void) | null = null

  private async readLoop(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const split = splitSseEvents(buffer)
        buffer = split.rest
        for (const event of split.events) {
          if (event.event === 'endpoint') {
            const endpoint = parseEndpoint(event.data, this.postUrl)
            if (endpoint) this.endpointResolve?.(endpoint)
            continue
          }
          let payload: unknown
          try {
            payload = JSON.parse(event.data) as unknown
          } catch {
            continue
          }
          const id = typeof payload === 'object' && payload !== null
            ? (payload as { id?: unknown }).id
            : undefined
          if (typeof id !== 'number') continue
          const waiter = this.waiters.get(id)
          if (!waiter) continue
          this.waiters.delete(id)
          clearTimeout(waiter.timer)
          waiter.resolve(payload)
        }
      }
    } catch (error) {
      if (!this.closed) this.failAll(new Error(`SSE 流中断:${errorMessage(error)}`))
    }
  }

  private failAll(error: Error): void {
    this.closed = true
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.waiters.clear()
  }

  private async post(frame: unknown, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    let response: Response
    try {
      response = await fetch(this.postUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: ACCEPT_SSE,
          [HEADER_PROTOCOL_VERSION]: PROTOCOL_VERSION,
          ...this.headers,
        },
        body: JSON.stringify(frame),
        signal: withCancel(timeoutMs, signal),
      })
    } catch (error) {
      throw new Error(`POST ${this.postUrl} 失败:${errorMessage(error)}`)
    }
    if (!response.ok) {
      throw new Error(`MCP 服务器 ${this.name} 的 POST 端点返回 HTTP ${response.status}`)
    }
  }

  async request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    return this.mutex.runSignal(signal, async () => {
      if (this.closed) throw new Error(`MCP 服务器 ${this.name} 连接已断开`)
      const id = this.nextId
      this.nextId += 1
      const waiting = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiters.delete(id)
          reject(new Error(`MCP 请求超时(${method})`))
        }, timeoutMs)
        timer.unref?.()
        const waiter: SseWaiter = { resolve, reject, timer }
        this.waiters.set(id, waiter)
        if (signal) {
          const onAbort = () => {
            if (this.waiters.get(id) !== waiter) return
            this.waiters.delete(id)
            clearTimeout(timer)
            reject(abortError())
          }
          waiter.signal = signal
          waiter.onAbort = onAbort
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
      })
      try {
        await this.post(requestFrame(id, method, params), timeoutMs, signal)
      } catch (error) {
        const waiter = this.waiters.get(id)
        if (waiter) {
          this.waiters.delete(id)
          clearTimeout(waiter.timer)
        }
        throw error
      }
      return decodeResponseValue(await waiting)
    })
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.post(notificationFrame(method, params), 10_000)
  }

  async shutdown(): Promise<void> {
    this.closed = true
    this.controller.abort()
    this.failAll(new Error(`MCP 服务器 ${this.name} 已关闭`))
  }
}

function parseEndpoint(data: string, base: string): string | null {
  const endpoint = data.trim().replace(/^"|"$/g, '')
  if (endpoint === '') return null
  if (/^https?:\/\//i.test(endpoint)) return endpoint
  try {
    return new URL(endpoint, base).toString()
  } catch {
    return null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function createTransport(config: McpServerConfig): Promise<McpTransport> {
  switch (config.transport) {
    case 'stdio':
      return StdioTransport.connect(config.id, config.command, config.args, config.env, config.cwd)
    case 'http':
      if (!config.url) throw new Error('http 传输缺少 url')
      return new HttpTransport(config.id, config.url, config.headers)
    case 'sse':
      if (!config.url) throw new Error('sse 传输缺少 url')
      return SseTransport.connect(config.id, config.url, config.headers, 10_000)
    default:
      throw new Error(`不支持的传输方式:${config.transport}(可用:stdio / http / sse)`)
  }
}