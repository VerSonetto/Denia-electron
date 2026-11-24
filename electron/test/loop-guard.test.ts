// Loop guard unit + mock-provider integration tests.
//
// The guard must fingerprint whole completed batches (calls + actual results),
// warn once after four identical cycles, and only hard-stop after two more
// complete cycles of the same pattern. Read-only evidence may stop; opaque or
// side-effecting evidence may only produce one weak reminder.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startHost } from '../src/host/server.ts'
import {
  LOOP_GUARD_CHANNEL,
  LOOP_GUARD_STRONG_REMINDER,
  LOOP_GUARD_WEAK_REMINDER,
  LoopGuard,
  type GuardCallObservation,
  type GuardStepObservation,
  type LoopGuardDecision,
} from '../src/agent/loop-guard.ts'
import type { Envelope } from '../src/core/wire.ts'
import { startMockGateway, writeConfig } from './helpers/mock-gateway.ts'

function readCall(overrides: Partial<GuardCallObservation> = {}): GuardCallObservation {
  return {
    name: 'read_file',
    arguments: '{"path":"a.txt"}',
    content: 'a.txt 第 1-1 行（1 行）:\nhello',
    isError: false,
    ...overrides,
  }
}

function stepOf(...calls: GuardCallObservation[]): GuardStepObservation {
  return { calls }
}

function readStep(id = 'a'): GuardStepObservation {
  return stepOf(readCall({ arguments: JSON.stringify({ path: `${id}.txt` }), content: `content ${id}` }))
}

function observeMany(guard: LoopGuard, steps: GuardStepObservation[]): LoopGuardDecision[] {
  return steps.map((step) => guard.observe(step))
}

test('guard: one step is one fingerprint even when the step repeats a call', () => {
  const guard = new LoopGuard()
  const duplicate = stepOf(readCall(), readCall())
  const decisions = observeMany(guard, [duplicate, duplicate, duplicate])
  assert.deepEqual(decisions, [{ kind: 'none' }, { kind: 'none' }, { kind: 'none' }])
  assert.deepEqual(guard.observe(duplicate), { kind: 'strong-reminder' })
})

test('guard: mixed progress breaks the repetition even with a repeated call', () => {
  const guard = new LoopGuard()
  const a = readStep('a')
  assert.deepEqual(observeMany(guard, [a, a, a]), [
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
  ])
  // A new action in the same step is progress, not a repeat of A.
  assert.deepEqual(guard.observe(stepOf(readCall(), readCall({ name: 'glob', arguments: '{"pattern":"*.ts"}', content: 'a.ts' }))), {
    kind: 'none',
  })
  assert.deepEqual(observeMany(guard, [a, a, a]), [
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
  ])
  assert.deepEqual(guard.observe(a), { kind: 'strong-reminder' })
})

test('guard: JSON object key order is not meaningful, array order is', () => {
  const guard = new LoopGuard()
  const first = stepOf(
    readCall({ arguments: '{"a":1,"b":{"x":2,"y":[3,4]}}', content: 'same' }),
  )
  const reordered = stepOf(
    readCall({ arguments: '{"b":{"y":[3,4],"x":2},"a":1}', content: 'same' }),
  )
  assert.deepEqual(observeMany(guard, [first, reordered, first]), [
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
  ])
  assert.deepEqual(guard.observe(reordered), { kind: 'strong-reminder' })

  const arrays = new LoopGuard()
  const forward = stepOf(readCall({ arguments: '{"values":[1,2]}', content: 'same' }))
  const backward = stepOf(readCall({ arguments: '{"values":[2,1]}', content: 'same' }))
  const decisions = observeMany(arrays, [
    forward,
    backward,
    forward,
    backward,
    forward,
    backward,
    forward,
    backward,
  ])
  assert.deepEqual(decisions.slice(0, 7), [
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
  ])
  assert.deepEqual(decisions[7], { kind: 'strong-reminder' })
})

