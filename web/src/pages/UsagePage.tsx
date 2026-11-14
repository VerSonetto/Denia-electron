import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api'
import { t, getLocale } from '../i18n'
import { IconArrowLeft, IconRefresh } from '../components/icons'
import type { UsageRange, UsageSnapshot } from '../types'
import {
  USAGE_RANGE_LABELS,
  axisLabelIndexes,
  barShare,
  cacheHitText,
  chartCeiling,
  chartPoints,
  formatCount,
  formatTokens,
  fullDateText,
  heatmapColumns,
  monthLabels,
  sessionLabel,
  shareText,
  shortDateText,
  totalTokensOf,
  usageSegments,
} from '../usage'
import styles from './UsagePage.module.css'

/**
 * 用量统计页。
 *
 * 三段回答三个不同的问题,顺序不能换:
 *
 * 1. **总览**(全量):一共花了多少、跨了多少天、最忙的一天是哪天。它不随区间
 *    收窄 —— 用户点开"今天"时仍然想看到累计刻度,否则数字忽大忽小。
 * 2. **构成条**:同样的总量拆成未缓存输入 / 缓存读 / 输出。用量是三个数,
 *    读成一条比例才是"贵在哪":缓存占大半说明上下文被复用,输出占大半说明
 *    在长篇生成。
 * 3. **区间**:每日趋势、模型与会话排行跟着区间走。
 *
 * 热力图夹在各段之间,承担"这一年有没有断档"的时间感。
 */
export default function UsagePage({ onBack }: { onBack: () => void }) {
  const locale = getLocale()
  const [range, setRange] = useState<UsageRange>('30d')
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const titleRef = useRef<HTMLHeadingElement>(null)
  /** 只接受最后一次请求的结果:切区间很快时,慢的旧响应不能覆盖新的。 */
  const requestRef = useRef(0)

  const load = useCallback((next: UsageRange, mode: 'first' | 'switch' | 'refresh') => {
    requestRef.current += 1
    const ticket = requestRef.current
    if (mode === 'first') setLoading(true)
    else setRefreshing(true)
    api
      .getUsage(next)
      .then((data) => {
        if (requestRef.current !== ticket) return
        setSnapshot(data)
        setError(null)
      })
      .catch((reason: unknown) => {
        if (requestRef.current !== ticket) return
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (requestRef.current !== ticket) return
        setLoading(false)
        setRefreshing(false)
      })
  }, [])

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    load(range, snapshot === null ? 'first' : 'switch')
    // `snapshot` 只用来判断首屏;把它列进依赖会让每次响应都重新请求一轮。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, load])

  const ranges: UsageRange[] = snapshot?.ranges ?? [range]

  return (
    <section className={styles.page} aria-labelledby="usage-page-title">
      <div className={styles.content}>
        <header className={styles.header}>
          <div className={styles.headerTop}>
            <button type="button" className={styles.back} onClick={onBack}>
              <IconArrowLeft size={15} />
              <span>{t('usageBack')}</span>
            </button>
            <button
              type="button"
              className={styles.refresh}
              onClick={() => load(range, 'refresh')}
              disabled={refreshing}
            >
              <IconRefresh size={14} />
              <span>{refreshing ? t('usageRefreshing') : t('usageRefresh')}</span>
            </button>
          </div>
          <div className={styles.titleRow}>
            <h1 id="usage-page-title" ref={titleRef} tabIndex={-1}>
              {t('usagePageTitle')}
            </h1>
            {snapshot !== null && (
              <span className={styles.timezone} title={snapshot.timeZone}>
                {snapshot.timeZone}
              </span>
            )}
          </div>
          <p className={styles.lede}>{t('usagePageDescription')}</p>
        </header>

        {loading && snapshot === null ? (
          <div className={styles.loading} role="status">
            <span className={styles.loadingDot} />
            <p>{t('usageLoading')}</p>
          </div>
        ) : error !== null && snapshot === null ? (
          <div className={styles.error} role="alert">
            <p>{error}</p>
            <button type="button" className={styles.refresh} onClick={() => load(range, 'first')}>
              {t('usageRetry')}
            </button>
          </div>
        ) : snapshot === null ? null : (
          <>
            {error !== null && (
              <p className={styles.errorInline} role="alert">
                {error}
              </p>
            )}
            <LifetimeStrip snapshot={snapshot} />
            <Heatmap snapshot={snapshot} locale={locale} />
            <section className={styles.block} aria-label={t('usageRangeTitle')}>
              <div className={styles.blockHead}>
                <h2>{t('usageRangeTitle')}</h2>
                <div className={styles.tabs} role="tablist" aria-label={t('usageRangeTitle')}>
                  {ranges.map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="tab"
                      aria-selected={range === option}
                      className={styles.tab}
                      onClick={() => setRange(option)}
                    >
                      {t(USAGE_RANGE_LABELS[option] as Parameters<typeof t>[0])}
                    </button>
                  ))}
                </div>
              </div>
              <RangeOverview snapshot={snapshot} />
              <DailyTrend snapshot={snapshot} locale={locale} />
              <div className={styles.columns}>
                <ModelRanking snapshot={snapshot} />
                <SessionRanking snapshot={snapshot} locale={locale} />
              </div>
            </section>
          </>
        )}
      </div>
    </section>
  )
}

