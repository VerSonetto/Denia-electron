// Session titles: one best-effort background completion after the first prompt.
//
// Titles are a hint for the sidebar; generation failures are silent and never
// disturb the turn. The event is latest-wins and never enters model history.

import type { AppConfig } from '../config.ts'
import { findProvider, resolveDefault } from '../config.ts'
import type { ModelSelection } from '../core/wire.ts'
import { streamFor } from '../llm/index.ts'
import type { SessionStore } from '../session/store.ts'

const MAX_INPUT_BYTES = 4096
const MAX_TITLE_BYTES = 80
const TIMEOUT_MS = 60_000
const SYSTEM_PROMPT =
  '为一次 AI 编码助手会话起一个简洁标题,依据提供的人类消息。\n只返回一行标题:纯自然语言文本,不带引号、前缀、解释、Markdown、XML 或终端控制字符;不允许代码。\n使用消息的语言。\n非 CJK 语言约 5 个词,CJK 语言不超过 10 个字。'

export interface TitleOptions {
  store: SessionStore
  config: AppConfig
  sessionId: string
  selection?: ModelSelection
  prompt: string
  onUpdated?: () => void
}

/** Fire and forget; returns the promise for tests. */
export async function scheduleSessionTitle(options: TitleOptions): Promise<void> {
  const session = options.store.read(options.sessionId)
  if (!session) return
  if (session.events.some((event) => event.type === 'session-title')) return
  const selection = options.selection ?? resolveDefault(options.config)
  const provider = findProvider(options.config, selection.provider) ?? options.config.providers[0]
  if (!provider) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  timer.unref?.()
  try {
    const parts: string[] = []
    for await (const chunk of streamFor({
      provider,
      model: selection.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: frameInput(options.prompt) }],
      tools: [],
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      signal: controller.signal,
    })) {
      if (chunk.type === 'text-delta') parts.push(chunk.text)
    }
    const title = normalizeTitle(parts.join(''), MAX_TITLE_BYTES)
    if (title === '') return
    const current = options.store.read(options.sessionId)
    if (!current || current.events.some((event) => event.type === 'session-title')) return
    options.store.append(options.sessionId, { type: 'session-title', title })
    options.store.flush(options.sessionId)
    options.onUpdated?.()
  } catch {
    // Best effort: the sidebar falls back to the first-message excerpt.
  } finally {
    clearTimeout(timer)
  }
}

function frameInput(prompt: string): string {
  const text = truncateUtf8(prompt.trim(), MAX_INPUT_BYTES)
  return `根据以下 JSON 数组中的人类消息生成会话标题:\n${JSON.stringify([{ seq: 1, text }])}`
}

export function normalizeTitle(input: string, maxBytes: number): string {
  const stripped = stripEscapeSequences(input)
  const cleaned = [...stripped].filter((char) => !isStrippedControl(char)).join('')
  const normalized = cleaned.split(/\s+/).filter(Boolean).join(' ')
  return truncateUtf8(normalized, maxBytes).trimEnd()
}

function isStrippedControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
}

function stripEscapeSequences(input: string): string {
  const chars = [...input]
  let out = ''
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!
    if (char === '\u001b') {
      const next = chars[index + 1]
      if (next === ']') {
        index += 2
        while (index < chars.length) {
          if (chars[index] === '\u0007') break
          if (chars[index] === '\u001b' && chars[index + 1] === '\\') {
            index += 1
            break
          }
          index += 1
        }
      } else if (next === '[') {
        index += 2
        while (index < chars.length) {
          const code = chars[index]!.codePointAt(0) ?? 0
          if (code >= 0x40 && code <= 0x7e) break
          index += 1
        }
      } else if (next && next >= '@' && next <= '_') {
        index += 1
      }
      continue
    }
    if (char === '\u009b') {
      index += 1
      while (index < chars.length) {
        const code = chars[index]!.codePointAt(0) ?? 0
        if (code >= 0x40 && code <= 0x7e) break
        index += 1
      }
      continue
    }
    if (char === '\u009d') {
      index += 1
      while (index < chars.length && chars[index] !== '\u0007') index += 1
      continue
    }
    out += char
  }
  return out
}

function truncateUtf8(text: string, bytes: number): string {
  let size = 0
  let out = ''
  for (const char of text) {
    const width = Buffer.byteLength(char, 'utf8')
    if (size + width > bytes) break
    size += width
    out += char
  }
  return out
}