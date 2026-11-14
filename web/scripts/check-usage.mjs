/**
 * 用量页的口径与版式回归(纯源码 + 纯函数,不起浏览器):
 *   node scripts/check-usage.mjs
 *
 * 守四件事,都是"算错了界面照样好看"的那类:
 *   1) 总量 = 未缓存输入 + 缓存读 + 输出,推理 token 不重复计;
 *   2) "没报缓存"不画命中率,"报了 0"才画 0%;
 *   3) 热力图周列的形状与最忙当天归一化;月份标签最多 12 个且 span 不丢;
 *   4) 页面读的是服务端 `ranges`,不在界面里抄一份区间列表。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'denia-usage-'))
try {
  const output = join(directory, 'usage.mjs')
  await build({
    entryPoints: [join(root, 'src/usage.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  })
  const usage = await import(pathToFileURL(output).href)

  /* ---------- 口径 ---------- */

  const bucket = {
    inputTokens: 100,
    cacheReadTokens: 900,
    outputTokens: 20,
    reasoningTokens: 7,
    requests: 1,
    turns: 1,
    toolCalls: 0,
  }
  assert.equal(usage.totalTokensOf(bucket), 1020, '总量是缓存读 + 未缓存输入 + 输出')
  assert.equal(usage.totalTokensOf({ ...bucket, reasoningTokens: 10_000 }), 1020, '推理 token 不进总量')
  assert.equal(
    usage.totalTokensOf({ ...bucket, reasoningTokens: undefined }),
    1020,
    '缺字段按 0 处理',
  )

  // 三段构成条:互斥且加起来等于总量。
  const segments = usage.usageSegments(bucket)
  assert.deepEqual(
    segments.map((segment) => segment.key),
    ['uncached', 'cache', 'output'],
    '构成条顺序固定:未缓存输入 → 缓存读 → 输出',
  )
  assert.equal(
    segments.reduce((sum, segment) => sum + segment.tokens, 0),
    usage.totalTokensOf(bucket),
  )
  assert.ok(Math.abs(segments.reduce((sum, s) => sum + s.share, 0) - 1) < 1e-12)
  assert.deepEqual(
    usage.usageSegments({ ...bucket, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }).map((s) => s.share),
    [0, 0, 0],
    '零用量不做除零',
  )

  /* ---------- 缓存命中率 ---------- */

  const reported = {
    inputTokens: 100,
    cacheReadTokens: 900,
    outputTokens: 0,
    reasoningTokens: 0,
    requests: 1,
    turns: 0,
    toolCalls: 0,
    totalTokens: 1000,
    cacheHitRate: 90,
    activeDays: 1,
    peakDay: '2026-03-15',
    peakDayTokens: 1000,
    currentStreakDays: 1,
    longestStreakDays: 1,
    sessions: 1,
  }
  assert.equal(usage.cacheHitText(reported), '90%', '命中率按服务端口径显示')
  // 服务端没给 rate 时退回本地算式;两边都不该在"无缓存上报"时编出 0%。
  assert.equal(usage.cacheHitText({ ...reported, cacheHitRate: null }), '90%')
  assert.equal(
    usage.cacheHitText({ ...reported, inputTokens: 50, cacheReadTokens: 0, cacheHitRate: null }),
    '0%',
    '报了 0 命中就是 0%',
  )
  assert.equal(
    usage.cacheHitText({ ...reported, inputTokens: 0, cacheReadTokens: 0, cacheHitRate: null }),
    null,
    '完全没有计费输入时不显示命中率',
  )

  /* ---------- 格式化 ---------- */

  assert.equal(usage.formatTokens(999), '999')
  assert.equal(usage.formatTokens(1_000), '1k', '整数不带 .0')
  assert.equal(usage.formatTokens(1_234), '1.2k')
  assert.equal(usage.formatTokens(12_345_678), '12.3m')
  assert.equal(usage.formatTokens(-5), '0')
  assert.equal(usage.shareText(0), '0%')
  assert.equal(usage.shareText(0.0005), '<0.1%')
  assert.equal(usage.shareText(0.5), '50%')
  assert.equal(usage.barShare(5, 0), 0, '榜首为 0 时不做除零')
  assert.equal(usage.barShare(10, 5), 1, '条长封顶在榜首')

  /* ---------- 趋势分桶 ---------- */

  // 一天一柱只在两个月内成立;更长要按周、按月,否则每根不到 2px。
  assert.equal(usage.chartBucketSize(30), 1)
  assert.equal(usage.chartBucketSize(62), 1)
  assert.equal(usage.chartBucketSize(63), 7)
  assert.equal(usage.chartBucketSize(400), 7)
  assert.equal(usage.chartBucketSize(401), 30)
  const day = (n, tokens) => ({
    date: new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10),
    inputTokens: tokens,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    requests: 1,
    turns: 0,
    toolCalls: 0,
    totalTokens: tokens,
  })
  const short = usage.chartPoints(Array.from({ length: 30 }, (_, i) => day(i, i + 1)))
  assert.equal(short.length, 30, "一个月内一天一柱")
  assert.equal(short[0].days, 1)
  const long = usage.chartPoints(Array.from({ length: 100 }, (_, i) => day(i, 1)))
  assert.equal(long.length, 15, "100 天按周分桶 = 14 整周 + 2 天")
  assert.equal(long[0].days, 2, "零头落在最早一桶,末尾保持整周")
  assert.equal(long.at(-1).days, 7, "最后一桶贴住今天且是整周")
  assert.equal(long.reduce((sum, p) => sum + p.days, 0), 100, "分桶不丢天")
  assert.equal(long.reduce((sum, p) => sum + p.total, 0), 100, "分桶不丢用量")
  const monthly = usage.chartPoints(Array.from({ length: 400 }, (_, i) => day(i, 2)))
  assert.equal(monthly.reduce((sum, p) => sum + p.total, 0), 800, "按月分桶同样不丢用量")
  assert.equal(monthly.at(-1).endDate, day(399, 0).date, "最后一桶到区间末尾")
  assert.equal(usage.chartCeiling([]), 1, '空数据给 1,不出现贴顶满高线')
  assert.equal(usage.chartCeiling([{ date: 'd', total: 0, input: 0, cache: 0, output: 0 }]), 1)
  assert.deepEqual(usage.axisLabelIndexes(3), [0, 1, 2])
  assert.deepEqual(usage.axisLabelIndexes(0), [])
  const ticks = usage.axisLabelIndexes(30)
  assert.equal(ticks[0], 0)
  assert.equal(ticks.at(-1), 29, '首尾刻度必须出现')
  assert.ok(ticks.length <= 7 && ticks.length >= 5, `刻度数量应稳定在 5–7 个,实际 ${ticks.length}`)

  /* ---------- 热力图 ---------- */

  assert.equal(usage.heatLevel(0, 100), 0)
  assert.equal(usage.heatLevel(100, 100), 4)
  assert.equal(usage.heatLevel(10, 100), 1)
  assert.equal(usage.heatLevel(60, 100), 3)

  // 两周(其中最后一周只有周三之前有数据),周一在前。
  const cell = (date, tokens) => ({ date, totalTokens: tokens, requests: tokens > 0 ? 1 : 0, level: tokens > 0 ? 1 : 0 })
  const heatmap = {
    startDate: '2026-03-02',
    endDate: '2026-03-11',
    maxTokens: 500,
    weeks: [
      {
        weekIndex: 0,
        days: [
          cell('2026-03-02', 100),
          null,
          cell('2026-03-04', 500),
          cell('2026-03-05', 0),
          null,
          null,
          null,
        ],
      },
      { weekIndex: 1, days: [cell('2026-03-09', 20), cell('2026-03-10', 0), null, null, null, null, null] },
    ],
  }
  const columns = usage.heatmapColumns(heatmap)
  assert.equal(columns.length, 2)
  assert.equal(columns[0].cells.length, 7, '每列七格')
  assert.equal(columns[0].monthDate, '2026-03-02', '没有 1 日时退回周一')
  assert.equal(columns[0].weekIndex, 0)

  const withFirst = usage.heatmapColumns({
    ...heatmap,
    weeks: [
      {
        weekIndex: 0,
        days: [cell('2026-02-25', 1), cell('2026-02-26', 1), cell('2026-02-27', 1), cell('2026-02-28', 1), cell('2026-03-01', 1), null, null],
      },
      { weekIndex: 1, days: [cell('2026-03-02', 1), null, null, null, null, null, null] },
    ],
  })
  assert.equal(withFirst[0].monthDate, '2026-03-01', '周内有 1 日则锚定到 1 日所在列')

  // 月份标签:超过 12 个月时只保留最近 12 个带文字,但 span 总和不变。
  // 53 周正好能落在 12 个自然月内,要 54 周才跨出第 13 个月。
  const manyWeeks = Array.from({ length: 54 }, (_, index) => {
    const weekStart = new Date(Date.UTC(2025, 11, 1) + index * 7 * 86_400_000)
    const month = `${weekStart.getUTCFullYear()}-${String(weekStart.getUTCMonth() + 1).padStart(2, '0')}`
    return {
      weekIndex: index,
      days: Array.from({ length: 7 }, (_, dayOffset) => cell(`${month}-01`, dayOffset + 1)),
    }
  })
  const manyColumns = usage.heatmapColumns({ ...heatmap, weeks: manyWeeks })
  const labels = usage.monthLabels(columns, 'zh')
  assert.equal(
    labels.reduce((sum, label) => sum + label.span, 0),
    columns.length,
    '月份标签的 span 必须盖满所有列',
  )
  const many = usage.monthLabels(manyColumns, 'zh')
  assert.equal(
    many.reduce((sum, label) => sum + label.span, 0),
    manyColumns.length,
  )
  assert.ok(many.filter((label) => label.label !== '').length <= 12, '最多 12 个带文字的月份')
  assert.equal(many[0]?.label, '', '多余的最早月份留位不留字')

  assert.equal(usage.fullDateText('not-a-date', 'zh'), 'not-a-date', '坏日期不抛')
  assert.ok(usage.fullDateText('2026-03-15', 'zh').includes('2026'))
  assert.equal(usage.shortDateText('2026-03-15', 'zh'), '3/15')

  /* ---------- 名称 ---------- */

  assert.equal(usage.modelLabel('magpie', 'deepseek-flash'), 'magpie / deepseek-flash')
  assert.equal(usage.modelLabel('', 'm'), 'm')
  assert.equal(usage.modelLabel('p', ''), 'p')
  assert.equal(usage.sessionLabel({ id: 'abcdefgh1234', title: '  构建 ', cwd: '/w/p' }), '构建')
  assert.equal(usage.sessionLabel({ id: 'abcdefgh1234', title: null, cwd: '/w/denia' }), 'denia')
  assert.equal(usage.sessionLabel({ id: 'abcdefgh1234', title: null, cwd: null }), 'abcdefgh')

  /* ---------- 页面接线 ---------- */

  const page = readFileSync(join(root, 'src/pages/UsagePage.tsx'), 'utf8')
  assert.ok(/snapshot\?\.ranges/.test(page), '区间切换项必须来自服务端 ranges')
  assert.ok(
    !/ranges\s*=\s*\[/.test(page),
    '界面不另抄一份区间列表当事实源',
  )
  assert.ok(page.includes("role=\"tablist\""), '区间切换可访问')
  assert.ok(page.includes("role=\"tab\""))
  assert.ok(page.includes('aria-selected'))
  assert.ok(page.includes('lifetime'), '总览条读 lifetime,不随区间缩水')
  const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')
  assert.ok(app.includes("hash === '#usage'"), '用量页可直达')
  assert.ok(app.includes('sidebar-usage-btn'), '侧栏有入口')
  assert.ok(app.includes('railMounted') && app.includes('usageOpen'), '收起态侧栏也有入口')
  const api = readFileSync(join(root, 'src/api.ts'), 'utf8')
  assert.ok(api.includes('/api/usage?range='), '请求带区间参数')


  /* ---------- 样式变量 ---------- */

  // 页面引用的每个 CSS 变量都必须有定义。曾经 heat-0…4 与构成条三色
  // 只被引用、从未定义:热力图整片透明、进度条只剩底槽,而所有断言
  // 都通过 —— 它们只检查了 DOM 结构与文案。
  const css = readFileSync(join(root, 'src/pages/UsagePage.module.css'), 'utf8')
  const foundation = readFileSync(join(root, 'src/styles/foundation.css'), 'utf8')
  const referenced = new Set([...css.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]))
  const definedInPage = new Set([...css.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]))
  const definedInFoundation = new Set([...foundation.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]))
  const missing = [...referenced].filter(
    (name) => !definedInPage.has(name) && !definedInFoundation.has(name),
  )
  assert.deepEqual(missing, [], `这些 CSS 变量被引用但从未定义:${missing.join(', ')}`)
  console.log('ok usage accounting, cache reporting, heatmap shape and page wiring')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
