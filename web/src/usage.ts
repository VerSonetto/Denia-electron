/**
 * 用量页的纯计算与格式化。
 *
 * 页面本身只负责布局与交互,所有"这个数怎么算、这段占多少"都在这里,好让
 * `scripts/check-usage.mjs` 不起浏览器就能守口径。三条硬约定:
 *
 * 1. **总量 = 未缓存输入 + 缓存读 + 输出**。`reasoningTokens` 是输出侧的明细,
 *    不计入总量 —— 多数提供方已把它算进 output,再加一遍就是双计。
 * 2. **"没报缓存"与"报了 0"不同**。前者整个命中率不出现(不拿 0% 冒充实测
 *    零命中),后者才如实给 0。
 * 3. **热力图与总览条不随区间收窄**。它们读的是全量折叠,区间只影响下方
 *    趋势与排行。
 */
import type {
  UsageBucket,
  UsageDay,
  UsageHeatmap,
  UsageHeatmapCell,
  UsageRange,
  UsageSummary,
} from './types'

/** 区间名到文案键;顺序由服务端 `ranges` 决定,这里只做翻译。 */
export const USAGE_RANGE_LABELS: Record<UsageRange, string> = {
  today: 'usageRangeToday',
  '7d': 'usageRange7d',
  '30d': 'usageRange30d',
  all: 'usageRangeAll',
}

