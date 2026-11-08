import { useSyncExternalStore } from 'react'

/**
 * 工作步骤展示方式（console 设置 `conversationFoldMode` 的前端镜像）。
 *
 * - `standard`：把一段工作步骤收成一个折叠组；运行中标题显示当前动作与
 *   详情，展开后才出现完整思考与工具调用。
 * - `tool-group`：思考收为一行；仅合并连续同类工具，夹入思考、正文或
 *   异类工具时断开。
 * - `detailed`：运行中完整展开思考与工具调用；结束后统一折叠。
 */
export type ConversationFoldMode = 'standard' | 'tool-group' | 'detailed'

const DEFAULT_MODE: ConversationFoldMode = 'standard'

let current: ConversationFoldMode = DEFAULT_MODE
const listeners = new Set<() => void>()

/**
 * 宽松解析设置值；`concise` 是旧值，按新名称继续生效。未知/缺省值回落到
 * 默认「标准」，已有显式选择不会被改写。
 */
export function normalizeConversationFoldMode(raw: unknown): ConversationFoldMode {
  if (raw === 'detailed') return 'detailed'
  // `concise` was the pre-three-mode name for the adjacent-tool grouping mode.
  if (raw === 'concise' || raw === 'tool-group') return 'tool-group'
  return DEFAULT_MODE
}

/** 写入缓存（App 拉取设置、设置页保存成功后调用）。 */
export function setConversationFoldMode(mode: ConversationFoldMode): void {
  if (current === mode) return
  current = mode
  for (const listener of listeners) listener()
}

/** 组件渲染路径同步读取当前值。 */
export function peekConversationFoldMode(): ConversationFoldMode {
  return current
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 对话流组件订阅折叠方式；设置变更后立即重渲染。 */
export function useConversationFoldMode(): ConversationFoldMode {
  return useSyncExternalStore(subscribe, peekConversationFoldMode, peekConversationFoldMode)
}