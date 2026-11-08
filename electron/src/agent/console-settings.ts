// Cache-related console preferences, read from the shared settings document.
//
// Both builds store these under the `console` namespace, so a value changed in
// either UI (or edited by hand) applies everywhere.

import { loadSettings } from '../config.ts'
import { isRecord } from '../core/util.ts'
import { defaultCacheWarmingSettings, type CacheWarmingSettings, type CacheWarmingMode } from './cache-warm.ts'
import { defaultMicrocompactSettings, type MicrocompactSettings } from './microcompact.ts'

export interface ConsoleCacheSettings {
  cacheWarming: CacheWarmingSettings
  microcompact: MicrocompactSettings
  /** Summarization threshold as a fraction of the context window. */
  compactionRatio: number
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback
}

function ratio(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : fallback
}

function warmingMode(value: unknown, fallback: CacheWarmingMode): CacheWarmingMode {
  return value === 'off' || value === 'streaming' || value === 'idle' ? value : fallback
}

export function loadConsoleCacheSettings(home: string): ConsoleCacheSettings {
  const document = loadSettings(home)
  const section = isRecord(document?.['console']) ? document['console'] : {}
  const rawMicro = isRecord(section.microcompact) ? section.microcompact : {}
  const rawCompaction = isRecord(section.compaction) ? section.compaction : {}
  const warming = defaultCacheWarmingSettings()
  const micro = defaultMicrocompactSettings()
  const tools = Array.isArray(rawMicro.microcompactTools)
    ? rawMicro.microcompactTools.filter((tool): tool is string => typeof tool === 'string' && tool !== '')
    : micro.tools
  return {
    compactionRatio: ratio(rawCompaction.compactRatio, 0.9),
    cacheWarming: {
      mode: warmingMode(section.cacheWarming, warming.mode),
      ttlSeconds: count(section.cacheWarmTtlSeconds, warming.ttlSeconds),
    },
    microcompact: {
      enabled:
        typeof rawMicro.microcompactEnabled === 'boolean'
          ? rawMicro.microcompactEnabled
          : micro.enabled,
      keepRecentGroups: count(rawMicro.microcompactKeepRecentGroups, micro.keepRecentGroups),
      idleThresholdMinutes: count(
        rawMicro.microcompactIdleThresholdMinutes,
        micro.idleThresholdMinutes,
      ),
      minSavings: count(rawMicro.microcompactMinSavings, micro.minSavings),
      tools,
      cacheWarmSuffixTokens: count(
        rawMicro.microcompactCacheWarmSuffixTokens,
        micro.cacheWarmSuffixTokens,
      ),
      cacheLookbackPositions: count(
        rawMicro.microcompactCacheLookbackPositions,
        micro.cacheLookbackPositions,
      ),
      clearErrorResults:
        typeof rawMicro.microcompactClearErrorResults === 'boolean'
          ? rawMicro.microcompactClearErrorResults
          : micro.clearErrorResults,
    },
  }
}