// Denia private relay: a small untrusted WebSocket courier (this file's
// RelayServer) plus the host's outbound client (RelayHostClient). The relay
// only pairs a host-control socket, one host-data socket per client, and
// forwards opaque frames. E2EE, HTTP/SSE multiplexing and loopback dispatch
// live in RelayHostClient.

import crypto from 'node:crypto'
import http from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

import { WebSocket, WebSocketServer } from 'ws'

import {
  createRelayDecryptor,
  createRelayEncryptor,
  decodeJsonPayload,
  decodeTunnelFrame,
  deriveRelaySessionKeys,
  encodeJsonPayload,
  encodeTunnelFrame,
  MAX_TUNNEL_PAYLOAD_BYTES,
  TunnelFrameType,
  type RelayIdentity,
  type RelayPublicJwk,
} from './relay-crypto.ts'
import { relayProofHeaders, RELAY_PROOF_HEADER } from './relay-provenance.ts'

const MAX_CLIENTS = 16
const MAX_CONNECTS_PER_MIN = 60
const MAX_PENDING_BYTES = 2 * 1024 * 1024
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024
const HOST_STUCK_MS = 15_000
const BACKPRESSURE_LIMIT_BYTES = 4 * 1024 * 1024

interface PendingBuffer {
  frames: { data: Buffer; isBinary: boolean }[]
  bytes: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const textOf = (data: Buffer | ArrayBuffer | Buffer[]): string => {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

const binaryOf = (data: Buffer | ArrayBuffer | Buffer[]): Buffer => {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

const safeClose = (ws: WebSocket, code: number, reason: string): void => {
  try {
    ws.close(code, reason)
  } catch {
    // already closed
  }
}

const safeSend = (ws: WebSocket, data: Buffer | string, isBinary = true): boolean => {
  try {
    ws.send(data, { binary: isBinary })
    return true
  } catch {
    return false
  }
}

// —— relay server ——

class RelayRoom {
  readonly serverId: string
  private control: WebSocket | null = null
  private readonly hostData = new Map<string, WebSocket>()
  private readonly clients = new Map<string, WebSocket>()
  private readonly pending = new Map<string, PendingBuffer>()
  private readonly stuck = new Map<string, NodeJS.Timeout>()
  private clientConnectTimes: number[] = []

  constructor(serverId: string) {
    this.serverId = serverId
  }

  attachControl(ws: WebSocket): void {
    if (this.control && this.control !== ws) {
      const old = this.control
      this.control = null
      safeClose(old, 4001, 'Control replaced')
    }
    this.control = ws
    ws.on('message', () => {
      // Host-control messages are reserved for future use. Data is opaque.
    })
    ws.on('close', () => {
      if (this.control !== ws) return
      this.control = null
      for (const client of this.clients.values()) safeClose(client, 1011, 'Host disconnected')
      this.clients.clear()
      for (const socket of this.hostData.values()) safeClose(socket, 1011, 'Host disconnected')
      this.hostData.clear()
      this.pending.clear()
      for (const timer of this.stuck.values()) clearTimeout(timer)
      this.stuck.clear()
    })
    ws.on('error', () => {})
    safeSend(ws, JSON.stringify({ type: 'sync', connectionIds: [...this.clients.keys()] }), false)
  }

  attachData(connectionId: string, ws: WebSocket): void {
    const stale = this.hostData.get(connectionId)
    if (stale) {
      this.hostData.delete(connectionId)
      safeClose(stale, 1008, 'Replaced by new connection')
    }
    this.hostData.set(connectionId, ws)
    const timer = this.stuck.get(connectionId)
    if (timer) {
      clearTimeout(timer)
      this.stuck.delete(connectionId)
    }
    ws.on('message', (data, isBinary) => {
      const client = this.clients.get(connectionId)
      if (client) safeSend(client, binaryOf(data), isBinary)
    })
    ws.on('close', () => {
      if (this.hostData.get(connectionId) !== ws) return
      this.hostData.delete(connectionId)
      const client = this.clients.get(connectionId)
      this.clients.delete(connectionId)
      this.pending.delete(connectionId)
      if (client) safeClose(client, 1011, 'Host data closed')
    })
    ws.on('error', () => {})
    this.flushPending(connectionId)
  }

  rejectionReason(): string | null {
    const now = Date.now()
    this.clientConnectTimes = this.clientConnectTimes.filter((at) => now - at < 60_000)
    if (this.clients.size >= MAX_CLIENTS) return 'Too many concurrent clients'
    if (this.clientConnectTimes.length >= MAX_CONNECTS_PER_MIN) return 'Too many connects'
    return null
  }

  attachClient(connectionId: string, ws: WebSocket): void {
    this.clientConnectTimes.push(Date.now())
    const duplicate = this.clients.get(connectionId)
    if (duplicate) {
      this.clients.delete(connectionId)
      safeClose(duplicate, 4002, 'Duplicate client')
    }
    this.clients.set(connectionId, ws)
    this.notifyControl({ type: 'connected', connectionId })
    ws.on('message', (data, isBinary) => {
      const target = this.hostData.get(connectionId)
      if (!target) {
        this.buffer(connectionId, binaryOf(data), isBinary, ws)
        return
      }
      safeSend(target, binaryOf(data), isBinary)
    })
    ws.on('close', () => {
      if (this.clients.get(connectionId) !== ws) return
      this.clients.delete(connectionId)
      this.pending.delete(connectionId)
      const timer = this.stuck.get(connectionId)
      if (timer) clearTimeout(timer)
      this.stuck.delete(connectionId)
      const data = this.hostData.get(connectionId)
      if (data) {
        this.hostData.delete(connectionId)
        safeClose(data, 1000, 'Client closed')
      }
      this.notifyControl({ type: 'disconnected', connectionId })
    })
    ws.on('error', () => {})
    if (!this.hostData.has(connectionId)) {
      this.stuck.set(
        connectionId,
        setTimeout(() => {
          const client = this.clients.get(connectionId)
          if (!client || this.hostData.has(connectionId)) return
          safeClose(client, 4008, 'Host unavailable')
        }, HOST_STUCK_MS),
      )
    }
  }

  close(): void {
    for (const client of this.clients.values()) safeClose(client, 1012, 'Relay stopping')
    for (const socket of this.hostData.values()) safeClose(socket, 1012, 'Relay stopping')
    if (this.control) safeClose(this.control, 1012, 'Relay stopping')
    this.clients.clear()
    this.hostData.clear()
    this.pending.clear()
    for (const timer of this.stuck.values()) clearTimeout(timer)
    this.stuck.clear()
  }

  isEmpty(): boolean {
    return this.control === null && this.hostData.size === 0 && this.clients.size === 0
  }

  clientsForStatus(): number {
    return this.clients.size
  }

  private notifyControl(message: unknown): void {
    if (!this.control) return
    safeSend(this.control, JSON.stringify(message), false)
  }

  private buffer(connectionId: string, data: Buffer, isBinary: boolean, client: WebSocket): void {
    let entry = this.pending.get(connectionId)
    if (!entry) {
      entry = { frames: [], bytes: 0 }
      this.pending.set(connectionId, entry)
    }
    if (entry.frames.length >= 200 || entry.bytes + data.length > MAX_PENDING_BYTES) {
      this.pending.delete(connectionId)
      safeClose(client, 4029, 'Host buffer overflow')
      return
    }
    entry.frames.push({ data, isBinary })
    entry.bytes += data.length
  }

  private flushPending(connectionId: string): void {
    const entry = this.pending.get(connectionId)
    const target = this.hostData.get(connectionId)
    if (!entry || !target) return
    this.pending.delete(connectionId)
    for (const frame of entry.frames) safeSend(target, frame.data, frame.isBinary)
  }
}

export interface RelayServerStatus {
  listening: boolean
  port: number | null
  clients: number
  rooms: number
}

export class RelayServer {
  private server: http.Server | null = null
  private wss: WebSocketServer | null = null
  private hostToken = ''
  private readonly rooms = new Map<string, RelayRoom>()
  private port = 0

  async start(hostToken: string, listenPort = 0): Promise<RelayServerStatus> {
    await this.stop()
    this.hostToken = hostToken
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, service: 'denia-relay' }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(listenPort, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    this.port = typeof address === 'object' && address ? address.port : listenPort
    this.server = server
    this.wss = wss
    return this.status()
  }

  async stop(): Promise<void> {
    for (const room of this.rooms.values()) room.close()
    this.rooms.clear()
    this.wss?.close()
    this.wss = null
    const server = this.server
    this.server = null
    if (server) {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  status(): RelayServerStatus {
    let clients = 0
    for (const room of this.rooms.values()) clients += room.clientsForStatus()
    return { listening: this.server !== null, port: this.port || null, clients, rooms: this.rooms.size }
  }

  private room(serverId: string): RelayRoom {
    let room = this.rooms.get(serverId)
    if (!room) {
      room = new RelayRoom(serverId)
      this.rooms.set(serverId, room)
    }
    return room
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://relay.local')
    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }
    const role = url.searchParams.get('role') ?? ''
    const serverId = url.searchParams.get('serverId') ?? ''
    if (!serverId || !/^[0-9a-f]{8,64}$/i.test(serverId)) {
      rejectUpgrade(socket, 400, 'Invalid serverId')
      return
    }
    if (role === 'host-control' || role === 'host-data') {
      if (url.searchParams.get('token') !== this.hostToken) {
        rejectUpgrade(socket, 401, 'Unauthorized')
        return
      }
      if (role === 'host-data' && !url.searchParams.get('connectionId')) {
        rejectUpgrade(socket, 400, 'Missing connectionId')
        return
      }
    } else if (role === 'client') {
      const room = this.room(serverId)
      const rejection = room.rejectionReason()
      if (rejection) {
        // Complete the upgrade then close with the relay code so clients can
        // distinguish limit errors from transport failures.
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          safeClose(ws, 4029, rejection)
        })
        return
      }
    } else {
      rejectUpgrade(socket, 400, 'Invalid role')
      return
    }

    this.wss!.handleUpgrade(req, socket, head, (ws) => {
      const room = this.room(serverId)
      if (role === 'host-control') {
        room.attachControl(ws)
      } else if (role === 'host-data') {
        room.attachData(url.searchParams.get('connectionId')!, ws)
      } else {
        const connectionId =
          url.searchParams.get('connectionId') ??
          `conn_${crypto.randomBytes(8).toString('hex')}`
        room.attachClient(connectionId, ws)
      }
    })
  }
}

const rejectUpgrade = (socket: Duplex, status: number, message: string): void => {
  const statusText = status === 401 ? 'Unauthorized' : status === 400 ? 'Bad Request' : 'Error'
  socket.write(
    `HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  )
  socket.destroy()
}

// —— host side ——

export interface RelayHostStatus {
  state: 'idle' | 'connecting' | 'connected' | 'error'
  connectedClients: number
  lastError: string | null
}

interface HostDataSocket {
  socket: WebSocket
  opened: boolean
  dispatcher: TunnelDispatcher | null
  timer: NodeJS.Timeout | null
}

interface DiscoveredRequest {
  method: string
  path: string
  query: string
  headers: Record<string, string>
  hasBody: boolean
}

const ALLOWED_PATH = (pathname: string): boolean => pathname === '/api' || pathname.startsWith('/api/')

const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  RELAY_PROOF_HEADER.toLowerCase(),
])

const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding',
])

class TunnelDispatcher {
  private readonly streams = new Map<
    number,
    {
      abort: AbortController
      body: Buffer[]
      bodyBytes: number
      request: DiscoveredRequest | null
      started: boolean
    }
  >()

  private readonly connectionId: string
  private readonly remotePort: number
  private readonly send: (plaintext: Buffer) => Promise<void>
  private readonly close: (code: number, reason: string) => void

  constructor(
    connectionId: string,
    remotePort: number,
    send: (plaintext: Buffer) => Promise<void>,
    close: (code: number, reason: string) => void,
  ) {
    this.connectionId = connectionId
    this.remotePort = remotePort
    this.send = send
    this.close = close
  }

  handle(frame: ReturnType<typeof decodeTunnelFrame>): void {
    switch (frame.type) {
      case TunnelFrameType.HttpRequest: {
        const request = decodeJsonPayload<DiscoveredRequest>(frame.payload)
        if (
          typeof request.method !== 'string' ||
          typeof request.path !== 'string' ||
          typeof request.query !== 'string' ||
          typeof request.headers !== 'object'
        ) {
          this.close(1008, 'Malformed request')
          return
        }
        if (!ALLOWED_PATH(request.path)) {
          void this.sendJson(frame.streamId, 403, { error: 'relay/path-blocked' })
          return
        }
        this.streams.set(frame.streamId, {
          abort: new AbortController(),
          body: [],
          bodyBytes: 0,
          request,
          started: false,
        })
        if (!request.hasBody) void this.dispatch(frame.streamId)
        return
      }
      case TunnelFrameType.HttpBody: {
        const stream = this.streams.get(frame.streamId)
        if (!stream) return
        stream.bodyBytes += frame.payload.length
        if (stream.bodyBytes > MAX_REQUEST_BODY_BYTES) {
          stream.abort.abort()
          this.streams.delete(frame.streamId)
          void this.sendAbort(frame.streamId, 'body exceeds limit')
          return
        }
        stream.body.push(Buffer.from(frame.payload))
        return
      }
      case TunnelFrameType.StreamEnd: {
        void this.dispatch(frame.streamId)
        return
      }
      case TunnelFrameType.StreamAbort: {
        const stream = this.streams.get(frame.streamId)
        if (!stream) return
        stream.abort.abort()
        this.streams.delete(frame.streamId)
        return
      }
      case TunnelFrameType.Ping:
        void this.send(encodeTunnelFrame(TunnelFrameType.Pong, 0, frame.payload))
        return
      default:
        return
    }
  }

  closeAll(reason: string): void {
    for (const stream of this.streams.values()) {
      stream.abort.abort()
      void this.sendAbort(-1, reason).catch(() => {})
    }
    this.streams.clear()
  }

  private async dispatch(streamId: number): Promise<void> {
    const stream = this.streams.get(streamId)
    if (!stream || !stream.request || stream.started) return
    stream.started = true
    const request = stream.request
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value !== 'string') continue
      const lower = name.toLowerCase()
      if (STRIPPED_REQUEST_HEADERS.has(lower)) continue
      if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) continue
      headers[lower] = value
    }
    const body = stream.body.length
      ? Buffer.concat(stream.body)
      : request.method === 'GET' || request.method === 'HEAD'
        ? null
        : Buffer.alloc(0)
    Object.assign(headers, relayProofHeaders())
    headers['x-denia-relay-connection'] = this.connectionId
    headers['accept-encoding'] = 'identity'
    headers.origin = `http://127.0.0.1:${this.remotePort}`
    const query = request.query ? `?${request.query}` : ''
    const url = `http://127.0.0.1:${this.remotePort}${request.path}${query}`
    let response: Response
    try {
      response = await fetch(url, {
        method: request.method,
        headers,
        body,
        signal: stream.abort.signal,
        redirect: 'manual',
        ...(body ? { duplex: 'half' as const } : {}),
      })
    } catch (error) {
      if (this.streams.get(streamId) !== stream) return
      this.streams.delete(streamId)
      await this.sendAbort(streamId, error instanceof Error ? error.message : 'loopback request failed')
      return
    }

    const responseHeaders: Record<string, string> = {}
    for (const [name, value] of response.headers.entries()) {
      if (STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue
      responseHeaders[name.toLowerCase()] = value
    }
    await this.send(
      encodeTunnelFrame(
        TunnelFrameType.HttpResponse,
        streamId,
        encodeJsonPayload({ status: response.status, headers: responseHeaders }),
      ),
    )

    if (response.body) {
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (this.streams.get(streamId) !== stream) break
          for (let offset = 0; offset < value.length; offset += MAX_TUNNEL_PAYLOAD_BYTES) {
            const chunk = value.subarray(offset, offset + MAX_TUNNEL_PAYLOAD_BYTES)
            await this.send(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, chunk))
          }
        }
      } catch {
        // Aborted or transport gone; the client already sees a failed stream.
      } finally {
        reader.releaseLock()
      }
    }
    if (this.streams.get(streamId) === stream) {
      this.streams.delete(streamId)
      await this.send(encodeTunnelFrame(TunnelFrameType.StreamEnd, streamId))
    }
  }

