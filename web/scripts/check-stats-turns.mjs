/**
 * 状态栏轮次计数的渲染回归:
 *   node scripts/check-stats-turns.mjs
 *
 * 轮次胶囊吃"已闭合轮次 + 进行中这一轮",不能等 turn-end 才从 0 变 1;
 * 收尾时也不能与累计值重复计数。
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(webRoot, 'node_modules', '.shots', 'stats-turns.mjs')
mkdirSync(dirname(output), { recursive: true })
await build({
  entryPoints: [join(webRoot, 'src', 'components', 'StatsBar.tsx')],
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
})

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})
for (const key of [
  'window', 'document', 'navigator', 'location', 'history', 'HTMLElement', 'Element', 'Node',
  'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'EventTarget', 'MutationObserver',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia',
  'localStorage', 'sessionStorage', 'DOMParser', 'Blob', 'URL', 'CSS', 'SVGSVGElement',
  'ResizeObserver',
]) {
  try {
    globalThis[key] = dom.window[key]
  } catch {
    /* 只读全局跳过 */
  }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { StatsBar } = await import(`${pathToFileURL(output).href}?t=${Date.now()}`)
const H = React.createElement
const doc = dom.window.document
const root = createRoot(doc.getElementById('root'))
const emptyTotals = {
  turnMs: 0,
  turns: 0,
  steps: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  reasoningTokens: 0,
}

async function render(props) {
  await act(async () => {
    root.render(H(StatsBar, { nodes: [], ...props }))
  })
}

function activityText() {
  return doc.querySelector('.stats-cluster-activity')?.textContent?.trim() ?? null
}

// 进行中的第一轮:服务端累计仍是 0,显示必须立即是 1。
await render({ totals: { ...emptyTotals }, openTurn: true, openTurnStartedAt: Date.now() })
assert.equal(activityText(), '1 轮 · 0 步', '首轮开始后应立即显示 1 轮')
console.log('ok   首轮开始即显示 1 轮')

// 累计两轮 + 进行中一轮 → 3 轮;已结算步数照旧。
await render({
  totals: { ...emptyTotals, turns: 2, steps: 10, toolCalls: 3, turnMs: 5000 },
  openTurn: true,
  openTurnStartedAt: Date.now(),
})
assert.equal(activityText(), '3 轮 · 10 步', '进行中的轮次要补进累计轮次')
console.log('ok   进行中轮次补进累计轮次')

// 收尾:openTurn 熄灭,累计值接管,不重复计数。
await render({
  totals: { ...emptyTotals, turns: 3, steps: 10, toolCalls: 3, turnMs: 5000 },
  openTurn: false,
  openTurnStartedAt: null,
})
assert.equal(activityText(), '3 轮 · 10 步', '收尾后不应重复计数')
console.log('ok   收尾后不重复计数')

// 没有任何轮次、步、工具、token 时不渲染。
await render({ totals: { ...emptyTotals }, openTurn: false, openTurnStartedAt: null })
assert.equal(doc.querySelector('.stats-bar'), null, '无数据时不应渲染状态栏')
console.log('ok   无数据不渲染')

await act(async () => {
  root.unmount()
})
console.log('\nAll stats turn-count checks passed.')