import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Envelope } from '../core/wire.ts'
import type { SessionStore } from '../session/store.ts'
import { json, queryNumber, sseHeaders, writeSse } from './http.ts'

export const HEARTBEAT_MS = 15_000
const POLL_MAX_SEC = 30
const POLL_DEFAULT_SEC = 25
const RING_LIMIT = 128

interface GlobalEventEntry {
  seq: number
  event: { type: string; [key: string]: unknown }
}

/**
 * Cross-session push ring and SSE client set. The ring makes `/api/events/poll`
 * cheap for clients that cannot keep an EventSource open; the live set serves
 * the desktop console.
 */
export class GlobalEventHub {
  private readonly clients = new Set<ServerResponse>()
  private readonly ring: GlobalEventEntry[] = []
  private ringSeq = 0
  private readonly heartbeatTimer: NodeJS.Timeout
  private readonly running: () => string[]

  constructor(
    running: () => string[],
    heartbeatMs = HEARTBEAT_MS,
  ) {
    this.running = running
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) writeSse(client, { type: 'hb' })
    }, heartbeatMs)
    this.heartbeatTimer.unref?.()
  }

  broadcast(event: { type: string; [key: string]: unknown }): void {
    this.ringSeq += 1
    this.ring.push({ seq: this.ringSeq, event })
    if (this.ring.length > RING_LIMIT) this.ring.splice(0, this.ring.length - RING_LIMIT)
    for (const client of this.clients) writeSse(client, event)
  }

  handleSse(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, sseHeaders())
    res.write('retry: 1000\n\n')
    this.clients.add(res)
    writeSse(res, { type: 'running-snapshot', ids: this.running() })
    req.on('close', () => {
      this.clients.delete(res)
    })
  }

  async handlePoll(res: ServerResponse, url: URL): Promise<void> {
    const after = queryNumber(url, 'after') ?? 0
    const waitSec = Math.max(
      0,
      Math.min(POLL_MAX_SEC, queryNumber(url, 'wait') ?? POLL_DEFAULT_SEC),
    )
    const deadline = Date.now() + waitSec * 1000
    while (true) {
      const pending = this.ring.filter((entry) => entry.seq > after).slice(0, 64)
      if (pending.length > 0 || Date.now() >= deadline) {
        json(res, 200, {
          events: pending.map((entry) => entry.event),
          seq: pending.length > 0 ? pending[pending.length - 1]!.seq : after,
          resync: false,
          running: this.running(),
        })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  close(): void {
    clearInterval(this.heartbeatTimer)
    for (const client of this.clients) client.end()
    this.clients.clear()
  }
}

/** Per-session follow stream: replay from the cursor, then stream live. */
export function followSse(
  store: SessionStore,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): void {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const after = queryNumber(url, 'after') ?? 0
  res.writeHead(200, sseHeaders())
  res.write('retry: 1000\n\n')
  let lastSent = after
  let replaying = true
  const pending: Envelope[] = []

  const send = (envelope: Envelope): void => {
    if (envelope.seq <= lastSent) return
    lastSent = envelope.seq
    writeSse(res, envelope)
  }
  const unsubscribe = store.subscribe(sessionId, (envelope) => {
    if (replaying) pending.push(envelope)
    else send(envelope)
  })
  for (const envelope of store.eventsAfter(sessionId, after)) send(envelope)
  replaying = false
  for (const envelope of pending) send(envelope)
  const heartbeat = setInterval(() => writeSse(res, { type: 'hb' }), HEARTBEAT_MS)
  heartbeat.unref?.()
  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
  })
}

/** Polling fallback for the same follow stream. */
export async function followPoll(
  store: SessionStore,
  res: ServerResponse,
  sessionId: string,
  url: URL,
): Promise<void> {
  const after = queryNumber(url, 'after') ?? 0
  const waitSec = Math.max(
    0,
    Math.min(POLL_MAX_SEC, queryNumber(url, 'wait') ?? POLL_DEFAULT_SEC),
  )
  const deadline = Date.now() + waitSec * 1000
  const unsubscribe = store.subscribe(sessionId, () => {})
  try {
    while (true) {
      const envelopes = store.eventsAfter(sessionId, after)
      if (envelopes.length > 0 || Date.now() >= deadline) {
        const last = envelopes[envelopes.length - 1]
        json(res, 200, { envelopes, seq: last?.seq ?? after })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  } finally {
    unsubscribe()
  }
}
