// Conversation rewind: checkpoint listing, file preview and physical truncation.
//
// The central safety case: a file that existed before the agent ever touched
// it must be restored — not deleted — when rewinding to a checkpoint created
// before its first tracked edit.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startHost } from '../src/host/server.ts'
import type { Host } from '../src/host/server.ts'
import { FileHistoryStore } from '../src/session/file-history.ts'
import { SessionStore } from '../src/session/store.ts'
import type { Envelope } from '../src/core/wire.ts'
import { startMockGateway, writeConfig, lastUserText } from './helpers/mock-gateway.ts'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

async function waitFor<T>(fn: () => Promise<T | null> | T | null, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value !== null && value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('condition not met in time')
}

async function createSession(host: Host, cwd: string): Promise<string> {
  const response = await fetch(`${host.baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd }),
  })
  return ((await response.json()) as { session: { id: string } }).session.id
}

async function prompt(host: Host, id: string, text: string): Promise<void> {
  const response = await fetch(`${host.baseUrl}/api/sessions/${id}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: text, provider: 'mock', model: 'mock-1' }),
  })
  assert.equal(response.status, 202)
}

async function eventsOf(host: Host, id: string): Promise<Envelope[]> {
  const body = (await (await fetch(`${host.baseUrl}/api/sessions/${id}`)).json()) as {
    events: Envelope[]
  }
  return body.events
}

test('checkpoint before the first edit restores a pre-existing file instead of deleting it', () => {
  const home = tempDir('denia-rewind-home-')
  const cwd = tempDir('denia-rewind-cwd-')
  const file = path.join(cwd, 'a.txt')
  fs.writeFileSync(file, 'v1', 'utf8')

  const history = new FileHistoryStore(home)
  // Two checkpoints exist before the file is ever edited; neither pins the
  // untracked file, which is exactly the dangerous case.
  history.snapshot('s1', cwd, 1)
  history.snapshot('s1', cwd, 2)

  const backend = history.backend('s1', cwd)
  backend.trackBeforeWrite(file)
  fs.writeFileSync(file, 'v2', 'utf8')

  assert.deepEqual(history.diff('s1', cwd, 1), [{ path: 'a.txt', action: 'restore' }])
  assert.deepEqual(history.rewind('s1', cwd, 1), ['a.txt'])
  assert.equal(fs.readFileSync(file, 'utf8'), 'v1')
})

test('rewind removes a file that did not exist when it was first tracked', () => {
  const home = tempDir('denia-rewind-home-')
  const cwd = tempDir('denia-rewind-cwd-')
  const file = path.join(cwd, 'new.txt')

  const history = new FileHistoryStore(home)
  history.snapshot('s2', cwd, 1)
  history.backend('s2', cwd).trackBeforeWrite(file)
  fs.writeFileSync(file, 'hello', 'utf8')

  assert.deepEqual(history.diff('s2', cwd, 1), [{ path: 'new.txt', action: 'delete' }])
  assert.deepEqual(history.rewind('s2', cwd, 1), ['new.txt'])
  assert.equal(fs.existsSync(file), false)
})

test('file history reloads from disk and keeps the target version', () => {
  const home = tempDir('denia-rewind-home-')
  const cwd = tempDir('denia-rewind-cwd-')
  const file = path.join(cwd, 'a.txt')
  fs.writeFileSync(file, 'v1', 'utf8')

  const history = new FileHistoryStore(home)
  history.snapshot('s3', cwd, 1)
  history.snapshot('s3', cwd, 2)
  history.backend('s3', cwd).trackBeforeWrite(file)
  fs.writeFileSync(file, 'v3', 'utf8')

  // A fresh host process must see the same checkpoint chain.
  const reloaded = new FileHistoryStore(home)
  assert.deepEqual(reloaded.diff('s3', cwd, 2), [{ path: 'a.txt', action: 'restore' }])
  assert.deepEqual(reloaded.rewind('s3', cwd, 2), ['a.txt'])
  assert.equal(fs.readFileSync(file, 'utf8'), 'v1')
})

test('buffered events are written one per line and survive a reload', () => {
  const home = tempDir('denia-rewind-log-')
  const cwd = tempDir('denia-rewind-cwd-')
  const store = new SessionStore(home)
  const header = store.create(cwd)
  // None of these types triggers an immediate flush; a single buffered write
  // must still produce one parseable envelope per line.
  store.append(header.id, { type: 'permission-mode', mode: 'auto-edit' })
  store.append(header.id, {
    type: 'permission-selection',
    sandbox: 'workspace-write',
    approval: 'on-request',
    reviewer: 'user',
    collaboration: 'default',
  })
  store.append(header.id, { type: 'agent-preset', preset: 'standard' })
  store.flush(header.id)

  const events = new SessionStore(home).read(header.id)!.events
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3])
})

