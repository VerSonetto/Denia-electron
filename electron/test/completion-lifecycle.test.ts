// Unified completion lifecycle: subagent results and background-job results
// share one queue, wait for the model's current step, and wake an idle model.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CompletionLifecycle } from '../src/agent/lifecycle.ts'
import { JobManager } from '../src/jobs/manager.ts'
import { SessionStore } from '../src/session/store.ts'
import type { Envelope } from '../src/core/wire.ts'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function eventsOf(store: SessionStore, id: string): Envelope[] {
  return store.read(id)?.events ?? []
}

function deliveredIds(store: SessionStore, id: string): string[] {
  return eventsOf(store, id)
    .filter((event): event is Extract<Envelope, { type: 'agent-delivery' }> =>
      event.type === 'agent-delivery')
    .map((event) => event.id)
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
}

test('a completion waits for the current step and delivers at its boundary', () => {
  const store = new SessionStore(tempDir('denia-lifecycle-boundary-'))
  const parent = store.create(tempDir('denia-lifecycle-boundary-cwd-'), { sandbox: true })
  const lifecycle = new CompletionLifecycle({
    store,
    isRunning: () => true,
    startTurn: async () => {
      throw new Error('a running turn must not be woken')
    },
  })
  try {
    store.append(parent.id, {
      type: 'assistant-chunk',
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'working' },
    })
    assert.equal(
      lifecycle.push({
        id: 'job:boundary',
        target: parent.id,
        text: 'job finished',
        source: 'job-completed',
      }),
      true,
    )
    // Even an explicit drain must not inject during a streamed action.
    lifecycle.drainInbox(parent.id)
    assert.deepEqual(deliveredIds(store, parent.id), [])

    store.append(parent.id, { type: 'step-end', turn: 1, step: 1 })
    lifecycle.drainInbox(parent.id)
    assert.deepEqual(deliveredIds(store, parent.id), ['job:boundary'])
  } finally {
    lifecycle.close()
    store.delete(parent.id)
  }
})

test('an idle model is woken and receives the completion immediately', () => {
  const store = new SessionStore(tempDir('denia-lifecycle-idle-'))
  const parent = store.create(tempDir('denia-lifecycle-idle-cwd-'), { sandbox: true })
  let starts = 0
  let lifecycle!: CompletionLifecycle
  lifecycle = new CompletionLifecycle({
    store,
    isRunning: () => false,
    startTurn: async (sessionId) => {
      starts += 1
      lifecycle.drainInbox(sessionId)
    },
  })
  try {
    const pushed = lifecycle.push({
      id: 'job:idle',
      target: parent.id,
      text: 'job finished while idle',
      source: 'job-completed',
    })
    assert.equal(pushed, true)
    assert.equal(starts, 1)
    assert.deepEqual(deliveredIds(store, parent.id), ['job:idle'])

    // The same completion identity is a no-op on a later retry.
    assert.equal(
      lifecycle.push({
        id: 'job:idle',
        target: parent.id,
        text: 'job finished while idle',
        source: 'job-completed',
      }),
      false,
    )
    assert.equal(starts, 1)
    assert.deepEqual(deliveredIds(store, parent.id), ['job:idle'])
  } finally {
    lifecycle.close()
    store.delete(parent.id)
  }
})

test('multiple completions keep their arrival order and deduplicate by id', () => {
  const store = new SessionStore(tempDir('denia-lifecycle-order-'))
  const parent = store.create(tempDir('denia-lifecycle-order-cwd-'), { sandbox: true })
  const lifecycle = new CompletionLifecycle({
    store,
    isRunning: () => true,
    startTurn: async () => {},
  })
  try {
    store.append(parent.id, {
      type: 'assistant-chunk',
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'working' },
    })
    lifecycle.push({ id: 'job:1', target: parent.id, text: 'one', source: 'job-completed' })
    lifecycle.push({ id: 'sub:1', target: parent.id, text: 'two', source: 'subagent-settled' })
    lifecycle.push({ id: 'job:1', target: parent.id, text: 'one', source: 'job-completed' })
    lifecycle.push({ id: 'job:2', target: parent.id, text: 'three', source: 'job-completed' })
    store.append(parent.id, { type: 'step-end', turn: 1, step: 1 })
    lifecycle.drainInbox(parent.id)
    assert.deepEqual(deliveredIds(store, parent.id), ['job:1', 'sub:1', 'job:2'])
    const inboxes = eventsOf(store, parent.id).filter((event) => event.type === 'agent-inbox')
    assert.equal(inboxes.length, 3)
  } finally {
    lifecycle.close()
    store.delete(parent.id)
  }
})

