// Token usage accounting over the session logs.
//
// The conversation log is the only place denia records provider usage: every
// settled model request leaves one `assistant-message` carrying the numbers the
// provider reported. This module folds those rows into day / model / session
// buckets, so the usage page can answer "how many tokens did the last 30 days
// take" without re-reading hundreds of megabytes of logs on every render.
//
// Accounting contract (mirrors `core/wire.ts` `TokenUsage`): `inputTokens` is
// the **uncached** prompt, disjoint from `cacheReadTokens`; the billed prompt is
// their sum, and `reasoningTokens` is a detail of the output side rather than a
// fourth bucket. Every total here therefore adds cached prompt + output and
// leaves reasoning out, or a reasoning-heavy turn would be billed twice.

import fs from 'node:fs'
import path from 'node:path'

import type { SessionHeader, TokenUsage } from '../core/wire.ts'

const DAY_MS = 86_400_000

/** Activity heatmap width in weeks, this one included. Monday is the top row. */
export const HEATMAP_WEEKS = 53

export type UsageRange = 'today' | '7d' | '30d' | 'all'

/** Every range the usage endpoint accepts, in the order the page offers them. */
export const USAGE_RANGES: readonly UsageRange[] = ['today', '7d', '30d', 'all']

export function isUsageRange(value: unknown): value is UsageRange {
  return typeof value === 'string' && (USAGE_RANGES as readonly string[]).includes(value)
}

/** Token counters for one day, model or session. */
export interface UsageBucket {
  /** Uncached prompt tokens. */
  inputTokens: number
  /** Prompt tokens served from the provider cache (disjoint from `inputTokens`). */
  cacheReadTokens: number
  outputTokens: number
  /** Output-side detail; already inside `outputTokens` for most providers. */
  reasoningTokens: number
  /** Model requests that reported usage. */
  requests: number
  /** Finished turns. */
  turns: number
  /** Tool calls started. */
  toolCalls: number
}

export interface UsageSummary extends UsageBucket {
  /** Billed prompt + output. */
  totalTokens: number
  /** `cacheRead / (input + cacheRead)`, percent; null when no provider reported a cache. */
  cacheHitRate: number | null
  activeDays: number
  peakDay: string | null
  peakDayTokens: number
  currentStreakDays: number
  longestStreakDays: number
  /** Sessions that reported usage in the window. */
  sessions: number
}

export interface UsageDay extends UsageBucket {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string
  totalTokens: number
}

export interface UsageModelRow extends UsageBucket {
  provider: string
  model: string
  totalTokens: number
  /** Share of the window's total tokens, 0–1. */
  share: number
}

export interface UsageSessionRow extends UsageBucket {
  id: string
  title: string | null
  cwd: string | null
  updatedAt: number
  /** Spawned by another session rather than by the user. */
  subagent: boolean
  totalTokens: number
}

export interface UsageHeatmapCell {
  date: string
  totalTokens: number
  requests: number
  /** 0 = none, 1–4 = rising quarters of the busiest day. */
  level: number
}

export interface UsageHeatmapWeek {
  weekIndex: number
  /** Seven cells, Monday first; null fills the columns after today. */
  days: (UsageHeatmapCell | null)[]
}

export interface UsageHeatmap {
  startDate: string
  endDate: string
  maxTokens: number
  weeks: UsageHeatmapWeek[]
}

export interface UsageSnapshot {
  range: UsageRange
  /** Ranges the page may offer; the server owns the set. */
  ranges: UsageRange[]
  generatedAt: number
  timeZone: string
  /** All-time totals: the strip and the heatmap never shrink with the range. */
  lifetime: UsageSummary
  summary: UsageSummary
  /** Continuous days across the window, oldest first. */
  days: UsageDay[]
  models: UsageModelRow[]
  sessions: UsageSessionRow[]
  heatmap: UsageHeatmap
}

interface Bucket extends UsageBucket {
  /** Requests that explicitly reported cache tokens (0 = provider sent none). */
  cacheReported: number
}

interface ModelFacts {
  provider: string
  model: string
  bucket: Bucket
}

