/**
 * 提示词优化行为回归：真实 SessionsPage/editor/usePromptOptimize/promptOptimizer + jsdom。
 *   node web/scripts/check-prompt-optimizer.mjs
 * esbuild 内存 bundle 仅隔离 API/store/SSE、本地草稿存储和无关展示组件；
 * getSessionPage / chatCompletion 由测试替身记录并手动 resolve/reject。
 * 点击真实优化/撤销按钮，不复制页面 handler，也不发出网络请求或改配置。
 */
import assert from 'node:assert/strict'
import { createRequire, Module } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const web = fileURLToPath(new URL('..', import.meta.url))
const src = join(web, 'src')
const bridgeKey = '__deniaPromptOptimizerRegression'
const projectA = { id: 'project-a', title: 'Project A', dirs: ['D:/mock-project-a'], createdAt: 1, sessionIds: [] }
const projectB = { id: 'project-b', title: 'Project B', dirs: ['D:/mock-project-b'], createdAt: 2, sessionIds: [] }
const session = { id: 'session-test', title: 'Conversation', cwd: projectA.dirs[0], cwd_alive: true, created_at: 1 }
const second = { ...session, id: 'session-second', title: 'Second conversation' }
const bridge = {
  activeProject: 0, running: false, history: [], pageError: null, pageWait: false,
  projects: [projectA, projectB], sessions: [session, second],
  notifications: [], networkAttempts: [], memory: new Map(), pageCalls: [], chatCalls: [],
  ensureSessionCalls: [],
  getSessionPage(id, options, signal) {
    bridge.pageCalls.push({ id, options: structuredClone(options), signal })
    if (bridge.pageError) return Promise.reject(new Error(bridge.pageError))
    if (bridge.pageWait) {
      return new Promise((_, reject) => {
        signal.throwIfAborted()
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    return Promise.resolve(structuredClone({
      header: {}, events: bridge.history, total: bridge.history.length,
      hasMoreBefore: false, anchors: [],
    }))
  },
  chatCompletion(options, signal) {
    return new Promise((resolve, reject) => {
      bridge.chatCalls.push({ options: structuredClone(options), signal, resolve, reject })
    })
  },
}
globalThis[bridgeKey] = bridge
const prelude = `const b = globalThis[${JSON.stringify(bridgeKey)}];`
const unexpectedApi = ['answerApproval', 'answerAsk', 'cancelAsk', 'cancelSession', 'compactSession',
  'forkSession', 'getCheckpointDiff', 'getCheckpoints', 'getSession', 'goalAction', 'rewindSession',
  'setSessionAgentPreset', 'setSessionPermission', 'postPrompt', 'pickFiles']
const stubs = new Map([
  ['composerMemory', `${prelude}
    const empty = () => ({ text: '', images: [], attachments: [], quotes: [], queue: [] });
    export async function loadComposer(scope) { return structuredClone(b.memory.get(scope) ?? empty()); }
    export function readComposerText(scope) { return b.memory.get(scope)?.text ?? null; }
    export async function saveComposer(scope, snapshot) { b.memory.set(scope, structuredClone(snapshot)); }
  `],
  ['api', `${prelude}
    export async function getCatalog() { return { groups: [{ id: 'mock-provider', label: 'Mock', models: [{ id: 'mock-model', name: 'Mock', inputModalities: ['text'] }] }] }; }
    export async function getSettings() { return { namespaces: [] }; }
    export async function permissionCatalog() { return { modes: ['read-only', 'auto-edit', 'plan', 'full'] }; }
    export async function listAgentPresets() { return { modeSelection: false, default: null, presets: [] }; }
    export function subscribeEvents() { return () => {}; }
    export async function listSkills() { return { skills: [] }; }
    export async function getGoal() { return { goal: null, tokensUsed: 0, maxRounds: 10 }; }
    export async function pickerCapability() { return { kind: 'native' }; }
    export async function searchMentions() { return { items: [] }; }
    export function getSessionPage(id, options, signal) { return b.getSessionPage(id, options, signal); }
    export function chatCompletion(options, signal) { return b.chatCompletion(options, signal); }
    ${unexpectedApi.map(name => `export function ${name}() { throw new Error('Unexpected API: ${name}'); }`).join('\n')}
  `],
  ['appStore', `${prelude}
    export const useSessions = () => b.sessions;
    export const useProjects = () => b.projects;
    export function getActiveProject() { return b.projects[b.activeProject]; }
    export const useCatalogTick = () => 0;
    export const useCompactingFor = () => null;
    export function useRunningFor() { return b.running; }
    export function notify(...args) { b.notifications.push(args); }
    export async function ensureSession(...args) { b.ensureSessionCalls.push(args); throw new Error('Unexpected session creation'); }
    export function subscribeRunningStatus() { return () => {}; }
    export function setRunningStatus() {} export function setActiveId() {}
    export function markStarted() {} export function markCompacting() {}
    export function refreshList() {} export function addSessionLocal() {}
  `],
  ['sessionStreams', 'export function attach() { return () => {}; } export function ensureFollowing() {} export function invalidateSession() {}'],
  ['features/conversation/useSessionContext', 'export const useSessionContext = () => ({ context: null });'],
  ['streaming/useFollow', `import { useMemo } from 'react';
    export function useFollow(ref) { return useMemo(() => ({ stick: true, pressure: { speedCps: 0, speedAt: 0, scale: 1 }, snapToBottom() {}, release() {}, reset() {}, follow() {}, setPort(node) { ref.current = node; } }), [ref]); }
  `],
  ['streaming/pressure', `import { createContext } from 'react';
    export const SmoothStreamContext = createContext(null);
    export const useStreamPressure = () => null;
    export const createPressure = () => ({ speedCps: 0, speedAt: 0, scale: 1 });
  `],
  ['hooks/useContainedWheel', "import { useRef } from 'react'; export const useContainedWheel = () => useRef(null);"],
  ['components/PermissionSelector', "export const PermissionSelector = () => null; export const loadPermission = () => 'auto-edit'; export const hasStoredPermission = () => false;"],
])
for (const name of ['RuntimePanel', 'SessionView', 'AgentPresetSelector', 'SessionPresetLabel', 'OpenInApp',
  'StatsBar', 'ComposerModelMenu', 'ComposerEffortControl', 'PlanReviewPanel', 'ApprovalDialog',
  'ConfirmDialog', 'ContextRing', 'TodoPanel', 'GoalBar', 'ConversationAxis']) {
  stubs.set(`components/${name}`, `export const ${name} = () => null;`)
}
const result = await build({
  absWorkingDir: web,
  stdin: { contents: 'export { default as SessionsPage } from "./pages/SessionsPage"; export * as editorApi from "./pages/editor"; export { t, setLocale } from "./i18n";',
    resolveDir: src, sourcefile: 'prompt-optimizer-entry.tsx', loader: 'tsx' },
  bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node20', jsx: 'automatic',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' }, logLevel: 'silent', metafile: true,
  plugins: [{ name: 'prompt-optimizer-stubs', setup(plugin) {
    plugin.onResolve({ filter: /^\./ }, args => {
      const resolved = join(args.resolveDir, args.path).replace(/\\/g, '/').replace(/\.(tsx?|jsx?)$/, '')
      const prefix = src.replace(/\\/g, '/') + '/'
      const key = resolved.startsWith(prefix) ? resolved.slice(prefix.length) : ''
      return stubs.has(key) ? { path: key, namespace: 'optimizer-stub' } : undefined
    })
    plugin.onLoad({ filter: /.*/, namespace: 'optimizer-stub' }, args => ({ contents: stubs.get(args.path), loader: 'tsx', resolveDir: src }))
  } }],
})
const inputs = new Set(Object.keys(result.metafile.inputs)
  .filter(path => !path.startsWith('optimizer-stub:') && path !== '<stdin>')
  .map(path => resolve(web, path).replace(/\\/g, '/')))
const realInput = path => inputs.has(join(src, path).replace(/\\/g, '/'))
for (const path of ['api.ts', 'appStore.ts', 'sessionStreams.ts', 'composerMemory.ts']) {
  assert.ok(!realInput(path), `Real ${path} must not be bundled`)
}
for (const path of ['pages/SessionsPage.tsx', 'pages/editor.ts', 'features/conversation/useComposerSlash.ts',
  'features/conversation/usePromptOptimize.ts', 'promptOptimizer.ts']) {
  assert.ok(realInput(path), `Must retain real ${path}`)
}

const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/', pretendToBeVisual: true })
const g = dom.window
const previousGlobals = new Map()
function install(name, value) {
  previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}
for (const name of ['window', 'document', 'navigator', 'location', 'history', 'HTMLElement', 'HTMLInputElement',
  'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage', 'File', 'FileReader', 'Blob']) install(name, g[name])
install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
install('IS_REACT_ACT_ENVIRONMENT', true)
g.HTMLElement.prototype.scrollIntoView = function () {}
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']) {
  const blocked = (...args) => { bridge.networkAttempts.push({ name, args }); throw new Error(`External transport forbidden: ${name}`) }
  install(name, blocked)
  g[name] = blocked
}
const uncaught = []
g.addEventListener('error', event => { uncaught.push(event.error ?? new Error(event.message)); event.preventDefault() })
const consoleErrors = []
const originalConsoleError = console.error
console.error = (...args) => { consoleErrors.push(args.map(arg => arg?.stack ?? String(arg)).join(' ')) }
const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const filename = join(web, 'node_modules', '.prompt-optimizer-regression.cjs')
const bundled = new Module(filename)
bundled.filename = filename
bundled.paths = Module._nodeModulePaths(join(web, 'node_modules'))
bundled.require = createRequire(filename)
bundled._compile(result.outputFiles[0].text, filename)
const { SessionsPage, editorApi, t, setLocale } = bundled.exports
setLocale('en')
const editor = () => document.querySelector('.prompt-editor')
const button = () => document.querySelector('.composer-opt-btn')
const text = () => editorApi.serializeEditor(editor())
async function setDraft(value) {
  await act(async () => {
    editor().focus()
    editor().textContent = value
    editorApi.selectRange(editor(), value.length, value.length)
    editor().dispatchEvent(new g.Event('input', { bubbles: true }))
  })
  assert.equal(text(), value, 'Input fixture must preserve whitespace before optimization')
}
async function clickButton() {
  assert.ok(button(), 'Real optimization button exists')
  await act(async () => button().click())
}
async function renderPage(activeId) {
  await act(async () => root.render(React.createElement(SessionsPage, {
    activeId, locked: false, hasStarted: Boolean(activeId),
    onSelectProject() {}, onOpenPicker() {}, onAddProject() {},
  })))
  assert.ok(editor(), 'Real SessionsPage mounts')
}
function chatPayload(request) {
  assert.ok(request, 'Optimization must call chatCompletion')
  const { options, signal } = request
  assert.equal(options.provider, 'mock-provider', 'Uses the current provider')
  assert.equal(options.model, 'mock-model', 'Uses the current model')
  assert.ok(typeof options.system === 'string' && options.system.trim().length > 0, 'System prompt is non-empty')
  assert.ok(Array.isArray(options.messages), 'Sends a messages array')
  assert.equal(options.messages.length, 1, 'Sends exactly one user message')
  assert.equal(options.messages[0].role, 'user')
  assert.ok(signal instanceof AbortSignal, 'Forwards an AbortSignal')
  assert.equal(signal.aborted, false, 'Request is live while pending')
  return JSON.parse(options.messages[0].content)
}
async function begin(original, expectHistory) {
  await setDraft(original)
  assert.equal(button().disabled, false, 'Optimization is enabled for a non-empty draft with an available target')
  const pagesBefore = bridge.pageCalls.length
  const chatsBefore = bridge.chatCalls.length
  await clickButton()
  if (expectHistory) {
    assert.equal(bridge.pageCalls.length, pagesBefore + 1, 'Reads the session log exactly once')
  } else {
    assert.equal(bridge.pageCalls.length, pagesBefore, 'Draft optimization must not read session history')
  }
  assert.equal(bridge.chatCalls.length, chatsBefore + 1, 'Real page calls chatCompletion once')
  const request = bridge.chatCalls.at(-1)
  assert.equal(text(), original, 'Pending optimization leaves the draft intact')
  assert.equal(button().disabled, true, 'Optimization is disabled while pending')
  assert.equal(button().classList.contains('busy'), true, 'Button exposes busy state')
  return request
}
async function resolveChat(request, value) {
  await act(async () => request.resolve(value))
}
function assertIdle() {
  assert.equal(button().classList.contains('undo'), false, 'Undo state disappears')
  assert.equal(button().classList.contains('busy'), false, 'Busy state disappears')
  assert.equal(button().getAttribute('aria-label'), t('optimizePrompt'), 'Button returns to optimize action')
  assert.equal(button().disabled, false)
}
const history = []
for (let turn = 1; turn <= 7; turn++) {
  history.push(
    { seq: history.length + 1, time: turn, type: 'turn-start', turn },
    { seq: history.length + 2, time: turn, type: 'user-message', text: `ROUND_${turn}_USER`, injected: false },
    { seq: history.length + 3, time: turn, type: 'step-start', turn, step: 1 },
    { seq: history.length + 4, time: turn, type: 'system-prompt', turn, step: 1, text: `SYSTEM_ONLY_${turn}` },
    { seq: history.length + 5, time: turn, type: 'tool-call', turn, step: 1, call_id: `call-${turn}`, name: 'read_file', arguments: `ARGUMENTS_${turn}` },
    { seq: history.length + 6, time: turn, type: 'tool-result', turn, step: 1, call_id: `call-${turn}`, content: `TOOL_RESULT_${turn}`, is_error: false },
    { seq: history.length + 7, time: turn, type: 'assistant-message', turn, step: 1, blocks: [
      { type: 'reasoning', text: `REASONING_${turn}` },
      { type: 'tool-call', id: `call-${turn}`, name: 'read_file', arguments: '{}' },
      { type: 'text', text: `ROUND_${turn}_ANSWER_A` },
      { type: 'text', text: `ROUND_${turn}_ANSWER_B` },
    ] },
    { seq: history.length + 8, time: turn, type: 'turn-end', turn, reason: 'stop' },
  )
}
const recentContext = [3, 4, 5, 6, 7].map(turn =>
  `用户：ROUND_${turn}_USER\n助手：ROUND_${turn}_ANSWER_A\nROUND_${turn}_ANSWER_B`,
).join('\n\n')
let root
try {
  root = createRoot(document.getElementById('root'))
  await renderPage(null)
  assert.equal(button().disabled, true, 'Empty draft disables optimization')
  await setDraft(' \n\t ')
  assert.equal(button().disabled, true, 'Whitespace-only draft disables optimization')
  assert.equal(bridge.pageCalls.length, 0, 'Blank draft never reads history')

  const firstDraft = '  第一份需求\n\n保留首尾空格和换行。\n  '
  const first = await begin(firstDraft, false)
  assert.deepEqual(chatPayload(first), { draft: firstDraft }, 'No session means no recentContext key')
  assert.equal(bridge.ensureSessionCalls.length, 0, 'Optimizing a first draft must not create a session')
  const firstOptimized = '优化后的首条草稿\n第二行'
  await resolveChat(first, '```text\n优化后的提示词：' + firstOptimized + '\n```')
  assert.equal(text(), firstOptimized, 'Success fills the real editor')
  assert.equal(button().classList.contains('undo'), true, 'Success offers undo')
  assert.deepEqual(bridge.notifications.at(-1), ['ok', t('optimizeDone')])
  const chatCount = bridge.chatCalls.length
  await clickButton()
  assert.equal(text(), firstDraft, 'Undo restores project draft character for character')
  assert.equal(bridge.chatCalls.length, chatCount, 'Undo never invokes the model')
  assertIdle()

  const projectADraft = '  项目 A 的草稿  \n'
  const projectARequest = await begin(projectADraft, false)
  assert.deepEqual(chatPayload(projectARequest), { draft: projectADraft })
  bridge.activeProject = 1
  await renderPage(null)
  const projectBDraft = '\n 项目 B 草稿 \n'
  await setDraft(projectBDraft)
  const noticeCount = bridge.notifications.length
  await resolveChat(projectARequest, '项目 A 的迟到优化结果')
  assert.equal(text(), projectBDraft, 'Late result from project A does not touch project B draft')
  assert.equal(button().classList.contains('undo'), false, 'Late result does not arm undo in project B')
  assert.equal(bridge.notifications.length, noticeCount, 'Late result does not report success in project B')
  const projectBRequest = await begin(projectBDraft, false)
  assert.deepEqual(chatPayload(projectBRequest), { draft: projectBDraft })
  await resolveChat(projectBRequest, '项目 B 优化结果')
  assert.equal(text(), '项目 B 优化结果')
  await clickButton()
  assert.equal(text(), projectBDraft, 'Project B undo restores its own exact draft')
  assertIdle()

  bridge.activeProject = 0
  bridge.history = history
  bridge.running = true
  await renderPage(session.id)
  await setDraft('运行中的会话')
  assert.equal(button().disabled, true, 'Running session keeps optimization disabled')
  bridge.running = false
  await renderPage(session.id)
  const sessionDraft = '```ts\nconst basedOnHistory = false\n```'
  const sessionOptimized = '```ts\nconst basedOnHistory = true\n```'
  const sessionRequest = await begin(sessionDraft, true)
  assert.equal(bridge.pageCalls.at(-1).id, session.id, 'Reads the active session log')
  assert.deepEqual(chatPayload(sessionRequest), { draft: sessionDraft, recentContext }, 'Sends only the last five rounds of user/assistant text, never tool or system events')
  await resolveChat(sessionRequest, sessionOptimized)
  assert.equal(text(), sessionOptimized, 'Meaningful code fence is preserved, not stripped as a display wrapper')
  await clickButton()
  assert.equal(text(), sessionDraft, 'Session undo restores the original text exactly')
  assertIdle()

  const failureDraft = '  失败时不要改变我\n\n 最后一行  \n'
  const failureRequest = await begin(failureDraft, true)
  await act(async () => failureRequest.reject(new Error('MOCK_OPTIMIZE_FAILURE')))
  assert.equal(text(), failureDraft, 'Failure leaves the original draft unchanged')
  assertIdle()
  assert.deepEqual(bridge.notifications.at(-1), ['err', 'MOCK_OPTIMIZE_FAILURE'])

  bridge.pageError = 'MOCK_HISTORY_FAILURE'
  const degradedDraft = '历史读取失败也要能优化'
  const degraded = await begin(degradedDraft, true)
  assert.deepEqual(chatPayload(degraded), { draft: degradedDraft }, 'History read failure degrades to no context')
  await resolveChat(degraded, '无历史优化结果')
  assert.equal(text(), '无历史优化结果')
  await clickButton()
  assert.equal(text(), degradedDraft, 'Degraded success still supports exact undo')
  assertIdle()
  bridge.pageError = null

  bridge.pageWait = true
  const canceledDraft = '取消时不要调用模型'
  await setDraft(canceledDraft)
  const pagesBeforeCancel = bridge.pageCalls.length
  const chatsBeforeCancel = bridge.chatCalls.length
  await clickButton()
  assert.equal(bridge.pageCalls.length, pagesBeforeCancel + 1, 'Cancellation fixture starts with a history read')
  assert.equal(bridge.chatCalls.length, chatsBeforeCancel, 'Model waits for history')
  const pendingPage = bridge.pageCalls.at(-1)
  assert.equal(button().classList.contains('busy'), true)
  await renderPage(second.id)
  assert.equal(pendingPage.signal.aborted, true, 'Switching session aborts the in-flight history read')
  assert.equal(bridge.chatCalls.length, chatsBeforeCancel, 'Canceled optimization never calls the model')
  assert.equal(button().classList.contains('busy'), false, 'Canceled optimization leaves the button idle')

  assert.equal(bridge.ensureSessionCalls.length, 0, 'Optimization never creates a session')
  assert.deepEqual(bridge.networkAttempts, [], 'No real API or network transport used')
  assert.deepEqual(uncaught, [], 'No uncaught DOM errors')
  assert.deepEqual(consoleErrors, [], 'No React/runtime errors')
  console.log('PASS prompt optimizer: project draft optimizes without session/history; session context is last 5 human rounds; success/undo/failure/degrade/cancel and late results are isolated; no real network')
} finally {
  if (root) await act(async () => root.unmount())
  console.error = originalConsoleError
  dom.window.close()
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  delete globalThis[bridgeKey]
}
