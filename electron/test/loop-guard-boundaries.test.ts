// Runtime wiring for loop-guard boundaries.
//
// The detector has its own unit tests; these integration tests drive a real
// SessionDriver against a mock OpenAI-compatible gateway and assert that the
// driver wires business boundaries correctly:
//   - after a reminder, changed work completes normally;
//   - delivered/queued agent messages win over a stop;
//   - real approvals and permission changes reset the repetition run;
//   - an effective system-prompt update resets it (frozen prefix case);
//   - a new turn recounts from zero.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { SessionDriver } from '../src/agent/loop.ts'
import type { SessionServices } from '../src/agent/loop.ts'
import type { ApprovalBridge } from '../src/agent/gate.ts'
import type { AppConfig } from '../src/config.ts'
import type { Envelope, SessionEvent } from '../src/core/wire.ts'
import { ExecPolicy } from '../src/core/exec-policy.ts'
import { SessionStore } from '../src/session/store.ts'
import { ToolRegistry } from '../src/tools/index.ts'
import { startMockGateway } from './helpers/mock-gateway.ts'
import type { GatewayPlan, GatewayRequest } from './helpers/mock-gateway.ts'

const LOOP_GUARD_CHANNEL = 'loop-guard'
const TODO_RESULT = '已更新任务列表:1 个待办、0 个进行中、0 个已完成。'

function todoPlan(): GatewayPlan {
  return {
    calls: [
      {
        name: 'todo_write',
        arguments: { todos: [{ content: '检查状态', status: 'pending' }] },
      },
    ],
  }
}

interface Harness {
  store: SessionStore
  driver: SessionDriver
  sessionId: string
  events(): Envelope[]
  close(): Promise<void>
}

async function startHarness(
  respond: (request: GatewayRequest) => GatewayPlan,
  configure?: (store: SessionStore) => Partial<SessionServices>,
  bridge?: ApprovalBridge,
): Promise<Harness> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-loop-guard-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-loop-guard-cwd-'))
  const mock = await startMockGateway(respond)
  const config: AppConfig = {
    providers: [
      {
        id: 'mock',
        name: 'Mock',
        baseURL: mock.baseURL,
        protocol: 'openai-completions',
        models: [{ id: 'mock-1', name: 'Mock 1' }],
      },
    ],
    default: { provider: 'mock', model: 'mock-1' },
  }
  const store = new SessionStore(home)
  const session = store.create(cwd)
  const driver = new SessionDriver(
    store,
    ToolRegistry.builtin(),
    () => config,
    { maxSteps: 40 },
    undefined,
    bridge ? { bridge, policy: new ExecPolicy() } : undefined,
  )
  driver.attachServices({
    extraSchemas: () => [],
    executeExtra: async () => undefined,
    ...(configure ? configure(store) : {}),
  })
  return {
    store,
    driver,
    sessionId: session.id,
    events: () => store.read(session.id)?.events ?? [],
    async close() {
      driver.dispose()
      await mock.close()
    },
  }
}

async function runTurn(harness: Harness, prompt = '开始'): Promise<Envelope[]> {
  await harness.driver.startTurn(harness.sessionId, prompt, {
    selection: { provider: 'mock', model: 'mock-1' },
  })
  return harness.events()
}

function remindersOf(events: Envelope[]): Extract<Envelope, { type: 'user-message' }>[] {
  return events.filter(
    (event): event is Extract<Envelope, { type: 'user-message' }> =>
      event.type === 'user-message' && event.channel === LOOP_GUARD_CHANNEL,
  )
}

function endReasons(events: Envelope[]): unknown[] {
  return events
    .filter((event): event is Extract<Envelope, { type: 'turn-end' }> => event.type === 'turn-end')
    .map((event) => event.reason)
}

test('after a reminder, changed work completes instead of being stopped', async () => {
  let requests = 0
  const harness = await startHarness(() => {
    requests += 1
    if (requests <= 4) return todoPlan()
    if (requests === 5) return { calls: [{ name: 'ls', arguments: { path: '.' } }] }
    return { text: '换了做法,任务完成。' }
  })
  try {
    const events = await runTurn(harness)
    assert.equal(requests, 6)
    assert.equal(remindersOf(events).length, 1, 'four identical cycles produce one reminder')
    assert.deepEqual(endReasons(events), [{ kind: 'completed' }])
  } finally {
    await harness.close()
  }
})

test('an agent delivery at the step boundary resets the repetition run', async () => {
  let requests = 0
  let boundaries = 0
  const harness = await startHarness(
    () => {
      requests += 1
      return requests <= 8 ? todoPlan() : { text: '按新消息完成。' }
    },
    (store) => ({
      injections: (sessionId) => {
        boundaries += 1
        if (boundaries === 4) {
          store.append(sessionId, {
            type: 'agent-delivery',
            id: 'agent:parent:1',
            text: '父代理发来新的要求',
            source: 'agent:parent',
          })
        }
        return []
      },
    }),
  )
  try {
    const events = await runTurn(harness)
    // Without the boundary reset the sixth cycle would stop the turn; the
    // delivery makes steps 4-7 a fresh four-cycle run instead.
    assert.equal(requests, 9)
    assert.equal(remindersOf(events).length, 1)
    assert.deepEqual(endReasons(events), [{ kind: 'completed' }])
  } finally {
    await harness.close()
  }
})

