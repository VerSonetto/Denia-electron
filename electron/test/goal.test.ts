// Goal runtime tests: state transitions, accounting, verifier verdicts and
// automatic continuation. The runtime is driven with a fake verifier so no
// network is involved.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { GoalRuntime } from '../src/goal/runtime.ts'
import type { GoalRuntimeOptions } from '../src/goal/runtime.ts'
import { GoalStore } from '../src/goal/store.ts'
import {
  formatGoalContinuationPrompt,
  parseGoalCompletionVerificationText,
} from '../src/goal/prompts.ts'
import type { SessionGoal } from '../src/goal/types.ts'
import type { StartTurnOptions } from '../src/agent/loop.ts'
import { SessionStore } from '../src/session/store.ts'
import type { ModelSelection, SessionEvent, TurnEndReason } from '../src/core/wire.ts'

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'denia-goal-'))
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for goal state')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

interface Harness {
  runtime: GoalRuntime
  sessionId: string
  events: SessionEvent[]
  started: Array<{ prompt: string; options: StartTurnOptions }>
  goal: () => SessionGoal | null
}

function harness(
  overrides: Partial<GoalRuntimeOptions> = {},
  verifier: (prompt: string) => Promise<string> = async () =>
    JSON.stringify({ passed: true, reason: 'done' }),
): Harness {
  const home = tempHome()
  const store = new SessionStore(home)
  const session = store.create(home)
  const goalStore = new GoalStore(home)
  const events: SessionEvent[] = []
  const started: Array<{ prompt: string; options: StartTurnOptions }> = []
  const runtime = new GoalRuntime({
    goalStore,
    config: () => ({ providers: [] }),
    isRunning: () => false,
    startTurn: (_sessionId, prompt, options) => {
      started.push({ prompt, options })
    },
    cancel: () => {},
    selectionOf: () => ({ provider: 'mock', model: 'mock-1' }) as ModelSelection,
    verify: async (input) => verifier(input.prompt),
    planEnabled: () => false,
    append: (_sessionId, event) => events.push(event),
    ...overrides,
  })
  return {
    runtime,
    sessionId: session.id,
    events,
    started,
    goal: () => runtime.read(session.id),
  }
}

function closeTurn(
  h: Harness,
  usage?: { inputTokens: number; outputTokens: number },
): void {
  h.runtime.onTurnStart(h.sessionId)
  h.runtime.onTurnEnd(h.sessionId, { kind: 'completed' } as TurnEndReason, usage)
}

test('set creates an active goal and starts the first continuation turn', async () => {
  const h = harness()
  h.runtime.set(h.sessionId, 'Ship the feature')
  assert.equal(h.goal()?.status, 'active')
  assert.equal(h.goal()?.iteration, 1)
  await waitFor(() => h.started.length === 1)
  assert.equal(h.started[0]?.options.injected, true)
  assert.equal(h.started[0]?.options.channel, 'goal-continuation')
  assert.match(h.started[0]?.prompt ?? '', /Ship the feature/)
  assert.ok(h.events.some((event) => event.type === 'goal' && event.op === 'set'))
})

test('a passing verifier completes the goal after a turn', async () => {
  const h = harness()
  h.runtime.set(h.sessionId, 'Ship the feature')
  await waitFor(() => h.started.length === 1)
  closeTurn(h, { inputTokens: 10, outputTokens: 5 })
  await waitFor(() => h.goal()?.status === 'complete')
  const goal = h.goal()!
  assert.equal(goal.verifications.length, 1)
  assert.equal(goal.verifications[0]?.outcome, 'pass')
  assert.ok(h.events.some((event) => event.type === 'goal' && event.op === 'verified'))
})

test('a failing verifier opens the next iteration and starts another turn', async () => {
  const h = harness({}, async () =>
    JSON.stringify({ passed: false, reason: 'tests missing', nextAction: 'add tests' }),
  )
  h.runtime.set(h.sessionId, 'Ship the feature')
  await waitFor(() => h.started.length === 1)
  closeTurn(h)
  await waitFor(() => h.started.length === 2)
  const goal = h.goal()!
  assert.equal(goal.status, 'active')
  assert.equal(goal.iteration, 2)
  assert.equal(goal.verifications[0]?.outcome, 'not-satisfied')
  assert.equal(h.started[1]?.options.injected, true)
  assert.match(h.started[1]?.prompt ?? '', /add tests/)
  assert.match(h.started[1]?.prompt ?? '', /Ship the feature/)
})

test('a malformed verifier response fails open instead of looping', async () => {
  const h = harness({}, async () => 'not json at all')
  h.runtime.set(h.sessionId, 'Ship the feature')
  await waitFor(() => h.started.length === 1)
  closeTurn(h)
  await waitFor(() => h.goal()?.status === 'complete')
  assert.equal(h.goal()?.verifications[0]?.outcome, 'pass')
})

