/**
 * 侧栏置顶货架的运行时验收(jsdom)。
 *
 * 守住 ZCode 式管理的关键行为:
 * - 置顶任务出现在顶部「已置顶」货架,并从项目/未分组列表里消失;
 * - 取消置顶后回到原来的项目;
 * - 置顶项目整块上浮,并从「项目」分区消失;
 * - 项目/置顶任务按「运行中优先 + 最近更新」排序;
 * - 最近更新视图是平铺列表,不显示置顶货架;
 * - 置顶货架首屏 20 条,可展开;
 * - 进行中标记与筛选已从菜单和 DOM 中删除。
 *
 *   node scripts/check-sidebar-pins.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const here = fileURLToPath(new URL('.', import.meta.url))
const srcRoot = join(here, '..', 'src')
const outDir = join(here, '..', 'node_modules', '.shots')
mkdirSync(outDir, { recursive: true })

/* appStore 会把整套网络栈拉进 bundle;这里只用到 bumpCatalogTick,
 * 用空实现替身隔离,测试只关心侧栏自身状态。 */
const stubAppStore = {
  name: 'stub-app-store',
  setup(build) {
    build.onResolve({ filter: /(^|\/)appStore$/ }, () => ({
      path: 'app-store',
      namespace: 'denia-stub',
    }))
    build.onLoad({ filter: /^app-store$/, namespace: 'denia-stub' }, () => ({
      contents: 'export const bumpCatalogTick = () => {}',
      loader: 'js',
    }))
  },
}

const entry = join(outDir, 'sidebar-pins-entry.tsx')
writeFileSync(
  entry,
  `import { SidebarWorkspaces } from ${JSON.stringify(join(srcRoot, 'components', 'sidebar', 'SidebarWorkspaces.tsx').replace(/\\/g, '/'))}
export { SidebarWorkspaces }
`,
)

const bundle = join(outDir, 'sidebar-pins.mjs')
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  plugins: [stubAppStore],
  logLevel: 'silent',
})

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const g = dom.window
for (const key of [
  'window', 'document', 'navigator', 'location', 'history',
  'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent',
  'KeyboardEvent', 'EventTarget', 'MutationObserver', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia',
  'localStorage', 'sessionStorage', 'DOMParser', 'Blob', 'URL', 'CSS',
  'SVGSVGElement', 'ResizeObserver', 'DataTransfer', 'DragEvent', 'PointerEvent',
]) {
  try {
    globalThis[key] = g[key]
  } catch {
    /* 只读全局跳过 */
  }
}

const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { SidebarWorkspaces } = await import(pathToFileURL(bundle).href)
const H = React.createElement
const tick = (ms = 90) => new Promise((resolve) => setTimeout(resolve, ms))

const PINS_KEY = 'denia.sidebar-pins.v1'
const VIEW_KEY = 'denia.sidebar-view.v1'
const storedPins = () => JSON.parse(g.localStorage.getItem(PINS_KEY) ?? '{"workspaces":[],"sessions":[]}')
const seedPins = (workspaces, sessions) => {
  g.localStorage.setItem(PINS_KEY, JSON.stringify({ workspaces, sessions }))
}
const clearStorage = () => g.localStorage.clear()

const now = Date.now()
const sessions = [
  { id: 's1', created_at: now - 5_000, updated_at: now - 5_000, excerpt: 'running session', title: null, cwd: 'D:/ws' },
  { id: 's2', created_at: now - 6_000, updated_at: now - 2_000, excerpt: 'pinned session', title: null, cwd: 'D:/ws' },
  { id: 's3', created_at: now - 7_000, updated_at: now - 1_000, excerpt: 'idle session', title: null, cwd: 'D:/ws' },
  { id: 's4', created_at: now - 8_000, updated_at: now - 4_000, excerpt: 'loose pinned', title: null, cwd: undefined },
  { id: 's5', created_at: now - 9_000, updated_at: now - 3_000, excerpt: 'loose idle', title: null, cwd: undefined },
]
const workspaces = [
  { id: 'w1', path: 'D:/ws', title: 'ws', createdAt: 0, sessionIds: ['s1', 's2', 's3'] },
]

