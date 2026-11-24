import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { t } from '../i18n'
import type { TranscriptNode } from '../fold'
import type { SessionTotals } from '../types'
import { cacheHitPercent, deriveStats, formatCompactDuration, formatTokens } from '../stats'

/**
 * 输入框下方的会话状态栏 —— 三枚平涂数据胶囊。
 *
 * 活动(轮次/步数)、性能(耗时/首字/吞吐)、用量(输入/输出/缓存)各一枚。
 * 胶囊用主色与页底的 4% 实色混合:无边框、无投影、无内高光,存在感压在
 * 输入框之下;簇内用 2px 圆点分隔,标签走 11.5px 辅助色、数值走 12.5px
 * 读数色。缓存命中率可点开明细。上下文占用仍只住在输入框的 ContextRing,
 * 一处事实一处家。
 *
 * 累计口径(轮次/步数/工具数/耗时/token)吃服务端对**整份日志**的投影
 * (`totals`),不再按当前加载窗口折叠 —— 分页只给尾部窗口,按窗口折叠会在
 * 刷新、翻页、长会话实时裁剪后缩水。进行中的轮次没有 turn-end,两侧累计
 * 都不含它:展示时轮次 +1、耗时叠加实时值(该轮起点由事件流直接给,不等
 * 节点节流),所以发起首轮时胶囊立刻从 0 变 1,收尾时也不会多算一轮。
 * 首 token 延迟与吞吐是均值,仍按窗口。
 */
export const StatsBar = memo(function StatsBar({
  nodes,
  totals,
  openTurn = false,
  openTurnStartedAt = null,
}: {
  nodes: TranscriptNode[]
  /** 全会话累计统计(服务端投影 + 实时增量);缺省时退化为按窗口折叠。 */
  totals?: SessionTotals
  /**
   * 当前是否有未闭合轮次。由事件流直接维护(不等 transcript 节点节流):
   * 会话刚发起时轮次立刻 +1,收尾时立刻回到闭合口径,不会出现"等第一轮
   * 结束才从 0 变 1"或结束瞬间多算一轮的跳变。
   */
  openTurn?: boolean
  /** 进行中轮次起点(epoch ms);有值时耗时按秒跳动。 */
  openTurnStartedAt?: number | null
}) {
  const windowStats = useMemo(() => deriveStats(nodes), [nodes])
  // openTurn 是实时开关;缺省时退回按节点推导(独立使用 StatsBar 的场景)。
  const live = openTurn || openTurnStartedAt !== null
  const now = useLiveClock(live)
  const liveMs = openTurnStartedAt === null ? 0 : Math.max(0, now - openTurnStartedAt)
  const stats = totals === undefined
    ? { ...windowStats, turnMs: windowStats.turnMs + liveMs }
    : { ...windowStats, ...totals, turnMs: totals.turnMs + liveMs }

  // 累计 turns/steps 只记已闭合轮次与已结算步;展示时把进行中的这一轮补上,
  // 它还没有 turn-end,两侧累计都不含它。
  const turnsShown = stats.turns + (live ? 1 : 0)
  const hasActivity = turnsShown > 0 || stats.steps > 0 || stats.toolCalls > 0
  const hasTokens = stats.inputTokens > 0 || stats.outputTokens > 0
  if (!hasActivity && !hasTokens) return null

  const duration = stats.turnMs > 0 ? formatCompactDuration(stats.turnMs) : null
  const ttft = stats.avgTtftMs === null ? null : formatCompactDuration(stats.avgTtftMs)
  const speed = stats.tokensPerSecond === null ? null : stats.tokensPerSecond.toFixed(1)
  const cache = cacheHitPercent(stats.inputTokens, stats.cacheReadTokens)
  const tokensHint = hasTokens ? tokenHint(stats) : ''

  // 性能簇:耗时、首字、吞吐。个别指标缺席时,分隔点只在相邻项之间出现。
  const performanceCells: CellSpec[] = []
  if (duration !== null) {
    performanceCells.push({
      key: 'duration',
      node: (
        <Metric
          key="duration"
          label={t('statsDurationLabel')}
          value={duration}
          title={t('statsDurationHint', { duration })}
        />
      ),
    })
  }
  if (ttft !== null) {
    performanceCells.push({
      key: 'ttft',
      node: (
        <Metric
          key="ttft"
          label={t('statsTtftLabel')}
          value={ttft}
          title={t('statsTtftHint', { duration: ttft })}
        />
      ),
    })
  }
  if (speed !== null) {
    performanceCells.push({
      key: 'speed',
      node: (
        <Metric
          key="speed"
          value={speed}
          unit={t('statsSpeedUnit')}
          title={t('statsSpeedHint', { speed })}
        />
      ),
    })
  }

  // 用量簇:输入 / 输出 / 缓存。
  const usageCells: CellSpec[] = []
  if (hasTokens) {
    usageCells.push({
      key: 'input',
      node: (
        <Metric
          key="input"
          label={t('statsInLabel')}
          value={formatTokens(stats.inputTokens)}
          title={tokensHint}
        />
      ),
    })
    usageCells.push({
      key: 'output',
      node: (
        <Metric
          key="output"
          label={t('statsOutLabel')}
          value={formatTokens(stats.outputTokens)}
          title={tokensHint}
        />
      ),
    })
  }
  if (cache !== null) {
    usageCells.push({
      key: 'cache',
      node: (
        <CacheCell
          key="cache"
          percent={cache}
          cacheRead={stats.cacheReadTokens}
          uncached={stats.inputTokens}
        />
      ),
    })
  }

  return (
    <div className="stats-bar" role="status">
      {hasActivity && (
        <div className="stats-cluster stats-cluster-activity">
          <span
            className="stats-cell stats-cell-phrase"
            title={t('statsTurnsHint', {
              turns: turnsShown,
              steps: stats.steps,
              tools: stats.toolCalls,
            })}
          >
            {t('statsTurns', { turns: turnsShown, steps: stats.steps })}
          </span>
        </div>
      )}
      {performanceCells.length > 0 && (
        <div className="stats-cluster stats-cluster-performance">{renderCells(performanceCells)}</div>
      )}
      {usageCells.length > 0 && (
        <div className="stats-cluster stats-cluster-usage">{renderCells(usageCells)}</div>
      )}
    </div>
  )
})

