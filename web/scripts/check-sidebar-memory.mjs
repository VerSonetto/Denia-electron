import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'denia-sidebar-memory-'))
try {
  const output = join(dir, 'memory.mjs')
  await build({ entryPoints: [join(root, 'src/sidebarMemory.ts')], outfile: output, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  const store = new Map()
  globalThis.window = {
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => { store.set(key, String(value)) },
      removeItem: (key) => { store.delete(key) },
    },
    location: { hash: '#s=child%201' },
  }
  const {
    readCollapsedChildren, writeCollapsedChildren, restoredSidebarSession,
    readSidebarOrder, writeSidebarOrder,
    readSidebarView, writeSidebarView,
    readSidebarPins, writeSidebarPins,
  } = await import(pathToFileURL(output).href)

  assert.deepEqual(readCollapsedChildren(), {})
  writeCollapsedChildren({ parent: true, expanded: false })
  assert.deepEqual(readCollapsedChildren(), { parent: true }, '刷新后保留收起状态')
  writeCollapsedChildren({})
  assert.deepEqual(readCollapsedChildren(), {}, '全部展开清除收起记忆')
  store.set('denia.sidebar-collapsed-children.v1', '{bad')
  assert.deepEqual(readCollapsedChildren(), {})
  store.set('denia.sidebar-collapsed-children.v1', '[true]')
  assert.deepEqual(readCollapsedChildren(), {})
  store.set('denia.sidebar-collapsed-children.v1', '{"a":true,"b":"true","c":false}')
  assert.deepEqual(readCollapsedChildren(), { a: true })
  assert.equal(restoredSidebarSession(null), 'child 1', '初始化识别待恢复会话，不触发祖先展开')
  assert.equal(restoredSidebarSession('current'), 'current')
  window.location.hash = '#s=%'
  assert.equal(restoredSidebarSession(null), null)

  assert.deepEqual(readSidebarOrder(), { workspaces: [] }, '默认无项目手动顺序')
  writeSidebarOrder({ workspaces: ['w2', 'w1'] })
  assert.deepEqual(readSidebarOrder(), { workspaces: ['w2', 'w1'] }, '项目顺序可往返')
  store.set('denia.sidebar-order.v1', '{bad')
  assert.deepEqual(readSidebarOrder(), { workspaces: [] })
  store.set('denia.sidebar-order.v1', '[true]')
  assert.deepEqual(readSidebarOrder(), { workspaces: [] })
  store.set('denia.sidebar-order.v1', '{"workspaces":["a",1,"","b"],"ungrouped":["x"],"sessions":{"ws":["s"]}}')
  assert.deepEqual(readSidebarOrder(), { workspaces: ['a', 'b'] }, '只保留项目顺序，旧的手动任务顺序字段被忽略')
  assert.equal(store.has('denia.sidebar-in-progress.v1'), false, '侧栏不再写进行中标记')

  assert.equal(readSidebarView(), 'projects', '默认按项目')
  writeSidebarView('timeline')
  assert.equal(readSidebarView(), 'timeline')
  assert.equal(store.get('denia.sidebar-view.v1'), 'timeline')
  writeSidebarView('projects')
  assert.equal(store.has('denia.sidebar-view.v1'), false, '回到默认视图时移除键')
  store.set('denia.sidebar-view.v1', 'weird')
  assert.equal(readSidebarView(), 'projects', '未知视图回落按项目')

  assert.deepEqual(readSidebarPins(), { workspaces: [], sessions: [] }, '默认无置顶')
  writeSidebarPins({ workspaces: ['w2', 'w1'], sessions: ['s1'] })
  assert.deepEqual(readSidebarPins(), { workspaces: ['w2', 'w1'], sessions: ['s1'] }, '置顶账本可往返')
  store.set('denia.sidebar-pins.v1', '{bad')
  assert.deepEqual(readSidebarPins(), { workspaces: [], sessions: [] })
  store.set('denia.sidebar-pins.v1', '{"workspaces":["w",1,""],"sessions":"x"}')
  assert.deepEqual(readSidebarPins(), { workspaces: ['w'], sessions: [] }, '非法置顶项丢弃')

  window.localStorage.getItem = () => { throw new Error('blocked') }
  window.localStorage.setItem = () => { throw new Error('quota') }
  window.localStorage.removeItem = () => { throw new Error('blocked') }
  assert.deepEqual(readCollapsedChildren(), {})
  assert.deepEqual(readSidebarOrder(), { workspaces: [] })
  assert.equal(readSidebarView(), 'projects')
  assert.deepEqual(readSidebarPins(), { workspaces: [], sessions: [] })
  assert.doesNotThrow(() => writeCollapsedChildren({ parent: true }))
  assert.doesNotThrow(() => writeSidebarOrder({ workspaces: ['w'] }))
  assert.doesNotThrow(() => writeSidebarView('timeline'))
  assert.doesNotThrow(() => writeSidebarPins({ workspaces: ['w'], sessions: ['s'] }))

  // 侧栏工作区树已整体抽到 components/sidebar;以下断言跟随迁移落在新文件。
  const app = readFileSync(join(root, 'src/components/sidebar/SidebarWorkspaces.tsx'), 'utf8')
  assert.ok(app.includes('useState(readCollapsedChildren)'))
  assert.ok(app.includes('activeId === revealedSessionRef.current'), '同会话推送不覆盖折叠状态')
  assert.ok(app.includes('collectPinnedSubtrees'), '置顶任务连同分支搬进货架')
  assert.ok(app.includes('collectSubtreeIds'), '置顶货架分页按根节点收集子树')
  assert.ok(app.includes('sortSessions'), '任务按活跃度/更新时间排序')
  assert.ok(app.includes('sidebarViewProjects'), '视图切换提供按项目')
  assert.ok(app.includes('sidebarViewTimeline'), '视图切换提供最近更新')
  assert.ok(app.includes('readSidebarView'), '视图偏好跨重启恢复')
  assert.ok(app.includes('writeSidebarView'), '视图偏好持久化')
  assert.ok(app.includes('pinnedTasksSection'), '顶部提供已置顶货架')
  assert.ok(app.includes('data-testid="sidebar-pinned-shelf"'))
  assert.ok(app.includes('data-testid="sidebar-projects"'))
  assert.ok(app.includes('data-testid="sidebar-tasks"'))
  assert.ok(app.includes('beginWorkspaceDrag'), '项目支持拖动排序')
  assert.ok(app.includes('togglePinned'), '项目与会话支持置顶')
  assert.ok(app.includes('openSessionMenu'), '会话支持自定义右键菜单')
  assert.ok(app.includes('openWorkspaceMenu'), '项目支持自定义右键菜单')
  assert.ok(app.includes("t('confirmDeleteInline')"), '删除改为行内二次确认')
  assert.ok(!app.includes('inProgress'), '进行中标记机制已删除')
  assert.ok(!app.includes('sidebarFilterRunning'), '进行中筛选已删除')
  assert.ok(!app.includes('beginSessionDrag'), '任务不再手动拖动排序')
  const row = readFileSync(join(root, 'src/components/sidebar/SessionRow.tsx'), 'utf8')
  assert.ok(row.includes('data-testid="pin-mark"'), '置顶有稳定的测试锚点')
  assert.ok(row.includes('sessionUpdatedAt'), '行尾时间改用最近更新时间')
  assert.ok(!row.includes('in-progress-mark'), '会话行不再渲染进行中标记')
  assert.ok(!row.includes('marked'), '会话行不再接收手动进行中标记')
  const main = readFileSync(join(root, 'src/main.tsx'), 'utf8')
  assert.ok(main.includes("addEventListener('contextmenu'"), '全局禁用浏览器默认右键菜单')
  console.log('ok sidebar collapse, project order, view and pin storage')
} finally { rmSync(dir, { recursive: true, force: true }) }