const props = (overrides = {}) => ({
  sessions,
  workspaces,
  activeId: null,
  secondaryId: null,
  runningIds: { s1: true },
  searchOpen: false,
  onSearchOpenChange: () => {},
  expandAllTick: 0,
  onAllExpandedChange: () => {},
  onOpenSession: () => {},
  onNewSession: () => {},
  onDeleteWorkspace: () => {},
  onDeleteSession: () => {},
  onDeleteUngrouped: () => {},
  ...overrides,
})

const mounted = []
function mount(nextProps) {
  const container = g.document.createElement('div')
  g.document.body.appendChild(container)
  const root = createRoot(container)
  root.render(H(SidebarWorkspaces, nextProps))
  mounted.push({ root, container })
  return {
    container,
    rerender: (overrides) => root.render(H(SidebarWorkspaces, props(overrides))),
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

const rows = (container) =>
  [...container.querySelectorAll('.session-row-wrap .excerpt')].map((node) => node.textContent)
const rowOf = (container, text) =>
  [...container.querySelectorAll('.session-row-wrap')].find((row) =>
    row.textContent.includes(text),
  )
const shelfRows = (container) =>
  [...container.querySelectorAll('[data-testid="sidebar-pinned-shelf"] .session-row-wrap .excerpt')]
    .map((node) => node.textContent)
const section = (container, testId) => container.querySelector(`[data-testid="${testId}"]`)
const openMenu = (row) => {
  assert.ok(row, '要打开菜单的会话行不存在')
  row.dispatchEvent(
    new g.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
  )
}
const menuLabels = () =>
  [...g.document.querySelectorAll('.sidebar-context-menu [role="menuitem"]')].map((node) =>
    node.textContent.trim(),
  )
const chooseMenu = (label) => {
  const item = [...g.document.querySelectorAll('.sidebar-context-menu [role="menuitem"]')].find(
    (node) => node.textContent.trim() === label,
  )
  assert.ok(item, `右键菜单里没有「${label}」:${menuLabels().join(' / ')}`)
  item.dispatchEvent(new g.MouseEvent('click', { bubbles: true }))
}

try {
  /* 1) 置顶任务进货架,并从项目/未分组列表过滤;取消置顶回到项目。 */
  clearStorage()
  seedPins([], ['s2', 's4'])
  const view = mount(props())
  await tick()
  assert.deepEqual(rows(view.container), ['pinned session', 'loose pinned', 'running session', 'idle session', 'loose idle'])
  assert.deepEqual(shelfRows(view.container), ['pinned session', 'loose pinned'])
  assert.ok(rowOf(view.container, 'pinned session').closest('[data-testid="sidebar-pinned-shelf"]'))
  assert.ok(!rowOf(view.container, 'pinned session').closest('[data-testid="sidebar-projects"]'))
  assert.ok(rowOf(view.container, 'running session').closest('[data-testid="sidebar-projects"]'))
  assert.ok(section(view.container, 'sidebar-tasks'), '未项目任务进入任务分区')
  assert.ok(!view.container.textContent.includes('进行中任务'), '进行中筛选标签已删除')
  assert.equal(view.container.querySelector('[data-testid="in-progress-mark"]'), null)
  assert.equal(view.container.querySelector('.sidebar-filter-count'), null)

  const pinnedRow = rowOf(view.container, 'pinned session')
  pinnedRow.querySelector('.row-action-btn').dispatchEvent(new g.MouseEvent('click', { bubbles: true }))
  await tick()
  assert.deepEqual(storedPins().sessions, ['s4'], '取消置顶写回账本')
  assert.deepEqual(shelfRows(view.container), ['loose pinned'])
  assert.deepEqual(rows(view.container), ['loose pinned', 'running session', 'idle session', 'pinned session', 'loose idle'])
  assert.ok(rowOf(view.container, 'pinned session').closest('[data-testid="sidebar-projects"]'))

  /* 2) 右键菜单置顶:菜单第一项是置顶,且没有进行中动作。 */
  openMenu(rowOf(view.container, 'idle session'))
  await tick()
  assert.deepEqual(menuLabels(), ['置顶', '重命名会话', '删除'])
  assert.ok(!menuLabels().some((label) => label.includes('进行中')))
  chooseMenu('置顶')
  await tick()
  assert.ok(storedPins().sessions.includes('s3'), '右键置顶写入账本')
  assert.deepEqual(shelfRows(view.container), ['idle session', 'loose pinned'])
  assert.ok(!rowOf(view.container, 'idle session').closest('[data-testid="sidebar-projects"]'))
  view.unmount()

  /* 3) 置顶项目:整块上浮,项目分区里不再出现;取消后回到项目分区。 */
  clearStorage()
  seedPins(['w1'], [])
  const pinnedProject = mount(props())
  await tick()
  assert.ok(section(pinnedProject.container, 'sidebar-pinned-projects'), '置顶项目块存在')
  assert.equal(section(pinnedProject.container, 'sidebar-projects'), null, '置顶项目从项目分区移除')
  assert.ok(
    section(pinnedProject.container, 'sidebar-pinned-projects').textContent.includes('ws'),
  )
  const workspacePin = section(pinnedProject.container, 'sidebar-pinned-projects')
    .querySelector('.ws-group-head-row .row-action-btn')
  workspacePin.dispatchEvent(new g.MouseEvent('click', { bubbles: true }))
  await tick()
  assert.deepEqual(storedPins().workspaces, [], '取消置顶项目写回账本')
  assert.equal(section(pinnedProject.container, 'sidebar-pinned-projects'), null)
  assert.ok(section(pinnedProject.container, 'sidebar-projects'), '项目回到项目分区')
  pinnedProject.unmount()

  /* 4) 最近更新视图:平铺、按更新时间倒序、不显示置顶货架。 */
  clearStorage()
  seedPins([], ['s2', 's4'])
  const timeline = mount(props())
  await tick()
  const timelineTab = [...timeline.container.querySelectorAll('.sidebar-filter-tab')]
    .find((node) => node.textContent.includes('最近更新'))
  assert.ok(timelineTab, '视图切换里有最近更新')
  timelineTab.dispatchEvent(new g.MouseEvent('click', { bubbles: true }))
  await tick()
  assert.equal(g.localStorage.getItem(VIEW_KEY), 'timeline')
  assert.equal(section(timeline.container, 'sidebar-pinned-shelf'), null, '最近更新不渲染置顶货架')
  assert.ok(section(timeline.container, 'sidebar-timeline'), '最近更新平铺列表')
  assert.deepEqual(rows(timeline.container), [
    'idle session',
    'pinned session',
    'loose idle',
    'loose pinned',
    'running session',
  ], '最近更新纯按 updated_at 倒序,不把 running 顶到前面')
  timeline.unmount()

  /* 5) 置顶货架首屏 20 条,可展开。 */
  clearStorage()
  const many = Array.from({ length: 21 }, (_, index) => ({
    id: `m${index}`,
    created_at: now - index * 1_000,
    updated_at: now - index * 1_000,
    excerpt: `many ${index}`,
    title: null,
    cwd: 'D:/many',
  }))
  const manyWorkspace = {
    id: 'w-many',
    path: 'D:/many',
    title: 'many',
    createdAt: 0,
    sessionIds: many.map((session) => session.id),
  }
  seedPins([], many.map((session) => session.id))
  const cap = mount(props({ sessions: many, workspaces: [manyWorkspace], runningIds: {} }))
  await tick()
  assert.equal(shelfRows(cap.container).length, 20, '置顶货架首屏 20 条')
  const more = cap.container.querySelector('[data-testid="sidebar-pinned-shelf"] .expand-rest')
  assert.ok(more, '超过 20 条时提供展开按钮')
  more.dispatchEvent(new g.MouseEvent('click', { bubbles: true }))
  await tick()
  assert.equal(shelfRows(cap.container).length, 21, '展开后显示全部置顶任务')
  cap.unmount()

  console.log('ok sidebar pins: shelf, project block, activity sort, timeline and cap')
} finally {
  for (const { root, container } of mounted) {
    try {
      root.unmount()
      container.remove()
    } catch {
      /* 已卸载 */
    }
  }
  clearStorage()
}