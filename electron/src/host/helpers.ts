import { loadSettings, resolveDefault } from '../config.ts'
import type { AppConfig } from '../config.ts'
import { isRecord } from '../core/util.ts'
import type { Envelope, ModelSelection } from '../core/wire.ts'

export function lastSelectionOf(events: Envelope[], config: AppConfig): ModelSelection {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'request-context') {
      return { provider: event.provider, model: event.model }
    }
    if (event.type === 'request-header') {
      return {
        provider: event.header.config.provider,
        model: event.header.config.model,
        ...(event.header.config.reasoningEffort
          ? { reasoningEffort: event.header.config.reasoningEffort }
          : {}),
      }
    }
  }
  return resolveDefault(config)
}

export function previewFingerprint(
  qualifiedId: string,
  tools: string[],
  instructions: string,
): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const text = `${qualifiedId}\x01${tools.join(',')}\x01${instructions}`
  for (const byte of Buffer.from(text, 'utf8')) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

export function subagentPolicyConcurrency(home: string): number {
  const document = loadSettings(home)
  const section = document?.['subagent-policy']
  if (!isRecord(section)) return 8
  const value = section.maxConcurrentRuns
  if (typeof value !== 'number' || !Number.isInteger(value)) return 8
  return Math.max(1, Math.min(64, value))
}

export function emptyWeixinStatus() {
  return {
    connected: false,
    account: null,
    lastError: null,
    lastInboundAt: null,
    lastInboundChars: 0,
    lastAction: null,
    login: null,
  }
}

export function emptyQqbotStatus() {
  return {
    connected: false,
    account: null,
    lastError: null,
    lastInboundAt: null,
    lastInboundChars: 0,
    lastAction: null,
  }
}
