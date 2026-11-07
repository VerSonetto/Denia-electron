// Completion delivery timing: a settled child cancels its leftover background
// work and says so in the notice, and a restart re-delivers results that were
// already enqueued before the host stopped.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { presetState } from '../src/core/permission.ts'
import { startHost } from '../src/host/server.ts'
import type { Envelope } from '../src/core/wire.ts'
import { SessionStore } from '../src/session/store.ts'
import { ProfileStore } from '../src/subagents/profiles.ts'
import { SubagentRuntime } from '../src/subagents/runtime.ts'
import type { SubagentDriverPort } from '../src/subagents/runtime.ts'
import { startMockGateway, writeConfig } from './helpers/mock-gateway.ts'

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

test('a settled child cancels leftover jobs and reports what was cancelled', async () => {
  const home = tempDir('denia-settle-home-')
  const cwd = tempDir('denia-settle-cwd-')
  const store = new SessionStore(home)
  const profiles = new ProfileStore(home)
  let runtime: SubagentRuntime
  const port: SubagentDriverPort = {
    startTurn: async (sessionId) => {
      // The real driver drains the inbox at the first step boundary; the stub
      // does the same so a wake never spins on an undrained queue.
      runtime.drainInbox(sessionId)
    },
    cancel: () => false,
    isRunning: () => false,
    append: (sessionId, event) => store.append(sessionId, event),
    permissionStateOf: () => presetState('workspace-write'),
  }
  runtime = new SubagentRuntime(store, profiles, port)
  runtime.setToolNames(() => [
    'read_file',
    'glob',
    'grep',
    'write_file',
    'edit',
    'bash',
    'job_start',
    'job_output',
    'job_kill',
    'job_list',
    'todo_write',
  ])

  const parent = store.create(cwd, { sandbox: true })
  const spawned = await runtime.spawn(
    parent.id,
    {
      prompt: '跑一个后台任务',
      inline: {
        name: 'worker',
        description: '执行任务',
        instructions: '执行任务',
        tools: { mode: 'inherit' },
        model: { mode: 'inherit' },
        permissionCeiling: 'inherit',
      },
    },
    { cwd, selection: { provider: 'mock', model: 'mock-1' } },
    false,
  )
  const childId = spawned.childId as string
  store.append(childId, { type: 'turn-start', turn: 1 })
  store.append(childId, {
    type: 'assistant-message',
    turn: 1,
    blocks: [{ type: 'text', text: '子代理结果' }],
  } as never)
  store.append(childId, { type: 'turn-end', turn: 1, reason: { kind: 'completed' } })

  const cleaned: string[] = []
  runtime.setJobCleaner((sessionId) => {
    cleaned.push(sessionId)
    return ['长期服务']
  })
  runtime.onTurnEnd(childId)

  assert.deepEqual(cleaned, [childId])
  const parentEvents = store.read(parent.id)?.events ?? []
  const notice = parentEvents.find((event) => event.type === 'agent-inbox')
  assert.ok(notice && notice.type === 'agent-inbox')
  assert.match(notice.text, /已取消的子代理后台工作/)
  assert.match(notice.text, /长期服务/)
})

test('startup recovery re-delivers a pending inbox result', async () => {
  const home = tempDir('denia-recover-home-')
  const cwd = tempDir('denia-recover-cwd-')
  const webDir = tempDir('denia-recover-web-')
  const mock = await startMockGateway(() => ({ text: '已收到后台结果' }))
  writeConfig(home, mock.baseURL)

  const id = randomUUID()
  const dir = path.join(home, 'sessions', id)
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const lines = [
    { type: 'session', version: 0, id, created_at: now, cwd, sandbox: true },
    { seq: 1, time: now, type: 'user-message', text: '之前的问题', injected: false },
    {
      seq: 2,
      time: now,
      type: 'agent-inbox',
      id: 'job:recovered',
      text: 'RECOVERED-MARKER 后台任务完成',
      source: 'job-completed',
    },
  ]
  fs.writeFileSync(
    path.join(dir, 'session.jsonl'),
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
    'utf8',
  )

  const host = await startHost({ home, webDir, port: 0 })
  try {
    const events = await waitFor<Envelope[]>(async () => {
      const response = await fetch(`${host.baseUrl}/api/sessions/${id}`)
      const session = (await response.json()) as { events: Envelope[] }
      return session.events.some((event) => event.type === 'turn-end') ? session.events : null
    })
    assert.ok(events.some((event) => event.type === 'agent-delivery'))
    const texts = mock.requests.flatMap((request) =>
      request.messages.map((message) =>
        typeof message.content === 'string' ? message.content : '',
      ),
    )
    assert.ok(
      texts.some((text) => text.includes('RECOVERED-MARKER')),
      `pending inbox was not delivered: ${JSON.stringify(texts.slice(-3))}`,
    )
  } finally {
    await host.close()
    await mock.close()
  }
})