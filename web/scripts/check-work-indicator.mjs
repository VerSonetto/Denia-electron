/**
 * 运行中指示行的渲染回归:
 *   node scripts/check-work-indicator.mjs
 *
 * 断言消息流末尾的「工作中」不再是三个匿名圆点,而是品牌 D 字标的自我重写:
 *   1) 行内是 role=status,文案与计时各就各位;
 *   2) 字标用共享的三笔轮廓,底稿层始终可读;
 *   3) 重写层按书写顺序错拍,并且字标对读屏隐藏。
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, '..')
const outDir = join(webRoot, 'node_modules', '.shots')
mkdirSync(outDir, { recursive: true })
const bundle = join(outDir, 'work-indicator.mjs')

await build({
  entryPoints: [join(webRoot, 'src', 'components', 'transcript', 'WorkIndicator.tsx')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  logLevel: 'silent',
  loader: { '.css': 'empty' },
})

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const g = dom.window
for (const k of [
  'window', 'document', 'navigator', 'location', 'history', 'HTMLElement', 'Element', 'Node',
  'Event', 'MouseEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'matchMedia', 'SVGElement', 'SVGSVGElement', 'ResizeObserver',
]) {
  try { globalThis[k] = g[k] } catch { /* 只读全局跳过 */ }
}

let failed = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failed++
    console.log(`FAIL ${label}\n  actual   ${a}\n  expected ${e}`)
  } else {
    console.log(`ok   ${label}`)
  }
}
function ok(label) { console.log(`ok   ${label}`) }
function fail(label, detail) {
  failed++
  console.log(`FAIL ${label}${detail ? `\n  ${detail}` : ''}`)
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const React = (await import('react')).default
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { WorkIndicator } = await import(`${pathToFileURL(bundle).href}?t=${Date.now()}`)
const H = React.createElement
const doc = g.document
const rootEl = doc.getElementById('root')
const root = createRoot(rootEl)

await act(async () => {
  root.render(H(WorkIndicator, { startedAt: Date.now() - 3400 }))
  await new Promise((resolve) => setTimeout(resolve, 40))
})

const row = rootEl.querySelector('.work-indicator')
if (!row) {
  fail('渲染出运行中指示行', rootEl.innerHTML.slice(0, 300))
} else {
  check('行是状态播报', row.getAttribute('role'), 'status')
  check('文案', row.querySelector('span')?.textContent, '工作中')
  const elapsed = row.querySelector('.work-elapsed')?.textContent ?? ''
  if (/^\d+\.\ds$/.test(elapsed)) ok('计时带一位小数')
  else fail('计时带一位小数', elapsed)
}

const svg = rootEl.querySelector('.work-mark')
if (!svg) {
  fail('字标存在', rootEl.innerHTML.slice(0, 300))
} else {
  ok('字标存在')
  check('字标对读屏隐藏', svg.getAttribute('aria-hidden'), 'true')
  check('字标是三笔轮廓', svg.querySelectorAll('.work-mark-body path').length, 3)
  const ink = svg.querySelector('.work-mark-ink')
  if (!ink) fail('上墨层存在', '没有 .work-mark-ink')
  else {
    const paths = [...ink.querySelectorAll('path')]
    check('上墨层与字标同样三笔', paths.length, 3)
    check('三笔按书写顺序错拍', paths.map((path) => path.style.getPropertyValue('--ink-order')), ['0', '1', '2'])
    check('上墨层压在字标之上(不改变字形轮廓)', ink.previousElementSibling?.classList.contains('work-mark-body'), true)
  }
}

check('旧的三点指示器已移除', rootEl.querySelector('.work-dots'), null)

// 组件持有一个 4Hz 计时器,卸载后进程才能自然退出。
await act(async () => { root.unmount() })

console.log('')
if (failed > 0) {
  console.log(`✗ ${failed} 项失败`)
  process.exit(1)
}
console.log('✓ 运行中指示行检查全部通过')
