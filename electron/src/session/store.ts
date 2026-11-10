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

/** 日志尾部的廉价探测结果，供启动恢复判断"这个会话是否还有待办"。 */
export interface TailProbe {
  /** 最后一条 turn-end 的时刻；没有则 null。 */
  lastTurnEnd: number | null
  /** 尾部窗口里存在尚未被 agent-delivery 消费的 agent-inbox。 */
  pendingInbox: boolean
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
  id: string
  header: SessionHeader
  /** 持久事件（不含流式帧）：分页、模型表面与统计只读这里。按 seq 升序。 */
  events: Envelope[]
  /**
   * 流式帧的驻留窗口，按 seq 升序。
   *
   * 这类帧占日志字节的 98%（一次长回答能产生上万条 `assistant-chunk`），
   * 但全部用途只有"打字机效果"：结算后正文以 `assistant-message` 为准，
   * 帧再没有人读。整份驻留会让单个会话独占数百 MB，所以内存里只留尚未
   * 结算的那些，已结算的只存在于磁盘日志。`events` 里写入 `assistant-message`
   * / `step-end` / `tool-result` 即视为该段帧已结算。
   */
  frames: Envelope[]
  /** 下一个可用 seq。events 与 frames 都不连续，这里单独维护。 */
  lastSeq: number
  writer: LogWriter
  followers: EventEmitter
  /** LRU 依据：最近一次被读写或追加的时刻。 */
  touchedAt: number
}

/** 流式帧驻留上限：兜住单个超长步骤，超出后最旧的帧让位（正文以磁盘为准）。 */
const FRAME_KEEP = 20_000

/** 空闲会话在内存里的保留上限；超出后按最久未用驱逐（有订阅者的不驱逐）。 */
const LIVE_SESSION_LIMIT = 4

/** 读日志的块大小：峰值内存随它增长，而不是随文件大小。 */
const READ_CHUNK = 1 << 20

/** 尾部帧窗口的读取字节数。 */
const TAIL_READ_BYTES = 2 << 20

/** 启动恢复探测的尾部窗口：够覆盖最后一轮的 inbox/delivery 往返。 */
const TAIL_PROBE_EVENTS = 64

/**
 * 流式帧的行首判型。
 *
 * 写入端固定按 `{ seq, time, type, ... }` 的键序序列化（见 append()），类型
 * 字段因此总在同一位置。命中这个模式的行一定是流式帧：它占日志行数的 98%，
 * 而归属与摘要都只关心持久事件，所以可以整行跳过 JSON.parse —— 长会话载入
 * 的主要 CPU 与瞬时分配就在这一步。
 */
const TRANSIENT_HEAD = /^\{"seq":(\d+),"time":\d+,"type":"(assistant-chunk|tool-output-chunk)"/

/** 按 seq 升序的数组里找第一个 seq >= target 的下标。 */
function lowerBound(list: Envelope[], target: number): number {
  let low = 0
  let high = list.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (list[mid]!.seq < target) low = mid + 1
    else high = mid
  }
  return low
}

/** 合并两个 seq 升序的数组。 */
function mergeBySeq(left: readonly Envelope[], right: readonly Envelope[]): Envelope[] {
  if (right.length === 0) return [...left]
  if (left.length === 0) return [...right]
  const out: Envelope[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i]!.seq <= right[j]!.seq) out.push(left[i++]!)
    else out.push(right[j++]!)
  }
  while (i < left.length) out.push(left[i++]!)
  while (j < right.length) out.push(right[j++]!)
  return out
}

/**
 * 单遍扫描日志：分离持久事件与流式帧，流式帧只取 seq。
 *
 * 流式帧的内容在这里被直接丢弃 —— 载入一个已有会话时，只有"正在流动的
 * 那一步"的帧还有消费者（见 tailFrames），它们由尾部扫描单独取出。
 */
/**
 * 逐块读日志并只保留持久事件。
 *
 * 一次 `readFileSync` 把整份日志读成字符串，会在解析期间同时持有"原文 +
 * 全部行 + 全部对象"三份数据；60 MB 的会话因此把瞬时堆推到百 MB 级，而这
 * 些中间态全是垃圾。按块读只长期持有结果，峰值随块大小而不是文件大小增长。
 */