test('guard: changed pagination or changed results are new evidence', () => {
  const paginated = new LoopGuard()
  const decisions = observeMany(
    paginated,
    [1, 2, 3, 4, 5, 6].map((offset) =>
      stepOf(
        readCall({
          arguments: JSON.stringify({ path: 'a.txt', offset, limit: 1 }),
          content: `page ${offset}`,
        }),
      ),
    ),
  )
  assert.ok(decisions.every((decision) => decision.kind === 'none'))

  const changed = new LoopGuard()
  assert.ok(
    observeMany(
      changed,
      [1, 2, 3, 4, 5, 6].map((value) =>
        stepOf(readCall({ content: `line changed ${value}` })),
      ),
    ).every((decision) => decision.kind === 'none'),
  )
})

test('guard: out-of-order read-only parallel batches still match', () => {
  const guard = new LoopGuard()
  const a = readCall({ content: 'a' })
  const b = readCall({ name: 'grep', arguments: '{"pattern":"x","path":"."}', content: 'match x' })
  const forward = stepOf(a, b)
  const backward = stepOf(b, a)
  const decisions = observeMany(guard, [forward, backward, forward, backward])
  assert.deepEqual(decisions.slice(0, 3), [
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
  ])
  assert.deepEqual(decisions[3], { kind: 'strong-reminder' })
})

test('guard: shortest periods A, AB and ABC are recognized', () => {
  const one = new LoopGuard()
  const a = readStep('a')
  assert.deepEqual(observeMany(one, [a, a, a]), [
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
  ])
  assert.deepEqual(one.observe(a), { kind: 'strong-reminder' })

  const two = new LoopGuard()
  const a2 = readStep('a')
  const b2 = readStep('b')
  const twoSteps = [a2, b2, a2, b2, a2, b2, a2]
  assert.ok(observeMany(two, twoSteps).every((decision) => decision.kind === 'none'))
  assert.deepEqual(two.observe(b2), { kind: 'strong-reminder' })

  const three = new LoopGuard()
  const a3 = readStep('a')
  const b3 = readStep('b')
  const c3 = readStep('c')
  const threeSteps = [a3, b3, c3, a3, b3, c3, a3, b3, c3, a3, b3]
  assert.ok(observeMany(three, threeSteps).every((decision) => decision.kind === 'none'))
  assert.deepEqual(three.observe(c3), { kind: 'strong-reminder' })
})

test('guard: strong reminder is followed by exactly two confirmation cycles', () => {
  const guard = new LoopGuard()
  const a = readStep('a')
  const decisions = observeMany(guard, [a, a, a, a, a, a])
  assert.deepEqual(decisions, [
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'strong-reminder' },
    { kind: 'none' },
    { kind: 'stop', repeats: 6 },
  ])
})

test('guard: period 2 and 3 also stop only after six complete cycles', () => {
  const two = new LoopGuard()
  const a2 = readStep('a')
  const b2 = readStep('b')
  const twoDecisions = observeMany(two, [
    a2, b2, a2, b2, a2, b2, a2, b2, a2, b2, a2, b2,
  ])
  assert.deepEqual(twoDecisions[7], { kind: 'strong-reminder' })
  assert.deepEqual(twoDecisions[11], { kind: 'stop', repeats: 6 })

  const three = new LoopGuard()
  const a3 = readStep('a')
  const b3 = readStep('b')
  const c3 = readStep('c')
  const pattern = [a3, b3, c3]
  const threeSteps = [
    ...pattern, ...pattern, ...pattern, ...pattern, ...pattern, ...pattern,
  ]
  const threeDecisions = observeMany(three, threeSteps)
  assert.deepEqual(threeDecisions[11], { kind: 'strong-reminder' })
  assert.deepEqual(threeDecisions[17], { kind: 'stop', repeats: 6 })
})

