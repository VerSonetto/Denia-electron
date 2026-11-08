// Tool-result microcompaction: candidate selection, cache guards, and the
// `replaces` surface rewrite it depends on.

import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveHistory, deriveSurface } from '../src/agent/history.ts'
import type { SurfaceItem } from '../src/agent/history.ts'
import {
  CLEARED_PLACEHOLDER,
  defaultMicrocompactSettings,
  planMicrocompact,
} from '../src/agent/microcompact.ts'
import type { MicrocompactSettings } from '../src/agent/microcompact.ts'
import type { Envelope, SessionEvent } from '../src/core/wire.ts'

function envelope(seq: number, event: SessionEvent): Envelope {
  return { seq, time: 1_700_000_000_000 + seq, ...event }
}

/** `count` assistant turns, each with one tool call and its result. */
function rounds(count: number, payload: string, tool = 'read_file'): Envelope[] {
  const events: Envelope[] = []
  let seq = 1
  for (let round = 0; round < count; round += 1) {
    const callId = `call_${round}`
    events.push(
      envelope(seq++, {
        type: 'assistant-message',
        turn: 1,
        step: round + 1,
        blocks: [
          { type: 'text', text: `第 ${round} 轮` },
          { type: 'tool-call', id: callId, name: tool, arguments: '{}' },
        ],
      }),
    )
    events.push(
      envelope(seq++, {
        type: 'tool-result',
        turn: 1,
        step: round + 1,
        call_id: callId,
        content: payload,
        is_error: false,
      }),
    )
  }
  return events
}

function surfaceOf(roundCount: number, payload: string): SurfaceItem[] {
  return deriveSurface(rounds(roundCount, payload))
}

function settingsWith(overrides: Partial<MicrocompactSettings>): MicrocompactSettings {
  return { ...defaultMicrocompactSettings(), ...overrides }
}

test('keeps the newest groups and clears the older ones under token pressure', () => {
  const surface = surfaceOf(10, 'x'.repeat(2000))
  const decision = planMicrocompact(
    surface,
    settingsWith({ minSavings: 0, cacheWarmSuffixTokens: 0, cacheLookbackPositions: 0 }),
    undefined,
    1000,
    500,
  )
  if (decision.kind !== 'applied') assert.fail(`应当触发清理,实际 ${decision.reason}`)
  assert.equal(decision.trigger, 'pressure')
  assert.deepEqual(decision.clearedToolCallIds, ['call_0', 'call_1', 'call_2', 'call_3', 'call_4'])
  assert.deepEqual(decision.keptToolCallIds, ['call_5', 'call_6', 'call_7', 'call_8', 'call_9'])
  // 每条结果 2000 字符 = 500 token,占位符 12 字符 = 3 token。
  assert.deepEqual(decision.clearedSeqs, [2, 4, 6, 8, 10])
  assert.equal(decision.estimatedSavings, 5 * (500 - 3))
})

test('idle time is the stronger trigger', () => {
  const surface = surfaceOf(10, 'x'.repeat(2000))
  const decision = planMicrocompact(surface, defaultMicrocompactSettings(), 120, 1000, 500)
  if (decision.kind !== 'applied') assert.fail(`应当触发清理,实际 ${decision.reason}`)
  assert.equal(decision.trigger, 'time')
})

test('warm-suffix budget keeps the newest clearable group and leaves older ones', () => {
  const surface = surfaceOf(10, 'x'.repeat(2000))
  // call_4 的后缀是 2510 token(5 条结果 + 5 条短 assistant),call_3 的后缀
  // 已到 3012:预算 2600 只够改后者之前的那一组。
  const decision = planMicrocompact(
    surface,
    settingsWith({ cacheWarmSuffixTokens: 2600 }),
    undefined,
    1000,
    500,
  )
  if (decision.kind !== 'applied') assert.fail(`应当触发清理,实际 ${decision.reason}`)
  assert.deepEqual(decision.clearedToolCallIds, ['call_4'])
  assert.ok(!decision.clearedToolCallIds.includes('call_0'), '最老一组已超出改写预算')
})