function scanLogFile(
  file: string,
): { header: SessionHeader | null; events: Envelope[]; lastSeq: number; size: number } {
  const headerless = { header: null as SessionHeader | null, events: [] as Envelope[], lastSeq: 0, size: 0 }
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return headerless
  }
  const result = { header: null as SessionHeader | null, events: [] as Envelope[], lastSeq: 0 }
  const chunk = Buffer.allocUnsafe(READ_CHUNK)
  let carry = ''
  let size = 0
  try {
    while (true) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null)
      if (read <= 0) break
      size += read
      // 按字节切块可能切在多字节字符中间：用 toString 解出完整字符，
      // 余下的半个字符留在 buffer 里等下一次拼接（StringDecoder 的语义）。
      carry += chunk.subarray(0, read).toString('utf8')
      let start = 0
      while (true) {
        const end = carry.indexOf('\n', start)
        if (end < 0) break
        consumeLine(carry.slice(start, end), result)
        start = end + 1
      }
      carry = start === 0 ? carry : carry.slice(start)
    }
    if (carry.trim() !== '') consumeLine(carry, result)
  } finally {
    fs.closeSync(fd)
  }
  return { ...result, size }
}

/** 解析一行：头部进 header，流式帧只取 seq，其余进 events。 */
function consumeLine(
  line: string,
  result: { header: SessionHeader | null; events: Envelope[]; lastSeq: number },
): void {
  if (line.trim() === '') return
  const head = TRANSIENT_HEAD.exec(line)
  if (head !== null) {
    const seq = Number(head[1])
    if (seq > result.lastSeq) result.lastSeq = seq
    return
  }
  let parsed: SessionHeader | Envelope
  try {
    parsed = JSON.parse(line) as SessionHeader | Envelope
  } catch {
    // Torn tail: drop the broken line rather than failing the session.
    return
  }
  if (result.header === null) {
    result.header = parsed as SessionHeader
    return
  }
  const envelope = parsed as Envelope
  if (typeof envelope.seq !== 'number' || typeof envelope.type !== 'string') return
  if (envelope.seq > result.lastSeq) result.lastSeq = envelope.seq
  if (isTransientEvent(envelope)) return
  result.events.push(envelope)
}
/**
 * 取出日志尾部仍在流动的流式帧（seq 升序）。
 *
 * 从文件末尾往回走，直到遇到第一条持久事件：那之前的帧必然属于已经被
 * 持久事件结算过的步骤，正文已有权威版本，没有重放价值。这样只解析真正
 * 需要的那几步，而不是几十万条历史 chunk。
 */