  private async sendJson(streamId: number, status: number, body: unknown): Promise<void> {
    await this.send(
      encodeTunnelFrame(
        TunnelFrameType.HttpResponse,
        streamId,
        encodeJsonPayload({ status, headers: { 'content-type': 'application/json' } }),
      ),
    )
    await this.send(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, encodeJsonPayload(body)))
    await this.send(encodeTunnelFrame(TunnelFrameType.StreamEnd, streamId))
  }

  private async sendAbort(streamId: number, reason: string): Promise<void> {
    await this.send(
      encodeTunnelFrame(TunnelFrameType.StreamAbort, streamId, encodeJsonPayload({ reason })),
    )
  }
}

export interface RelayHostClientOptions {
  relayUrl: string
  hostToken: string
  serverId: string
  identity: RelayIdentity
  remotePort: () => number
  onStatus?: (status: RelayHostStatus) => void
  logger?: Pick<Console, 'warn'>
}

export class RelayHostClient {
  private readonly options: RelayHostClientOptions
  private control: WebSocket | null = null
  private stopped = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private attempts = 0
  private readonly data = new Map<string, HostDataSocket>()
  private readonly pendingClients = new Set<string>()
  private state: RelayHostStatus = { state: 'idle', connectedClients: 0, lastError: null }

