// SessionStore 的内存约束：流式帧不常驻、空闲会话可被驱逐、seq 仍然连续。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { SessionStore } from '../src/session/store.ts'
import type { Envelope, SessionEvent } from '../src/core/wire.ts'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function append(store: SessionStore, id: string, event: SessionEvent): Envelope {
  const envelope = store.append(id, event)
  assert.ok(envelope)
  return envelope
}

/** 读日志文件的行数：流式帧必须落盘，即使内存里已经放弃它们。 */
function logLines(home: string, id: string): number {
  const raw = fs.readFileSync(path.join(home, 'sessions', id, 'session.jsonl'), 'utf8')
  return raw.split('\n').filter((line) => line.trim() !== '').length
}

test('streaming frames are written to disk even when memory stops holding them', () => {
  const home = tempDir('denia-store-mem-')
  const store = new SessionStore(home)
  const id = store.create(tempDir('denia-store-cwd-')).id

  append(store, id, { type: 'user-message', text: 'hello', injected: false })
  append(store, id, { type: 'turn-start', turn: 1 })
  append(store, id, { type: 'step-start', turn: 1, step: 1 })
  for (let index = 0; index < 40; index += 1) {
    append(store, id, {
      type: 'assistant-chunk',
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: `token ${index}` },
    })
  }
  append(store, id, {
    type: 'assistant-message',
    turn: 1,
    step: 1,
    blocks: [{ type: 'text', text: 'done' }],
  })
  store.flush(id)

  // 内存里的事件流仍能读到这一段（新连接要重放出打字机效果）。
  const live = store.read(id)
  assert.ok(live)
  const chunks = live.events.filter((event) => event.type === 'assistant-chunk')
  assert.equal(chunks.length, 40)
  // 磁盘上一条不少：内存窗口是显示缓存，不是事实来源。
  assert.equal(logLines(home, id), 1 + live.events.length)
})

test('a reopened session keeps durable events and only replays the live tail', () => {
  const home = tempDir('denia-store-reopen-')
  const id = new SessionStore(home).create(tempDir('denia-store-cwd-')).id

  {
    const store = new SessionStore(home)
    store.append(id, { type: 'user-message', text: 'first', injected: false })
    store.append(id, { type: 'turn-start', turn: 1 })
    store.append(id, { type: 'step-start', turn: 1, step: 1 })
    for (let index = 0; index < 30; index += 1) {
      store.append(id, {
        type: 'assistant-chunk',
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: `settled ${index}` },
      })
    }
    store.append(id, {
      type: 'assistant-message',
      turn: 1,
      step: 1,
      blocks: [{ type: 'text', text: 'settled answer' }],
    })
    store.append(id, { type: 'step-end', turn: 1, step: 1 })
    store.append(id, { type: 'turn-end', turn: 1, reason: { kind: 'completed' } })
    // 下一轮已经开始，最后这几条帧还没有结算事件。
    store.append(id, { type: 'turn-start', turn: 2 })
    store.append(id, { type: 'step-start', turn: 2, step: 1 })
    const live = store.append(id, {
      type: 'assistant-chunk',
      turn: 2,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'still flowing' },
    })
    assert.ok(live)
    store.flush(id)
  }

  // 新实例从磁盘重建：已结算的 chunk 不再进内存，持久事件一条不少。
  const fresh = new SessionStore(home)
  const reopened = fresh.read(id)
  assert.ok(reopened)
  const settledChunks = reopened.events.filter(
    (event) => event.type === 'assistant-chunk' && event.turn === 1,
  )
  assert.equal(settledChunks.length, 0, 'settled frames must not be re-materialised')
  const flowingChunks = reopened.events.filter(
    (event) => event.type === 'assistant-chunk' && event.turn === 2,
  )
  assert.equal(flowingChunks.length, 1, 'the live tail is still replayable')
  // 第 2 轮在日志里没有 turn-end，载入会补一条中断收尾（既有行为）。
  const ends = reopened.events.filter((event) => event.type === 'turn-end')
  assert.equal(ends.length, 2)
  assert.equal((ends[0] as { turn: number }).turn, 1)
  assert.equal(
    reopened.events.filter((event) => event.type === 'assistant-message').length,
    1,
  )
})

