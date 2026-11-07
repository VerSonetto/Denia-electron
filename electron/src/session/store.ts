// Event-sourced session storage: one JSONL file per session.
//
// Layout: `<home>/sessions/<id>/session.jsonl`; line 1 is the header, every
// following line one envelope. The envelope sequence is contiguous from 1,
// which is what the UI relies on to detect gaps in the follow stream.

import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import type {
  Envelope,
  SessionEvent,
  SessionHeader,
  SessionPage,
  SessionSummary,
  SessionTotals,
} from '../core/wire.ts'
import type { SubagentDescriptor } from '../subagents/types.ts'
import { newSessionId } from '../core/util.ts'

const SESSION_FORMAT_VERSION = 0
const EXCERPT_CHARS = 160

interface SummaryCache {
  mtimeMs: number
  size: number
  summary: SessionSummary
}

class LogWriter {
  private readonly file: string
  private buffer: string[] = []
  private bytes = 0
  private timer: NodeJS.Timeout | null = null

  constructor(file: string) {
    this.file = file
  }

  write(line: string): void {
    this.buffer.push(line)
    this.bytes += line.length + 1
    if (this.bytes >= 64 * 1024) this.flush()
    else this.arm()
  }

  flush(): void {
    if (this.buffer.length === 0) return
    const payload = this.buffer.join('') + '\n'
    this.buffer = []
    this.bytes = 0
    fs.appendFileSync(this.file, payload, 'utf8')
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private arm(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, 200)
    this.timer.unref?.()
  }
}

interface LiveSession {
  header: SessionHeader
  events: Envelope[]
  writer: LogWriter
  followers: EventEmitter
}

export class SessionStore {
  readonly home: string
  readonly sessionsDir: string
  private readonly live = new Map<string, LiveSession>()
  private readonly cache = new Map<string, SummaryCache>()
  readonly events = new EventEmitter()

  constructor(home: string) {
    this.home = home
    this.sessionsDir = path.join(home, 'sessions')
    fs.mkdirSync(this.sessionsDir, { recursive: true })
  }

  private sessionDir(id: string): string {
    return path.join(this.sessionsDir, id)
  }

  private logFile(id: string): string {
    return path.join(this.sessionDir(id), 'session.jsonl')
  }

  create(
    cwd: string,
    options: {
      sandbox?: boolean
      parentSession?: string
      subagent?: SubagentDescriptor
    } = {},
  ): SessionHeader {
    const id = newSessionId()
    const header: SessionHeader = {
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id,
      created_at: Date.now(),
      cwd,
      sandbox: options.sandbox ?? false,
      ...(options.parentSession ? { parent_session: options.parentSession } : {}),
      ...(options.subagent ? { subagent: options.subagent } : {}),
    }
    fs.mkdirSync(this.sessionDir(id), { recursive: true })
    fs.writeFileSync(this.logFile(id), JSON.stringify(header) + '\n', 'utf8')
    this.live.set(id, {
      header,
      events: [],
      writer: new LogWriter(this.logFile(id)),
      followers: new EventEmitter(),
    })
    return header
  }

  header(id: string): SessionHeader | null {
    const session = this.live.get(id)
    if (session) return session.header
    const file = this.logFile(id)
    if (!fs.existsSync(file)) return null
    const firstLine = readFirstLine(file)
    if (!firstLine) return null
    try {
      const parsed = JSON.parse(firstLine) as SessionHeader
      return parsed.type === 'session' ? parsed : null
    } catch {
      return null
    }
  }

  /** Rewrite the header line in place (fork projection, descriptors). */
  updateHeader(id: string, patch: Partial<SessionHeader>): void {
    const session = this.live.get(id) ?? this.load(id)
    if (!session) return
    session.header = { ...session.header, ...patch }
    session.writer.flush()
    const file = this.logFile(id)
    const raw = fs.readFileSync(file, 'utf8')
    const newline = raw.indexOf('\n')
    const rest = newline >= 0 ? raw.slice(newline + 1) : ''
    fs.writeFileSync(file, JSON.stringify(session.header) + '\n' + rest, 'utf8')
  }