test('guard: AAB, ABB and ABA keep one reminder and stop after two confirmation cycles', () => {
  const cases: Array<{ name: string; ids: readonly string[] }> = [
    { name: 'AAB', ids: ['a', 'a', 'b'] },
    { name: 'ABB', ids: ['a', 'b', 'b'] },
    { name: 'ABA', ids: ['a', 'b', 'a'] },
  ]
  for (const pattern of cases) {
    const guard = new LoopGuard()
    const steps = Array.from({ length: 18 }, (_, index) =>
      readStep(pattern.ids[index % pattern.ids.length]!),
    )
    const decisions = observeMany(guard, steps)
    assert.ok(
      decisions.slice(0, 11).every((decision) => decision.kind === 'none'),
      `${pattern.name} must stay quiet before four complete cycles`,
    )
    assert.equal(
      decisions.filter(
        (decision) => decision.kind === 'strong-reminder' || decision.kind === 'weak-reminder',
      ).length,
      1,
      `${pattern.name} must warn exactly once`,
    )
    assert.deepEqual(
      decisions[11],
      { kind: 'strong-reminder' },
      `${pattern.name} reminds after four complete cycles`,
    )
    assert.ok(
      decisions.slice(12, 17).every((decision) => decision.kind === 'none'),
      `${pattern.name} must not re-remind while confirming`,
    )
    assert.deepEqual(
      decisions[17],
      { kind: 'stop', repeats: 6 },
      `${pattern.name} stops after two further complete cycles`,
    )
  }
})

test('guard: a new pattern gets its own proof instead of the old reminder', () => {
  const guard = new LoopGuard()
  const a = readStep('a')
  const b = readStep('b')
  assert.deepEqual(observeMany(guard, [a, a, a, a]), [
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'strong-reminder' },
  ])
  // The first B is a deviation, not a continuation of the A cycle.
  assert.deepEqual(guard.observe(b), { kind: 'none' })
  assert.deepEqual(observeMany(guard, [b, b]), [{ kind: 'none' }, { kind: 'none' }])
  // The B run proves its own four cycles before it may remind.
  assert.deepEqual(guard.observe(b), { kind: 'strong-reminder' })
  assert.deepEqual(observeMany(guard, [b, b]), [{ kind: 'none' }, { kind: 'stop', repeats: 6 }])
})

test('guard: a new pattern after more than 18 unique steps starts fresh', () => {
  const guard = new LoopGuard()
  const unique = Array.from({ length: 20 }, (_, index) => readStep(`unique-${index}`))
  assert.ok(observeMany(guard, unique).every((decision) => decision.kind === 'none'))
  const a = readStep('a')
  assert.deepEqual(observeMany(guard, [a, a, a, a]), [
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'strong-reminder' },
  ])
})

test('guard: blank arguments are equivalent to an empty object', () => {
  const guard = new LoopGuard()
  const blank = stepOf(readCall({ arguments: ' \n\t ', content: 'same' }))
  const empty = stepOf(readCall({ arguments: '{}', content: 'same' }))
  assert.deepEqual(observeMany(guard, [blank, empty, blank, empty]), [
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'strong-reminder' },
  ])
})

test('guard: excessively deep arguments fail open and break the trajectory', () => {
  const guard = new LoopGuard()
  const deepArguments = '{"a":'.repeat(80) + '1' + '}'.repeat(80)
  const deep = stepOf(readCall({ arguments: deepArguments, content: 'same' }))
  assert.ok(
    observeMany(guard, [deep, deep, deep, deep, deep, deep]).every(
      (decision) => decision.kind === 'none',
    ),
  )
  const a = readStep('a')
  assert.deepEqual(observeMany(guard, [a, a, a]), [
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
  ])
  assert.deepEqual(guard.observe(a), { kind: 'strong-reminder' })
})

test('guard: an explicit business reset forces a new proof and reminder', () => {
  const guard = new LoopGuard()
  const a = readStep('a')
  assert.deepEqual(observeMany(guard, [a, a, a, a]), [
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'strong-reminder' },
  ])
  guard.reset()
  assert.deepEqual(observeMany(guard, [a, a, a]), [
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
  ])
  assert.deepEqual(guard.observe(a), { kind: 'strong-reminder' })
})