test('a verifier infrastructure error leaves the goal active without continuing', async () => {
  const h = harness({}, async () => {
    throw new Error('gateway down')
  })
  h.runtime.set(h.sessionId, 'Ship the feature')
  await waitFor(() => h.started.length === 1)
  closeTurn(h)
  await waitFor(() => (h.goal()?.verifications.length ?? 0) === 1)
  const goal = h.goal()!
  assert.equal(goal.status, 'active')
  assert.equal(goal.verifications[0]?.outcome, 'failed')
  assert.equal(h.started.length, 1)
})

test('turn usage and elapsed time settle into the goal', async () => {
  const h = harness({}, async () => JSON.stringify({ passed: false, reason: 'keep going' }))
  h.runtime.set(h.sessionId, 'Ship the feature')
  await waitFor(() => h.started.length === 1)
  closeTurn(h, { inputTokens: 120, outputTokens: 30 })
  await waitFor(() => h.started.length === 2)
  const goal = h.goal()!
  assert.ok(goal.tokensUsed >= 150)
  assert.equal(goal.activeRunStartedAtMs, null)
  assert.ok(goal.timeUsedSeconds >= 0)
})

test('the token budget stops the goal before another iteration', async () => {
  const h = harness({}, async () => JSON.stringify({ passed: false, reason: 'keep going' }))
  h.runtime.set(h.sessionId, 'Ship the feature', 100)
  await waitFor(() => h.started.length === 1)
  closeTurn(h, { inputTokens: 80, outputTokens: 30 })
  await waitFor(() => h.goal()?.status === 'budget-limited')
  assert.equal(h.started.length, 1)
})

test('pause settles the run, resume reactivates it and clear removes it', async () => {
  const h = harness({}, async () => JSON.stringify({ passed: false, reason: 'keep going' }))
  h.runtime.set(h.sessionId, 'Ship the feature')
  await waitFor(() => h.started.length === 1)
  h.runtime.onTurnStart(h.sessionId)
  const paused = h.runtime.pause(h.sessionId)
  assert.equal(paused?.status, 'paused')
  assert.equal(h.goal()?.activeRunStartedAtMs, null)

  const resumed = h.runtime.resume(h.sessionId)
  assert.equal(resumed?.status, 'active')
  await waitFor(() => h.started.length === 2)

  h.runtime.clear(h.sessionId)
  assert.equal(h.goal(), null)
})

test('an interrupted turn pauses an active goal', () => {
  const h = harness()
  h.runtime.set(h.sessionId, 'Ship the feature')
  h.runtime.onTurnStart(h.sessionId)
  h.runtime.onTurnEnd(
    h.sessionId,
    { kind: 'aborted', cause: { kind: 'user' } } as TurnEndReason,
    undefined,
  )
  assert.equal(h.goal()?.status, 'paused')
})

test('plan mode rejects a goal', () => {
  const h = harness({ planEnabled: () => true })
  assert.throws(() => h.runtime.set(h.sessionId, 'Ship the feature'), /计划模式/)
})

test('completion verifier parsing accepts JSON, fenced JSON and string-wrapped JSON', () => {
  assert.equal(parseGoalCompletionVerificationText('{"passed":true,"reason":"ok"}').passed, true)
  assert.equal(
    parseGoalCompletionVerificationText('```json\n{"passed":false,"reason":"no"}\n```').passed,
    false,
  )
  const wrapped = JSON.stringify(JSON.stringify({ passed: true, reason: 'wrapped' }))
  assert.equal(parseGoalCompletionVerificationText(wrapped).passed, true)
  const malformed = parseGoalCompletionVerificationText('oops')
  assert.equal(malformed.passed, true)
  assert.match(malformed.reason, /valid JSON/)
})

test('continuation prompt keeps the objective as untrusted data', () => {
  const goal: SessionGoal = {
    targetId: 't1',
    objective: 'fix <the> bug & ship',
    summaryTitle: null,
    status: 'active',
    tokenBudget: 1000,
    tokensUsed: 200,
    timeUsedSeconds: 5,
    activeRunStartedAtMs: null,
    iteration: 2,
    verifications: [],
    time: { created: 1, updated: 2 },
  }
  const prompt = formatGoalContinuationPrompt(goal, {
    reason: 'tests missing',
    nextAction: 'add tests',
  })
  assert.match(prompt, /fix &lt;the&gt; bug &amp; ship/)
  assert.match(prompt, /add tests/)
  assert.match(prompt, /Tokens remaining: 800/)
})