/** 全量刻度条:不随区间变化,回答"一共多少、多久、最忙哪天"。 */
function LifetimeStrip({ snapshot }: { snapshot: UsageSnapshot }) {
  const life = snapshot.lifetime
  const items = [
    { key: 'total', label: t('usageLifetimeTotal'), value: formatTokens(life.totalTokens) },
    { key: 'peak', label: t('usagePeakDay'), value: formatTokens(life.peakDayTokens) },
    {
      key: 'active',
      label: t('usageActiveDays'),
      value: formatCount(life.activeDays),
    },
    {
      key: 'streak',
      label: t('usageLongestStreak'),
      value: t('usageDaysUnit', { n: formatCount(life.longestStreakDays) }),
    },
  ]
  return (
    <section className={styles.strip} aria-label={t('usageLifetimeTitle')}>
      {items.map((item) => (
        <div key={item.key} className={styles.stripCell}>
          <span className={styles.stripValue}>{item.value}</span>
          <span className={styles.stripLabel}>{item.label}</span>
        </div>
      ))}
    </section>
  )
}

/** 热力图:全年每天一格,深浅按当天 token 相对最忙那天的比例。 */
function Heatmap({ snapshot, locale }: { snapshot: UsageSnapshot; locale: string }) {
  const columns = useMemo(() => heatmapColumns(snapshot.heatmap), [snapshot.heatmap])
  const labels = useMemo(() => monthLabels(columns, locale), [columns, locale])
  const peak = snapshot.heatmap.maxTokens

  return (
    <section className={styles.block} aria-label={t('usageHeatmapTitle')}>
      <div className={styles.blockHead}>
        <h2>{t('usageHeatmapTitle')}</h2>
        <div className={styles.legend} aria-hidden>
          <span>{t('usageLess')}</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <i key={level} className={styles.legendCell} data-level={level} />
          ))}
          <span>{t('usageMore')}</span>
        </div>
      </div>
      <div className={styles.heatmap}>
        <div className={styles.heatAxis} aria-hidden>
          {['', t('usageWeekdayMon'), '', t('usageWeekdayWed'), '', t('usageWeekdayFri'), ''].map(
            (label, index) => (
              <span key={index}>{label}</span>
            ),
          )}
        </div>
        <div className={styles.heatGridWrap}>
          <div
            className={styles.heatGrid}
            style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
          >
            {columns.map((column) => (
              <div key={column.weekIndex} className={styles.heatColumn}>
                {column.cells.map((cell, index) =>
                  cell === null ? (
                    <span key={index} className={`${styles.heatCell} ${styles.heatCellBlank}`} />
                  ) : (
                    <span
                      key={index}
                      className={styles.heatCell}
                      data-level={cell.level}
                      title={t('usageHeatCell', {
                        date: fullDateText(cell.date, locale),
                        tokens: formatTokens(cell.totalTokens),
                        requests: formatCount(cell.requests),
                      })}
                    />
                  ),
                )}
              </div>
            ))}
          </div>
          <div
            className={styles.heatMonths}
            style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
            aria-hidden
          >
            {labels.map((label) => (
              <span key={label.key} style={{ gridColumn: `span ${label.span}` }}>
                {label.label}
              </span>
            ))}
          </div>
        </div>
      </div>
      <p className={styles.heatFoot}>
        {t('usageHeatRange', {
          from: shortDateText(snapshot.heatmap.startDate, locale),
          to: shortDateText(snapshot.heatmap.endDate, locale),
          peak: formatTokens(peak),
        })}
      </p>
    </section>
  )
}