  /** Write a large auxiliary file inside the session directory. */
  writeAuxiliary(id: string, name: string, content: string): void {
    const dir = this.sessionDir(id)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, path.basename(name))
    fs.writeFileSync(file, content, 'utf8')
  }

  readAuxiliary(id: string, name: string): string | null {
    const file = path.join(this.sessionDir(id), path.basename(name))
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  }
  private load(id: string): LiveSession | null {
    const existing = this.live.get(id)
    if (existing) return existing
    const file = this.logFile(id)
    if (!fs.existsSync(file)) return null
    const raw = fs.readFileSync(file, 'utf8')
    const lines = raw.split('\n')
    let header: SessionHeader | null = null
    const events: Envelope[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      let parsed: SessionHeader | Envelope
      try {
        parsed = JSON.parse(line) as SessionHeader | Envelope
      } catch {
        // Torn tail: drop the broken line rather than failing the session.
        continue
      }
      if (!header) {
        header = parsed as SessionHeader
        continue
      }
      const envelope = parsed as Envelope
      if (typeof envelope.seq !== 'number' || typeof envelope.type !== 'string') continue
      events.push(envelope)
    }
    if (!header || header.type !== 'session') return null
    const repaired = repairOpenTurn(events)
    if (repaired) {
      events.push(repaired)
      fs.appendFileSync(file, JSON.stringify(repaired) + '\n', 'utf8')
    }
    const session: LiveSession = {
      header,
      events,
      writer: new LogWriter(file),
      followers: new EventEmitter(),
    }
    this.live.set(id, session)
    return session
  }

  read(id: string): { header: SessionHeader; events: Envelope[] } | null {
    const session = this.load(id)
    if (!session) return null
    return { header: session.header, events: [...session.events] }
  }

  readPage(id: string, before?: number, limit = 500): SessionPage | null {
    const session = this.load(id)
    if (!session) return null
    const all = session.events
    const end = before === undefined ? all.length : Math.max(0, Math.min(all.length, before - 1))
    const start = Math.max(0, end - limit)
    const events = all.slice(start, end)
    const anchors = all
      .filter((event) => event.type === 'user-message' && !(event as { injected?: boolean }).injected)
      .map((event) => ({ seq: event.seq, text: (event as { text: string }).text.slice(0, 120) }))
    return {
      header: session.header,
      events,
      total: all.length,
      hasMoreBefore: start > 0,
      anchors,
      totals: computeTotals(all),
    }
  }

  eventsAfter(id: string, after: number): Envelope[] {
    const session = this.load(id)
    if (!session) return []
    if (after <= 0) return [...session.events]
    // Events are contiguous, so the cursor maps to an array index.
    const start = Math.min(session.events.length, Math.max(0, Math.floor(after)))
    const first = session.events[start]
    if (first && first.seq === after + 1) return session.events.slice(start)
    return session.events.filter((event) => event.seq > after)
  }

  append(id: string, event: SessionEvent): Envelope | null {
    const session = this.live.get(id) ?? this.load(id)
    if (!session) return null
    const last = session.events[session.events.length - 1]
    const envelope = { seq: (last?.seq ?? 0) + 1, time: Date.now(), ...event } as Envelope
    session.events.push(envelope)
    session.writer.write(JSON.stringify(envelope))
    if (
      event.type === 'turn-end' ||
      event.type === 'assistant-message' ||
      event.type === 'tool-result' ||
      event.type === 'user-message' ||
      event.type === 'turn-start'
    ) {
      session.writer.flush()
    }
    session.followers.emit('event', envelope)
    this.events.emit('session-event', id, envelope)
    return envelope
  }

  flush(id: string): void {
    this.live.get(id)?.writer.flush()
  }

  /** Subscribe before replaying: the caller must read `eventsAfter` synchronously after this. */
  subscribe(id: string, listener: (envelope: Envelope) => void): () => void {
    const session = this.live.get(id) ?? this.load(id)
    if (!session) return () => {}
    session.followers.on('event', listener)
    return () => session.followers.off('event', listener)
  }

  delete(id: string): boolean {
    const dir = this.sessionDir(id)
    if (!fs.existsSync(dir)) return false
    const session = this.live.get(id)
    session?.writer.flush()
    this.live.delete(id)
    this.cache.delete(id)
    fs.rmSync(dir, { recursive: true, force: true })
    this.events.emit('sessions-updated')
    return true
  }

  list(): SessionSummary[] {
    const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true })
    const summaries: SessionSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const summary = this.summaryOf(entry.name)
      if (summary) summaries.push(summary)
    }
    summaries.sort((a, b) => b.created_at - a.created_at)
    return summaries
  }

  private summaryOf(id: string): SessionSummary | null {
    const file = this.logFile(id)
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      return null
    }
    const cached = this.cache.get(id)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { ...cached.summary, cwd_alive: cached.summary.cwd ? isDirectory(cached.summary.cwd) : undefined }
    }
    const liveSession = this.live.get(id)
    const header = liveSession?.header ?? this.header(id)
    if (!header) return null
    const events = liveSession?.events ?? readEnvelopes(file)
    // A subagent has no human prompt; its label is the only meaningful row
    // title until (and unless) a generated title arrives.
    const excerpt = header.subagent?.label ?? firstUserText(events)
    const title = lastTitle(events)
    const preset = lastAgentPreset(events)
    const summary: SessionSummary = {
      id,
      created_at: header.created_at,
      excerpt,
      title,
      cwd: header.cwd,
      sandbox: header.sandbox,
      cwd_alive: isDirectory(header.cwd),
      ...(header.parent_session ? { parent_session: header.parent_session } : {}),
      ...(header.subagent ? { subagent: header.subagent } : {}),
      ...(header.agent_preset || preset ? { agent_preset: preset ?? header.agent_preset } : {}),
    }
    this.cache.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, summary })
    return summary
  }
}