test('guard: side-effecting batch order is meaningful', () => {
  const guard = new LoopGuard()
  const first = stepOf(
    readCall({ name: 'write_file', arguments: '{"path":"a"}', content: 'ok a' }),
    readCall({ name: 'bash', arguments: '{"command":"echo b"}', content: 'b' }),
  )
  const reversed = stepOf(
    readCall({ name: 'bash', arguments: '{"command":"echo b"}', content: 'b' }),
    readCall({ name: 'write_file', arguments: '{"path":"a"}', content: 'ok a' }),
  )
  const decisions = observeMany(guard, [first, reversed, first, reversed])
  assert.ok(decisions.every((decision) => decision.kind === 'none'))
  assert.deepEqual(observeMany(guard, [first, reversed, first, reversed]), [
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'weak-reminder' },
  ])
})

test('guard: changing strategy or real progress invalidates the old reminder', () => {
  const guard = new LoopGuard()
  const a = readStep('a')
  const b = readStep('b')
  assert.deepEqual(observeMany(guard, [a, a, a, a]), [
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'strong-reminder' },
  ])
  assert.deepEqual(guard.observe(b), { kind: 'none' })
  // The old reminder must not terminate the new A run after two cycles.
  assert.deepEqual(observeMany(guard, [a, a, a]), [
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
  ])
  assert.deepEqual(guard.observe(a), { kind: 'strong-reminder' })
  assert.deepEqual(observeMany(guard, [a, a]), [
    { kind: 'none' },
    { kind: 'stop', repeats: 6 },
  ])
})

test('guard: truncated, missing and status-query steps break the trajectory', () => {
  const truncated = new LoopGuard()
  assert.ok(
    observeMany(
      truncated,
      [1, 2, 3, 4].map(() => stepOf(readCall({ truncated: true }))),
    ).every((decision) => decision.kind === 'none'),
  )
  assert.deepEqual(
    observeMany(truncated, [readStep('a'), readStep('a'), readStep('a')]),
    [{ kind: 'none' }, { kind: 'none' }, { kind: 'none' }],
  )
  assert.deepEqual(truncated.observe(readStep('a')), { kind: 'strong-reminder' })

  const missing = new LoopGuard()
  assert.ok(
    observeMany(
      missing,
      [1, 2, 3, 4].map(() => stepOf(readCall({ missing: true }))),
    ).every((decision) => decision.kind === 'none'),
  )

  const pending = new LoopGuard()
  assert.ok(
    observeMany(
      pending,
      [
        stepOf(readCall({ name: 'job_output', arguments: '{"id":"j1"}', content: 'pending' })),
        stepOf(readCall({ name: 'wait_agent', arguments: '{"id":"a1"}', content: 'pending' })),
        stepOf(readCall({ name: 'job_list', arguments: '{}', content: 'job j1 pending' })),
        stepOf(readCall({ name: 'list_agents', arguments: '{}', content: 'agent a1 pending' })),
      ],
    ).every((decision) => decision.kind === 'none'),
  )
})

test('guard: proven not-executed calls can hard-stop, successful writes only warn', () => {
  const unknown = new LoopGuard()
  const unknownStep = stepOf(
    readCall({
      name: 'write_file',
      arguments: '{"path":"a.txt","content":"x"}',
      content: '[工具错误] 未知工具:write_file',
      isError: true,
      errorIdentity: { name: 'write_file', code: 'unknown-tool' },
      notExecuted: true,
    }),
  )
  assert.deepEqual(observeMany(unknown, [unknownStep, unknownStep, unknownStep, unknownStep, unknownStep, unknownStep]), [
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'strong-reminder' },
    { kind: 'none' },
    { kind: 'stop', repeats: 6 },
  ])

  const weak = new LoopGuard()
  const writeStep = stepOf(
    readCall({ name: 'write_file', arguments: '{"path":"a.txt","content":"x"}', content: '已写入 a.txt' }),
  )
  assert.deepEqual(observeMany(weak, [writeStep, writeStep, writeStep, writeStep, writeStep, writeStep]), [
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'weak-reminder' },
    { kind: 'none' },
    { kind: 'none' },
  ])
  // The weak reminder must not consume the strong evidence budget.
  assert.deepEqual(
    observeMany(weak, [readStep('a'), readStep('a'), readStep('a')]),
    [{ kind: 'none' }, { kind: 'none' }, { kind: 'none' }],
  )
  assert.deepEqual(weak.observe(readStep('a')), { kind: 'strong-reminder' })
})