function tailFrames(file: string, size: number): Envelope[] {
  const out: Envelope[] = []
  // 只读尾部固定窗口：末尾之前的内容与"正在流动的帧"无关。
  const windowBytes = Math.min(size, TAIL_READ_BYTES)
  if (windowBytes <= 0) return out
  const buffer = Buffer.allocUnsafe(windowBytes)
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return out
  }
  let read = 0
  try {
    read = fs.readSync(fd, buffer, 0, windowBytes, size - windowBytes)
  } finally {
    fs.closeSync(fd)
  }
  const raw = buffer.subarray(0, read).toString('utf8')
  let end = raw.length
  while (end > 0 && out.length < FRAME_KEEP) {
    const newline = raw.lastIndexOf('\n', end - 1)
    const start = newline + 1
    const line = raw.slice(start, end)
    end = newline
    if (line.trim() === '') continue
    const head = TRANSIENT_HEAD.exec(line)
    if (head === null) break
    try {
      out.push(JSON.parse(line) as Envelope)
    } catch {
      break
    }
  }
  out.reverse()
  return out
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

  /**
   * 把最久未用的空闲会话移出内存。
   *
   * 有订阅者的会话不驱逐（follow 流正在读它）；写入缓冲先落盘，驱逐后没有
   * 任何人再持有那个 writer。被驱逐的会话下次访问时从日志重建，行为不变。
   */
  private evictIdle(): void {
    if (this.live.size <= LIVE_SESSION_LIMIT) return
    const idle: LiveSession[] = []
    for (const session of this.live.values()) {
      if (session.followers.listenerCount('event') > 0) continue
      idle.push(session)
    }
    if (idle.length === 0) return
    idle.sort((left, right) => left.touchedAt - right.touchedAt)
    const excess = Math.min(this.live.size - LIVE_SESSION_LIMIT, idle.length)
    for (let index = 0; index < excess; index += 1) {
      const victim = idle[index]!
      victim.writer.flush()
      this.live.delete(victim.id)
    }
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
      id,
      header,
      events: [],
      frames: [],
      lastSeq: 0,
      writer: new LogWriter(this.logFile(id)),
      followers: new EventEmitter(),
      touchedAt: Date.now(),
    })
    this.evictIdle()
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
    if (existing) {
      existing.touchedAt = Date.now()
      return existing
    }
    const file = this.logFile(id)
    if (!fs.existsSync(file)) return null
    const scan = scanLogFile(file)
    if (scan.header === null || scan.header.type !== 'session') return null
    let lastSeq = scan.lastSeq
    const repaired = repairOpenTurn(scan.events, lastSeq)
    if (repaired) {
      scan.events.push(repaired)
      lastSeq = repaired.seq
      fs.appendFileSync(file, JSON.stringify(repaired) + '\n', 'utf8')
    }
    const session: LiveSession = {
      id,
      header: scan.header,
      events: scan.events,
      // 只有尾部那几步还在流动，历史 chunk 一律只留磁盘。
      frames: tailFrames(file, scan.size),
      lastSeq,
      writer: new LogWriter(file),
      followers: new EventEmitter(),
      touchedAt: Date.now(),
    }
    this.live.set(id, session)
    this.evictIdle()
    return session
  }

  read(id: string): { header: SessionHeader; events: Envelope[] } | null {
    const session = this.load(id)
    if (!session) return null
    // 副本：调用方把它当只读事务日志用，不返回内部分页数组本身。
    return { header: session.header, events: mergeBySeq(session.events, session.frames) }
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
    // 截断之后，被砍掉的部分不再是"下一个 seq"的依据；帧全部作废。
    session.frames.length = 0
    session.lastSeq = lastSeq ?? synthesizedSeq(session.events)
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
    // events 只收持久事件（流式帧在 append 时就已经分流），所以它本身就是
    // 分页口径：chunk 不占历史窗口，一次长回答不会把额度吃光。
    const all = session.events
    const display = all
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

  /**
   * 只读日志尾部做一次廉价探测：最后一条 turn-end 的时刻，以及是否还有
   * 未被消费的 agent-inbox。
   *
   * 启动恢复要对每个会话判断"要不要重放完成结果 / 唤醒",而全量 read() 在
   * 上百个历史会话上是把整棵日志树搬进内存。这两个判断都只依赖尾部：
   * turn-end 只看最后一条，inbox 的投递必然紧随其后（同一轮内）。
   */
  tailProbe(id: string): TailProbe {
    const live = this.live.get(id)
    if (live) return probeEvents(live.events)
    let raw: string
    try {
      raw = fs.readFileSync(this.logFile(id), 'utf8')
    } catch {
      return { lastTurnEnd: null, pendingInbox: false }
    }
    // 只解析最后 TAIL_PROBE_EVENTS 条持久事件：更早的 inbox 一定已经被
    // 同轮投递消费掉，否则它早就该被唤醒了（那时进程还活着）。
    const tail: Envelope[] = []
    let end = raw.length
    while (end > 0 && tail.length < TAIL_PROBE_EVENTS) {
      const newline = raw.lastIndexOf('\n', end - 1)
      const start = newline + 1
      const line = raw.slice(start, end)
      end = newline
      if (line.trim() === '' || TRANSIENT_HEAD.test(line)) continue
      try {
        tail.push(JSON.parse(line) as Envelope)
      } catch {
        /* torn line */
      }
    }
    tail.reverse()
    return probeEvents(tail)
  }

  /**
   * 游标之后的全部事件（含仍驻留的流式帧），seq 升序。
   *
   * 帧与持久事件分成两个数组存放，这里按 seq 归并：归并成本对着"两者之和"
   * 而不是"日志总行数"。游标以前的那段用二分定位，不做线性过滤。
   */
  eventsAfter(id: string, after: number): Envelope[] {
    const session = this.load(id)
    if (!session) return []
    const durableStart = lowerBound(session.events, after + 1)
    const frameStart = lowerBound(session.frames, after + 1)
    if (frameStart >= session.frames.length) return session.events.slice(durableStart)
    return mergeBySeq(
      session.events.slice(durableStart),
      session.frames.slice(frameStart),
    )
  }

  append(id: string, event: SessionEvent): Envelope | null {
    const session = this.live.get(id) ?? this.load(id)
    if (!session) return null
    session.touchedAt = Date.now()
    session.lastSeq += 1
    const envelope = { seq: session.lastSeq, time: Date.now(), ...event } as Envelope
    if (isTransientEvent(envelope)) {
      // 环形窗口：只留最近 FRAME_KEEP 条。跟随流的游标依赖"最后一条事件"
      // 的 seq，所以要留着它们；但没必要为此把整轮回答的 chunk 都背着。
      session.frames.push(envelope)
      if (session.frames.length > FRAME_KEEP) {
        session.frames.splice(0, session.frames.length - FRAME_KEEP)
      }
    } else {
      session.events.push(envelope)
    }
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
    // 摘要只要"首条用户消息 + 末尾的标题/预设/模型"，不需要把整份日志
    // 物化成事件数组：长会话在这里省下的是每次 list() 一次的全量分配。
    const folded = liveSession ? foldSummary(liveSession.events) : foldSummaryFile(file)
    // A subagent has no human prompt; its label is the only meaningful row
    // title until (and unless) a generated title arrives.
    const excerpt = header.subagent?.label ?? folded.excerpt
    const title = folded.title
    const preset = folded.preset
    const lastSelection = folded.selection
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

/** 从一段（通常是尾部）事件里读出恢复所需的两个判断依据。 */
function probeEvents(events: readonly Envelope[]): TailProbe {
  let lastTurnEnd: number | null = null
  const delivered = new Set<string>()
  for (const event of events) {
    if (event.type === 'turn-end') lastTurnEnd = event.time
    else if (event.type === 'agent-delivery') delivered.add(event.id)
  }
  let pendingInbox = false
  for (const event of events) {
    if (event.type !== 'agent-inbox') continue
    if (!delivered.has(event.id)) pendingInbox = true
  }
  return { lastTurnEnd, pendingInbox }
}

/** 摘要所需的折叠结果：首条用户消息与末尾元数据。 */
interface SummaryFold {
  excerpt: string | null
  title: string | null
  preset: string | null
  selection: ModelSelection | null
}

/**
 * 折叠摘要字段。
 *
 * `selection` 取最后一条 request-header（仅请求形态变化时落盘，长会话可能
 * 只在最开头有一条），没有时退到 request-context —— 与 lastSelectionOf 同义。
 */
function foldSummary(events: readonly Envelope[]): SummaryFold {
  let excerpt: string | null = null
  for (const event of events) {
    if (event.type !== 'user-message' || (event as { injected?: boolean }).injected) continue
    const text = (event as { text: string }).text.trim()
    if (text !== '') {
      excerpt = text.slice(0, EXCERPT_CHARS)
      break
    }
  }
  let title: string | null = null
  let preset: string | null = null
  let selection: ModelSelection | null = null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (title === null && event.type === 'session-title') title = (event as { title: string }).title
    else if (preset === null && event.type === 'agent-preset') preset = (event as { preset: string }).preset
    else if (selection === null && event.type === 'request-header') {
      const config = (event as { header: { config: { provider?: string; model?: string; reasoningEffort?: string } } }).header.config
      if (config.provider && config.model) {
        selection = {
          provider: config.provider,
          model: config.model,
          ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
        }
      }
    } else if (selection === null && event.type === 'request-context') {
      const context = event as { provider?: string; model?: string }
      if (context.provider && context.model) selection = { provider: context.provider, model: context.model }
    }
  }
  return { excerpt, title, preset, selection }
}

/**
 * 从日志文件折叠摘要字段，边走边丢。
 *
 * 流式帧整行跳过（占行数 98%）：摘要只关心首条用户消息与末尾三条元数据，
 * 没必要为它们解析几十万条 chunk。反向扫描留给末尾字段用，正向扫描只到
 * 首条用户消息即停。
 */
function foldSummaryFile(file: string): SummaryFold {
  const raw = fs.readFileSync(file, 'utf8')
  let excerpt: string | null = null
  let first = true
  let start = 0
  while (start < raw.length) {
    let end = raw.indexOf('\n', start)
    if (end < 0) end = raw.length
    const line = raw.slice(start, end)
    start = end + 1
    if (line.trim() === '') continue
    if (first) {
      first = false
      continue
    }
    if (excerpt !== null) break
    if (TRANSIENT_HEAD.test(line)) continue
    let parsed: Envelope
    try {
      parsed = JSON.parse(line) as Envelope
    } catch {
      continue
    }
    if (parsed.type !== 'user-message' || (parsed as { injected?: boolean }).injected) continue
    const text = (parsed as { text: string }).text.trim()
    if (text !== '') excerpt = text.slice(0, EXCERPT_CHARS)
  }
  // 末尾字段从后往前走，命中各一条即可停。
  let title: string | null = null
  let preset: string | null = null
  let selection: ModelSelection | null = null
  let tail = raw.length
  let scanned = 0
  while (tail > 0 && scanned < 20_000 && (title === null || preset === null || selection === null)) {
    const newline = raw.lastIndexOf('\n', tail - 1)
    const lineStart = newline + 1
    const line = raw.slice(lineStart, tail)
    tail = newline
    scanned += 1
    if (line.trim() === '' || TRANSIENT_HEAD.test(line)) continue
    let parsed: Envelope
    try {
      parsed = JSON.parse(line) as Envelope
    } catch {
      continue
    }
    if (title === null && parsed.type === 'session-title') title = (parsed as { title: string }).title
    else if (preset === null && parsed.type === 'agent-preset') preset = (parsed as { preset: string }).preset
    else if (selection === null && parsed.type === 'request-header') {
      const config = (parsed as { header: { config: { provider?: string; model?: string; reasoningEffort?: string } } }).header.config
      if (config.provider && config.model) {
        selection = {
          provider: config.provider,
          model: config.model,
          ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
        }
      }
    }
  }
  return { excerpt, title, preset, selection }
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

function synthesizedSeq(events: Envelope[]): number {
  return events[events.length - 1]?.seq ?? 0
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
function repairOpenTurn(events: Envelope[], lastSeq = events[events.length - 1]?.seq ?? 0): Envelope | null {
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
  const seq = lastSeq + 1
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