function readFirstLine(file: string): string | null {
  const fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, read).toString('utf8')
    const newline = text.indexOf('\n')
    return newline >= 0 ? text.slice(0, newline) : text
  } finally {
    fs.closeSync(fd)
  }
}

function readEnvelopes(file: string): Envelope[] {
  const raw = fs.readFileSync(file, 'utf8')
  const out: Envelope[] = []
  let first = true
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    if (first) {
      first = false
      continue
    }
    try {
      out.push(JSON.parse(line) as Envelope)
    } catch {
      /* torn line */
    }
  }
  return out
}

function firstUserText(events: Envelope[]): string | null {
  for (const event of events) {
    if (event.type === 'user-message' && !(event as { injected?: boolean }).injected) {
      const text = (event as { text: string }).text.trim()
      if (text) return text.slice(0, EXCERPT_CHARS)
    }
  }
  return null
}

function lastTitle(events: Envelope[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'session-title') return (event as { title: string }).title
  }
  return null
}

function lastAgentPreset(events: Envelope[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'agent-preset') return (event as { preset: string }).preset
  }
  return null
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * A crash can leave an open turn/step in the log. Close it the way the Rust
 * session store does: a synthetic `turn-end { aborted, disposed }`, so the UI
 * (and the next turn) never sees a session stuck in "running".
 */
function repairOpenTurn(events: Envelope[]): Envelope | null {
  let turn: number | null = null
  let step: number | null = null
  for (const event of events) {
    if (event.type === 'turn-start') {
      turn = event.turn
      step = null
    } else if (event.type === 'turn-end') {
      turn = null
      step = null
    } else if (event.type === 'step-start') {
      step = event.step
    } else if (event.type === 'step-end') {
      step = null
    }
  }
  if (turn === null) return null
  const last = events[events.length - 1]
  const seq = (last?.seq ?? 0) + 1
  return {
    seq,
    time: Date.now(),
    type: 'turn-end',
    turn,
    reason: { kind: 'aborted', cause: { kind: 'disposed' } },
  } as Envelope
}

function computeTotals(events: Envelope[]): SessionTotals {
  const totals: SessionTotals = {
    turnMs: 0,
    turns: 0,
    steps: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  }
  const openTurns = new Map<number, number>()
  for (const event of events) {
    switch (event.type) {
      case 'turn-start': {
        openTurns.set(event.turn, event.time)
        break
      }
      case 'turn-end': {
        totals.turns += 1
        const started = openTurns.get(event.turn)
        if (started !== undefined) {
          totals.turnMs += Math.max(0, event.time - started)
          openTurns.delete(event.turn)
        }
        break
      }
      case 'step-end': {
        totals.steps += 1
        break
      }
      case 'tool-call': {
        totals.toolCalls += 1
        break
      }
      case 'assistant-message': {
        if (event.usage) {
          totals.inputTokens += event.usage.inputTokens ?? 0
          totals.outputTokens += event.usage.outputTokens ?? 0
          totals.cacheReadTokens += event.usage.cacheReadTokens ?? 0
          totals.reasoningTokens += event.usage.reasoningTokens ?? 0
        }
        break
      }
      default:
        break
    }
  }
  return totals
}