import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const web = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(web, 'node_modules', '.shots')
mkdirSync(outDir, { recursive: true })
const bundle = join(outDir, 'plan-review-layout.mjs')
await build({
  stdin: {
    contents: `export { PlanReviewPanel } from './src/components/PlanReviewPanel';
      export { PlanPreviewPanel } from './src/components/PlanPreviewPanel';`,
    resolveDir: web,
  },
  outfile: bundle, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', '@radix-ui/react-slider', 'motion/react'],
  loader: { '.css': 'empty' }, logLevel: 'silent',
})
const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/', pretendToBeVisual: true })
const w = dom.window
w.matchMedia = () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'SVGElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLFormElement', 'localStorage']) {
  try { Object.defineProperty(globalThis, key, { value: key === 'window' ? w : w[key], configurable: true }) } catch {}
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { PlanReviewPanel, PlanPreviewPanel } = await import(pathToFileURL(bundle).href)
const root = createRoot(w.document.getElementById('root'))
const H = React.createElement
const query = selector => w.document.querySelector(selector)
const click = async selector => {
  const node = query(selector)
  assert(node, `Missing ${selector}`)
  await act(async () => node.dispatchEvent(new w.MouseEvent('click', { bubbles: true })))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
}
const check = (name, fn) => { fn(); console.log(`ok   ${name}`) }
const catalog = { groups: [{ id: 'p', name: 'Provider', models: [{
  id: 'm', name: 'Model', thinkingSupported: true,
  reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
}] }] }
const decisions = []
try {
  await act(async () => root.render(H('div', { className: 'harness' },
    H(PlanPreviewPanel, { title: 'Ship it', planText: '## Goal\n\nImplement the layout.' }),
    H(PlanReviewPanel, { title: 'Ship it', planText: '## Goal\n\nImplement the layout.', catalog,
      selection: { provider: 'p', model: 'm', reasoningEffort: 'low' },
      onDecision: async payload => { decisions.push(payload) }, onExit() {} }),
  )))
  check('plan markdown is isolated in the preview; the input card has decisions only', () => {
    assert(query('.plan-preview-panel .markdown-body, .plan-preview-panel .md-body, .plan-preview-panel .plan-review-body'))
    assert(query('.plan-review-panel .plan-review-actions'))
    assert.equal(query('.plan-review-panel .plan-review-body'), null)
  })
  await click('.plan-review-panel .effort-chip')
  check('the reasoning slider opens as a popover above the approval controls', () => {
    assert(query('.plan-review-panel .effort-popover [role="slider"]'))
    assert.equal(query('.plan-review-panel .effort-popover').style.position, '')
  })
  await click('.plan-review-panel .effort-control > .menu-backdrop')
  await click('.plan-review-submit')
  check('approval still submits with model controls available', () => {
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0].decision, 'allow-once')
  })
  const css = readFileSync(join(web, 'src/styles/panels.css'), 'utf8')
  const card = /\.plan-review-panel\s*\{([^}]+)\}/.exec(css)?.[1] ?? ''
  check('the approval card does not clip model or reasoning popovers', () => {
    assert.match(card, /overflow:\s*visible/)
    assert.doesNotMatch(card, /overflow:\s*hidden/)
  })
  const page = readFileSync(join(web, 'src/pages/SessionsPage.tsx'), 'utf8')
  const app = readFileSync(join(web, 'src/App.tsx'), 'utf8')
  const pane = readFileSync(join(web, 'src/components/SidePane.tsx'), 'utf8')
  check('production wiring opens and clears the right-side plan tab', () => {
    assert(app.includes("pane.openPanel('plan'"))
    assert(app.includes('planReview={planReview}'))
    assert(pane.includes('<PlanPreviewPanel'))
    assert(page.includes('onPlanReviewChange?.(planReview)'))
  })
} finally {
  await act(async () => root.unmount())
  w.close()
}