const stopInterruptions: Array<[string, SessionEvent]> = [
  [
    'a queued agent inbox',
    { type: 'agent-inbox', id: 'job:1', text: '后台任务完成', source: 'job-completed' },
  ],
  ['a real user message', { type: 'user-message', text: '补充要求:先说明结果', injected: false }],
  [
    'a delivered agent message',
    { type: 'agent-delivery', id: 'agent:parent:2', text: '父代理的新指令', source: 'agent:parent' },
  ],
]

for (const [label, interruption] of stopInterruptions) {
  test(`${label} after the request prevents a false stop`, async () => {
    let requests = 0
    let batches = 0
    let target = ''
    const harness = await startHarness(
      () => {
        requests += 1
        return requests <= 6 ? todoPlan() : { text: '处理完新输入。' }
      },
      (store) => ({
        intercept: (call) => {
          if (call.name !== 'todo_write') return undefined
          batches += 1
          // Sixth completed cycle is exactly when the guard would hard-stop.
          if (batches === 6) {
            store.append(target, interruption)
            return { content: TODO_RESULT, isError: false }
          }
          return undefined
        },
      }),
    )
    target = harness.sessionId
    try {
      const events = await runTurn(harness)
      assert.equal(requests, 7)
      assert.deepEqual(endReasons(events), [{ kind: 'completed' }])
    } finally {
      await harness.close()
    }
  })
}

test('a real permission change resets the repetition run', async () => {
  let requests = 0
  let boundaries = 0
  const harness = await startHarness(
    () => {
      requests += 1
      return requests <= 7 ? todoPlan() : { text: '完成。' }
    },
    (store) => ({
      injections: (sessionId) => {
        boundaries += 1
        if (boundaries === 4) {
          // Tighten approval without changing the preset text: the system
          // prompt stays byte-identical, so only the permission boundary can
          // reset the guard here.
          store.append(sessionId, {
            type: 'permission-selection',
            sandbox: 'project-write',
            approval: 'untrusted',
            reviewer: 'user',
            collaboration: 'default',
          })
        }
        return []
      },
    }),
  )
  try {
    const events = await runTurn(harness)
    assert.equal(requests, 8)
    assert.equal(remindersOf(events).length, 1)
    assert.deepEqual(endReasons(events), [{ kind: 'completed' }])
  } finally {
    await harness.close()
  }
})

test('a user approval inside a batch resets the repetition run', async () => {
  let requests = 0
  let approvals = 0
  const bridge: ApprovalBridge = {
    async request() {
      approvals += 1
      return { choice: 'accept' }
    },
  }
  const harness = await startHarness(
    () => {
      requests += 1
      return requests <= 6
        ? { calls: [{ name: 'bash', arguments: { command: 'echo hi > out.txt' } }] }
        : { text: '完成。' }
    },
    undefined,
    bridge,
  )
  try {
    const events = await runTurn(harness)
    assert.equal(requests, 7)
    assert.equal(approvals, 6)
    assert.equal(
      events.filter((event) => event.type === 'approval-decided').length,
      6,
      'every step is a real approval boundary',
    )
    assert.equal(remindersOf(events).length, 0)
    assert.deepEqual(endReasons(events), [{ kind: 'completed' }])
  } finally {
    await harness.close()
  }
})

test('an effective frozen system-prompt update resets the repetition run', async () => {
  let requests = 0
  let personaVersion = 1
  const harness = await startHarness(
    () => {
      requests += 1
      // The next request assembles a different prompt; the wire system stays
      // frozen and the change arrives as an injected update message.
      if (requests === 4) personaVersion = 2
      return requests <= 8 ? todoPlan() : { text: '完成。' }
    },
    () => ({
      persona: () => (personaVersion === 1 ? '人格版本一。' : '人格版本二。'),
    }),
  )
  try {
    const events = await runTurn(harness)
    // Correct wiring: reminder at cycle 4 (step 4), reset on the system update
    // at step 5, second reminder at step 8. Broken wiring: hard stop at step 6.
    assert.equal(requests, 9)
    assert.equal(remindersOf(events).length, 2)
    assert.ok(
      events.some(
        (event) => event.type === 'user-message' && event.channel === 'system-prompt-update',
      ),
      'the effective update must be model-visible as an injected message',
    )
    assert.deepEqual(endReasons(events), [{ kind: 'completed' }])
  } finally {
    await harness.close()
  }
})

test('a new turn starts a fresh repetition count', async () => {
  let requests = 0
  const harness = await startHarness(() => {
    requests += 1
    return requests <= 4 ? todoPlan() : { text: '完成。' }
  })
  try {
    await runTurn(harness, '第一轮')
    assert.equal(requests, 5)
    requests = 0
    const events = await runTurn(harness, '第二轮')
    assert.equal(requests, 5)
    assert.equal(remindersOf(events).length, 2, 'each turn reaches its own reminder')
    assert.deepEqual(endReasons(events), [{ kind: 'completed' }, { kind: 'completed' }])
  } finally {
    await harness.close()
  }
})

test('the guard reminder itself is not counted as new progress', async () => {
  let requests = 0
  const harness = await startHarness(() => {
    requests += 1
    return todoPlan()
  })
  try {
    const events = await runTurn(harness)
    // Six identical cycles, with the reminder after the fourth: it must not
    // reset the run that the reminder itself diagnosed.
    assert.equal(requests, 6)
    assert.equal(remindersOf(events).length, 1)
    assert.deepEqual(endReasons(events), [{ kind: 'loop-detected', repeats: 6 }])
  } finally {
    await harness.close()
  }
})
