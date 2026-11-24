import { memo, useEffect, useState, type CSSProperties } from 'react'
import { t } from '../../i18n'
import { DENIA_GLYPH_PATHS } from '../deniaGlyph'
import { formatDuration } from './formatDuration'

/**
 * 落墨顺序:竖笔 → 碗形 → 断脚。最后一拍落在字标特有的断口上,
 * 三笔错开 0.12s,合起来就像字标在一笔一笔重写自己。
 */
const INK_ORDER = [1, 0, 2] as const

/**
 * 运行中指示行:消息流末尾「工作中 + 计时」。
 * 叶子组件自持 4Hz tick,流式重渲染不牵动;起点取当前 turn 的 turn-start,
 * 切会话往返计时不重置。
 *
 * 标记直接用 D 字标本体:底下一层是 30% 的底稿,上面一层按书写顺序重新落墨、
 * 停顿、再淡去,2.8s 一轮;底稿保证字标在任何时刻都还认得出。
 */
export const WorkIndicator = memo(function WorkIndicator({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(interval)
  }, [])
  const elapsed = Math.max(0, now - startedAt)
  return (
    <div className="work-indicator" role="status">
      <svg className="work-mark" viewBox="-155 -155 310 310" aria-hidden="true" focusable="false">
        <g className="work-mark-body" transform="translate(-255 -256)">
          {DENIA_GLYPH_PATHS.map((d) => <path key={d} d={d} />)}
        </g>
        <g className="work-mark-ink" transform="translate(-255 -256)">
          {INK_ORDER.map((stroke, at) => (
            <path key={stroke} d={DENIA_GLYPH_PATHS[stroke]} style={{ '--ink-order': at } as CSSProperties} />
          ))}
        </g>
      </svg>
      <span>{t('workIndicator')}</span>
      <span className="work-elapsed">
        {elapsed < 60_000 ? `${(elapsed / 1000).toFixed(1)}s` : formatDuration(elapsed)}
      </span>
    </div>
  )
})
