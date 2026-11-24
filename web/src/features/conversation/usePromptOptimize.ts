import { useLayoutEffect, useRef, useState } from 'react';
import { optimizePromptText } from '../../promptOptimizer';
import { notify } from '../../appStore';
import { t } from '../../i18n';
import type { ModelSelection } from '../../types';

/** 提示词优化:当前模型 + 最近 5 轮上下文,支持一键撤销。 */
export function usePromptOptimize({
  activeId,
  selection,
  composerScope,
  running,
  sending,
  prompt,
  applyDraftRef,
}: {
  activeId: string | null
  selection: ModelSelection | null
  composerScope: string | null
  running: boolean
  sending: boolean
  prompt: string
  /** 编辑器草稿重建入口。applyDraft 由 useComposerSlash 产出,晚于本 hook,
   *  故走 ref 转发(页面每渲染重赋,见 runCompactRef 同款套路)。 */
  applyDraftRef: { current: (text: string) => void }
}) {
  const [optimizing, setOptimizing] = useState(false)
  const [optimizedPrompt, setOptimizedPrompt] = useState<string | null>(null)
  const originalPromptRef = useRef('')
  const optimizeAbortRef = useRef<AbortController | null>(null)

  // 欢迎页切项目时 activeId 仍是 null；请求和撤销都归属于发起它的草稿。
  useLayoutEffect(() => {
    setOptimizing(false)
    setOptimizedPrompt(null)
    originalPromptRef.current = ''
    return () => {
      optimizeAbortRef.current?.abort()
      optimizeAbortRef.current = null
    }
  }, [composerScope])

  const canOptimize = Boolean(composerScope && selection && prompt.trim() && !optimizing && !running && !sending)
  const handleOptimize = async () => {
    if (!canOptimize || !selection || optimizeAbortRef.current) return
    const original = prompt
    const controller = new AbortController()
    optimizeAbortRef.current = controller
    setOptimizedPrompt(null)
    setOptimizing(true)
    try {
      const optimized = await optimizePromptText({
        sessionId: activeId,
        prompt: original,
        selection,
        signal: controller.signal,
      })
      if (optimizeAbortRef.current !== controller) return
      applyDraftRef.current(optimized)
      originalPromptRef.current = original
      setOptimizedPrompt(optimized)
      notify('ok', t('optimizeDone'))
    } catch (error) {
      if (controller.signal.aborted || optimizeAbortRef.current !== controller) return
      notify('err', error instanceof Error ? error.message : String(error))
    } finally {
      if (optimizeAbortRef.current === controller) {
        optimizeAbortRef.current = null
        setOptimizing(false)
      }
    }
  }

  const handleUndoOptimize = () => {
    if (!optimizedPrompt) return
    applyDraftRef.current(originalPromptRef.current)
  }

  return {
    optimizing,
    canOptimize,
    optimizedPrompt,
    setOptimizedPrompt,
    originalPromptRef,
    handleOptimize,
    handleUndoOptimize,
  }
}
