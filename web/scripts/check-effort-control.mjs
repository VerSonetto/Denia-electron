// User-visible selection semantics: preview, commit, cancel and model changes.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const web = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(web, 'node_modules', '.shots')
mkdirSync(outDir, { recursive: true })
const bundle = join(outDir, 'effort-control.mjs')
await build({
  entryPoints: [join(web, 'src/components/ComposerEffortControl.tsx')],
  outfile: bundle, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', '@radix-ui/react-slider', 'motion/react'],
  logLevel: 'silent',
})
// 竖线颜色映射依赖 modelCatalog 的绝对等级,单独打一份做纯函数断言。
const catalogBundle = join(outDir, 'effort-catalog.mjs')
await build({
  entryPoints: [join(web, 'src/modelCatalog.ts')],
  outfile: catalogBundle, bundle: true, format: 'esm', platform: 'node',
  logLevel: 'silent',
})
const dom = new JSDOM('<body><div id="root"></div><button id="outside">Outside</button></body>', {
  url: 'http://localhost/', pretendToBeVisual: true,
})
const w = dom.window
w.matchMedia = () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'SVGElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLFormElement']) {
  try { Object.defineProperty(globalThis, key, { value: key === 'window' ? w : w[key], configurable: true }) } catch {}
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { ComposerEffortControl } = await import(pathToFileURL(bundle).href)
const { hasReasoningEffort, reasoningEffortRank } = await import(pathToFileURL(catalogBundle).href)
const root = createRoot(w.document.getElementById('root'))
const calls = []
let patch
const levels = ['off', 'low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id, name: id }))
function Harness() {
  const [props, setProps] = React.useState({ efforts: levels, value: 'medium', disabled: false, key: 'model-a' })
  patch = (next) => setProps((previous) => ({ ...previous, ...next }))
  return React.createElement(ComposerEffortControl, {
    ...props,
    onChange: (value) => { calls.push(value); setProps((previous) => ({ ...previous, value })) },
  })
}
const query = (selector) => w.document.querySelector(selector)
const dispatch = async (node, event) => {
  assert(node, `Missing target for ${event.type}`)
  await act(async () => { node.dispatchEvent(event) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
}
const click = (selector) => dispatch(query(selector), new w.MouseEvent('click', { bubbles: true }))
const key = (name) => dispatch(query('[role="slider"]'), new w.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
const sliderValue = () => query('[role="slider"]')?.getAttribute('aria-valuenow')
const meterRank = (selector) => query(selector)?.getAttribute('data-rank')
const check = (name, fn) => { fn(); console.log(`ok   ${name}`) }

check('reasoningEffortRank maps each id to its absolute level', () => {
  assert.equal(reasoningEffortRank('off'), 0)
  assert.equal(reasoningEffortRank('low'), 1)
  assert.equal(reasoningEffortRank('medium'), 2)
  assert.equal(reasoningEffortRank('high'), 3)
  assert.equal(reasoningEffortRank('xhigh'), 4)
  assert.equal(reasoningEffortRank('max'), 5)
  assert.equal(reasoningEffortRank('unknown-effort'), 0)
})

check('only-off reasoning is not an adjustable effort', () => {
  assert.equal(hasReasoningEffort([]), false)
  assert.equal(hasReasoningEffort([{ id: 'off' }]), false)
  assert.equal(hasReasoningEffort([{ id: 'off' }, { id: 'high' }]), true)
})

try {
  await act(async () => root.render(React.createElement(Harness)))
  check('trigger shows one meter whose rank matches the current effort', () => {
    assert(meterRank('.effort-chip .effort-meter'), 'meter missing on the effort trigger')
    assert.equal(meterRank('.effort-chip .effort-meter'), '2')
    // 可见内容只剩竖线:文字与图标都不再出现在 chip 里(档位名走 aria/title)。
    assert.equal(query('.effort-chip').textContent.trim(), '')
    assert.equal(query('.effort-chip svg'), null)
  })
  await click('.effort-chip')
  check('open focuses the configured discrete effort', () => {
    assert.equal(sliderValue(), '2')
    assert.equal(w.document.activeElement, query('[role="slider"]'))
  })
  await key('ArrowRight')
  check('arrow adjustment previews without changing the parent', () => {
    assert.equal(sliderValue(), '3')
    assert.deepEqual(calls, [])
  })
  check('previewing recolors the trigger meter before commit', () => {
    assert.equal(meterRank('.effort-chip .effort-meter'), '3')
  })
  await key('Enter')
  check('Enter commits exactly once and restores trigger focus', () => {
    assert.deepEqual(calls, ['high'])
    assert.equal(query('[role="dialog"]'), null)
    assert.equal(w.document.activeElement, query('.effort-chip'))
  })
  await click('.effort-chip')
  await key('End')
  check('End previews the highest available effort', () => assert.equal(sliderValue(), '5'))
  await key('Escape')
  await click('.effort-chip')
  check('Escape cancels the preview', () => {
    assert.equal(sliderValue(), '3')
    assert.deepEqual(calls, ['high'])
  })
  await dispatch(query('.effort-slider'), new w.WheelEvent('wheel', { deltaY: -30, bubbles: true, cancelable: true }))
  check('wheel adjusts one configured step without committing', () => { assert.equal(sliderValue(), '4'); assert.equal(calls.length, 1) })
  await click('.menu-backdrop')
  check('outside dismissal commits the wheel preview once', () => assert.deepEqual(calls, ['high', 'xhigh']))
  await click('.effort-chip')
  await dispatch(query('.effort-slider'), new w.WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }))
  check('Ctrl+wheel preserves zoom and selection', () => assert.equal(sliderValue(), '4'))
  await key('Home')
  await key('Enter')
  check('off remains selectable and is submitted as off', () => assert.equal(calls.at(-1), 'off'))
  check('off draws the lowest rank on the meter', () => {
    assert.equal(meterRank('.effort-chip .effort-meter'), '0')
  })
  await click('.effort-chip')
  await key('End')
  await act(async () => patch({ disabled: true }))
  check('becoming disabled discards an uncommitted change', () => {
    assert.equal(query('[role="dialog"]'), null)
    assert.equal(calls.at(-1), 'off')
    assert.equal(query('.effort-chip').disabled, true)
  })
  await act(async () => patch({ disabled: false }))
  await click('.effort-chip')
  await key('End')
  await act(async () => patch({ key: 'model-b', efforts: levels.slice(1, 3), value: 'low' }))
  await click('.effort-chip')
  check('changing models resets draft and uses only the new model levels', () => {
    assert.equal(sliderValue(), '0')
    assert.equal(query('[role="slider"]').getAttribute('aria-valuemax'), '1')
  })
  await key('End')
  await act(async () => { query('#outside').focus() })
  check('tabbing focus outside applies the draft', () => assert.equal(calls.at(-1), 'medium'))
  await act(async () => patch({ key: 'single', efforts: [levels[0]], value: 'off' }))
  check('a one-level model has no editable slider', () => {
    assert.equal(query('.effort-chip'), null)
    assert(query('.effort-chip-static'))
  })
  check('the static single-level chip also draws a meter', () => {
    assert(meterRank('.effort-chip-static .effort-meter'), 'meter missing on the static chip')
    assert.equal(meterRank('.effort-chip-static .effort-meter'), '0')
    assert.equal(query('.effort-chip-static').textContent.trim(), '')
  })
} finally {
  await act(async () => root.unmount())
  w.close()
}