test('seq stays strictly increasing across frames, durable events and reloads', () => {
  const home = tempDir('denia-store-seq-')
  const id = new SessionStore(home).create(tempDir('denia-store-cwd-')).id
  const store = new SessionStore(home)

  const written: Envelope[] = []
  written.push(append(store, id, { type: 'user-message', text: 'q', injected: false }))
  written.push(append(store, id, { type: 'turn-start', turn: 1 }))
  for (let index = 0; index < 5; index += 1) {
    written.push(
      append(store, id, {
        type: 'assistant-chunk',
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: String(index) },
      }),
    )
  }
  written.push(
    append(store, id, {
      type: 'assistant-message',
      turn: 1,
      step: 1,
      blocks: [{ type: 'text', text: 'a' }],
    }),
  )
  store.flush(id)

  for (let index = 1; index < written.length; index += 1) {
    assert.equal(written[index]!.seq, written[index - 1]!.seq + 1)
  }

  // 重开后再追加：seq 必须接在磁盘上最后一条之后，不能回退。
  // 上一轮没有 turn-end，载入时会补一条中断收尾（既有行为），所以这里只断言
  // 「严格递增」，不断言具体偏移。
  const reopened = new SessionStore(home)
  const next = append(reopened, id, { type: 'turn-end', turn: 1, reason: { kind: 'completed' } })
  assert.ok(next.seq > written[written.length - 1]!.seq)
})

test('idle sessions are evicted from memory and rebuilt on demand', () => {
  const home = tempDir('denia-store-lru-')
  const store = new SessionStore(home)
  const ids: string[] = []
  // 超过内部保留上限，逼出驱逐。
  for (let index = 0; index < 16; index += 1) {
    const id = store.create(tempDir('denia-store-cwd-')).id
    append(store, id, { type: 'user-message', text: `session ${index}`, injected: false })
    ids.push(id)
  }
  for (const id of ids) store.flush(id)

  // 被驱逐的会话仍然可读：内容来自磁盘，不是空壳。
  for (const id of ids) {
    const session = store.read(id)
    assert.ok(session, `session ${id} must still be readable`)
    const text = session.events.find((event) => event.type === 'user-message')
    assert.ok(text && 'text' in text)
    assert.match(text.text, /^session \d+$/)
  }
})

test('a session with a live subscriber is never evicted', () => {
  const home = tempDir('denia-store-sub-')
  const store = new SessionStore(home)
  const watched = store.create(tempDir('denia-store-cwd-')).id
  append(store, watched, { type: 'user-message', text: 'watch me', injected: false })
  const seen: Envelope[] = []
  const unsubscribe = store.subscribe(watched, (envelope) => seen.push(envelope))
  try {
    for (let index = 0; index < 16; index += 1) {
      const id = store.create(tempDir('denia-store-cwd-')).id
      append(store, id, { type: 'user-message', text: `noise ${index}`, injected: false })
    }
    // 订阅者仍然收到后续事件：会话没有被驱逐掉订阅关系。
    const appended = append(store, watched, { type: 'turn-start', turn: 1 })
    assert.ok(appended)
    assert.ok(seen.some((event) => event.seq === appended.seq))
  } finally {
    unsubscribe()
  }
})

test('tailProbe reports pending inbox without materialising the whole log', () => {
  const home = tempDir('denia-store-probe-')
  const store = new SessionStore(home)
  const id = store.create(tempDir('denia-store-cwd-')).id

  append(store, id, { type: 'agent-inbox', id: 'task-1', text: 'delegated', source: 'agent:parent' })
  store.flush(id)
  assert.equal(store.tailProbe(id).pendingInbox, true)

  append(store, id, { type: 'agent-delivery', id: 'task-1', text: 'delegated', source: 'agent:parent' })
  append(store, id, { type: 'turn-start', turn: 1 })
  const end = append(store, id, { type: 'turn-end', turn: 1, reason: { kind: 'completed' } })
  store.flush(id)
  assert.equal(store.tailProbe(id).pendingInbox, false)
  assert.equal(store.tailProbe(id).lastTurnEnd, end.time)

  // 从磁盘读同一个结论。
  assert.equal(new SessionStore(home).tailProbe(id).pendingInbox, false)
})