test('a finished background job enters the same queue as a subagent result', async () => {
  const store = new SessionStore(tempDir('denia-lifecycle-job-'))
  const parent = store.create(tempDir('denia-lifecycle-job-cwd-'), { sandbox: true })
  let running = true
  let lifecycle!: CompletionLifecycle
  lifecycle = new CompletionLifecycle({
    store,
    isRunning: () => running,
    startTurn: async (sessionId) => {
      lifecycle.drainInbox(sessionId)
    },
  })
  const settled = Promise.withResolvers<void>()
  const manager = new JobManager({
    onDone: (job) => {
      const text = `[后台任务完成]\n${JSON.stringify(manager.peek(job.id, job.owner))}`
      lifecycle.push({
        id: `job:${job.id}`,
        target: job.owner,
        text,
        source: 'job-completed',
      })
      settled.resolve()
      return true
    },
  })
  try {
    store.append(parent.id, {
      type: 'assistant-chunk',
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'working' },
    })
    const job = manager.start({
      owner: parent.id,
      cwd: process.cwd(),
      command: 'node -e "console.log(\'job-ok\')"',
    })
    await settled.promise
    // The job is already an inbox entry, but the model is still in its step.
    assert.deepEqual(deliveredIds(store, parent.id), [])
    store.append(parent.id, { type: 'step-end', turn: 1, step: 1 })
    running = false
    lifecycle.onTurnEnd(parent.id, { kind: 'completed' })
    assert.deepEqual(deliveredIds(store, parent.id), [`job:${job.id}`])
  } finally {
    lifecycle.close()
    store.delete(parent.id)
  }
})

test('a new completion batch bypasses the exhausted wake budget, abort pauses it', async () => {
  const store = new SessionStore(tempDir('denia-lifecycle-budget-'))
  const parent = store.create(tempDir('denia-lifecycle-budget-cwd-'), { sandbox: true })
  let starts = 0
  const lifecycle = new CompletionLifecycle({
    store,
    isRunning: () => false,
    maxConsecutiveWakes: 1,
    startTurn: async () => {
      starts += 1
      // Intentionally leave the inbox pending: this simulates a wake that
      // failed before the step loop could drain it.
    },
  })
  try {
    lifecycle.push({ id: 'job:1', target: parent.id, text: 'first', source: 'job-completed' })
    await flushMicrotasks()
    // First attempt plus one ordinary retry; then the batch's budget is spent.
    await flushMicrotasks()
    assert.equal(starts, 2)
    // A new completion identity is a fresh batch and must still wake.
    lifecycle.push({ id: 'job:2', target: parent.id, text: 'second', source: 'job-completed' })
    await flushMicrotasks()
    assert.equal(starts, 3)

    // A user stop holds automatic wakes until the next human turn.
    lifecycle.onTurnEnd(parent.id, { kind: 'aborted', cause: { kind: 'user' } })
    lifecycle.push({ id: 'job:3', target: parent.id, text: 'later', source: 'job-completed' })
    await flushMicrotasks()
    assert.equal(starts, 3)
    lifecycle.onTurnStart(parent.id)
    lifecycle.push({ id: 'job:4', target: parent.id, text: 'after human', source: 'job-completed' })
    assert.equal(starts, 4)
  } finally {
    lifecycle.close()
    store.delete(parent.id)
  }
})