interface DayFacts {
  bucket: Bucket
  models: Map<string, ModelFacts>
}

interface SessionFacts {
  id: string
  title: string | null
  excerpt: string | null
  cwd: string | null
  createdAt: number
  updatedAt: number
  subagent: boolean
  days: Map<string, DayFacts>
}

interface CachedFacts {
  mtimeMs: number
  size: number
  facts: SessionFacts
}

function emptyBucket(): Bucket {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    requests: 0,
    turns: 0,
    toolCalls: 0,
    cacheReported: 0,
  }
}

function addUsage(bucket: Bucket, usage: TokenUsage): void {
  bucket.inputTokens += Math.max(0, usage.inputTokens ?? 0)
  bucket.outputTokens += Math.max(0, usage.outputTokens ?? 0)
  bucket.reasoningTokens += Math.max(0, usage.reasoningTokens ?? 0)
  bucket.requests += 1
  // Absent means "the provider did not report a cache" — a different fact from
  // a reported zero, and the one that decides whether a hit rate is shown.
  if (usage.cacheReadTokens !== undefined) {
    bucket.cacheReadTokens += Math.max(0, usage.cacheReadTokens)
    bucket.cacheReported += 1
  }
}

function addBucket(target: Bucket, source: UsageBucket & { cacheReported?: number }): void {
  target.inputTokens += source.inputTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.outputTokens += source.outputTokens
  target.reasoningTokens += source.reasoningTokens
  target.requests += source.requests
  target.turns += source.turns
  target.toolCalls += source.toolCalls
  target.cacheReported += source.cacheReported ?? (source.cacheReadTokens > 0 ? 1 : 0)
}

/** Local calendar day of an epoch timestamp, `YYYY-MM-DD`. */
export function dayKeyOf(time: number): string {
  const date = new Date(time)
  const month = date.getMonth() + 1
  const day = date.getDate()
  return `${date.getFullYear()}-${month < 10 ? '0' : ''}${month}-${day < 10 ? '0' : ''}${day}`
}

/** Day index of a `YYYY-MM-DD` key: days since the epoch, stable across DST. */
function dayIndexOf(key: string): number {
  return Math.round(Date.parse(`${key}T00:00:00.000Z`) / DAY_MS)
}

function dateOfDayIndex(index: number): string {
  return new Date(index * DAY_MS).toISOString().slice(0, 10)
}

function shiftDay(key: string, days: number): string {
  return dateOfDayIndex(dayIndexOf(key) + days)
}

/** Window start day: `today` is a single day, `all` reaches the earliest usage. */
function rangeStart(range: UsageRange, today: string, earliest: string | null): string {
  switch (range) {
    case 'today':
      return today
    case '7d':
      return shiftDay(today, -6)
    case '30d':
      return shiftDay(today, -29)
    case 'all':
      return earliest !== null && earliest < today ? earliest : today
  }
}

export interface UsageSnapshotOptions {
  /** Injectable clock; the snapshot is otherwise built from the real one. */
  now?: number
}

/**
 * Cached fold of every session log under `sessionsDir`.
 *
 * One instance per host. Files are re-read only when their size or mtime
 * changed, and `SCAN_TTL_MS` keeps a range switch from stat-ing the whole
 * directory again; the folded facts are small (a day/model map per session), so
 * holding them for every session is cheaper than the alternative of re-reading.
 */
