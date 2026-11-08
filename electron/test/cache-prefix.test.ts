// Cache-prefix stability: frozen system bytes, request-header snapshots and
// the warming timer's scheduling rules.

import assert from 'node:assert/strict'
import test from 'node:test'

import type { Envelope, MessageCache } from '../src/core/wire.ts'
import type { ProviderConfig } from '../src/config.ts'
import type { SurfaceItem } from '../src/agent/history.ts'
import {
  buildRequestHeader,
  estimatePressure,
  frozenSystem,
  lastAssistantAgeMinutes,
  sameRequestHeader,
  SYSTEM_UPDATE_CHANNEL,
  systemUpdateText,
} from '../src/agent/prefix.ts'
import {
  CacheWarmer,
  warmDelayMs,
  warmingRequest,
  type CacheWarmingSettings,
} from '../src/agent/cache-warm.ts'

function headerEvent(seq: number, system: string): Envelope {
  return {
    seq,
    time: 1_000,
    type: 'request-header',
    turn: 1,
    step: 1,
    reason: 'initial',
    header: { config: { provider: 'p', model: 'm' }, system, tools: [] },
  }
}

function surfaceItem(
  seq: number,
  role: SurfaceItem['message']['role'],
  content: string,
  channel: string | null = null,
  cache?: MessageCache,
): SurfaceItem {
  return {
    seq,
    isError: false,
    channel,
    message: { role, content, ...(cache ? { cache } : {}) },
  }
}

test('system prompt changes append an update instead of rewriting the prefix', () => {
  const events = [headerEvent(1, 'OLD-SYSTEM')]
  const first = frozenSystem('NEW-SYSTEM', events, [])
  assert.equal(first.system, 'OLD-SYSTEM')
  assert.equal(first.update, systemUpdateText('NEW-SYSTEM'))

  const surface = [surfaceItem(2, 'user', first.update!, SYSTEM_UPDATE_CHANNEL)]
  const again = frozenSystem('NEW-SYSTEM', events, surface)
  assert.equal(again.system, 'OLD-SYSTEM')
  assert.equal(again.update, null, 'the same update is not appended twice')
})

test('returning to the frozen prompt restores it over a stale update', () => {
  const events = [headerEvent(1, 'OLD-SYSTEM')]
  const surface = [surfaceItem(2, 'user', systemUpdateText('NEW-SYSTEM'), SYSTEM_UPDATE_CHANNEL)]
  const decision = frozenSystem('OLD-SYSTEM', events, surface)
  assert.equal(decision.system, 'OLD-SYSTEM')
  assert.equal(decision.update, systemUpdateText('OLD-SYSTEM'))
  const restored = [
    ...surface,
    surfaceItem(3, 'user', decision.update!, SYSTEM_UPDATE_CHANNEL),
  ]
  assert.equal(frozenSystem('OLD-SYSTEM', events, restored).update, null)
})

test('a session without a request header uses the assembled prompt', () => {
  const decision = frozenSystem('CURRENT', [], [])
  assert.equal(decision.system, 'CURRENT')
  assert.equal(decision.update, null)
})

test('legacy logs without a header keep the last recorded prompt frozen', () => {
  const events: Envelope[] = [
    { seq: 1, time: 1_000, type: 'system-prompt', turn: 1, step: 1, text: 'LEGACY' },
  ]
  const decision = frozenSystem('CURRENT', events, [])
  assert.equal(decision.system, 'LEGACY')
  assert.equal(decision.update, systemUpdateText('CURRENT'))
})

test('request headers compare by prefix shape, not object identity', () => {
  const tools = [{ name: 'bash', description: 'run', parameters: { type: 'object' } }]
  const selection = { provider: 'p', model: 'm' }
  const a = buildRequestHeader(selection, 'SYS', tools)
  const b = buildRequestHeader({ ...selection }, 'SYS', [
    { name: 'bash', description: 'run', parameters: { type: 'object' } },
  ])
  assert.equal(sameRequestHeader(a, b), true)
  assert.equal(sameRequestHeader(a, buildRequestHeader(selection, 'SYS-2', tools)), false)
  assert.deepEqual(a.config, { provider: 'p', model: 'm' })
})

