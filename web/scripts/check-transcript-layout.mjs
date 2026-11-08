import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(webRoot, 'node_modules', '.shots', 'transcript-layout.mjs')
mkdirSync(dirname(output), { recursive: true })
await build({ stdin: { contents: `
export { Transcript } from './components/transcript'
export { ViewportRow } from './components/ViewportRow'
export { foldEvents, applyEnvelope } from './fold'
export {
  normalizeConversationFoldMode,
  setConversationFoldMode,
} from './features/conversation/foldMode'
`, resolveDir: join(webRoot, 'src'), loader: 'tsx' }, outfile: output,
  bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'], logLevel: 'silent' })
const dom = new JSDOM('<!doctype html><div class="conversation-scroll"><div class="transcript-pane" id="root"></div></div>', {
  url: 'http://localhost', pretendToBeVisual: true,
})
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver',
  'localStorage', 'navigator', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = function () {}
let measuredHeight = 24
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  const height = this.classList.contains('transcript-viewport-row')
    ? this.style.height ? Number.parseFloat(this.style.height) : measuredHeight
    : 0
  return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: height, width: 800, height }
}
const intersectionObservers = []
class MockIntersectionObserver {
  targets = new Set()
  constructor(callback) { this.callback = callback; intersectionObservers.push(this) }
  observe(target) { this.targets.add(target) }
  unobserve(target) { this.targets.delete(target) }
  disconnect() { this.targets.clear() }
  emit(visibleTargets) {
    this.callback([...this.targets].map(target => ({ target, isIntersecting: visibleTargets.has(target) })))
  }
}
const resizeObservers = []
class MockResizeObserver {
  targets = new Set()
  constructor(callback) { this.callback = callback; resizeObservers.push(this) }
  observe(target) { this.targets.add(target) }
  disconnect() { this.targets.clear() }
  emit() { this.callback([...this.targets].map(target => ({ target }))) }
}
globalThis.IntersectionObserver = MockIntersectionObserver
globalThis.ResizeObserver = MockResizeObserver
const {
  Transcript, ViewportRow, foldEvents, applyEnvelope,
  normalizeConversationFoldMode, setConversationFoldMode,
} = await import(pathToFileURL(output).href)
const container = document.getElementById('root')
const root = createRoot(container)
// 既有行级断言针对详细模式；三种模式的差异在末尾单独覆盖。
await act(async () => setConversationFoldMode('detailed'))
const element = React.createElement
const marker = { kind: 'turn-start', turn: 1, time: Date.now() }
const end = { kind: 'turn-end', turn: 1, time: marker.time + 1000, reason: { kind: 'completed' } }
const tool = (callId, name = 'grep') => ({ kind: 'tool', callId, name, args: JSON.stringify({ pattern: callId }),
  result: { content: 'ok', isError: false } })
const assistant = (step, blocks = [], extra = {}) => ({ kind: 'assistant', turn: 1, step,
  streaming: false, interrupted: false, blocks, ...extra })
const toolBlock = { kind: 'tool-call', text: '', id: 'call', name: 'grep', args: '{}' }
const rows = () => [...container.querySelectorAll(':scope > .transcript-viewport-row')]
const render = async (nodes, props = {}) => {
  await act(async () => root.render(element(Transcript, { nodes, ...props })))
}
async function check(label, run) {
  await act(async () => root.render(null))
  measuredHeight = 24
  await run()
  console.log(`ok   ${label}`)
}