export class UsageIndex {
  private readonly sessionsDir: string
  private readonly cached = new Map<string, CachedFacts>()
  private lastScan = 0

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir
  }

  snapshot(range: UsageRange, options: UsageSnapshotOptions = {}): UsageSnapshot {
    const now = options.now ?? Date.now()
    this.refresh(now)

    const today = dayKeyOf(now)
    // The earliest usage day decides where `all` starts, and it is a property
    // of the folded keys only — no bucket arithmetic needed to find it.
    let earliest: string | null = null
    for (const { facts } of this.cached.values()) {
      for (const date of facts.days.keys()) {
        if (earliest === null || date < earliest) earliest = date
      }
    }
    const start = rangeStart(range, today, earliest)

    // One pass fills both windows. The lifetime strip and the heatmap must not
    // shrink when the range narrows, so they cannot be derived from the range
    // buckets; walking the facts twice would repeat the same arithmetic.
    const lifetimeDays = new Map<string, Bucket>()
    const rangeDays = new Map<string, Bucket>()
    const lifetimeModels = new Map<string, ModelFacts>()
    const rangeModels = new Map<string, ModelFacts>()
    const lifetimeSessions = new Map<string, Bucket>()
    const rangeSessions = new Map<string, Bucket>()

    for (const { facts } of this.cached.values()) {
      let lifetime = (null as Bucket | null)
      let windowed = (null as Bucket | null)
      for (const [date, day] of facts.days) {
        addBucket((lifetime ??= emptyBucket()), day.bucket)
        addBucket(addInto(lifetimeDays, date), day.bucket)
        for (const [key, model] of day.models) {
          addBucket(modelInto(lifetimeModels, key, model).bucket, model.bucket)
        }
        if (date < start || date > today) continue
        addBucket((windowed ??= emptyBucket()), day.bucket)
        addBucket(addInto(rangeDays, date), day.bucket)
        for (const [key, model] of day.models) {
          addBucket(modelInto(rangeModels, key, model).bucket, model.bucket)
        }
      }
      // A session that only ran turns without any provider usage is not a row.
      if (lifetime !== null && lifetime.requests > 0) lifetimeSessions.set(facts.id, lifetime)
      if (windowed !== null && windowed.requests > 0) rangeSessions.set(facts.id, windowed)
    }

    const lifetimeTotals = sumBuckets(lifetimeDays.values())
    const rangeTotals = sumBuckets(rangeDays.values())
    const rangeTotal = totalOf(rangeTotals)

    return {
      range,
      ranges: [...USAGE_RANGES],
      generatedAt: now,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      lifetime: summarize(lifetimeTotals, lifetimeDays, lifetimeSessions.size, today),
      summary: summarize(rangeTotals, rangeDays, rangeSessions.size, today),
      days: filledDays(rangeDays, start, today),
      models: [...rangeModels.values()]
        .map((model) => ({
          provider: model.provider,
          model: model.model,
          ...rowOf(model.bucket),
          totalTokens: totalOf(model.bucket),
          share: rangeTotal > 0 ? totalOf(model.bucket) / rangeTotal : 0,
        }))
        .sort((left, right) => right.totalTokens - left.totalTokens),
      sessions: [...rangeSessions.entries()]
        .map(([id, bucket]) => this.sessionRow(id, bucket))
        .sort((left, right) => right.totalTokens - left.totalTokens),
      heatmap: buildHeatmap(lifetimeDays, today),
    }
  }

  /** Session row for a folded bucket; metadata comes from the cached facts. */
  private sessionRow(id: string, bucket: Bucket): UsageSessionRow {
    const facts = this.cached.get(id)?.facts
    return {
      id,
      title: facts?.title ?? facts?.excerpt ?? null,
      cwd: facts?.cwd ?? null,
      updatedAt: facts?.updatedAt ?? 0,
      subagent: facts?.subagent ?? false,
      ...rowOf(bucket),
      totalTokens: totalOf(bucket),
    }
  }

  /** Re-read logs whose size or mtime changed; drop sessions that disappeared. */
  private refresh(now: number): void {
    if (now - this.lastScan < SCAN_TTL_MS) return
    this.lastScan = now
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true })
    } catch {
      this.cached.clear()
      return
    }
    const seen = new Set<string>()
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const id = entry.name
      const file = path.join(this.sessionsDir, id, 'session.jsonl')
      let stat: fs.Stats
      try {
        stat = fs.statSync(file)
      } catch {
        continue
      }
      seen.add(id)
      const hit = this.cached.get(id)
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) continue
      const facts = foldLog(file, id, stat)
      if (facts === null) this.cached.delete(id)
      else this.cached.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, facts })
    }
    for (const id of [...this.cached.keys()]) {
      if (!seen.has(id)) this.cached.delete(id)
    }
  }
}

/** Directory re-stat cooldown; the folded facts survive it. */
const SCAN_TTL_MS = 2_000