/** 区间总览:总量 + 三段构成条 + 请求/轮次/缓存命中。 */
function RangeOverview({ snapshot }: { snapshot: UsageSnapshot }) {
  const summary = snapshot.summary
  const total = totalTokensOf(summary)
  const segments = usageSegments(summary)
  const hit = cacheHitText(summary)
  const facts = [
    { key: 'input', label: t('turnUsageInputUncached'), tokens: summary.inputTokens },
    { key: 'cache', label: t('cacheReadTokens'), tokens: summary.cacheReadTokens },
    { key: 'output', label: t('outputTokens'), tokens: summary.outputTokens },
  ]

  return (
    <div className={styles.overview}>
      <div className={styles.overviewHead}>
        <div>
          <span className={styles.overviewLabel}>{t('usageWindowTotal')}</span>
          <p className={styles.overviewTotal}>{formatTokens(total)}</p>
        </div>
        <dl className={styles.overviewMeta}>
          <div>
            <dt>{t('usageRequests')}</dt>
            <dd>{formatCount(summary.requests)}</dd>
          </div>
          <div>
            <dt>{t('usageTurns')}</dt>
            <dd>{formatCount(summary.turns)}</dd>
          </div>
          <div>
            <dt>{t('usageSessions')}</dt>
            <dd>{formatCount(summary.sessions)}</dd>
          </div>
          {hit !== null && (
            <div>
              <dt>{t('statsCacheHitRate')}</dt>
              <dd>{hit}</dd>
            </div>
          )}
        </dl>
      </div>

      {total > 0 ? (
        <div className={styles.segments} aria-hidden>
          {segments.map((segment) => (
            <span
              key={segment.key}
              className={styles.segment}
              data-segment={segment.key}
              style={{ flexGrow: segment.tokens }}
            />
          ))}
        </div>
      ) : (
        <div className={`${styles.segments} ${styles.segmentsEmpty}`} aria-hidden>
          <span className={styles.segmentEmpty} />
        </div>
      )}

      <ul className={styles.segmentFacts}>
        {facts.map((fact) => (
          <li key={fact.key} className={styles.segmentFact}>
            <i className={styles.factChip} data-segment={fact.key} aria-hidden />
            <span className={styles.factLabel}>{fact.label}</span>
            <span className={styles.factValue}>{formatTokens(fact.tokens)}</span>
            <span className={styles.factShare}>
              {shareText(total > 0 ? fact.tokens / total : 0)}
            </span>
          </li>
        ))}
      </ul>
      {total === 0 && <p className={styles.empty}>{t('usageEmptyRange')}</p>}
    </div>
  )
}

/**
 * 用量趋势。
 *
 * 手绘柱子而不是引图表库:一条柱状序列不需要坐标系、缩放与交互,拉进来
 * 的依赖会立刻成为首屏最大的一块。柱高按窗口内峰值归一 —— 归一化到全量
 * 峰值会让安静的窗口整片贴地。
 *
 * 粒度由区间长度决定(见 `chartPoints`):一个月内一天一柱,更长按周、按月。
 */