/** 计数紧凑显示:999 原样,1234 → 1.2k,1234567 → 1.2m。 */
export function formatCount(count: number): string {
  const value = Math.max(0, Math.round(count))
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${trimZero(value / 1_000)}k`
  if (value < 1_000_000_000) return `${trimZero(value / 1_000_000)}m`
  return `${trimZero(value / 1_000_000_000)}b`
}

/** 一位小数,但整数值不显示 `.0`(1.0k 读起来像有精度,其实没有)。 */
function trimZero(value: number): string {
  const fixed = value.toFixed(1)
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}

/** token 总量的可读形式:两位有效小数以上给到 13.4m 这类量级。 */
export function formatTokens(count: number): string {
  return formatCount(count)
}

/**
 * 计费 token 总量。
 *
 * 输入侧分未缓存与缓存读两桶(互斥),输出侧单独一桶;三者相加才是这次
 * 请求真正计费的量。
 */
export function totalTokensOf(bucket: UsageBucket): number {
  return bucket.inputTokens + bucket.cacheReadTokens + bucket.outputTokens
}

/** 缓存命中率(百分比数值);没有任何计费输入时返回 null。 */
export function cacheHitPercent(summary: UsageSummary | UsageBucket): number | null {
  const prompt = summary.inputTokens + summary.cacheReadTokens
  if (prompt <= 0) return null
  return Math.min(100, (summary.cacheReadTokens / prompt) * 100)
}

/** 命中率文案;服务端已经算过一遍,这里只在缺失时退回本地口径。 */
export function cacheHitText(summary: UsageSummary): string | null {
  const percent = summary.cacheHitRate ?? cacheHitPercent(summary)
  if (percent === null) return null
  // 0% 与 100% 都是实测到的端点值,多给一位小数只会写成 "0.0%"(看着像估算)。
  if (percent <= 0) return '0%'
  if (percent >= 100) return '100%'
  return `${percent.toFixed(percent >= 10 ? 0 : 1)}%`
}

/** 占比文案:小于 0.1% 时不显示 0.0%,而是一个下限标记。 */
export function shareText(share: number): string {
  const percent = share * 100
  if (percent <= 0) return '0%'
  if (percent < 0.1) return '<0.1%'
  return `${percent.toFixed(percent >= 10 ? 0 : 1)}%`
}

export interface UsageSegment {
  key: 'uncached' | 'cache' | 'output'
  labelKey: string
  tokens: number
  /** 占总量的比例,0–1;总量为 0 时为 0。 */
  share: number
}

/**
 * 构成条的三段:未缓存输入 / 缓存读 / 输出。
 *
 * 顺序固定(输入在前、输出在后),宽度按 token 数分配 —— 用量是几个数,
 * 但"钱花在哪"是一条比例:缓存占大半说明上下文被反复复用,输出占大半
 * 说明模型在长篇生成。
 */
export function usageSegments(bucket: UsageBucket): UsageSegment[] {
  const total = totalTokensOf(bucket)
  const segment = (
    key: UsageSegment['key'],
    labelKey: string,
    tokens: number,
  ): UsageSegment => ({
    key,
    labelKey,
    tokens,
    share: total > 0 ? tokens / total : 0,
  })
  return [
    segment('uncached', 'turnUsageInputUncached', bucket.inputTokens),
    segment('cache', 'cacheReadTokens', bucket.cacheReadTokens),
    segment('output', 'outputTokens', bucket.outputTokens),
  ]
}

/** 热力图最忙一天的配色档位;0 表示空槽。 */
export function heatLevel(tokens: number, max: number): UsageHeatmapCell['level'] {
  if (tokens <= 0 || max <= 0) return 0
  const ratio = tokens / max
  if (ratio > 0.75) return 4
  if (ratio > 0.5) return 3
  if (ratio > 0.25) return 2
  return 1
}

export interface HeatmapColumn {
  weekIndex: number
  /** 该列归属月份(用于列首的月份标签)。 */
  monthDate: string
  cells: (UsageHeatmapCell | null)[]
}

/**
 * 热力图列模型:原样保留服务端的周切片,只补月份标签。
 *
 * 月份取该周内**第一个 1 日**所在的列;整周没有 1 日时退回周一日期。
 * 不按"周一起始月份"判断 —— 那样非周日的 1 号会被推到下一列,标签最多
 * 错开一整列。
 */
export function heatmapColumns(heatmap: UsageHeatmap): HeatmapColumn[] {
  return heatmap.weeks.map((week) => ({
    weekIndex: week.weekIndex,
    monthDate: monthAnchorOf(week.days),
    cells: week.days,
  }))
}

function monthAnchorOf(days: (UsageHeatmapCell | null)[]): string {
  for (const cell of days) {
    if (cell !== null && cell.date.endsWith('-01')) return cell.date
  }
  for (const cell of days) {
    if (cell !== null) return cell.date
  }
  return ''
}

export interface MonthLabel {
  key: string
  label: string
  span: number
}

/**
 * 底部的月份刻度:按月合并连续列,只保留最近 12 个带文字。
 *
 * 53 周会横跨 13 个月,全画出来会在窄容器里糊成一片;被隐藏的那几个月
 * 仍然占据 `span`,月份与列的对齐关系才不会漂。
 */
export function monthLabels(columns: HeatmapColumn[], locale: string): MonthLabel[] {
  const labels: MonthLabel[] = []
  for (const column of columns) {
    const key = column.monthDate.slice(0, 7)
    if (key === '') continue
    const last = labels[labels.length - 1]
    if (last !== undefined && last.key === key) {
      last.span += 1
      continue
    }
    labels.push({ key, label: monthName(column.monthDate, locale), span: 1 })
  }
  const hidden = Math.max(0, labels.length - 12)
  for (let index = 0; index < hidden; index += 1) {
    const label = labels[index]
    if (label !== undefined) label.label = ''
  }
  return labels
}

/** 月份短名;日期按 UTC 解释(它是日历日,不是时刻)。 */
function monthName(date: string, locale: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) return date.slice(5, 7)
  return new Intl.DateTimeFormat(locale.startsWith('zh') ? 'zh-CN' : 'en-US', {
    timeZone: 'UTC',
    month: locale.startsWith('zh') ? 'numeric' : 'short',
  }).format(parsed)
}

/** 完整日期文案,给热力图格子的 title 用。 */
export function fullDateText(date: string, locale: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) return date
  return new Intl.DateTimeFormat(locale.startsWith('zh') ? 'zh-CN' : 'en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(parsed)
}

/** 趋势图的短日期刻度:3/15。 */
export function shortDateText(date: string, locale: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) return date.slice(5)
  return new Intl.DateTimeFormat(locale.startsWith('zh') ? 'zh-CN' : 'en-US', {
    timeZone: 'UTC',
    month: 'numeric',
    day: 'numeric',
  }).format(parsed)
}

/** 连续天数文案的单位词由 i18n 提供,这里只给数值。 */
export function streakText(days: number): string {
  return formatCount(days)
}

export interface ChartPoint {
  /** 该桶的起始日,同时充当 React key。 */
  date: string
  /** 桶的末日;与 date 相同表示一天一柱。 */
  endDate: string
  /** 桶内天数。 */
  days: number
  total: number
  input: number
  cache: number
  output: number
}

/**
 * 趋势图的聚合粒度(天)。
 *
 * 一天一柱只在区间不超过两个月时成立:365 根柱子挤在 1000px 里,每根不到
 * 2px,画出来是一条灰边而不是趋势。超过就按周、再超就按月 —— 粒度随区间
 * 变,读者看到的一直是"这段时间的起伏",而不是一排栅栏。
 */
export function chartBucketSize(dayCount: number): number {
  if (dayCount <= 62) return 1
  if (dayCount <= 400) return 7
  return 30
}

/**
 * 趋势图的绘图数据:按区间长度自动分桶。
 *
 * 桶的边界从**区间末尾**往前对齐:最后一桶总是贴着今天且是整周,不足
 * 一周的零头落在**最早**那一桶上(它离现在最远,读者不会拿它比长度)。
 */
export function chartPoints(days: UsageDay[]): ChartPoint[] {
  const size = chartBucketSize(days.length)
  if (size === 1) {
    return days.map((day) => ({
      date: day.date,
      endDate: day.date,
      days: 1,
      total: day.totalTokens,
      input: day.inputTokens,
      cache: day.cacheReadTokens,
      output: day.outputTokens,
    }))
  }
  const out: ChartPoint[] = []
  for (let end = days.length; end > 0; end -= size) {
    const start = Math.max(0, end - size)
    const bucket = days.slice(start, end)
    const first = bucket[0]!
    const last = bucket[bucket.length - 1]!
    let total = 0
    let input = 0
    let cache = 0
    let output = 0
    for (const day of bucket) {
      total += day.totalTokens
      input += day.inputTokens
      cache += day.cacheReadTokens
      output += day.outputTokens
    }
    out.push({
      date: first.date,
      endDate: last.date,
      days: bucket.length,
      total,
      input,
      cache,
      output,
    })
  }
  return out.reverse()
}

/**
 * 折线/柱状图的最大值,带一个下限:
 *
 * 全部为 0 时不能除以 0,也不该画一条贴着顶的满高线 —— 那会被读成"用满了"。
 */
export function chartCeiling(points: ChartPoint[]): number {
  let max = 0
  for (const point of points) max = Math.max(max, point.total)
  return max > 0 ? max : 1
}

/** 折线图 x 轴标签的抽稀:最多约 6 个刻度,首尾必出。 */
export function axisLabelIndexes(count: number, maxLabels = 6): number[] {
  if (count <= 0) return []
  if (count <= maxLabels) return Array.from({ length: count }, (_, index) => index)
  const step = Math.ceil((count - 1) / (maxLabels - 1))
  const out: number[] = []
  for (let index = 0; index < count; index += step) out.push(index)
  const last = count - 1
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

/** 排行条的长度比例:相对榜首,0–1。 */
export function barShare(value: number, top: number): number {
  if (top <= 0) return 0
  return Math.min(1, Math.max(0, value / top))
}

/** 「provider / model」的展示名;缺任一项时退回另一项。 */
export function modelLabel(provider: string, model: string): string {
  if (provider === '') return model
  if (model === '') return provider
  return `${provider} / ${model}`
}

/**
 * 会话行的展示名。
 *
 * 标题缺省时退回工作区末段目录名(比"未命名会话"更能定位),两者都没有
 * 才用 id 前 8 位 —— 至少能让两行不重名。
 */
export function sessionLabel(row: {
  id: string
  title: string | null
  cwd: string | null
}): string {
  const title = row.title?.trim()
  if (title !== undefined && title !== '') return title
  const name = row.cwd?.split(/[\\/]/).filter(Boolean).pop()
  if (name !== undefined && name !== '') return name
  return row.id.slice(0, 8)
}