const READ_CHUNK = 1 << 20

/**
 * Record head: the writer serialises `{ seq, time, ...event }`, so the type is
 * always in the same place. Matching it first skips JSON.parse for the ~98% of
 * lines that are stream frames or carry nothing the usage fold needs.
 */
const HEAD = /^\{"seq":\d+,"time":(\d+),"type":"([a-z-]*)/

const INTERESTING = new Set([
  'assistant-message',
  'request-context',
  'turn-end',
  'tool-call',
  'session-title',
  'user-message',
])

interface UsageRecord {
  seq: number
  time: number
  type: string
  usage?: TokenUsage
  turn?: number
  step?: number
  provider?: string
  model?: string
  title?: string
  text?: string
  injected?: boolean
}

/**
 * Fold one session log.
 *
 * Reads by chunk rather than whole-file: a long session reaches tens of
 * megabytes of stream frames, and only the settled records matter here. Chunks
 * are split on newlines with a carry buffer, because a chunk boundary can land
 * in the middle of a multi-byte character or of a line.
 */
function foldLog(file: string, id: string, stat: fs.Stats): SessionFacts | null {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return null
  }
  const facts: SessionFacts = {
    id,
    title: null,
    excerpt: null,
    cwd: null,
    createdAt: stat.birthtimeMs || stat.mtimeMs,
    updatedAt: stat.mtimeMs,
    subagent: false,
    days: new Map(),
  }
  // Model of each (turn, step): usage lands on the assistant message, while the
  // model is named by the request-context row emitted just before it.
  const models = new Map<string, { provider: string; model: string }>()
  let sawHeader = false
  let carry = ''

  const handle = (record: UsageRecord): void => {
    const time = typeof record.time === 'number' ? record.time : facts.updatedAt
    switch (record.type) {
      case 'assistant-message': {
        if (!record.usage) return
        const day = dayOf(facts, time)
        addUsage(day.bucket, record.usage)
        const key = `${record.turn ?? 0}:${record.step ?? 0}`
        const named = models.get(key)
        if (named === undefined) return
        const modelKey = `${named.provider}\u0000${named.model}`
        const model = day.models.get(modelKey) ?? {
          provider: named.provider,
          model: named.model,
          bucket: emptyBucket(),
        }
        addUsage(model.bucket, record.usage)
        day.models.set(modelKey, model)
        return
      }
      case 'request-context': {
        if (typeof record.provider !== 'string' || typeof record.model !== 'string') return
        models.set(`${record.turn ?? 0}:${record.step ?? 0}`, {
          provider: record.provider,
          model: record.model,
        })
        return
      }
      case 'turn-end':
        dayOf(facts, time).bucket.turns += 1
        return
      case 'tool-call':
        dayOf(facts, time).bucket.toolCalls += 1
        return
      case 'session-title':
        if (typeof record.title === 'string' && record.title.trim() !== '') {
          facts.title = record.title.trim()
        }
        return
      case 'user-message':
        // The sidebar excerpt is the fallback label when no title was generated.
        if (facts.excerpt !== null || facts.title !== null) return
        if (record.injected === true) return
        if (typeof record.text !== 'string') return
        facts.excerpt = record.text.trim().slice(0, 120) || null
        return
      default:
        return
    }
  }

  const consumeRecord = (line: string): void => {
    if (!sawHeader) {
      sawHeader = true
      try {
        const header = JSON.parse(line) as SessionHeader
        if (header.type !== 'session') return
        if (typeof header.cwd === 'string') facts.cwd = header.cwd
        facts.subagent = header.subagent !== undefined
        if (typeof header.created_at === 'number' && header.created_at > 0) {
          facts.createdAt = header.created_at
        }
        const label = header.subagent?.label
        if (typeof label === 'string' && label.trim() !== '') facts.title = label.trim()
      } catch {
        /* torn header: keep going, the summary just lacks metadata */
      }
      return
    }
    const head = HEAD.exec(line)
    if (head === null) {
      for (const part of splitMerged(line)) consumeRecord(part)
      return
    }
    if (!INTERESTING.has(head[2]!)) {
      // Old writers could buffer several envelopes onto one line; the first
      // record decides the head match, so only look for more when the line
      // actually carries another record.
      if (!line.includes('}{"seq":')) return
      for (const part of splitMerged(line)) consumeRecord(part)
      return
    }
    let parsed: UsageRecord
    try {
      parsed = JSON.parse(line) as UsageRecord
    } catch {
      for (const part of splitMerged(line)) consumeRecord(part)
      return
    }
    handle(parsed)
  }

  const consumeLine = (line: string): void => {
    if (line.trim() === '') return
    consumeRecord(line)
  }

  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK)
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null)
      if (read <= 0) break
      carry += chunk.subarray(0, read).toString('utf8')
      let start = 0
      for (;;) {
        const end = carry.indexOf('\n', start)
        if (end < 0) break
        consumeLine(carry.slice(start, end))
        start = end + 1
      }
      carry = start === 0 ? carry : carry.slice(start)
    }
    if (carry.trim() !== '') consumeLine(carry)
  } catch {
    // A partially written log is still worth its prefix.
  } finally {
    fs.closeSync(fd)
  }
  return facts
}