await check('tool-only, empty and whitespace assistant messages never create flex items', async () => {
  for (const streaming of [false, true]) {
    for (const blocks of [[], [toolBlock], [{ kind: 'text', text: '' }],
      [{ kind: 'text', text: ' \n\t' }], [{ kind: 'reasoning', text: '' }],
      [{ kind: 'reasoning', text: ' \n' }]]) {
      await render([marker, tool('first'), assistant(1, blocks, { streaming }), tool('last')])
      assert.equal(rows().length, 2)
      assert.ok(rows().every(row => row.querySelector('.tool-row')))
    }
  }
})
await check('cold replay and incremental tool events have identical visible rows', async () => {
  const events = [
    { seq: 1, time: marker.time, type: 'turn-start', turn: 1 },
    { seq: 2, time: marker.time + 1, type: 'assistant-chunk', turn: 1, step: 1,
      chunk: { type: 'block-start', index: 0, block_type: 'tool-call' } },
    { seq: 3, time: marker.time + 2, type: 'assistant-message', turn: 1, step: 1,
      blocks: [{ type: 'tool-call', id: 'call', name: 'grep', arguments: '{}' }] },
    { seq: 4, time: marker.time + 3, type: 'tool-call', turn: 1, step: 1,
      call_id: 'call', name: 'grep', arguments: '{}' },
  ]
  let live = []
  for (const event of events) {
    live = applyEnvelope(live, event)
    await render(live)
    assert.equal(rows().length, event.type === 'tool-call' ? 1 : 0)
  }
  await render(foldEvents(events))
  assert.equal(rows().length, 1)
  assert.ok(rows()[0].querySelector('.tool-row'))
})
await check('visible text, reasoning and interruption markers remain available', async () => {
  for (const node of [assistant(1, [{ kind: 'text', text: 'answer' }]),
    assistant(1, [{ kind: 'reasoning', text: 'thinking' }]),
    assistant(1, [{ kind: 'reasoning', text: 'thinking' }], { streaming: true }),
    assistant(1, [], { interrupted: true })]) {
    await render([marker, node])
    assert.equal(rows().length, 1)
    assert.ok(rows()[0].querySelector('.msg-assistant'))
  }
  await render([marker, assistant(1, [{ kind: 'text', text: '' },
    { kind: 'text', text: 'answer' }, { kind: 'reasoning', text: ' ' }])])
  assert.equal(container.querySelector('.msg-assistant').childElementCount, 1)
})
await check('final actions render only when a real copy or branch button exists', async () => {
  const blank = assistant(1, [toolBlock], { seq: 50 })
  await render([marker, blank, end])
  assert.equal(container.querySelector('.msg-assistant'), null)
  let forked
  await render([marker, blank, end], { onFork: seq => { forked = seq } })
  const branch = container.querySelector('.branch')
  assert.ok(branch)
  await act(async () => branch.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  assert.equal(forked, 50)
  await render([marker, assistant(1, [], { seq: undefined }), end], { onFork() {} })
  assert.equal(container.querySelector('.message-actions'), null)
  await render([marker, assistant(1, [{ kind: 'text', text: 'answer' }]), end])
  assert.equal(container.querySelectorAll('.message-actions button').length, 1)
})
await check('eager rendering counts visible rows rather than hidden assistant nodes', async () => {
  const hidden = Array.from({ length: 40 }, (_, index) => assistant(index + 1, [toolBlock]))
  await render([marker, tool('first'), ...hidden, tool('last')])
  assert.equal(rows().length, 2)
  assert.equal(container.querySelectorAll('.tool-row').length, 2)
})
await check('row insertion, removal and streaming settle preserve existing row identity', async () => {
  const first = tool('first', 'write_file')
  const last = tool('last', 'edit')
  await render([marker, first, last])
  const lastRow = rows()[1]
  await act(async () => lastRow.querySelector('button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  assert.ok(lastRow.querySelector('.disc-body'))
  const text = assistant(1, [{ kind: 'text', text: 'answer' }], { streaming: true })
  await render([marker, text, first, last])
  assert.equal(rows()[2], lastRow)
  assert.ok(lastRow.querySelector('.disc-body'))
  const textRow = rows()[0]
  await render([marker, { ...text, streaming: false, seq: 30 }, first, last])
  assert.equal(rows()[0], textRow)
  assert.equal(rows()[2], lastRow)
  await render([marker, first, last])
  assert.equal(rows()[1], lastRow)
  assert.ok(lastRow.querySelector('.disc-body'))
})
await check('closing a turn does not transfer row state to later turns', async () => {
  const nextMarker = { kind: 'turn-start', turn: 2, time: marker.time + 2000 }
  const nextTool = tool('next-turn')
  const first = tool('first')
  const blank = assistant(1, [{ kind: 'reasoning', text: ' ' }])
  await render([marker, blank, first, nextMarker, nextTool])
  const nextRow = rows()[1]
  await act(async () => nextRow.querySelector('button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  await render([marker, blank, first, end, nextMarker, nextTool])
  assert.equal(rows().at(-1), nextRow)
  assert.ok(nextRow.querySelector('.disc-body'))
  const overview = container.querySelector('.process-group')
  assert.ok(overview)
  // 没有可见回答的收尾轮次默认展开，避免只剩一行“已工作”。
  assert.equal(overview.querySelectorAll('.tool-row').length, 1)
  await act(async () => overview.querySelector('button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  assert.equal(overview.querySelector('.msg-assistant'), null)
  assert.equal(overview.querySelectorAll('.tool-row').length, 0)
})
await check('measured zero height replaces the initial placeholder estimate', async () => {
  measuredHeight = 0
  await act(async () => root.render(element(ViewportRow, { eager: true }, null)))
  const row = rows()[0]
  await act(async () => intersectionObservers.at(-1).emit(new Set()))
  assert.equal(row.style.height, '0px')
})
await check('resize to zero clears a previously measured nonzero height', async () => {
  measuredHeight = 240
  await act(async () => root.render(element(ViewportRow, { eager: true }, element('div', null, 'content'))))
  const row = rows()[0]
  measuredHeight = 0
  await act(async () => {
    root.render(element(ViewportRow, { eager: true }, null))
    for (const observer of resizeObservers) {
      if (observer.targets.has(row)) observer.emit()
    }
  })
  await act(async () => intersectionObservers.at(-1).emit(new Set()))
  assert.equal(row.style.height, '0px')
})
await check('leaving the viewport measures the latest height before a queued resize', async () => {
  measuredHeight = 240
  await act(async () => root.render(element(ViewportRow, { eager: true }, element('div', null, 'content'))))
  const row = rows()[0]
  measuredHeight = 0
  await act(async () => root.render(element(ViewportRow, { eager: true }, null)))
  await act(async () => intersectionObservers.at(-1).emit(new Set()))
  assert.equal(row.style.height, '0px')
})
await check('unmeasured rows retain an estimate and measured rows preserve their actual height', async () => {
  measuredHeight = 180
  await act(async () => root.render(element(ViewportRow, null, element('div', null, 'content'))))
  const row = rows()[0]
  assert.equal(row.style.height, '96px')
  await act(async () => intersectionObservers.at(-1).emit(new Set([row])))
  assert.equal(row.style.height, '')
  await act(async () => intersectionObservers.at(-1).emit(new Set()))
  assert.equal(row.style.height, '180px')
  await act(async () => intersectionObservers.at(-1).emit(new Set([row])))
  assert.match(row.textContent, /content/)
})

await check('adjacent same-family tool calls fold into one summary row', async () => {
  await act(async () => setConversationFoldMode('tool-group'))
  await render([
    marker,
    tool('read-1', 'read_file'),
    tool('list-1', 'ls'),
    tool('bash-1', 'bash'),
    tool('bash-2', 'bash'),
    tool('edit-1', 'edit'),
  ])
  const groups = [...container.querySelectorAll('.tool-group')]
  assert.equal(groups.length, 2)
  assert.match(groups[0].querySelector('.disc-head').textContent, /查阅.*1 个文件.*1 个列表/)
  assert.match(groups[1].querySelector('.disc-head').textContent, /终端.*2 条命令/)
  assert.equal(container.querySelectorAll('.disc-body').length, 0)
  await act(async () => groups[1].querySelector('.disc-head').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true })))
  assert.equal(groups[1].querySelectorAll('.disc-body .tool-row').length, 2)
  // 单项不额外套一层组。
  await render([marker, tool('single', 'read_file')])
  assert.equal(container.querySelector('.tool-group'), null)
  assert.equal(container.querySelectorAll('.tool-row').length, 1)
  // 中间夹思考或正文必须断开，不能跨过它们合并。
  await render([
    marker,
    tool('read-a', 'read_file'),
    assistant(1, [{ kind: 'reasoning', text: 'between tools' }]),
    tool('read-b', 'ls'),
  ])
  assert.equal(container.querySelector('.tool-group'), null)
  // 详细模式运行中不聚合。
  await act(async () => setConversationFoldMode('detailed'))
  await render([marker, tool('read-c', 'read_file'), tool('read-d', 'ls')])
  assert.equal(container.querySelector('.tool-group'), null)
  assert.equal(container.querySelectorAll('.tool-row').length, 2)
})

await check('finished reasoning shows elapsed time instead of its text summary', async () => {
  const t0 = marker.time
  const nodes = foldEvents([
    { seq: 90, time: t0, type: 'turn-start', turn: 9 },
    { seq: 91, time: t0 + 1, type: 'step-start', turn: 9, step: 1 },
    { seq: 92, time: t0 + 10, type: 'assistant-chunk', turn: 9, step: 1,
      chunk: { type: 'block-start', index: 0, block_type: 'reasoning' } },
    { seq: 93, time: t0 + 20, type: 'assistant-chunk', turn: 9, step: 1,
      chunk: { type: 'reasoning-delta', index: 0, text: 'private reasoning text' } },
    { seq: 94, time: t0 + 510, type: 'assistant-chunk', turn: 9, step: 1,
      chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'private reasoning text' } } },
    { seq: 95, time: t0 + 600, type: 'assistant-message', turn: 9, step: 1,
      blocks: [{ type: 'reasoning', text: 'private reasoning text' }] },
  ])
  assert.equal(nodes.find(node => node.kind === 'assistant')?.blocks[0]?.durationMs, 500)
  await act(async () => setConversationFoldMode('tool-group'))
  await render(nodes)
  const think = container.querySelector('.disc-row:not(.tool-row)')
  assert.ok(think)
  assert.equal(think.querySelector('.think-content'), null)
  assert.match(think.querySelector('.disc-head').textContent, /思考.*持续了 1 秒/)
  assert.doesNotMatch(think.textContent, /private reasoning text/)
})

await check('finished process label uses the turn duration only', async () => {
  await render([
    marker,
    assistant(1, [{ kind: 'reasoning', text: 'reasoning' }]),
    tool('finished-tool'),
    assistant(2, [{ kind: 'text', text: 'final answer' }]),
    end,
  ])
  const overview = container.querySelector('.process-group')
  assert.ok(overview)
  assert.match(overview.textContent, /已工作 .*秒/)
  assert.doesNotMatch(overview.textContent, /次工具调用|tool calls/)
  assert.equal(overview.querySelectorAll('.tool-row').length, 0)
  assert.match(container.textContent, /final answer/)
})

await check('mode values default to standard and migrate the legacy concise name', async () => {
  assert.equal(normalizeConversationFoldMode(undefined), 'standard')
  assert.equal(normalizeConversationFoldMode('concise'), 'tool-group')
  assert.equal(normalizeConversationFoldMode('tool-group'), 'tool-group')
  assert.equal(normalizeConversationFoldMode('detailed'), 'detailed')
})

await check('standard mode folds a whole running work section behind its live activity', async () => {
  await act(async () => setConversationFoldMode('standard'))
  const liveTool = {
    kind: 'tool', callId: 'live-bash', name: 'bash',
    args: JSON.stringify({ command: 'pnpm build' }),
  }
  await render([
    marker,
    assistant(1, [{ kind: 'reasoning', text: 'first line\nworking on it' }], { streaming: true }),
    liveTool,
  ])
  const group = container.querySelector('.work-process-group')
  assert.ok(group)
  assert.equal(group.querySelector('.work-process-body'), null)
  const head = group.querySelector('.process-head')
  assert.match(head.textContent, /正在运行命令/)
  assert.match(head.textContent, /pnpm build/)
  assert.doesNotMatch(group.textContent, /working on it/)
  await act(async () => head.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  assert.ok(group.querySelector('.work-process-body'))
  assert.equal(group.querySelectorAll('.work-process-body .tool-row').length, 1)

  // 助手正文切断工作段；前一组结束后，后续工具另起一组。
  await render([
    marker,
    assistant(1, [{ kind: 'reasoning', text: 'first stage' }], { streaming: false }),
    assistant(2, [{ kind: 'text', text: 'intermediate answer' }]),
    { ...liveTool, callId: 'next-bash' },
  ])
  assert.equal(container.querySelectorAll('.work-process-group').length, 2)
  const answer = [...container.querySelectorAll('.prose')].find((node) => node.textContent?.includes('intermediate answer'))
  assert.ok(answer)
  assert.equal(answer.closest('.work-process-group'), null)
})

await check('completed turns nest one work group in standard mode and none in detailed', async () => {
  const finished = [
    marker,
    assistant(1, [{ kind: 'reasoning', text: 'reasoning' }]),
    tool('finished-read', 'read_file'),
    tool('finished-list', 'ls'),
    tool('finished-bash', 'bash'),
    assistant(2, [
      { kind: 'reasoning', text: 'final-stage reasoning' },
      { kind: 'text', text: 'final answer' },
    ]),
    end,
  ]
  await act(async () => setConversationFoldMode('standard'))
  await render(finished)
  const overview = container.querySelector('.process-group')
  assert.ok(overview)
  assert.equal(container.querySelector('.work-process-group'), null)
  await act(async () => overview.querySelector('.process-head').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true })))
  const work = container.querySelector('.work-process-group')
  assert.ok(work)
  assert.equal(work.querySelector('.work-process-body'), null)
  assert.match(work.querySelector('.process-head').textContent, /已读取文件.*执行了命令/)
  assert.match(container.textContent, /final answer/)
  // 最终一步同时含推理与正文：推理进入工作步骤组，正文留在组外。
  assert.equal([...container.querySelectorAll('.disc-row:not(.tool-row)')]
    .filter((node) => !node.closest('.work-process-group')).length, 0)
  await act(async () => work.querySelector('.process-head').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true })))
  const finalThink = [...work.querySelectorAll('.disc-row:not(.tool-row)')].at(-1)
  assert.ok(finalThink)
  assert.match(finalThink.querySelector('.disc-head').textContent, /思考.*final-stage reasoning/)
  assert.doesNotMatch(finalThink.querySelector('.disc-head').textContent, /持续了/)
  await act(async () => finalThink.querySelector('.disc-head').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true })))
  assert.match(work.textContent, /final-stage reasoning/)

  await act(async () => setConversationFoldMode('tool-group'))
  await render(finished)
  assert.equal(container.querySelector('.work-process-group'), null)
  assert.ok(container.querySelector('.tool-group'))

  await act(async () => setConversationFoldMode('detailed'))
  await render(finished)
  assert.equal(container.querySelector('.work-process-group'), null)
  assert.equal(container.querySelector('.tool-group'), null)
  assert.equal(container.querySelectorAll('.tool-row').length, 3)
})