function DailyTrend({ snapshot, locale }: { snapshot: UsageSnapshot; locale: string }) {
  const points = useMemo(() => chartPoints(snapshot.days), [snapshot.days])
  const ceiling = chartCeiling(points)
  const ticks = useMemo(() => axisLabelIndexes(points.length), [points.length])
  if (points.length === 0) return null

  return (
    <div className={styles.chart}>
      <div className={styles.chartHead}>
        <h3>{t('usageDailyTitle')}</h3>
        <span className={styles.chartPeak}>
          {t('usageChartPeak', { tokens: formatTokens(ceiling) })}
        </span>
      </div>
      <div className={styles.chartBody}>
        <div className={styles.bars}>
          {points.map((point) => (
            <span
              key={point.date}
              className={styles.bar}
              style={{ height: `${Math.max(point.total > 0 ? 2 : 0, barShare(point.total, ceiling) * 100)}%` }}
              data-empty={point.total === 0}
              title={t('usageDayCell', {
                date:
                  point.days > 1
                    ? `${shortDateText(point.date, locale)} — ${shortDateText(point.endDate, locale)}`
                    : fullDateText(point.date, locale),
                tokens: formatTokens(point.total),
              })}
            />
          ))}
        </div>
      </div>
      <div className={styles.chartAxis} aria-hidden>
        {points.map((point, index) =>
          ticks.includes(index) ? (
            <span key={point.date} style={{ left: `${(index / Math.max(1, points.length - 1)) * 100}%` }}>
              {shortDateText(point.date, locale)}
            </span>
          ) : null,
        )}
      </div>
    </div>
  )
}

/** 模型排行:按计费 token 排序,条长相对榜首。 */
function ModelRanking({ snapshot }: { snapshot: UsageSnapshot }) {
  const rows = snapshot.models.slice(0, 8)
  const top = rows[0]?.totalTokens ?? 0
  return (
    <div className={styles.rank}>
      <h3>{t('usageModelsTitle')}</h3>
      {rows.length === 0 ? (
        <p className={styles.empty}>{t('usageEmptyRange')}</p>
      ) : (
        <ul className={styles.rankList}>
          {rows.map((row) => (
            <li key={`${row.provider}\u0000${row.model}`} className={styles.rankRow}>
              <div className={styles.rankTop}>
                <span className={styles.rankName} title={`${row.provider} / ${row.model}`}>
                  {row.model}
                </span>
                <span className={styles.rankValue}>{formatTokens(row.totalTokens)}</span>
                <span className={styles.rankShare}>{shareText(row.share)}</span>
              </div>
              <div className={styles.rankTrack} aria-hidden>
                <span
                  className={styles.rankFill}
                  data-tone="model"
                  style={{ width: `${barShare(row.totalTokens, top) * 100}%` }}
                />
              </div>
              <span className={styles.rankMeta}>
                {row.provider} · {t('usageRequestsCount', { n: formatCount(row.requests) })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 会话排行:同一份用量按会话归属,回答"哪个会话最贵"。 */
function SessionRanking({ snapshot, locale }: { snapshot: UsageSnapshot; locale: string }) {
  const rows = snapshot.sessions.slice(0, 8)
  const top = rows[0]?.totalTokens ?? 0
  return (
    <div className={styles.rank}>
      <h3>{t('usageSessionsTitle')}</h3>
      {rows.length === 0 ? (
        <p className={styles.empty}>{t('usageEmptyRange')}</p>
      ) : (
        <ul className={styles.rankList}>
          {rows.map((row) => (
            <li key={row.id} className={styles.rankRow}>
              <div className={styles.rankTop}>
                <span className={styles.rankName} title={sessionLabel(row)}>
                  {sessionLabel(row)}
                </span>
                <span className={styles.rankValue}>{formatTokens(row.totalTokens)}</span>
                {row.subagent && <span className={styles.chip}>{t('usageSubagent')}</span>}
              </div>
              <div className={styles.rankTrack} aria-hidden>
                <span
                  className={styles.rankFill}
                  data-tone="session"
                  style={{ width: `${barShare(row.totalTokens, top) * 100}%` }}
                />
              </div>
              <span className={styles.rankMeta}>
                {relativeDay(row.updatedAt, locale)} ·{' '}
                {t('usageRequestsCount', { n: formatCount(row.requests) })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 会话行的"最近活动";只给日期,不做到分钟级的相对时间。 */
function relativeDay(at: number, locale: string): string {
  if (at <= 0) return '—'
  return new Intl.DateTimeFormat(locale.startsWith('zh') ? 'zh-CN' : 'en-US', {
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(at))
}
