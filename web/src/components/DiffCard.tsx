import { memo, useEffect, useState, type ReactNode } from 'react'
import { t } from '../i18n'
import type { DiffLine, EditDiff } from '../toolDisplay'

/** 普通 diff 行;折叠段展开后也复用它。 */
function DiffLineRow({ line }: { line: DiffLine }) {
  return (
    <div className={`diff-line ${line.kind}`}>
      <span className="diff-gutter">{line.oldNo ?? ''}</span>
      <span className="diff-gutter">{line.newNo ?? ''}</span>
      <span className="diff-sign">
        {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}
      </span>
      <span className="diff-text">{line.text === '' ? ' ' : line.text}</span>
    </div>
  )
}

/**
 * edit / write_file 的行级 diff 卡片。
 *
 * 长 diff 不再保留"文件头 + 文件尾"再挖掉中间:那样改动落在中段时,
 * 展开后反而看不到改了什么。这里按 hunk 折叠**未改动**的行 —— 每处
 * 增删都保留前后上下文,远端未改动段变成一条可点击展开的折叠带。
 * 展开/收起是卡片局部状态,不会让整条对话重新计算。
 */
export const DiffCard = memo(function DiffCard({
  diff,
  hidePath = false,
}: {
  diff: EditDiff
  hidePath?: boolean
}) {
  // 藏路径的多 hunk 组里,首行锚点为 1 且无增删时头部没有任何内容,
  // 整条不渲染,避免留一条空带。
  const showHead = !hidePath || diff.startLine > 1 || diff.added > 0 || diff.removed > 0
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())

  // 结果更新(diff 引用变化)时折叠所有段,避免旧的展开下标落到新折叠带上。
  useEffect(() => {
    setExpanded((current) => (current.size === 0 ? current : new Set()))
  }, [diff])

  const toggle = (index: number) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const rows: ReactNode[] = []
  diff.lines.forEach((line, index) => {
    if (!line.fold) {
      rows.push(<DiffLineRow key={index} line={line} />)
      return
    }
    const hidden = line.hidden ?? []
    if (expanded.has(index)) {
      // 收起带留在原折叠位置,展开的行接在它后面:视线落点不跳。
      rows.push(
        <button
          type="button"
          key={`${index}-collapse`}
          className="diff-line fold expanded"
          aria-expanded="true"
          onClick={() => toggle(index)}
        >
          <span className="diff-gutter">⋯</span>
          <span className="diff-text">{t('diffCollapse')}</span>
        </button>,
      )
      hidden.forEach((inner, innerIndex) => {
        rows.push(<DiffLineRow key={`${index}-${innerIndex}`} line={inner} />)
      })
      return
    }
    const count = hidden.length
    const from = line.oldNo
    const label =
      from === undefined
        ? t('diffFolded', { n: count })
        : t('diffFoldRange', { from, to: from + count - 1, n: count })
    rows.push(
      <button
        type="button"
        key={index}
        className="diff-line fold"
        aria-expanded="false"
        onClick={() => toggle(index)}
      >
        <span className="diff-gutter">⋯</span>
        <span className="diff-text">{label}</span>
        <span className="diff-fold-action">{t('diffExpand')}</span>
      </button>,
    )
  })

  return (
    <div className="diff-card">
      {showHead && (
        <div className="diff-head">
          {!hidePath && (
            <span className="diff-path" title={diff.path}>
              {diff.path}
            </span>
          )}
          {diff.startLine > 1 && (
            <span className="diff-anchor">{t('diffAtLine', { line: diff.startLine })}</span>
          )}
          <DiffStat added={diff.added} removed={diff.removed} />
        </div>
      )}
      <div className="diff-body">{rows}</div>
    </div>
  )
})

/**
 * 增删计数:`+N` 在左、`−N` 在右;值为 0 的一侧不展示(纯新增就不挂 `−0`)。
 * 两侧都是 0 时整块不渲染 —— 那种编辑(old==new)没有可展示的增删事实。
 * 收纯数值而非 EditDiff:多处编辑的工具行头部要挂的是跨 hunk 的聚合值。
 *
 * `compact` 用于工具行头部(更小的字号);卡片顶部用默认尺寸。
 */
export function DiffStat({
  added,
  removed,
  compact = false,
}: {
  added: number
  removed: number
  compact?: boolean
}) {
  if (added === 0 && removed === 0) return null
  const parts: string[] = []
  if (removed > 0) parts.push(t('diffRemoved', { n: removed }))
  if (added > 0) parts.push(t('diffAdded', { n: added }))
  return (
    <span className={`diff-stat${compact ? ' compact' : ''}`} title={parts.join(' · ')}>
      {added > 0 && <em className="add">+{added}</em>}
      {removed > 0 && <em className="del">−{removed}</em>}
    </span>
  )
}