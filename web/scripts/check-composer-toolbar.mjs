// ComposerToolbar should hide reasoning controls when a model has no adjustable effort.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const web = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(web, 'node_modules', '.shots')
mkdirSync(outDir, { recursive: true })
const bundle = join(outDir, 'composer-toolbar.mjs')
await build({
  stdin: {
    contents: `
      export { ComposerToolbar } from './src/components/ComposerToolbar'
    `,
    resolveDir: web,
    sourcefile: 'composer-toolbar-test.tsx',
    loader: 'tsx',
  },
  outfile: bundle, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@radix-ui/react-slider', 'motion/react'],
  loader: { '.css': 'empty' }, logLevel: 'silent',
})
const dom = new JSDOM('<body><div id="root"></div></body>', { url: 'http://localhost/', pretendToBeVisual: true })
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
const { ComposerToolbar } = await import(pathToFileURL(bundle).href)
const root = createRoot(w.document.getElementById('root'))
const query = (selector) => w.document.querySelector(selector)
const noop = () => {}
const render = (efforts, effort) => act(async () => root.render(React.createElement(ComposerToolbar, {
  panelAnchorRef: { current: null }, inert: false, optimizing: false, sending: false, running: false,
  canOptimize: false, promptEmpty: true, primaryStops: false, contextProjectPath: null, filesAvailable: false,
  activeId: null, sessions: [], showAttachRow: false, permission: 'full', permissionBusy: false, showApproveForMe: false,
  selection: { provider: 'p', model: 'm', reasoningEffort: effort },
  catalog: { routableProviders: ['p'], groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }], failures: [] },
  activeEffort: effort, effortLevels: efforts, optimizedPrompt: null, context: null,
  onOpenContextMenu: noop, onPickFiles: noop, onInsertFile: noop, onAddContextSession: noop, onInsertCommand: noop,
  onPermissionChange: noop, onSelectionChange: noop, onUndoOptimize: noop, onOptimize: noop, onStop: noop, onSend: noop,
})))
try {
  await render([{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], 'high')
  assert(query('.effort-control'), 'adjustable model must show the effort control')
  await render([{ id: 'off', name: 'Off' }], 'off')
  assert.equal(query('.effort-control'), null, 'thinking-off model must not show a grey effort control')
} finally {
  await act(async () => root.unmount())
  w.close()
}
console.log('ok   ComposerToolbar hides the thinking control when only off is configured')
