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
  ModelSelection,
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

/** 高频流式帧：只服务实时观感，不进历史分页窗口。 */
function isTransientEvent(event: Envelope): boolean {
  return event.type === 'assistant-chunk' || event.type === 'tool-output-chunk'
}

/**
 * 分页节点：用户自己的消息，以及父代理投递给子会话的任务/来信（子会话
 * 界面同样按用户气泡展示，是一轮工作的起点）。注入消息、系统提醒不是
 * 对话节点，不能作为页首。
 */
function isPageBoundary(event: Envelope, parentSessionId?: string): boolean {
  if (event.type === 'user-message') return !(event as { injected?: boolean }).injected
  return event.type === 'agent-delivery' &&
    parentSessionId !== undefined &&
    event.source === `agent:${parentSessionId}`
}

interface SummaryCache {
  mtimeMs: number
  size: number
  summary: SessionSummary
}

export interface RewindOutcome {
  toSeq: number
  toMessage: string
  removedEvents: number
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
    // One JSON envelope per line: joining without the separator would merge
    // buffered events into an unparsable line (and drop them on reload).
    const payload = this.buffer.join('\n') + '\n'
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

  /**
   * Physically truncate the log just before `toSeq`, which must be a
   * non-injected user message (a checkpoint). The cut removes that message and
   * everything after it; the caller restores file history first.
   */
  rewind(id: string, toSeq: number): RewindOutcome {
    const session = this.live.get(id) ?? this.load(id)
    if (!session) throw new Error(`会话不存在: ${id}`)
    if (!Number.isInteger(toSeq) || toSeq <= 0) throw new Error('回退点必须是正整数 seq')
    const index = session.events.findIndex((event) => event.seq === toSeq)
    if (index < 0) throw new Error(`回退点不存在: seq ${toSeq}`)
    const target = session.events[index]!
    if (target.type !== 'user-message' || target.injected) {
      throw new Error('只能回退到用户消息')
    }
    // Flush buffered envelopes first: the truncation offset is computed from
    // the file bytes, so every retained line must already be on disk.
    session.writer.flush()
    const file = this.logFile(id)
    const before = session.events.length
    const removedEvents = before - index
    session.events.splice(index)
    // Older logs wrote `turn-start` before the user message. Cutting at the
    // message would leave that turn open, so close it: drop the stale turn
    // head (nothing of that turn survived) or mark a mid-turn cut interrupted.
    const synthesized = closeRewoundTail(session.events)
    const lastSeq = session.events[session.events.length - 1]?.seq
    const cut = synthesized || lastSeq === undefined
      ? null
      : truncateOffsetOf(file, lastSeq)
    if (cut !== null) {
      fs.truncateSync(file, cut)
    } else {
      // Logs written by older builds could contain several envelopes on one
      // line (the writer used to join its buffer without newlines), so the
      // target cannot be located by scanning. Rewrite the retained events into
      // a canonical one-envelope-per-line file instead.
      rewriteLog(file, session.header, session.events)
    }
    this.cache.delete(id)
    return { toSeq, toMessage: target.text, removedEvents }
  }