test('guard: weak reminders happen at most once per turn', () => {
  const guard = new LoopGuard()
  const bashStep = stepOf(
    readCall({ name: 'bash', arguments: '{"command":"npm test"}', content: 'tests passed' }),
  )
  const decisions = observeMany(guard, [bashStep, bashStep, bashStep, bashStep, bashStep, bashStep, bashStep, bashStep])
  assert.deepEqual(decisions[3], { kind: 'weak-reminder' })
  assert.ok(decisions.filter((decision) => decision.kind === 'weak-reminder').length === 1)
  assert.ok(decisions.every((decision) => decision.kind !== 'stop'))
  assert.equal(LOOP_GUARD_WEAK_REMINDER.includes('任务已经完成'), false)
})

test('guard: identical error identity with changing error text is not a repeat', () => {
  const guard = new LoopGuard()
  const decisions = observeMany(
    guard,
    [1, 2, 3, 4, 5, 6].map((value) =>
      stepOf(
        readCall({
          isError: true,
          errorIdentity: { name: 'read_file', code: 'ENOENT' },
          content: `ENOENT: no such file or directory, open 'missing-${value}.txt'`,
        }),
      ),
    ),
  )
  assert.ok(decisions.every((decision) => decision.kind === 'none'))
})

test('guard: todo_write with the same state is a repeatable read-only batch', () => {
  const guard = new LoopGuard()
  const todo = stepOf(
    readCall({
      name: 'todo_write',
      arguments: '{"todos":[{"content":"x","status":"pending"}]}',
      content: '已更新任务列表',
    }),
  )
  assert.deepEqual(observeMany(guard, [todo, todo, todo, todo]), [
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'none' },
    { kind: 'strong-reminder' },
  ])
  assert.equal(LOOP_GUARD_STRONG_REMINDER.includes('不要为了结束而声称任务已经完成'), true)
})

// ---------------------------------------------------------------------------
// Mock-provider integration: the real driver must consume whole-step results.
// ---------------------------------------------------------------------------

async function waitForTurnEnds(baseUrl: string, sessionId: string, count: number): Promise<Envelope[]> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
    const snapshot = (await response.json()) as { events: Envelope[] }
    if (snapshot.events.filter((event) => event.type === 'turn-end').length >= count) {
      return snapshot.events
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`turn did not finish ${count} time(s) in time`)
}

async function newSession(host: { baseUrl: string }, cwd: string): Promise<string> {
  const created = await fetch(`${host.baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd }),
  })
  assert.equal(created.status, 201)
  const { session } = (await created.json()) as { session: { id: string } }
  return session.id
}

async function prompt(host: { baseUrl: string }, sessionId: string, text: string): Promise<void> {
  const response = await fetch(`${host.baseUrl}/api/sessions/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: text, provider: 'mock', model: 'mock-1' }),
  })
  assert.equal(response.status, 202)
}

function tempDirs(prefix: string): { home: string; cwd: string; webDir: string } {
  return {
    home: fs.mkdtempSync(path.join(os.tmpdir(), `denia-${prefix}-home-`)),
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), `denia-${prefix}-cwd-`)),
    webDir: fs.mkdtempSync(path.join(os.tmpdir(), `denia-${prefix}-web-`)),
  }
}