test('a generous warm-suffix budget clears every old group', () => {
  const surface = surfaceOf(10, 'x'.repeat(2000))
  const decision = planMicrocompact(
    surface,
    settingsWith({ cacheWarmSuffixTokens: 100_000, cacheLookbackPositions: 0 }),
    undefined,
    1000,
    500,
  )
  if (decision.kind !== 'applied') assert.fail(`应当触发清理,实际 ${decision.reason}`)
  assert.deepEqual(decision.clearedToolCallIds, ['call_0', 'call_1', 'call_2', 'call_3', 'call_4'])
})

test('lookback window leaves ancient groups for compaction', () => {
  const surface = surfaceOf(20, 'x'.repeat(2000))
  const decision = planMicrocompact(
    surface,
    settingsWith({
      keepRecentGroups: 1,
      minSavings: 0,
      cacheWarmSuffixTokens: 0,
      cacheLookbackPositions: 20,
    }),
    undefined,
    9999,
    1,
  )
  if (decision.kind !== 'applied') assert.fail(`应当触发清理,实际 ${decision.reason}`)
  assert.ok(decision.clearedToolCallIds.includes('call_18'), '窗口内的新组应当被清')
  assert.ok(!decision.clearedToolCallIds.includes('call_0'), '超出回看窗口的旧组应当保留')
  assert.deepEqual(decision.clearedToolCallIds, [
    'call_13',
    'call_14',
    'call_15',
    'call_16',
    'call_17',
    'call_18',
  ])
})

test('savings below the threshold stop the rewrite', () => {
  const surface = surfaceOf(10, 'tiny')
  const decision = planMicrocompact(surface, defaultMicrocompactSettings(), undefined, 1000, 500)
  assert.deepEqual(decision, { kind: 'skipped', reason: 'below_min_savings' })
})

test('nothing triggers without idle time or token pressure', () => {
  const surface = surfaceOf(10, 'x'.repeat(2000))
  const decision = planMicrocompact(surface, defaultMicrocompactSettings(), 10, 10, 500)
  assert.deepEqual(decision, { kind: 'skipped', reason: 'not_triggered' })
})

test('a disabled switch never clears', () => {
  const surface = surfaceOf(10, 'x'.repeat(2000))
  const decision = planMicrocompact(
    surface,
    settingsWith({ enabled: false, minSavings: 0 }),
    999,
    9999,
    1,
  )
  assert.deepEqual(decision, { kind: 'skipped', reason: 'disabled' })
})

/** Three rounds where the oldest one is the excluded case. */
function surfaceWithFirstRoundTweak(tweak: (surface: SurfaceItem[]) => void): SurfaceItem[] {
  const surface = surfaceOf(3, 'x'.repeat(2000))
  tweak(surface)
  return surface
}

function oneClearableGroup(): MicrocompactSettings {
  return settingsWith({ keepRecentGroups: 1, minSavings: 0 })
}

test('error results stay unless explicitly enabled', () => {
  const surface = surfaceWithFirstRoundTweak((items) => {
    items[1]!.isError = true
  })
  const decision = planMicrocompact(surface, oneClearableGroup(), undefined, 9999, 1)
  if (decision.kind !== 'applied') assert.fail(`应当触发清理,实际 ${decision.reason}`)
  assert.deepEqual(decision.clearedToolCallIds, ['call_1'])

  const withErrors = planMicrocompact(
    surface,
    { ...oneClearableGroup(), clearErrorResults: true },
    undefined,
    9999,
    1,
  )
  if (withErrors.kind !== 'applied') assert.fail(`应当触发清理,实际 ${withErrors.reason}`)
  assert.deepEqual(withErrors.clearedToolCallIds, ['call_0', 'call_1'])
})

test('results carrying images stay', () => {
  const surface = surfaceWithFirstRoundTweak((items) => {
    items[1]!.message.images = [{ mime: 'image/png', data: 'AAAA' }]
  })
  const decision = planMicrocompact(surface, oneClearableGroup(), undefined, 9999, 1)
  if (decision.kind !== 'applied') assert.fail(`应当触发清理,实际 ${decision.reason}`)
  assert.deepEqual(decision.clearedToolCallIds, ['call_1'])
})

