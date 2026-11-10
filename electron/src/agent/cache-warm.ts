// Provider prompt-cache warming.
//
// A coding turn often pauses long enough (a build, a test run, the user
// reading) for a 5-minute provider cache entry to expire. Replaying the last
// request at ~90% of its lifetime keeps the prefix hot; the replay asks for a
// single output token and is never written to the session log.
//
// Only the turn knows the phase: `streaming` protects a prefix while the turn
// is still working, `idle` also covers the gap after it settles.

import { streamFor } from '../llm/index.ts'
import type { GenerateRequest } from '../llm/types.ts'
import type { ProviderConfig } from '../config.ts'

export type CacheWarmingMode = 'off' | 'streaming' | 'idle'

export interface CacheWarmingSettings {
  mode: CacheWarmingMode
  /** Provider cache lifetime the replay targets. The timer fires at 90%. */
  ttlSeconds: number
}

export function defaultCacheWarmingSettings(): CacheWarmingSettings {
  return { mode: 'off', ttlSeconds: 300 }
}

/** Replay phase, chosen by the caller that schedules it. */
export type WarmPhase = 'streaming' | 'idle'

interface WarmRequest {
  provider: ProviderConfig
  request: GenerateRequest
}

type StreamFactory = (request: GenerateRequest) => AsyncIterable<unknown>

const MAX_REMEMBERED = 64
const WARM_TIMEOUT_MS = 60_000

/** Timer delay for a given provider cache lifetime: 90%, with a floor. */
export function warmDelayMs(ttlSeconds: number): number {
  const ttl = Math.max(10, Math.floor(ttlSeconds || 0))
  // setTimeout clamps anything above this to an immediate tick; a long TTL
  // must degrade to the latest representable delay, not to a hot replay loop.
  return Math.min(Math.floor((ttl * 9) / 10) * 1000, 2_147_483_647)
}

/**
 * Shape of a cache refresh: one output token, no sampling/reasoning controls,
 * and no cache key. A stateful Responses chain must not adopt the one-token
 * output as the next real turn's baseline.
 */
export function warmingRequest(request: GenerateRequest): GenerateRequest {
  return {
    ...request,
    cacheKey: undefined,
    maxTokens: 1,
    reasoningEffort: undefined,
    temperature: undefined,
    stop: [],
    signal: undefined,
  }
}

/** Per-session last request plus the one scheduled refresh. */
export class CacheWarmer {
  private readonly last = new Map<string, WarmRequest>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly inflight = new Map<string, AbortController>()
  private readonly stream: StreamFactory

  constructor(stream: StreamFactory = (request) => streamFor(request)) {
    this.stream = stream
  }

  /**
   * Remember the request shape to replay.
   *
   * 关闭预热时立刻丢弃已经存过的请求：remember 在每一步都被无条件调用，
   * 而它的载荷是一整份 messages 浅拷贝。默认关闭的配置下仍然保留这些，
   * 等于替每个用过的会话常驻一整份上下文；有上限也只是把浪费限制在上限里。
   */
  remember(
    session: string,
    provider: ProviderConfig,
    request: GenerateRequest,
    mode: CacheWarmingMode = 'off',
  ): void {
    if (mode === 'off') {
      this.last.delete(session)
      return
    }
    if (this.last.size >= MAX_REMEMBERED && !this.last.has(session)) {
      const oldest = this.last.keys().next()
      if (!oldest.done) this.last.delete(oldest.value)
    }
    this.last.set(session, {
      provider,
      request: { ...request, messages: [...request.messages] },
    })
  }

  /** Drop the pending refresh (new turn, compaction, or a mode change). */
  cancel(session: string): void {
    const timer = this.timers.get(session)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(session)
    }
    const refresh = this.inflight.get(session)
    if (refresh) {
      refresh.abort()
      this.inflight.delete(session)
    }
  }

  /** Arm a refresh for `session`. Replaces any refresh already armed for it. */
  schedule(session: string, phase: WarmPhase, settings: CacheWarmingSettings): void {
    if (settings.mode === 'off' || (phase === 'idle' && settings.mode !== 'idle')) {
      this.cancel(session)
      return
    }
    const warm = this.last.get(session)
    this.cancel(session)
    if (!warm) return
    const timer = setTimeout(() => {
      this.timers.delete(session)
      void this.refresh(session, warm)
    }, warmDelayMs(settings.ttlSeconds))
    timer.unref?.()
    this.timers.set(session, timer)
  }

  /** Test seam: whether a refresh is currently armed. */
  pending(session: string): boolean {
    return this.timers.has(session)
  }

  /** Drop every armed refresh (host shutdown). */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const refresh of this.inflight.values()) refresh.abort()
    this.inflight.clear()
    this.last.clear()
  }

  /** Drop one session's timer and remembered request (delete/rewind). */
  forget(session: string): void {
    this.cancel(session)
    this.last.delete(session)
  }

  private async refresh(session: string, warm: WarmRequest): Promise<void> {
    const controller = new AbortController()
    this.inflight.set(session, controller)
    const timer = setTimeout(() => controller.abort(), WARM_TIMEOUT_MS)
    timer.unref?.()
    try {
      const request = warmingRequest(warm.request)
      request.signal = controller.signal
      // Drain the tiny stream so the provider commits the cache read before
      // the connection closes.
      for await (const _chunk of this.stream(request)) {
        // No output is consumed: the request only refreshes the prefix.
      }
    } catch {
      // Warming is an optimization: a failed replay must not surface.
    } finally {
      clearTimeout(timer)
      if (this.inflight.get(session) === controller) this.inflight.delete(session)
    }
  }
}

export type { WarmRequest }