await check('tool-group mode keeps live tool and reasoning summaries in place', async () => {
  const reasoning = assistant(1, [{ kind: 'reasoning', text: 'first line\nsecond line' }], { streaming: true })
  await act(async () => setConversationFoldMode('tool-group'))
  await render([marker, reasoning, tool('live-tool')])
  const think = container.querySelector('.disc-row:not(.tool-row)')
  const liveTool = container.querySelector('.tool-row')
  assert.ok(think)
  assert.ok(liveTool)
  assert.equal(think.querySelector('.think-content'), null)
  assert.equal(liveTool.querySelector('.disc-body'), null)
  assert.match(think.textContent, /正在思考|Thinking/)
  assert.match(think.textContent, /second line/)
  await act(async () => think.querySelector('.disc-head').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  assert.ok(think.querySelector('.think-content'), think.outerHTML)
  // 手动展开优先于后续流式帧与完成态的自动折叠。
  await render([marker, { ...reasoning, blocks: [{ kind: 'reasoning', text: 'first line\nsecond line\nthird line' }] }, tool('live-tool')])
  assert.ok(think.querySelector('.think-content'))
  await render([marker, { ...reasoning, streaming: false }, tool('live-tool')])
  assert.ok(think.querySelector('.think-content'))
  await render([marker, reasoning, tool('live-tool'), assistant(2, [{ kind: 'text', text: 'final answer' }]), end])
  assert.ok(container.querySelector('.process-group'))
  assert.match(container.textContent, /final answer/)
  await act(async () => setConversationFoldMode('detailed'))
  await render([marker, assistant(3, [{ kind: 'reasoning', text: 'detail' }], { streaming: true })])
  assert.ok(container.querySelector('.think-content'))
})

await act(async () => root.unmount())
dom.window.close()
console.log('\nALL PASS')