test('tools outside the whitelist stay', () => {
  const surface = surfaceWithFirstRoundTweak((items) => {
    const call = items[0]!.message.toolCalls?.[0]
    if (call === undefined) assert.fail('第一轮应当带有工具调用')
    call.name = 'todo_write'
  })
  const decision = planMicrocompact(surface, oneClearableGroup(), undefined, 9999, 1)
  if (decision.kind !== 'applied') assert.fail(`应当触发清理,实际 ${decision.reason}`)
  assert.deepEqual(decision.clearedToolCallIds, ['call_1'])
})

test('already cleared content is idempotent', () => {
  const surface = surfaceWithFirstRoundTweak((items) => {
    items[1]!.message.content = `${CLEARED_PLACEHOLDER}[完整输出保留为产物 art-1]`
  })
  const decision = planMicrocompact(surface, oneClearableGroup(), undefined, 9999, 1)
  if (decision.kind !== 'applied') assert.fail(`应当触发清理,实际 ${decision.reason}`)
  assert.deepEqual(decision.clearedToolCallIds, ['call_1'])
})

test('a result without a matching tool call is never cleared', () => {
  const surface = surfaceWithFirstRoundTweak((items) => {
    items[0]!.message.toolCalls = []
  })
  const decision = planMicrocompact(surface, oneClearableGroup(), undefined, 9999, 1)
  if (decision.kind !== 'applied') assert.fail(`应当触发清理,实际 ${decision.reason}`)
  assert.ok(!decision.clearedToolCallIds.includes('call_0'))
})

test('deriveSurface rewrites a tool result in place through replaces', () => {
  const events = [
    envelope(1, { type: 'user-message', text: '先看一下', injected: false }),
    envelope(2, {
      type: 'assistant-message',
      turn: 1,
      step: 1,
      blocks: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{}' }],
    }),
    envelope(3, {
      type: 'tool-result',
      turn: 1,
      step: 1,
      call_id: 'c1',
      content: 'x'.repeat(4000),
      is_error: false,
    }),
    envelope(4, {
      type: 'tool-result',
      turn: 1,
      step: 2,
      call_id: 'c1',
      content: CLEARED_PLACEHOLDER,
      is_error: true,
      replaces: 3,
    }),
  ]
  const surface = deriveSurface(events)
  assert.equal(surface.length, 3, '替换必须原位:不新增节点')
  assert.deepEqual(
    surface.map((item) => item.seq),
    [1, 2, 3],
    '被替换节点保持原 seq',
  )
  const replaced = surface[2]!
  assert.deepEqual(replaced.message, {
    role: 'tool',
    content: CLEARED_PLACEHOLDER,
    toolCallId: 'c1',
  })
  assert.equal(replaced.isError, true)

  const history = deriveHistory(events)
  assert.equal(history.length, 3)
  assert.deepEqual(history[2], {
    role: 'tool',
    content: CLEARED_PLACEHOLDER,
    toolCallId: 'c1',
  })
})

test('a replacement whose target is gone is appended like a normal result', () => {
  const events = [
    envelope(1, {
      type: 'tool-result',
      turn: 1,
      step: 1,
      call_id: 'c1',
      content: '结果',
      is_error: false,
    }),
    envelope(2, {
      type: 'tool-result',
      turn: 1,
      step: 2,
      call_id: 'c1',
      content: CLEARED_PLACEHOLDER,
      is_error: false,
      replaces: 99,
    }),
  ]
  const surface = deriveSurface(events)
  assert.deepEqual(
    surface.map((item) => item.seq),
    [1, 2],
  )
})

test('surface items carry the injection channel and tool-result error flag', () => {
  const events = [
    envelope(1, { type: 'user-message', text: 'v1', injected: true, channel: 'capability' }),
    envelope(2, { type: 'user-message', text: 'v2', injected: true, channel: 'capability' }),
    // 非基线通道不折叠:它记录来源,但不参与"同通道只留最新"。
    envelope(3, {
      type: 'user-message',
      text: '技能正文',
      injected: true,
      channel: 'skill-invocation',
    }),
  ]
  const surface = deriveSurface(events)
  assert.deepEqual(
    surface.map((item) => item.seq),
    [2, 3],
    '基线通道只保留最新一条,非基线通道不参与折叠',
  )
  assert.equal(surface[0]!.channel, 'capability')
  assert.equal(surface[1]!.channel, 'skill-invocation')
  assert.equal(surface[0]!.isError, false)
})