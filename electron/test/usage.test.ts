// Token usage fold over the session logs: bucket boundaries, the model join
// and the cache-reported distinction.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { SessionStore } from '../src/session/store.ts'
import { UsageIndex, dayKeyOf } from '../src/session/usage.ts'
import type { SessionEvent, TokenUsage } from '../src/core/wire.ts'

function tempHome(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** One request: the context row names the model, the message carries usage. */
function request(
  store: SessionStore,
  id: string,
  turn: number,
  step: number,
  provider: string,
  model: string,
  usage: TokenUsage,
): void {
  store.append(id, { type: 'request-context', turn, step, provider, model })
  store.append(id, {
    type: 'assistant-message',
    turn,
    step,
    blocks: [{ type: 'text', text: 'ok' }],
    usage,
  })
  // The index reads the log from disk; the writer buffers other event types.
  store.flush(id)
}

function session(store: SessionStore, cwd: string): string {
  return store.create(cwd).id
}

function append(store: SessionStore, id: string, event: SessionEvent): void {
  store.append(id, event)
  store.flush(id)
}

test('usage: billed total is cached prompt + uncached prompt + output', () => {
  const home = tempHome('denia-usage-')
  try {
    const store = new SessionStore(home)
    const id = session(store, home)
    request(store, id, 1, 1, 'p', 'm', {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 900,
      // Reasoning is an output-side detail on most providers; adding it to the
      // total would bill those tokens twice.
      reasoningTokens: 7,
    })
    const snapshot = new UsageIndex(store.sessionsDir).snapshot('all')
    assert.equal(snapshot.summary.inputTokens, 100)
    assert.equal(snapshot.summary.cacheReadTokens, 900)
    assert.equal(snapshot.summary.outputTokens, 20)
    assert.equal(snapshot.summary.reasoningTokens, 7)
    assert.equal(snapshot.summary.totalTokens, 1020)
    assert.equal(snapshot.summary.cacheHitRate, 90)
    assert.equal(snapshot.summary.requests, 1)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('usage: a provider that reports no cache is not a cache miss', () => {
  // "Did not say" and "said zero" are different facts: the first must not
  // render a hit rate at all, the second must render 0%.
  const silentHome = tempHome('denia-usage-silent-')
  const zeroHome = tempHome('denia-usage-zero-')
  try {
    const silentStore = new SessionStore(silentHome)
    request(silentStore, session(silentStore, silentHome), 1, 1, 'p', 'm', {
      inputTokens: 50,
      outputTokens: 5,
    })
    const silent = new UsageIndex(silentStore.sessionsDir).snapshot('all')
    assert.equal(silent.summary.cacheHitRate, null)
    assert.equal(silent.summary.totalTokens, 55)

    const zeroStore = new SessionStore(zeroHome)
    request(zeroStore, session(zeroStore, zeroHome), 1, 1, 'p', 'm', {
      inputTokens: 50,
      outputTokens: 5,
      cacheReadTokens: 0,
    })
    const zero = new UsageIndex(zeroStore.sessionsDir).snapshot('all')
    assert.equal(zero.summary.cacheHitRate, 0)
    assert.equal(zero.summary.totalTokens, 55)
  } finally {
    fs.rmSync(silentHome, { recursive: true, force: true })
    fs.rmSync(zeroHome, { recursive: true, force: true })
  }
})

test('usage: rows land on the model named by the same turn and step', () => {
  const home = tempHome('denia-usage-')
  try {
    const store = new SessionStore(home)
    const id = session(store, home)
    request(store, id, 1, 1, 'alpha', 'first', { inputTokens: 10, outputTokens: 1 })
    request(store, id, 1, 2, 'beta', 'second', { inputTokens: 20, outputTokens: 2 })
    // A later turn repeating the first model must merge into one row.
    request(store, id, 2, 1, 'alpha', 'first', { inputTokens: 30, outputTokens: 3 })

    const snapshot = new UsageIndex(store.sessionsDir).snapshot('all')
    assert.equal(snapshot.models.length, 2)
    const [top, rest] = snapshot.models
    // Turn 2 repeats the first model, so its row must merge rather than split.
    assert.equal(top?.provider, 'alpha')
    assert.equal(top?.model, 'first')
    assert.equal(top?.totalTokens, 44)
    assert.equal(top?.requests, 2)
    assert.equal(rest?.provider, 'beta')
    assert.equal(rest?.model, 'second')
    assert.equal(rest?.totalTokens, 22)
    // Shares are of the window total, so they sum to 1.
    assert.ok(Math.abs((top?.share ?? 0) + (rest?.share ?? 0) - 1) < 1e-9)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('usage: usage before any request-context still counts in the totals', () => {
  const home = tempHome('denia-usage-')
  try {
    const store = new SessionStore(home)
    const id = session(store, home)
    // A log cut short can hold a message without its context row. The tokens
    // were spent, so they belong in the day and session totals; only the model
    // breakdown has nothing to attribute them to.
    append(store, id, {
      type: 'assistant-message',
      turn: 1,
      step: 1,
      blocks: [],
      usage: { inputTokens: 8, outputTokens: 2 },
    })
    const snapshot = new UsageIndex(store.sessionsDir).snapshot('all')
    assert.equal(snapshot.summary.totalTokens, 10)
    assert.equal(snapshot.models.length, 0)
    assert.equal(snapshot.sessions.length, 1)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('usage: turns and tool calls are counted once per event', () => {
  const home = tempHome('denia-usage-')
  try {
    const store = new SessionStore(home)
    const id = session(store, home)
    request(store, id, 1, 1, 'p', 'm', { inputTokens: 1, outputTokens: 1 })
    append(store, id, { type: 'turn-end', turn: 1, reason: { kind: 'completed' } })
    append(store, id, {
      type: 'tool-call',
      turn: 1,
      step: 1,
      call_id: 'c1',
      name: 'read_file',
      arguments: '{}',
    })
    append(store, id, {
      type: 'tool-call',
      turn: 1,
      step: 1,
      call_id: 'c2',
      name: 'read_file',
      arguments: '{}',
    })
    // `tool-call` does not force a flush on its own.
    const snapshot = new UsageIndex(store.sessionsDir).snapshot('all')
    assert.equal(snapshot.summary.turns, 1)
    assert.equal(snapshot.summary.toolCalls, 2)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('usage: the window filters days while lifetime and heatmap stay whole', () => {
  const home = tempHome('denia-usage-')
  try {
    const store = new SessionStore(home)
    const id = session(store, home)
    const now = Date.parse('2026-03-15T12:00:00.000Z')
    const today = new Date(now)
    const old = new Date(today.getTime() - 60 * 86_400_000)
    // The fold buckets by the record's own timestamp, so the test pins both the
    // clock and the row times to the same instants.
    request(store, id, 1, 1, 'p', 'old', { inputTokens: 1000, outputTokens: 0 })
    rewriteTimes(store, id, { 2: old.getTime(), 3: old.getTime() })
    request(store, id, 2, 1, 'p', 'new', { inputTokens: 10, outputTokens: 0 })
    rewriteTimes(store, id, { 4: now, 5: now })

    const index = new UsageIndex(store.sessionsDir)
    const recent = index.snapshot('7d', { now })
    assert.equal(recent.summary.totalTokens, 10)
    assert.equal(recent.lifetime.totalTokens, 1010)
    assert.equal(recent.heatmap.weeks.length, 53)
    assert.equal(recent.heatmap.weeks.flatMap((week) => week.days).length, 53 * 7)
    // The heatmap reaches back past the window: the old day is still painted.
    const painted = recent.heatmap.weeks
      .flatMap((week) => week.days)
      .filter((cell) => cell !== null && cell.totalTokens > 0)
    assert.equal(painted.length, 2)

    const all = index.snapshot('all', { now })
    assert.equal(all.summary.totalTokens, 1010)
    assert.equal(all.days[0]?.date, dayKeyOf(old.getTime()))
    assert.equal(all.summary.activeDays, 2)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('usage: the window is a continuous run of days, gaps included', () => {
  const home = tempHome('denia-usage-')
  try {
    const store = new SessionStore(home)
    const id = session(store, home)
    const now = Date.parse('2026-03-15T12:00:00.000Z')
    request(store, id, 1, 1, 'p', 'm', { inputTokens: 5, outputTokens: 0 })
    rewriteTimes(store, id, { 2: now, 3: now })

    const snapshot = new UsageIndex(store.sessionsDir).snapshot('7d', { now })
    assert.deepEqual(
      snapshot.days.map((day) => day.totalTokens),
      [0, 0, 0, 0, 0, 0, 5],
    )
    assert.equal(snapshot.days.at(-1)?.date, '2026-03-15')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('usage: an unknown range is rejected instead of silently defaulting', async () => {
  const { isUsageRange, USAGE_RANGES } = await import('../src/session/usage.ts')
  assert.deepEqual(USAGE_RANGES, ['today', '7d', '30d', 'all'])
  assert.equal(isUsageRange('7d'), true)
  assert.equal(isUsageRange('90d'), false)
  assert.equal(isUsageRange(null), false)
})

test('usage: a torn line and a concatenated line do not lose the rest', () => {
  const home = tempHome('denia-usage-')
  try {
    const store = new SessionStore(home)
    const id = session(store, home)
    request(store, id, 1, 1, 'p', 'm', { inputTokens: 4, outputTokens: 1 })
    store.flush(id)
    const file = path.join(store.sessionsDir, id, 'session.jsonl')
    const text = fs.readFileSync(file, 'utf8')
    // An older writer could glue two envelopes onto one line, and a crash can
    // leave a truncated tail. Neither may hide the records around them.
    const glued = [
      '{"seq":900,"time":0,"type":"request-context","turn":2,"step":1,"provider":"p","model":"glued"}',
      '{"seq":901,"time":0,"type":"assistant-message","turn":2,"step":1,"blocks":[],"usage":{"inputTokens":6,"outputTokens":1}}',
    ].join('')
    fs.appendFileSync(file, glued + '\n{"seq":902,"time":0,"ty', 'utf8')

    const snapshot = new UsageIndex(store.sessionsDir).snapshot('all')
    assert.equal(snapshot.summary.totalTokens, 12)
    assert.equal(snapshot.models.length, 2)
    assert.equal(snapshot.models[0]?.model, 'glued')
    assert.equal(snapshot.models[0]?.totalTokens, 7)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/**
 * Rewrite the `time` field of the log's durable records by seq.
 *
 * The store stamps `Date.now()` on append, so a test that needs an old day has
 * to move the rows after the fact; the fold cache keys on size+mtime, so the
 * index must be built afterwards.
 */
function rewriteTimes(store: SessionStore, id: string, times: Record<number, number>): void {
  store.flush(id)
  const file = path.join(store.sessionsDir, id, 'session.jsonl')
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const out = lines.map((line) => {
    if (line.trim() === '') return line
    let parsed: { seq?: number; time?: number }
    try {
      parsed = JSON.parse(line) as { seq?: number; time?: number }
    } catch {
      return line
    }
    const next = parsed.seq === undefined ? undefined : times[parsed.seq]
    if (next === undefined) return line
    return JSON.stringify({ ...parsed, time: next })
  })
  fs.writeFileSync(file, out.join('\n'), 'utf8')
  // Drop the in-memory copy so the next read comes from the rewritten file.
  const mutable = store as unknown as { live: Map<string, unknown> }
  mutable.live.delete(id)
}