  constructor(options: RelayHostClientOptions) {
    this.options = options
  }

  start(): void {
    this.stopped = false
    this.connectControl()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    for (const id of [...this.data.keys()]) this.closeData(id, 1001, 'host stopping')
    const control = this.control
    this.control = null
    if (control) safeClose(control, 1001, 'host stopping')
    this.setState({ state: 'idle', connectedClients: 0, lastError: null })
  }

  status(): RelayHostStatus {
    return this.state
  }

  private setState(next: RelayHostStatus): void {
    this.state = next
    this.options.onStatus?.(next)
  }

  private url(role: string, connectionId?: string): string {
    const url = new URL(this.options.relayUrl)
    url.searchParams.set('v', '1')
    url.searchParams.set('role', role)
    url.searchParams.set('serverId', this.options.serverId)
    url.searchParams.set('token', this.options.hostToken)
    if (connectionId) url.searchParams.set('connectionId', connectionId)
    return url.toString()
  }

  private connectControl(): void {
    if (this.stopped) return
    this.setState({
      state: this.attempts === 0 ? 'connecting' : 'connecting',
      connectedClients: this.data.size,
      lastError: this.state.lastError,
    })
    const ws = new WebSocket(this.url('host-control'))
    this.control = ws
    let opened = false
    const timer = setTimeout(() => {
      if (!opened) safeClose(ws, 4000, 'control open timeout')
    }, 15_000)
    timer.unref?.()
    ws.on('open', () => {
      opened = true
      clearTimeout(timer)
      this.attempts = 0
      this.setState({ state: 'connected', connectedClients: this.data.size, lastError: null })
    })
    ws.on('message', (data, isBinary) => {
      if (isBinary || this.control !== ws) return
      let message: Record<string, unknown>
      try {
        message = JSON.parse(textOf(data)) as Record<string, unknown>
      } catch {
        return
      }
      this.handleControl(message)
    })
    ws.on('close', (code, reason) => {
      clearTimeout(timer)
      if (this.control !== ws) return
      this.control = null
      for (const id of [...this.data.keys()]) this.closeData(id, 1011, 'control closed')
      this.pendingClients.clear()
      if (this.stopped) return
      this.scheduleReconnect(code, reason.toString())
    })
    ws.on('error', () => {})
  }

