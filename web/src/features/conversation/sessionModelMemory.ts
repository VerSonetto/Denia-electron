/**
 * 会话级模型记忆。
 *
 * # 为什么需要两份来源
 *
 * 一个会话"最后用的模型"有两个事实来源，覆盖面互补：
 *
 * 1. **会话日志**（服务端 `last_selection` 投影）：发过请求就一定有，跨设备
 *    跨重启都在，是权威来源；
 * 2. **本地草稿记忆**（本模块）：会话里刚选完模型但还没发消息时，日志里还
 *    是上一次请求的模型。此时切走再切回来，用户看到的应当是自己刚选的，
 *    而不是被悄悄退回旧值。
 *
 * 读取顺序是"本地记忆优先、日志兜底"，因为本地记忆只会在用户显式换模型时
 * 写入，而它一旦写入就代表比日志更新的一次意图。会话下一次发请求后日志会
 * 追上，两者自然一致。
 *
 * # 为什么按会话存到 localStorage
 *
 * 与 `denia.last-model`（全局"上次用的模型"，只服务新建草稿）分开是刻意的：
 * 混在一起就退化成"所有会话共用一个模型"，正是要修的问题。会话数量有限而
 * 且键很短，另设上限避免长期使用后无限增长。
 *
 * 纯前端偏好，不进 console 配置：它与模型目录里的可用性无关，换台机器
 * 重建也不影响正确性（日志那份仍在）。
 */

import type { ModelSelection } from '../../types'

const KEY = 'denia.session-model'

/** 最多记住多少个会话的选择。超出后按写入顺序淘汰最旧的。 */
const MAX_ENTRIES = 300

type Memory = Record<string, ModelSelection>

function read(): Memory {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Memory = {}
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      const selection = parseSelection(value)
      if (selection) out[id] = selection
    }
    return out
  } catch {
    return {}
  }
}

function parseSelection(value: unknown): ModelSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  if (typeof raw.provider !== 'string' || raw.provider === '') return null
  if (typeof raw.model !== 'string' || raw.model === '') return null
  return {
    provider: raw.provider,
    model: raw.model,
    ...(typeof raw.reasoningEffort === 'string' && raw.reasoningEffort !== ''
      ? { reasoningEffort: raw.reasoningEffort }
      : {}),
  }
}

/** 读取某个会话记住的模型；没有（或数据损坏）返回 null。 */
export function readSessionModel(sessionId: string | null): ModelSelection | null {
  if (!sessionId) return null
  return read()[sessionId] ?? null
}

/** 记住某个会话当前选中的模型。`sessionId` 为空（草稿态）时是空操作。 */
export function rememberSessionModel(sessionId: string | null, selection: ModelSelection): void {
  if (!sessionId) return
  try {
    const memory = read()
    memory[sessionId] = {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    }
    const ids = Object.keys(memory)
    if (ids.length > MAX_ENTRIES) {
      // Object 的键序对非数字键就是插入顺序：从头部淘汰最旧的写入。
      for (const stale of ids.slice(0, ids.length - MAX_ENTRIES)) delete memory[stale]
    }
    window.localStorage.setItem(KEY, JSON.stringify(memory))
  } catch {
    // 存储不可用（隐私模式/配额满）：会话切换退化为只用日志那份事实。
  }
}

/** 会话被删除时清掉它的记忆，避免 localStorage 里留孤儿条目。 */
export function forgetSessionModel(sessionId: string): void {
  try {
    const memory = read()
    if (!(sessionId in memory)) return
    delete memory[sessionId]
    window.localStorage.setItem(KEY, JSON.stringify(memory))
  } catch {
    /* storage unavailable */
  }
}