test('rewind closes a stale turn head in logs written before the reorder', () => {
  const home = tempDir('denia-rewind-log-')
  const cwd = tempDir('denia-rewind-cwd-')
  const store = new SessionStore(home)
  const header = store.create(cwd)
  // The pre-reorder shape: `turn-start` sits before its user message.
  store.append(header.id, { type: 'user-message', text: 'first', injected: false })
  store.append(header.id, { type: 'turn-start', turn: 1 })
  store.append(header.id, { type: 'step-start', turn: 1, step: 1 })
  store.append(header.id, {
    type: 'assistant-message',
    turn: 1,
    step: 1,
    blocks: [{ type: 'text', text: 'answer' }],
  })
  store.append(header.id, { type: 'turn-end', turn: 1, reason: { kind: 'completed' } })
  store.append(header.id, { type: 'turn-start', turn: 2 })
  const target = store.append(header.id, {
    type: 'user-message',
    text: 'second',
    injected: false,
  })!
  store.append(header.id, { type: 'step-start', turn: 2, step: 1 })
  store.flush(header.id)

  store.rewind(header.id, target.seq)
  const after = store.read(header.id)!.events
  assert.deepEqual(
    after.map((event) => event.type),
    ['user-message', 'turn-start', 'step-start', 'assistant-message', 'turn-end'],
  )
  // The same cut survives a fresh process reading the physical log.
  const reloaded = new SessionStore(home).read(header.id)!.events
  assert.deepEqual(reloaded.map((event) => event.seq), after.map((event) => event.seq))
})

test('HTTP rewind truncates the session log and restores the file', async () => {
  const home = tempDir('denia-rewind-home-')
  const cwd = tempDir('denia-rewind-cwd-')
  const webDir = tempDir('denia-rewind-web-')
  const file = path.join(cwd, 'a.txt')
  fs.writeFileSync(file, 'v1', 'utf8')

  const mock = await startMockGateway((request) => {
    const all = request.messages
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n')
    if (all.includes('生成会话标题')) return { text: '测试标题' }
    const user = lastUserText(request)
    if (user.includes('edit it')) {
      const toolOutput = request.messages
        .filter((message) => message.role === 'tool')
        .map((message) => (typeof message.content === 'string' ? message.content : ''))
        .join('\n')
      if (!toolOutput.includes('已写入 a.txt')) {
        return {
          calls: [
            {
              name: 'write_file',
              arguments: { path: 'a.txt', content: 'v2' },
            },
          ],
        }
      }
      return { text: 'edited' }
    }
    return { text: 'plain answer' }
  })
  writeConfig(home, mock.baseURL)
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const sessionId = await createSession(host, cwd)
    await prompt(host, sessionId, 'first message')
    await waitFor(() => (!host.driver.isRunning(sessionId) ? true : null))
    // Let the title turn settle so it cannot append events mid-rewind.
    await waitFor(async () => {
      const events = await eventsOf(host, sessionId)
      return events.some((event) => event.type === 'session-title') ? true : null
    })

    await prompt(host, sessionId, 'edit it')
    await waitFor(async () => {
      const events = await eventsOf(host, sessionId)
      return !host.driver.isRunning(sessionId) &&
        events.some(
          (event) =>
            event.type === 'assistant-message' &&
            event.blocks.some((block) => block.type === 'text' && block.text === 'edited'),
        )
        ? true
        : null
    })
    assert.equal(fs.readFileSync(file, 'utf8'), 'v2')

    const checkpoints = (await (
      await fetch(`${host.baseUrl}/api/sessions/${sessionId}/checkpoints`)
    ).json()) as { checkpoints: { seq: number; text: string }[] }
    assert.deepEqual(
      checkpoints.checkpoints.map((checkpoint) => checkpoint.text),
      ['first message', 'edit it'],
    )
    const firstSeq = checkpoints.checkpoints[0]!.seq

    const diff = (await (
      await fetch(
        `${host.baseUrl}/api/sessions/${sessionId}/checkpoints/${firstSeq}/diff`,
      )
    ).json()) as { changes: { path: string; action: string }[] }
    assert.deepEqual(diff.changes, [{ path: 'a.txt', action: 'restore' }])

    const response = await fetch(`${host.baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toSeq: firstSeq }),
    })
    const bodyText = await response.text()
    assert.equal(response.status, 200, bodyText)
    const result = JSON.parse(bodyText) as {
      ok: boolean
      toSeq: number
      toMessage: string
      changedFiles: string[]
    }
    assert.equal(result.ok, true)
    assert.equal(result.toSeq, firstSeq)
    assert.equal(result.toMessage, 'first message')
    assert.deepEqual(result.changedFiles, ['a.txt'])
    assert.equal(fs.readFileSync(file, 'utf8'), 'v1')

    const events = await eventsOf(host, sessionId)
    assert.equal(
      events.some(
        (event) => event.type === 'user-message' && event.text === 'edit it',
      ),
      false,
    )
    assert.ok(events.every((event) => event.seq < firstSeq))

    // The log file itself was truncated: the last kept event is the one right
    // before the checkpoint, and new events resume from that seq.
    await prompt(host, sessionId, 'after rewind')
    await waitFor(async () => {
      const current = await eventsOf(host, sessionId)
      return current.some(
        (event) =>
          event.type === 'assistant-message' &&
          event.blocks.some((block) => block.type === 'text' && block.text === 'plain answer'),
      ) &&
        current.filter((event) => event.type === 'user-message').some(
          (event) => event.text === 'after rewind',
        )
        ? true
        : null
    })
    const after = await eventsOf(host, sessionId)
    assert.equal(after[0]!.seq, 1)
    const newUser = after.find(
      (event) => event.type === 'user-message' && event.text === 'after rewind',
    )
    assert.ok(newUser)
    // The cut freed the target seq: the new branch continues right after the
    // last kept event instead of preserving the removed branch's numbering.
    assert.ok(newUser.seq > events[events.length - 1]!.seq)
    assert.equal(
      after.some((event) => event.type === 'user-message' && event.text === 'edit it'),
      false,
    )
  } finally {
    await host.close()
    await mock.close()
  }
})