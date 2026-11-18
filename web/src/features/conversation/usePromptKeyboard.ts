import type { KeyboardEvent } from 'react'

import type { QueuedMessage } from '../../types'
import { selectionOffsetsIn, serializeEditor, setCaretOffset } from '../../pages/editor'

interface InputHistory {
  navigate(direction: 'up' | 'down', current: string): string | null
}

/** 输入框键盘裁定:候选弹层、历史回退、停止与发送。 */
export function usePromptKeyboard<Mention, Slash>({
  mentionOpen,
  composingRef,
  mentionItems,
  mentionLoading,
  mentionActive,
  setMentionActive,
  pickMention,
  closeMention,
  slashOpen,
  slashItems,
  slashActive,
  setSlashActive,
  pickSlash,
  closeSlash,
  running,
  stop,
  optimizing,
  composerReady,
  promptRef,
  inputHistory,
  applyDraft,
  promptEmpty,
  queuedMessages,
  interjectQueued,
  sending,
  send,
}: {
  mentionOpen: boolean
  composingRef: { current: boolean }
  mentionItems: Mention[]
  mentionLoading: boolean
  mentionActive: number
  setMentionActive: (update: (index: number) => number) => void
  pickMention: (item: Mention) => void
  closeMention: () => void
  slashOpen: boolean
  slashItems: Slash[]
  slashActive: number
  setSlashActive: (update: (index: number) => number) => void
  pickSlash: (item: Slash) => void
  closeSlash: () => void
  running: boolean
  stop: () => unknown
  optimizing: boolean
  composerReady: boolean
  promptRef: { current: HTMLDivElement | null }
  inputHistory: InputHistory
  applyDraft: (text: string) => void
  promptEmpty: boolean
  queuedMessages: QueuedMessage[]
  interjectQueued: (message: QueuedMessage) => unknown
  sending: boolean
  send: () => unknown
}) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (mentionOpen) {
      // IME 组词阶段的按键交给输入法,不做选择/发送旁路。
      if (composingRef.current) return
      const count = mentionItems.length
      if (event.key === 'ArrowDown' && count > 0) {
        event.preventDefault()
        setMentionActive((index) => Math.min(count - 1, index + 1))
        return
      }
      if (event.key === 'ArrowUp' && count > 0) {
        event.preventDefault()
        setMentionActive((index) => Math.max(0, index - 1))
        return
      }
      // 弹层打开时 Enter/Tab 优先选择候选,不发送。
      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault()
        if (mentionLoading || count === 0) return
        const target = mentionItems[Math.min(mentionActive, count - 1)]
        if (target) pickMention(target)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMention()
        return
      }
    }
    if (slashOpen) {
      // IME 组词阶段的按键交给输入法,不做选择/发送旁路。
      if (composingRef.current) return
      const count = slashItems.length
      if (event.key === 'ArrowDown' && count > 0) {
        event.preventDefault()
        setSlashActive((index) => Math.min(count - 1, index + 1))
        return
      }
      if (event.key === 'ArrowUp' && count > 0) {
        event.preventDefault()
        setSlashActive((index) => Math.max(0, index - 1))
        return
      }
      // 弹层打开时 Enter/Tab 优先选择候选,不发送。
      if ((event.key === 'Tab' || event.key === 'Enter') && count > 0) {
        event.preventDefault()
        const target = slashItems[Math.min(slashActive, count - 1)]
        if (target) pickSlash(target)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        closeSlash()
        return
      }
    }
    // 卡片原子性(contenteditable=false)由浏览器原生保证:光标进不去、
    // Backspace/Delete/选择删除均整卡处理,无需任何拦截。
    if (composingRef.current || event.nativeEvent.isComposing) return
    // Esc 停止当前回复。只挂在输入框上:弹层打开时 Esc 先关弹层(上面的
    // mention/slash 分支已 return),不会误触停止。
    if (event.key === 'Escape' && running) {
      event.preventDefault()
      void stop()
      return
    }
    if (!mentionOpen && !slashOpen && !optimizing && composerReady
      && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
      && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const editor = promptRef.current
      const range = editor ? selectionOffsetsIn(editor) : null
      if (editor && range && range.start === range.end) {
        const current = serializeEditor(editor)
        const up = event.key === 'ArrowUp'
        const boundary = up ? !current.slice(0, range.start).includes('\n') : !current.slice(range.end).includes('\n')
        if (boundary) {
          const text = inputHistory.navigate(up ? 'up' : 'down', current)
          if (text !== null) {
            event.preventDefault()
            applyDraft(text)
            setCaretOffset(editor, up ? 0 : text.length)
            return
          }
        }
      }
    }
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    if (optimizing) return
    // AI 运行且输入框为空:Enter 不再是"停止",而是立即把队首消息送出去
    // (插话)。没有队列时保持原状,不打断当前回复;停止交给 Esc 或按钮。
    if (running && promptEmpty) {
      const next = queuedMessages.find((message) => message.state !== 'steering')
      if (next) void interjectQueued(next)
      return
    }
    if (!sending) void send()
  }
}