/**
 * Split a line that holds several concatenated envelopes.
 *
 * Only reached for lines that failed to parse as one record (a handful in logs
 * written by older builds). The marker is the start of every envelope; a
 * false split inside a record's text costs that one record, not the session.
 */
function splitMerged(line: string): string[] {
  const parts: string[] = []
  let start = line.indexOf('{"seq":')
  while (start >= 0) {
    const next = line.indexOf('{"seq":', start + 7)
    parts.push((next < 0 ? line.slice(start) : line.slice(start, next)).trim())
    start = next
  }
  return parts
}

function dayOf(facts: SessionFacts, time: number): DayFacts {
  const key = dayKeyOf(time)
  const existing = facts.days.get(key)
  if (existing !== undefined) return existing
  const created: DayFacts = { bucket: emptyBucket(), models: new Map() }
  facts.days.set(key, created)
  return created
}

function addInto(map: Map<string, Bucket>, key: string): Bucket {
  const existing = map.get(key)
  if (existing !== undefined) return existing
  const created = emptyBucket()
  map.set(key, created)
  return created
}

/** Model bucket of `map`, created on first use. */
function modelInto(map: Map<string, ModelFacts>, key: string, source: ModelFacts): ModelFacts {
  const existing = map.get(key)
  if (existing !== undefined) return existing
  const created: ModelFacts = {
    provider: source.provider,
    model: source.model,
    bucket: emptyBucket(),
  }
  map.set(key, created)
  return created
}

function sumBuckets(buckets: Iterable<Bucket>): Bucket {
  const total = emptyBucket()
  for (const bucket of buckets) addBucket(total, bucket)
  return total
}

/** Billed tokens of a bucket: prompt (cached + uncached) plus output. */
function totalOf(bucket: UsageBucket): number {
  return bucket.inputTokens + bucket.cacheReadTokens + bucket.outputTokens
}

function rowOf(bucket: UsageBucket): UsageBucket {
  return {
    inputTokens: bucket.inputTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    outputTokens: bucket.outputTokens,
    reasoningTokens: bucket.reasoningTokens,
    requests: bucket.requests,
    turns: bucket.turns,
    toolCalls: bucket.toolCalls,
  }
}

function summarize(
  totals: Bucket,
  days: Map<string, Bucket>,
  sessions: number,
  today: string,
): UsageSummary {
  let activeDays = 0
  let peakDay: string | null = null
  let peakDayTokens = 0
  for (const [date, bucket] of days) {
    const tokens = totalOf(bucket)
    if (tokens <= 0) continue
    activeDays += 1
    if (tokens > peakDayTokens) {
      peakDayTokens = tokens
      peakDay = date
    }
  }
  const { currentStreakDays, longestStreakDays } = streaks(days, today)
  const prompt = totals.inputTokens + totals.cacheReadTokens
  return {
    ...rowOf(totals),
    totalTokens: totalOf(totals),
    cacheHitRate:
      totals.cacheReported > 0 && prompt > 0
        ? Math.min(100, (totals.cacheReadTokens / prompt) * 100)
        : null,
    activeDays,
    peakDay,
    peakDayTokens,
    currentStreakDays,
    longestStreakDays,
    sessions,
  }
}

