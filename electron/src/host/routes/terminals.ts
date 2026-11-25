// Terminal API: lifecycle over REST and interactive bytes over WebSocket.
//
// REST is intentionally low-frequency (list/create/close/resize); keystrokes
// and PTY output share one WebSocket so typing does not pay an HTTP round trip
// per key. All PTY bytes are base64 because a chunk can split a multi-byte
// UTF-8 character or contain binary terminal output.

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  apiError,
  json,
  readJson,
} from '../http.ts'
import { errorMessage } from '../../core/util.ts'
import {
  decodeBase64,
  encodeBase64,
  type TerminalEvent,
  type TerminalManager,
} from '../../terminal/manager.ts'

export interface TerminalApiDeps {
  terminals: TerminalManager
}

/** Minimal structural socket type shared by the `ws` runtime and tests. */
export interface TerminalSocket {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: string, listener: (...args: never[]) => void): this
}

const WS_OPEN = 1

export function terminalIdFromSocketPath(pathname: string): string | null {
  const match = /^\/api\/terminals\/([^/]+)\/ws$/.exec(pathname)
  return match?.[1] ?? null
}

function numberArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export async function handleTerminalsApi(
  deps: TerminalApiDeps,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
): Promise<boolean> {
  if (pathname === '/api/terminals') {
    if (method === 'GET') {
      json(res, 200, deps.terminals.snapshot())
      return true
    }
    if (method === 'POST') {
      try {
        const body = await readJson(req)
        const cwd = typeof body.cwd === 'string' ? body.cwd : undefined
        const terminal = deps.terminals.create(
          cwd,
          numberArg(body.cols),
          numberArg(body.rows),
        )
        json(res, 200, { terminal })
      } catch (error) {
        apiError(res, 400, 'terminal/create-failed', errorMessage(error))
      }
      return true
    }
    apiError(res, 405, 'terminal/method', '只支持 GET / POST')
    return true
  }

  const closeMatch = /^\/api\/terminals\/([^/]+)$/.exec(pathname)
  if (closeMatch && method === 'DELETE') {
    const id = closeMatch[1]!
    try {
      deps.terminals.close(id)
      json(res, 200, { ok: true })
    } catch (error) {
      apiError(res, 404, 'terminal/not-found', errorMessage(error))
    }
    return true
  }

  const detailMatch = /^\/api\/terminals\/([^/]+)$/.exec(pathname)
  if (detailMatch && method === 'GET') {
    const terminal = deps.terminals.get(detailMatch[1]!)
    if (!terminal) {
      apiError(res, 404, 'terminal/not-found', `终端不存在:${detailMatch[1]}`)
      return true
    }
    json(res, 200, { terminal })
    return true
  }

  const resizeMatch = /^\/api\/terminals\/([^/]+)\/resize$/.exec(pathname)
  if (resizeMatch && method === 'POST') {
    const id = resizeMatch[1]!
    try {
      const body = await readJson(req)
      const cols = numberArg(body.cols)
      const rows = numberArg(body.rows)
      if (cols === undefined || rows === undefined) {
        apiError(res, 400, 'terminal/bad-size', 'cols 与 rows 必须是数字')
        return true
      }
      deps.terminals.resize(id, cols, rows)
      json(res, 200, { ok: true })
    } catch (error) {
      apiError(res, 400, 'terminal/resize-failed', errorMessage(error))
    }
    return true
  }

  return false
}

function send(socket: TerminalSocket, payload: unknown): void {
  if (socket.readyState !== WS_OPEN) return
  try {
    socket.send(JSON.stringify(payload))
  } catch {
    /* close event cleans up */
  }
}

/**
 * Attach one WebSocket to one terminal.
 *
 * Subscription happens before the replay snapshot. Output produced between
 * those two steps is buffered and sent after the snapshot, so a reconnect
 * never loses data or renders it out of order.
 */
export function attachTerminalWebSocket(
  socket: TerminalSocket,
  terminals: TerminalManager,
  id: string,
  replay: boolean,
): void {
  if (!terminals.get(id)) {
    send(socket, { type: 'error', message: `终端不存在:${id}` })
    socket.close()
    return
  }

  let replaying = true
  const pending: TerminalEvent[] = []
  let disposed = false

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    unsubscribe()
  }

  const deliver = (event: TerminalEvent): void => {
    if (event.type === 'terminals-changed') return
    if (event.terminalId !== id) return
    send(socket, event)
    if (event.type === 'exit' || event.type === 'closed') socket.close()
  }

  const unsubscribe = terminals.subscribe((event) => {
    if (replaying) {
      pending.push(event)
      return
    }
    deliver(event)
  })

  if (replay) {
    const bytes = terminals.scrollback(id)
    if (bytes && bytes.length > 0) {
      send(socket, { type: 'replay', data: encodeBase64(bytes) })
    }
  }
  replaying = false
  for (const event of pending.splice(0)) deliver(event)

  socket.on('message', (raw: unknown) => {
    if (disposed) return
    let text: string
    if (typeof raw === 'string') text = raw
    else if (Buffer.isBuffer(raw)) text = raw.toString('utf8')
    else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString('utf8')
    else return

    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (typeof frame !== 'object' || frame === null) return
    const value = frame as Record<string, unknown>
    try {
      switch (value.type) {
        case 'input': {
          if (typeof value.data !== 'string') return
          terminals.write(id, decodeBase64(value.data))
          break
        }
        case 'resize': {
          const cols = numberArg(value.cols)
          const rows = numberArg(value.rows)
          if (cols === undefined || rows === undefined) return
          terminals.resize(id, cols, rows)
          break
        }
        case 'ping':
          break
        default:
          break
      }
    } catch (error) {
      send(socket, { type: 'error', message: errorMessage(error) })
    }
  })

  socket.on('close', dispose)
  socket.on('error', dispose)
}