  private handleControl(message: Record<string, unknown>): void {
    const type = message.type
    if (type === 'sync' && Array.isArray(message.connectionIds)) {
      const wanted = new Set(message.connectionIds.filter((id): id is string => typeof id === 'string'))
      for (const id of [...this.data.keys()]) {
        if (!wanted.has(id)) this.closeData(id, 1000, 'not announced')
      }
      for (const id of wanted) this.openData(id)
      return
    }
    if (type === 'connected' && typeof message.connectionId === 'string') {
      this.openData(message.connectionId)
      return
    }
    if (type === 'disconnected' && typeof message.connectionId === 'string') {
      this.closeData(message.connectionId, 1000, 'client disconnected')
    }
  }

  private openData(connectionId: string): void {
    if (this.stopped || this.data.has(connectionId) || this.pendingClients.has(connectionId)) return
    this.pendingClients.add(connectionId)
    const ws = new WebSocket(this.url('host-data', connectionId))
    let opened = false
    const timer = setTimeout(() => {
      if (!opened) safeClose(ws, 4000, 'data open timeout')
    }, 10_000)
    timer.unref?.()
    const entry: HostDataSocket = { socket: ws, opened: false, dispatcher: null, timer }
    this.data.set(connectionId, entry)
    ws.on('open', () => {
      opened = true
      entry.opened = true
      clearTimeout(timer)
      this.pendingClients.delete(connectionId)
      this.setState({ ...this.state, connectedClients: this.data.size })
    })
    let handshake: ReturnType<typeof createRelayDecryptor> | null = null
    let encryptor: ReturnType<typeof createRelayEncryptor> | null = null
    const send = async (plaintext: Buffer): Promise<void> => {
      if (!encryptor || ws.readyState !== WebSocket.OPEN) throw new Error('channel closed')
      while (ws.bufferedAmount > BACKPRESSURE_LIMIT_BYTES) {
        if (ws.readyState !== WebSocket.OPEN) throw new Error('channel closed')
        await delay(20)
      }
      ws.send(encryptor.encrypt(plaintext), { binary: true })
    }
    ws.on('message', (data, isBinary) => {
      if (this.data.get(connectionId) !== entry) return
      if (!entry.dispatcher) {
        if (isBinary) {
          safeClose(ws, 1008, 'expected hello')
          return
        }
        let hello: Record<string, unknown>
        try {
          hello = JSON.parse(textOf(data)) as Record<string, unknown>
        } catch {
          safeClose(ws, 1008, 'bad hello')
          return
        }
        if (hello.t !== 'hello' || hello.v !== 1 || typeof hello.pub !== 'object' || typeof hello.nonce !== 'string') {
          safeClose(ws, 1008, 'bad hello')
          return
        }
        try {
          const nonce = Buffer.from(hello.nonce, 'base64url')
          const keys = deriveRelaySessionKeys(
            this.options.identity.privateKey,
            hello.pub,
            nonce,
          )
          encryptor = createRelayEncryptor(keys.hostToClient)
          handshake = createRelayDecryptor(keys.clientToHost)
          entry.dispatcher = new TunnelDispatcher(
            connectionId,
            this.options.remotePort(),
            send,
            (code, reason) => safeClose(ws, code, reason),
          )
          ws.send(JSON.stringify({ t: 'ready', v: 1 }), { binary: false })
        } catch (error) {
          this.options.logger?.warn?.(`[relay] handshake failed: ${error instanceof Error ? error.message : String(error)}`)
          safeClose(ws, 1008, 'handshake failed')
        }
        return
      }
      if (!isBinary || !handshake) {
        safeClose(ws, 1008, 'plaintext after handshake')
        return
      }
      try {
        entry.dispatcher.handle(
          decodeTunnelFrame(handshake.decrypt(binaryOf(data))),
        )
      } catch {
        safeClose(ws, 1008, 'channel failure')
      }
    })
    ws.on('close', () => {
      clearTimeout(timer)
      this.pendingClients.delete(connectionId)
      if (this.data.get(connectionId) === entry) this.data.delete(connectionId)
      this.setState({ ...this.state, connectedClients: this.data.size })
    })
    ws.on('error', () => {})
  }

  private closeData(connectionId: string, code: number, reason: string): void {
    const entry = this.data.get(connectionId)
    if (!entry) return
    this.data.delete(connectionId)
    this.pendingClients.delete(connectionId)
    entry.dispatcher?.closeAll(reason)
    safeClose(entry.socket, code, reason)
    this.setState({ ...this.state, connectedClients: this.data.size })
  }

  private scheduleReconnect(code: number, reason: string): void {
    if (this.reconnectTimer || this.stopped) return
    this.attempts += 1
    const wait = code === 4001 ? 60_000 : Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts - 1, 5))
    this.setState({ state: 'error', connectedClients: 0, lastError: reason || `control closed (${code})` })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectControl()
    }, wait)
    this.reconnectTimer.unref?.()
  }
}

export interface RelayPairingCandidate {
  type: 'relay'
  relayUrl: string
  serverId: string
  hostEncPubJwk: RelayPublicJwk
  priority?: number
}