test('pressure is the billed prompt plus later surface content', () => {
  const events: Envelope[] = [
    {
      seq: 1,
      time: 1_000,
      type: 'assistant-message',
      turn: 1,
      step: 1,
      blocks: [],
      usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 50 },
    },
    { seq: 2, time: 2_000, type: 'user-message', text: 'x'.repeat(400), injected: false },
  ]
  const surface = [
    surfaceItem(1, 'assistant', 'answer'),
    surfaceItem(2, 'user', 'x'.repeat(400)),
  ]
  const pressure = estimatePressure(events, surface, 1_000)
  assert.equal(pressure?.projectedTokens, 250)
  assert.equal(pressure?.thresholdTokens, 810)
  assert.equal(estimatePressure([], [], 1_000), null)
})

test('idle age comes from the newest assistant message', () => {
  const events: Envelope[] = [
    { seq: 1, time: 0, type: 'assistant-message', turn: 1, step: 1, blocks: [] },
    { seq: 2, time: 8 * 60_000, type: 'user-message', text: 'later', injected: false },
  ]
  assert.equal(lastAssistantAgeMinutes(events, 10 * 60_000), 10)
  assert.equal(lastAssistantAgeMinutes([], Date.now()), undefined)
})

function settings(mode: CacheWarmingSettings['mode']): CacheWarmingSettings {
  return { mode, ttlSeconds: 300 }
}

const provider: ProviderConfig = {
  id: 'p',
  name: 'P',
  baseURL: 'http://127.0.0.1:1/v1',
  protocol: 'openai-completions',
  models: [{ id: 'm' }],
}

test('warming respects the phase and mode, and cancel drops the timer', () => {
  const warmer = new CacheWarmer(() => (async function* () {})())
  const request = {
    provider,
    model: 'm',
    messages: [{ role: 'user' as const, content: 'hi' }],
    tools: [],
    cacheKey: 'session-1',
    maxTokens: 50,
    reasoningEffort: 'high',
    temperature: 0.7,
    stop: ['x'],
  }
  warmer.remember('session-1', provider, request)

  warmer.schedule('session-1', 'idle', settings('off'))
  assert.equal(warmer.pending('session-1'), false)
  warmer.schedule('session-1', 'streaming', settings('off'))
  assert.equal(warmer.pending('session-1'), false)

  warmer.schedule('session-1', 'idle', settings('streaming'))
  assert.equal(warmer.pending('session-1'), false)
  warmer.schedule('session-1', 'streaming', settings('streaming'))
  assert.equal(warmer.pending('session-1'), true)
  warmer.cancel('session-1')
  assert.equal(warmer.pending('session-1'), false)

  warmer.schedule('session-1', 'idle', settings('idle'))
  assert.equal(warmer.pending('session-1'), true)
  warmer.dispose()
  assert.equal(warmer.pending('session-1'), false)
})

test('a warming replay keeps the prefix and drops per-request controls', () => {
  const warm = warmingRequest({
    provider,
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    cacheKey: 'session-1',
    maxTokens: 50,
    reasoningEffort: 'high',
    temperature: 0.7,
    stop: ['x'],
  })
  assert.equal(warm.maxTokens, 1)
  assert.equal(warm.cacheKey, undefined)
  assert.equal(warm.reasoningEffort, undefined)
  assert.equal(warm.temperature, undefined)
  assert.deepEqual(warm.stop, [])
  assert.equal(warm.system, undefined)
  assert.equal(warmDelayMs(300), 270_000)
  assert.equal(warmDelayMs(1), 9_000)
})
test('a fired warming timer replays the shaped request and drains it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const seen: { maxTokens?: number; cacheKey?: string }[] = []
  const warmer = new CacheWarmer((request) => {
    seen.push({ maxTokens: request.maxTokens, cacheKey: request.cacheKey })
    return (async function* () {
      yield { type: 'usage' }
    })()
  })
  warmer.remember('session-1', provider, {
    provider,
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    cacheKey: 'session-1',
    maxTokens: 50,
  })
  warmer.schedule('session-1', 'streaming', settings('streaming'))
  t.mock.timers.tick(270_000)
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], { maxTokens: 1, cacheKey: undefined })
  assert.equal(warmer.pending('session-1'), false)
})
