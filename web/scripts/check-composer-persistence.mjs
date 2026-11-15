import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const web = fileURLToPath(new URL('..', import.meta.url))
const out = join(web, 'node_modules', '.shots', 'composer-persistence.mjs')
mkdirSync(join(web, 'node_modules', '.shots'), { recursive: true })
await build({
  entryPoints: [join(web, 'src/features/conversation/useComposerPersistence.ts')],
  outfile: out, bundle: true, format: 'esm', platform: 'node',
  external: ['react', 'react-dom', 'react/jsx-runtime'], logLevel: 'silent',
  plugins: [{ name: 'memory', setup(build) {
    build.onResolve({ filter: /composerMemory$/ }, () => ({ path: 'memory', namespace: 'mock' }))
    build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `
      export const loadComposer = (...args) => globalThis.memory.load(...args)
      export const saveComposer = (...args) => globalThis.memory.save(...args)
      export const readComposerText = (...args) => globalThis.memory.read(...args)
    `, loader: 'js' }))
  } }],
})
const dom = new JSDOM('<body><div id="root"></div></body>', { url: 'http://localhost/' })
for (const name of ['window', 'document', 'navigator']) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { useComposerPersistence } = await import(pathToFileURL(out).href)
const empty = (text = '') => ({ text, images: [], attachments: [], quotes: [], queue: [] })
const rich = text => ({ ...empty(text), images: [{ id: 'image', blob: new Blob(['image']) }],
  attachments: [{ name: 'file' }], quotes: [{ text: 'quote' }], queue: [{ text: 'queued' }] })
const stored = new Map([['session:a', rich('saved a')], ['session:b', rich('saved b')]])
const saves = []
const errors = []
let fail = false
let delayed = false
const pendingLoads = []
const pendingWrites = []
let holdWrites = false
const backups = new Map()
globalThis.memory = {
  load: scope => {
    assert.ok(scope, 'loading requires an active project or session')
    if (fail) return Promise.reject(new Error('IndexedDB unavailable'))
    if (delayed) return new Promise(resolve => pendingLoads.push({ scope, resolve }))
    return Promise.resolve(stored.get(scope) ?? empty())
  },
  save: (scope, snapshot) => {
    assert.ok(scope, 'saving requires an active project or session')
    saves.push({ scope, snapshot })
    backups.set(scope, snapshot.text)
    stored.set(scope, snapshot)
    if (fail) return Promise.reject(new Error('IndexedDB unavailable'))
    if (holdWrites) return new Promise(resolve => pendingWrites.push(resolve))
    return Promise.resolve()
  },
  read: scope => {
    assert.ok(scope, 'reading a backup requires an active project or session')
    return backups.get(scope) ?? null
  },
}
let state
let edit
let current
function Probe({ scope }) {
  const [snapshot, setSnapshot] = React.useState(empty)
  current = snapshot
  edit = setSnapshot
  state = useComposerPersistence({ scope, snapshot: { ...snapshot },
    restore: value => setSnapshot(value), onError: message => errors.push(message) })
  return null
}
let root = createRoot(document.getElementById('root'))
const render = scope => act(async () => root.render(React.createElement(React.StrictMode, null,
  React.createElement(Probe, { scope }))))
await render(null)
assert.equal(state.ready, true)
await act(async () => state.flush())
window.dispatchEvent(new window.Event('pagehide'))
assert.equal(saves.length, 0, 'startup without a project must not persist an invalid scope')
assert.equal(errors.length, 0, 'startup without a project is not a storage failure')
await render('session:a')
assert.equal(state.ready, true)
assert.equal(current.text, 'saved a')
assert.equal(saves.length, 0, 'StrictMode must not persist initial empty state')
await act(async () => edit(rich('edited a')))
await render('session:b')
assert.equal(current.text, 'saved b')
assert.equal(stored.get('session:a').text, 'edited a')
assert.ok(!saves.some(item => item.scope === 'session:b'), 'old snapshot must not leak into new scope')
await act(async () => edit(rich('edited b')))
const beforeUnmount = saves.length
await act(async () => root.unmount())
assert.equal(saves.length, beforeUnmount + 1)
assert.deepEqual(saves.at(-1).snapshot, rich('edited b'))
root = createRoot(document.getElementById('root'))
await render('session:b')
assert.equal(current.text, 'edited b')
assert.equal(current.queue.length, 1)
await render(null)
assert.deepEqual(current, empty(), 'deselecting the project must clear the previous composer')
const savesWithoutScope = saves.length
await act(async () => state.flush())
window.dispatchEvent(new window.Event('pagehide'))
assert.equal(saves.length, savesWithoutScope)
assert.equal(errors.length, 0)
await render('session:b')
assert.equal(current.text, 'edited b', 'returning to a session must restore its retained draft')
assert.equal(current.queue.length, 1)
await act(async () => root.unmount())

root = createRoot(document.getElementById('root'))
delayed = true
await render('session:slow')
assert.equal(state.ready, false)
await act(async () => edit(rich('typed while loading')))
await act(async () => {
  for (const request of pendingLoads.splice(0)) request.resolve(rich('stale stored value'))
})
assert.equal(current.text, 'typed while loading')
assert.equal(stored.get('session:slow').text, 'typed while loading')
assert.equal(state.ready, true)
await render('session:abandoned')
await render('session:latest')
await act(async () => {
  const requests = pendingLoads.splice(0)
  requests.find(request => request.scope === 'session:latest').resolve(empty('latest scope'))
  requests.find(request => request.scope === 'session:abandoned').resolve(empty('abandoned scope'))
})
assert.equal(current.text, 'latest scope', 'cancelled load must not restore over the active scope')
assert.ok(!saves.some(item => item.scope === 'session:latest' && item.snapshot.text === 'typed while loading'))
delayed = false
await act(async () => root.unmount())

root = createRoot(document.getElementById('root'))
fail = true
backups.set('session:offline', 'text backup')
await render('session:offline')
assert.equal(current.text, 'text backup')
assert.equal(current.images.length, 0)
assert.equal(state.ready, true)
await act(async () => edit(empty('offline edit')))
await act(async () => state.flush())
window.dispatchEvent(new window.Event('pagehide'))
await act(async () => root.unmount())
assert.equal(errors.length, 1, 'storage failures must notify only once per mount')
assert.equal(backups.get('session:offline'), 'offline edit')

fail = false
root = createRoot(document.getElementById('root'))
await render('session:immediate')
holdWrites = true
await act(async () => edit(empty('sync backup')))
assert.equal(backups.get('session:immediate'), 'sync backup')
const beforePageHide = saves.length
window.dispatchEvent(new window.Event('pagehide'))
assert.equal(saves.length, beforePageHide + 1, 'pagehide must invoke save synchronously despite a pending write')
holdWrites = false
for (const resolve of pendingWrites) resolve()
await act(async () => root.unmount())
dom.window.close()
console.log('ok   StrictMode, scope isolation, remount, delayed load, full unmount snapshot, fallback and synchronous pagehide backup')
