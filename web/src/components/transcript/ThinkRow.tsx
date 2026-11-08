import { useEffect, useRef, useState } from 'react'
import { t } from '../../i18n'
import { useConversationFoldMode } from '../../features/conversation/foldMode'
import { useFollow } from '../../streaming/useFollow'
import { IconChevron, IconThink } from '../icons'

/** 流式摘要取最后一行:读者关心的是模型此刻在说什么。 */
function lastLine(text: string): string {
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim()
    if (line.length > 0) return line
  }
  return ''
}

/** 标准模式取最后一段的首行,并在摘要里去掉 Markdown 强调标记。 */
function lastParagraphFirstLine(text: string): string {
  const paragraphs = text.replace(/\*\*/g, '').split(/\r?\n\s*\r?\n/)
  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    const line = paragraphs[index]!.split(/\r?\n/).map((item) => item.trim()).find(Boolean)
    if (line) return line
  }
  return ''
}

export function ThinkRow({
  text,
  streaming = false,
  durationMs,
}: {
  text: string
  /** 思考内容正在流式输出:详细模式展开;输出完毕自动折叠(手动点击随时可开合)。 */
  streaming?: boolean
  /** 流式阶段量到的思考耗时;历史快照没有时显示模糊时长。 */
  durationMs?: number
}) {
  // 标准与工具分组都把运行中的思考收起；详细模式保留流式展开。
  const mode = useConversationFoldMode()
  const standard = mode === 'standard'
  const foldStreamingReasoning = mode !== 'detailed'
  const [open, setOpen] = useState(foldStreamingReasoning ? false : streaming)
  const previousStreaming = useRef(streaming)
  const previousFold = useRef(foldStreamingReasoning)
  // 自动折叠只发生在用户尚未操作过该思考块时。
  const userToggledRef = useRef(false)
  const summaryRef = useRef<HTMLSpanElement | null>(null)
  // 思考框是 240px 的内部滚动框(外层对话容器不被撑高),跟随发生在它自己
  // 身上:流式期间框内吸底,框内手动上翻即脱跟,滚回底部自动恢复。
  // 引擎与对话流同一套(见 streaming/useFollow),不再各自为政。
  // alignOnAttach 只在流式时对齐:流式展开=看最新,流式结束后手动展开=从头读。
  const preRef = useRef<HTMLPreElement | null>(null)
  const follow = useFollow(preRef, {
    active: streaming,
    alignOnAttach: streaming,
  })
  useEffect(() => {
    const streamingChanged = previousStreaming.current !== streaming
    const modeChanged = previousFold.current !== foldStreamingReasoning
    previousStreaming.current = streaming
    previousFold.current = foldStreamingReasoning
    if (modeChanged) {
      userToggledRef.current = false
      setOpen(foldStreamingReasoning ? false : streaming)
      return
    }
    // 流式追加不覆盖手动开合；折叠模式完成时也只自动收起尚未交互的块。
    if (streamingChanged && (!foldStreamingReasoning || !userToggledRef.current)) {
      setOpen(foldStreamingReasoning ? false : streaming)
    }
  }, [foldStreamingReasoning, streaming])
  const streamingSummary = streaming && !open
  const settledSummary =
    durationMs !== undefined
      ? t('thinkDurationSeconds', {
          seconds: String(Math.max(1, Math.ceil(durationMs / 1000))),
        })
      : t('thinkDurationFewSeconds')
  const previewLine = lastParagraphFirstLine(text)
  const summary = standard
    ? previewLine
    : streaming
      ? lastLine(text)
      : settledSummary
  const titleLive = streamingSummary && !standard
  const title = titleLive ? t('thinkStreamingTitle') : t('thinkTitle')
  useEffect(() => {
    const viewport = summaryRef.current
    if (!viewport || !streamingSummary) return
    // 单行摘要宽度不足时保持最新 token 可见，而不是一直停在旧前缀。
    viewport.scrollLeft = viewport.scrollWidth
  }, [streamingSummary, summary])
  return (
    <div className={`disc-row${open ? ' open' : ''}`}>
      <button
        className={`disc-head${streamingSummary ? ' think-live' : ''}`}
        aria-expanded={open}
        onClick={() => {
          userToggledRef.current = true
          setOpen(!open)
        }}
      >
        <span className="glyph">
          <IconThink size={16} />
        </span>
        <span className={`title${titleLive ? ' think-live-title' : ''}`}>{title}</span>
        {summary && (
          <>
            <span className="sep" />
            <span
              ref={summaryRef}
              className={`summary${
                streamingSummary ? ' think-live-summary' : standard ? ' think-preview' : ' think-duration'
              }`}
            >
              {summary}
            </span>
          </>
        )}
        <span className="chev">
          <IconChevron size={12} />
        </span>
      </button>
      {open && (
        <div className="disc-body">
          {/* 思考正文不套代码卡外框；限制仍放在自身滚动区，外层对话高度不被撑开。 */}
          <pre
            ref={follow.setPort}
            className={`think-content${streaming ? ' think-streaming' : ''}`}
          >
            {text}
          </pre>
        </div>
      )}
    </div>
  )
}
