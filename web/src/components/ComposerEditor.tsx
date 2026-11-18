import type {
  ClipboardEvent,
  KeyboardEvent,
  RefCallback,
} from 'react'
import { useCallback } from 'react'

import { t } from '../i18n'
import { serializeEditor, syncEmptyMark } from '../pages/editor'

/** contentEditable 输入器:DOM 是草稿事实源,prompt 状态只作镜像。 */
export function ComposerEditor({
  promptScrollRef,
  editorRef,
  placeholderText,
  inert,
  optimizing,
  composerReady,
  mentionOpen,
  mentionLoading,
  mentionItems,
  mentionActive,
  composingRef,
  onDraftChange,
  syncPromptHeight,
  refreshMenus,
  onCopy,
  onCut,
  onPaste,
  onDragOver,
  onDrop,
  onKeyDown,
  onOpenPicker,
}: {
  promptScrollRef: RefCallback<HTMLDivElement>
  editorRef: { current: HTMLDivElement | null }
  placeholderText: string
  inert: boolean
  optimizing: boolean
  composerReady: boolean
  mentionOpen: boolean
  mentionLoading: boolean
  mentionItems: unknown[]
  mentionActive: number
  composingRef: { current: boolean }
  onDraftChange: (text: string) => void
  syncPromptHeight: () => void
  refreshMenus: () => void
  onCopy: (event: ClipboardEvent<HTMLDivElement>) => void
  onCut: (event: ClipboardEvent<HTMLDivElement>) => void
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  onOpenPicker: () => void
}) {
  const setEditor = useCallback((element: HTMLDivElement | null) => {
    editorRef.current = element
  }, [editorRef])
  return (
    <div className="prompt-scroll" ref={promptScrollRef} data-placeholder={placeholderText}>
      <div
        ref={setEditor}
        className="prompt-editor"
        contentEditable={!inert && !optimizing && composerReady}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-autocomplete="list"
        aria-controls={mentionOpen ? 'file-mention-results' : undefined}
        aria-activedescendant={mentionOpen && !mentionLoading && mentionItems.length > 0 ? `file-mention-option-${mentionActive}` : undefined}
        aria-label={inert ? t('heroChooseProject') : t('chatPlaceholder')}
        aria-readonly={inert || optimizing || !composerReady}
        spellCheck={false}
        onInput={() => {
          // DOM 是草稿事实源:同步 prompt 镜像 + 触发检测(IME 组词期间
          // 只同步状态,不刷新弹层)。删空后浏览器会补一个占位 <br>,
          // 占位提示的显隐交给 syncEmptyMark(serializeEditor 把 <br>
          // 读成换行,只看字符串会让提示消失)。
          const el = editorRef.current
          if (!el) return
          const text = serializeEditor(el)
          syncEmptyMark(el)
          onDraftChange(text)
          syncPromptHeight()
          if (!composingRef.current) refreshMenus()
        }}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          composingRef.current = false
          const el = editorRef.current
          if (el) {
            syncEmptyMark(el)
            onDraftChange(serializeEditor(el))
          }
          refreshMenus()
        }}
        onCopy={onCopy}
        onCut={onCut}
        onPaste={onPaste}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onFocus={() => {
          if (inert) onOpenPicker()
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}