  /**
   * 读取一页展示事件：`before` 是排他 seq 上界。分页节点是用户消息（子
   * 会话还包括父代理投递），`limit` 是每轮工作量的参考值：页首选在参考
   * 边界附近最近的分页节点上，因此一页会覆盖若干完整轮次；单轮本身超过
   * `limit` 时整轮作为一页，不再切在半截回答里。
   */
  readPage(id: string, before?: number, limit = 500): SessionPage | null {
    const session = this.load(id)
    if (!session) return null
    const all = session.events
    // 分页按“展示事件”计数：流式 chunk 只服务实时观感，不能占历史窗口，
    // 否则一次长回答就能把 200 条额度吃光，用户打开会话只看得到半段正文。
    const display = all.filter((event) => !isTransientEvent(event))
    const anchors = display
      .filter((event) => event.type === 'user-message' && !(event as { injected?: boolean }).injected)
      .map((event) => ({ seq: event.seq, text: (event as { text: string }).text.slice(0, 120) }))
    const eligible = before === undefined
      ? display
      : display.filter((event) => event.seq < before)
    // `start` 先按事件数划出参考边界，再移到分页节点上：选离参考边界
    // 最近的用户消息，让一页的工作量接近 `limit`，同时不切在轮次中间。
    // 边界前后都没有节点时才退回按事件数切。
    let start = Math.max(0, eligible.length - limit)
    if (start > 0) {
      let nearest = -1
      let distance = Infinity
      for (let index = 0; index < eligible.length; index += 1) {
        if (!isPageBoundary(eligible[index]!, session.header.parent_session)) continue
        const candidate = Math.abs(index - start)
        if (candidate < distance) {
          nearest = index
          distance = candidate
        }
      }
      if (nearest >= 0) start = nearest
    }
    const lastSelection = lastSelectionOf(all)
    return {
      header: session.header,
      events: eligible.slice(start),
      total: display.length,
      hasMoreBefore: start > 0,
      anchors,
      totals: computeTotals(all),
      ...(lastSelection ? { last_selection: lastSelection } : {}),
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
    const lastSelection = lastSelectionOf(events)
    const summary: SessionSummary = {
      id,
      created_at: header.created_at,
      updated_at: stat.mtimeMs,
      excerpt,
      title,
      cwd: header.cwd,
      sandbox: header.sandbox,
      cwd_alive: isDirectory(header.cwd),
      ...(header.parent_session ? { parent_session: header.parent_session } : {}),
      ...(header.subagent ? { subagent: header.subagent } : {}),
      ...(header.agent_preset || preset ? { agent_preset: preset ?? header.agent_preset } : {}),
      ...(lastSelection ? { last_selection: lastSelection } : {}),
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

/**
 * Byte offset just after the line carrying `seq`. Torn or unparsable lines are
 * skipped: the target is found by its parsed envelope, not by line number.
 */
function truncateOffsetOf(file: string, seq: number): number | null {
  const buffer = fs.readFileSync(file)
  const matches = (start: number, end: number): boolean => {
    if (end <= start) return false
    try {
      const parsed = JSON.parse(buffer.subarray(start, end).toString('utf8')) as {
        seq?: unknown
      }
      return parsed.seq === seq
    } catch {
      return false
    }
  }
  let lineStart = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue
    if (matches(lineStart, index)) return index + 1
    lineStart = index + 1
  }
  // A crash can leave the target as the final line without a trailing newline.
  if (lineStart < buffer.length && matches(lineStart, buffer.length)) return buffer.length
  return null
}

/** Canonical one-envelope-per-line rewrite, used when the old file cannot be
 *  cut at a line boundary. */
function rewriteLog(file: string, header: SessionHeader, events: Envelope[]): void {
  const lines = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))]
  const temporary = `${file}.rewrite.tmp`
  fs.writeFileSync(temporary, lines.join('\n') + '\n', 'utf8')
  fs.renameSync(temporary, file)
}

/**
 * Close a trailing open turn left by the cut. Returns true when a synthetic
 * `turn-end` was appended (so the log must be rewritten rather than truncated).
 *
 * Two shapes exist:
 * - old-format cut (turn-start before the user message): nothing from that turn
 *   survives, so drop the opening marker and the injected input before it;
 * - mid-turn cut (a steering message): earlier steps are still in the branch,
 *   so close the turn as interrupted instead of deleting those messages.
 */
function closeRewoundTail(events: Envelope[]): boolean {
  let open = -1
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!
    if (event.type === 'turn-start') open = index
    else if (event.type === 'turn-end') open = -1
  }
  if (open < 0) return false
  const start = events[open]
  if (start?.type !== 'turn-start') return false
  const hasSteps = events
    .slice(open + 1)
    .some((event) => event.type === 'step-start')
  if (!hasSteps) {
    events.length = open
    return false
  }
  const last = events[events.length - 1]!
  events.push({
    seq: last.seq + 1,
    time: Date.now(),
    type: 'turn-end',
    turn: start.turn,
    reason: { kind: 'interrupted' },
  })
  return true
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

/**
 * The model this session last asked with, folded from the whole log.
 *
 * `request-header` is the only record carrying the reasoning effort, and it is
 * written only when the request shape changes — so a session whose model never
 * changed keeps a single header at its very beginning, far outside any page
 * window. Folding here is what lets the console restore the right model per
 * session instead of carrying the previous session's choice over.
 */
function lastSelectionOf(events: Envelope[]): ModelSelection | null {
  let fallback: ModelSelection | null = null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'request-header') {
      const { provider, model, reasoningEffort } = event.header.config
      if (!provider || !model) return fallback
      return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
    }
    if (event.type === 'request-context' && fallback === null) {
      if (!event.provider || !event.model) continue
      fallback = { provider: event.provider, model: event.model }
    }
  }
  return fallback
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