test('integration: >5 identical calls with new results finish normally', async () => {
  const dirs = tempDirs('guard-progress')
  const stateFile = path.join(dirs.cwd, 'state.txt')
  let requests = 0
  const mock = await startMockGateway((request) => {
    // Session-title generation is a separate tool-less completion.
    if (!request.tools || request.tools.length === 0) return { text: '标题' }
    requests += 1
    if (requests <= 7) {
      fs.writeFileSync(stateFile, `value ${requests}\n${'x'.repeat(requests * 7)}`)
      return { calls: [{ name: 'read_file', arguments: { path: 'state.txt' } }] }
    }
    return { text: '处理完成。' }
  })
  writeConfig(dirs.home, mock.baseURL)
  const host = await startHost({ home: dirs.home, webDir: dirs.webDir, port: 0 })
  try {
    const sessionId = await newSession(host, dirs.cwd)
    await prompt(host, sessionId, '读取不断变化的状态文件')
    const events = await waitForTurnEnds(host.baseUrl, sessionId, 1)
    const end = events.find((event) => event.type === 'turn-end') as { reason: unknown }
    assert.deepEqual(end.reason, { kind: 'completed' })
    assert.equal(events.filter((event) => event.type === 'tool-call').length, 7)
    assert.equal(events.filter((event) => event.type === 'tool-result').length, 7)
    assert.equal(
      events.filter(
        (event) => event.type === 'user-message' && event.channel === LOOP_GUARD_CHANNEL,
      ).length,
      0,
    )
  } finally {
    await host.close()
    await mock.close()
  }
})

test('integration: repeated read-only results remind once then stop at six cycles', async () => {
  const dirs = tempDirs('guard-stop')
  fs.writeFileSync(path.join(dirs.cwd, 'only.txt'), 'stable\n')
  let requests = 0
  const mock = await startMockGateway((request) => {
    if (!request.tools || request.tools.length === 0) return { text: '标题' }
    requests += 1
    if (requests <= 6) return { calls: [{ name: 'ls', arguments: { path: '.' } }] }
    return { text: '恢复完成。' }
  })
  writeConfig(dirs.home, mock.baseURL)
  const host = await startHost({ home: dirs.home, webDir: dirs.webDir, port: 0 })
  try {
    const sessionId = await newSession(host, dirs.cwd)
    await prompt(host, sessionId, '检查目录')
    const events = await waitForTurnEnds(host.baseUrl, sessionId, 1)

    const guardMessages = events.filter(
      (event): event is Extract<Envelope, { type: 'user-message' }> =>
        event.type === 'user-message' && event.channel === LOOP_GUARD_CHANNEL,
    )
    assert.equal(guardMessages.length, 1)
    assert.equal(guardMessages[0]!.text, LOOP_GUARD_STRONG_REMINDER)

    // The fifth step request is the first normal request after the fourth cycle.
    const toolRequests = mock.requests.filter((request) => (request.tools?.length ?? 0) > 0)
    const fifthRequest = toolRequests[4]!
    assert.ok(
      fifthRequest.messages.some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content === LOOP_GUARD_STRONG_REMINDER,
      ),
      'the reminder must be present in the next model request',
    )

    const starts = events.filter((event) => event.type === 'step-start')
    const ends = events.filter((event) => event.type === 'step-end')
    assert.equal(starts.length, 6)
    assert.equal(ends.length, 6)
    assert.equal(events.filter((event) => event.type === 'tool-call').length, 6)
    assert.equal(events.filter((event) => event.type === 'tool-result').length, 6)
    const end = events.find((event) => event.type === 'turn-end') as { reason: unknown }
    assert.deepEqual(end.reason, { kind: 'loop-detected', repeats: 6 })
    assert.equal(toolRequests.length, 6)

    // The closed turn is usable: a new prompt starts a fresh turn and count.
    await prompt(host, sessionId, '继续处理')
    const continued = await waitForTurnEnds(host.baseUrl, sessionId, 2)
    const turnEnds = continued.filter((event) => event.type === 'turn-end')
    assert.equal(turnEnds.length, 2)
    assert.deepEqual((turnEnds[1] as { reason: unknown }).reason, { kind: 'completed' })
    assert.equal(
      continued.filter(
        (event) => event.type === 'user-message' && event.channel === LOOP_GUARD_CHANNEL,
      ).length,
      1,
    )
  } finally {
    await host.close()
    await mock.close()
  }
})