/** 簇内一项:由 renderCells 穿插圆点。 */
type CellSpec = { key: string; node: ReactNode }

function renderCells(cells: CellSpec[]): ReactNode[] {
  return cells.flatMap((cell, index) =>
    index === 0
      ? [cell.node]
      : [
          <span key={`sep-${cell.key}`} className="stats-dot" aria-hidden="true" />,
          cell.node,
        ],
  )
}

/** 单项指标:微标签 + 读数(+ 可选单位)。 */
function Metric({
  label,
  value,
  unit,
  title,
}: {
  label?: string
  value: string
  unit?: string
  title: string
}) {
  return (
    <span className="stats-cell" title={title}>
      {label !== undefined && <span className="stats-label">{label}</span>}
      <span className="stats-value">{value}</span>
      {unit !== undefined && <span className="stats-label stats-unit">{unit}</span>}
    </span>
  )
}

/** token 胶囊的完整说明:输入、输出与缓存读(三者口径互斥,见 stats.ts)。 */
function tokenHint(stats: {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}): string {
  const cachePart = stats.cacheReadTokens > 0
    ? t('statsCachePart', { cache: formatTokens(stats.cacheReadTokens) })
    : ''
  return t('statsTokensHint', {
    input: formatTokens(stats.inputTokens),
    output: formatTokens(stats.outputTokens),
    cache: cachePart,
  })
}

/**
 * 秒级时钟:只有存在进行中轮次时才装定时器,空闲会话零定时器零重渲染。
 * 锚点用服务端事件时刻(与「工作中」指示行同源),不随重挂载丢失。
 */
function useLiveClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [active])
  return now
}

/**
 * 缓存命中:微型进度条 + 整数百分比。轨道交代"还有多少没命中",
 * 填充用同一抹青绿 —— 与用量页、上下文占用里的缓存色同源。
 * 点击弹出明细卡片,取代纯 hover 的 title。
 */
function CacheCell({
  percent,
  cacheRead,
  uncached,
}: {
  percent: string
  cacheRead: number
  /** 未缓存输入(core 里与缓存读互斥,直接就是计费输入的未命中部分)。 */
  uncached: number
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const exact = `${percent}%`
  const rounded = `${Math.round(Number(percent))}%`
  const hint = t('statsCacheHint', { percent })

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <span className="cache-anchor" ref={rootRef}>
      <button
        type="button"
        className="stats-cell stats-cell-button"
        title={hint}
        aria-label={hint}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="stats-label">{t('statsCacheLabel')}</span>
        <span className="stats-value stats-value-compact">{rounded}</span>
      </button>
      {open && (
        <div className="cache-card" role="dialog" aria-label={t('statsCacheHitRate')}>
          <div className="cache-card-head">
            <span>{t('statsCacheHitRate')}</span>
            <span className="cache-card-percent stats-mono">{exact}</span>
          </div>
          <dl className="cache-card-rows">
            <div>
              <dt>{t('cacheReadTokens')}</dt>
              <dd className="stats-mono">{formatTokens(cacheRead)}</dd>
            </div>
            <div>
              <dt>{t('statsCacheMiss')}</dt>
              <dd className="stats-mono">{formatTokens(uncached)}</dd>
            </div>
          </dl>
        </div>
      )}
    </span>
  )
}