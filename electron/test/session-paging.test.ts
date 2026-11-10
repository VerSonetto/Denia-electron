// History paging must count display events only and split at conversation turns.

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

/** one complete turn: 6 durable events plus a burst of stream-only frames. */
function turn(store: SessionStore, id: string, number: number): Envelope[] {
  const events: Envelope[] = []
  events.push(append(store, id, { type: 'user-message', text: `question ${number}`, injected: false }))
  events.push(append(store, id, { type: 'turn-start', turn: number }))
  events.push(append(store, id, { type: 'step-start', turn: number, step: 1 }))
  for (let index = 0; index < 40; index += 1) {
    append(store, id, {
      type: 'assistant-chunk',
      turn: number,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: `chunk ${number}/${index}` },
    })
    append(store, id, {
      type: 'tool-output-chunk',
      call_id: `call-${number}-${index}`,
      stream: 'stdout',
      text: `output ${number}/${index}`,
    })
  }
  events.push(append(store, id, {
    type: 'assistant-message',
    turn: number,
    step: 1,
    blocks: [{ type: 'text', text: `answer ${number}` }],
  }))
  events.push(append(store, id, { type: 'step-end', turn: number, step: 1 }))
  events.push(append(store, id, { type: 'turn-end', turn: number, reason: { kind: 'completed' } }))
  return events
}

test('readPage pages durable events and starts at a user message', () => {
  const store = new SessionStore(tempDir('denia-paging-home-'))
  const id = store.create(tempDir('denia-paging-cwd-')).id
  const turns = [turn(store, id, 1), turn(store, id, 2), turn(store, id, 3)]

  const first = store.readPage(id, undefined, 4)
  assert.ok(first)
  assert.equal(first.total, 18)
  assert.equal(first.events.length, 6)
  assert.equal(first.events[0]?.type, 'user-message')
  assert.equal((first.events[0] as { text: string }).text, 'question 3')
  assert.equal(first.hasMoreBefore, true)
  assert.ok(first.events.every(
    (event) => event.type !== 'assistant-chunk' && event.type !== 'tool-output-chunk',
  ))

  const second = store.readPage(id, turns[2]![0]!.seq, 4)
  assert.ok(second)
  assert.equal(second.events.length, 6)
  assert.equal((second.events[0] as { text: string }).text, 'question 2')
  assert.equal(second.hasMoreBefore, true)

  const third = store.readPage(id, turns[1]![0]!.seq, 4)
  assert.ok(third)
  assert.equal(third.events.length, 6)
  assert.equal((third.events[0] as { text: string }).text, 'question 1')
  assert.equal(third.hasMoreBefore, false)

  const whole = store.readPage(id, undefined, 100)
  assert.ok(whole)
  assert.equal(whole.events.length, 18)
  assert.equal(whole.hasMoreBefore, false)

  // 短轮次会合并进同一页：页首取离预算边界最近的那条用户消息。
  const combined = store.readPage(id, undefined, 12)
  assert.ok(combined)
  assert.equal(combined.events.length, 12)
  assert.equal((combined.events[0] as { text: string }).text, 'question 2')
  assert.equal(combined.hasMoreBefore, true)

  // 参考边界落在两轮之间时，页首取最近的那一轮，不切在轮次中间。
  const aligned = store.readPage(id, undefined, 5)
  assert.ok(aligned)
  assert.equal(aligned.events.length, 6)
  assert.equal((aligned.events[0] as { text: string }).text, 'question 3')
})

test('a parent delivery is a page boundary in a child session', () => {
  const store = new SessionStore(tempDir('denia-paging-child-home-'))
  const id = store.create(tempDir('denia-paging-child-cwd-'), { parentSession: 'parent-1' }).id
  for (const number of [1, 2]) {
    append(store, id, {
      type: 'agent-delivery',
      id: `task-${number}`,
      text: `delegated task ${number}`,
      source: 'agent:parent-1',
    })
    append(store, id, { type: 'turn-start', turn: number })
    append(store, id, {
      type: 'assistant-message',
      turn: number,
      step: 1,
      blocks: [{ type: 'text', text: `answer ${number}` }],
    })
    append(store, id, { type: 'turn-end', turn: number, reason: { kind: 'completed' } })
  }

  const page = store.readPage(id, undefined, 2)
  assert.ok(page)
  assert.equal(page.events.length, 4)
  assert.equal(page.events[0]?.type, 'agent-delivery')
  assert.equal((page.events[0] as { text: string }).text, 'delegated task 2')
  assert.equal(page.hasMoreBefore, true)
})