/**
 * Consecutive active days.
 *
 * The current streak counts back from today; a today with no usage yet does not
 * break it (a user asking at 09:00 should not see yesterday's run reset to 0),
 * so it starts at yesterday in that case. `longest` is over the whole history.
 */
function streaks(
  days: Map<string, Bucket>,
  today: string,
): { currentStreakDays: number; longestStreakDays: number } {
  const active: number[] = []
  for (const [date, bucket] of days) {
    if (totalOf(bucket) > 0) active.push(dayIndexOf(date))
  }
  if (active.length === 0) return { currentStreakDays: 0, longestStreakDays: 0 }
  active.sort((left, right) => left - right)
  let longest = 1
  let run = 1
  for (let index = 1; index < active.length; index += 1) {
    if (active[index] === active[index - 1]! + 1) run += 1
    else run = 1
    if (run > longest) longest = run
  }
  const latest = active[active.length - 1]!
  const todayIndex = dayIndexOf(today)
  let current = 0
  if (latest === todayIndex || latest === todayIndex - 1) {
    current = 1
    for (let index = active.length - 1; index > 0; index -= 1) {
      if (active[index - 1] !== active[index]! - 1) break
      current += 1
    }
  }
  return { currentStreakDays: current, longestStreakDays: longest }
}

/** Continuous calendar days across the window, gaps included as zeros. */
function filledDays(days: Map<string, Bucket>, start: string, end: string): UsageDay[] {
  const out: UsageDay[] = []
  const last = dayIndexOf(end)
  for (let index = dayIndexOf(start); index <= last; index += 1) {
    const date = dateOfDayIndex(index)
    const bucket = days.get(date)
    const empty = emptyBucket()
    const source = bucket ?? empty
    out.push({
      date,
      ...rowOf(source),
      totalTokens: totalOf(source),
    })
  }
  return out
}

/**
 * Heatmap of the last `HEATMAP_WEEKS` weeks, Monday first.
 *
 * Levels are relative to the busiest day on screen: absolute thresholds would
 * either paint an entire quiet history black or wash out a busy one.
 */
function buildHeatmap(days: Map<string, Bucket>, today: string): UsageHeatmap {
  const lastIndex = dayIndexOf(today)
  // getUTCDay(): 0 = Sunday. Monday-first offset of today's column.
  const weekday = new Date(lastIndex * DAY_MS).getUTCDay()
  const mondayOffset = (weekday + 6) % 7
  const startIndex = lastIndex - mondayOffset - (HEATMAP_WEEKS - 1) * 7
  let maxTokens = 0
  for (const bucket of days.values()) {
    maxTokens = Math.max(maxTokens, totalOf(bucket))
  }
  const weeks: UsageHeatmapWeek[] = []
  for (let weekIndex = 0; weekIndex < HEATMAP_WEEKS; weekIndex += 1) {
    const cells: (UsageHeatmapCell | null)[] = []
    for (let offset = 0; offset < 7; offset += 1) {
      const dayIndex = startIndex + weekIndex * 7 + offset
      if (dayIndex > lastIndex) {
        cells.push(null)
        continue
      }
      const date = dateOfDayIndex(dayIndex)
      const bucket = days.get(date)
      const tokens = bucket === undefined ? 0 : totalOf(bucket)
      cells.push({
        date,
        totalTokens: tokens,
        requests: bucket?.requests ?? 0,
        level: heatLevel(tokens, maxTokens),
      })
    }
    weeks.push({ weekIndex, days: cells })
  }
  return {
    startDate: dateOfDayIndex(startIndex),
    endDate: today,
    maxTokens,
    weeks,
  }
}

function heatLevel(tokens: number, max: number): number {
  if (tokens <= 0 || max <= 0) return 0
  const ratio = tokens / max
  if (ratio > 0.75) return 4
  if (ratio > 0.5) return 3
  if (ratio > 0.25) return 2
  return 1
}
