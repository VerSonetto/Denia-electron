import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { setLocale, t } from './i18n'
import { subscribeServerEvents, subscribeServerStatus } from './serverEvents'
import SessionsPage from './pages/SessionsPage'
import { DeniaWordmark } from './components/DeniaWordmark'
import { UpdateBadge } from './components/updates/UpdateBadge'
import { ensureStartupUpdateCheck, useUpdateDialogOpen } from './updateStore'
import { loadComposer } from './composerMemory'
import { extensionTabFromHash, type ExtensionTab } from './extensionsRoute'
import { settingsHash, settingsTabFromHash, type SettingsTab } from './settingsRoute'
import * as api from './api'
import {
  addSessionLocal,
  bumpCatalogTick,
  deleteSessionAction,
  deleteProjectAction,
  findProjectBlank,
  getActiveProject,
  markLocalBlank,
  notify,
  refreshList,
  setActiveId,
  setConnLost,
  setPendingProjectId,
  replaceRunningIds,
  setRunningStatus,
  clearCompacting,
  useActiveId,
  useConnLost,
  useLocalBlankIds,
  useRunningIds,
  useSessions,
  useSessionsLoaded,
  useStartedIds,
  useToast,
  useProjects,
} from './appStore'
import { useBrowserSidebar } from './hooks/useBrowserSidebar'
import { useIsMobile } from './hooks/useIsMobile'
import { useSidePaneController, useTerminalReconcile } from './hooks/useSidePane'
import { startQueueScheduler } from './features/conversation/queueScheduler'
import { prefetchModelMeta } from './modelMeta'
import {
  normalizeQueueDefaultAction,
  setQueueDefaultAction,
} from './features/conversation/queueDefaults'
import {
  normalizeConversationFoldMode,
  setConversationFoldMode,
} from './features/conversation/foldMode'
import { useSidebarCollapse } from './hooks/useSidebarCollapse'
import { useSplitView } from './hooks/useSplitView'
import { registerOpenFile } from './fileOpen'
import { registerOpenReview, type OpenReviewOptions } from './reviewOpen'
import { setTurnChanges } from './turnChangesStore'
import { closeTab, scopeKey, upsertTab } from './sidePane'
import { SidePane } from './components/SidePane'
import { TerminalHost } from './components/TerminalHost'
import { closeTerminal } from './terminalApi'
import { dropScope, peekSidePane, setSidePaneCollapsed, updateSidePane } from './sidePaneStore'
import { useModelSelection } from './modelSelectionStore'
import type { SidePaneTab } from './sidePane'
import {
  SPLIT_MAX_RATIO,
  SPLIT_MIN_RATIO,
  openSessionInView,
  type PaneSlot,
  type SplitSide,
} from './splitView'
import {
  IconClose,
  IconCollapseAll,
  IconExpandAll,
  IconFolderPlus,
  IconGear,
  IconMenu,
  IconPanelClose,
  IconPanelOpen,
  IconNewSession,
  IconExtensions,
  IconSessionSearch,
} from './components/icons'
import { ProjectDialog } from './components/ProjectDialog'
import { ConfirmDialog } from './components/ConfirmDialog'
import { SidebarProjects } from './components/sidebar/SidebarProjects'
import { DesktopTitleBar } from './components/DesktopTitleBar'

// 设置/浏览器面板按需加载,减少首屏主包体积。
const LazySettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((module) => ({ default: module.SettingsPage })),
)
const LazyBrowserPanel = lazy(() => import('./components/BrowserPanel'))
const LazyExtensionsPage = lazy(() => import('./pages/ExtensionsPage'))
const LazyVersionPage = lazy(() => import('./pages/VersionPage'))
const LazyUpdateDialog = lazy(() => import('./components/updates/UpdateDialog').then((module) => ({ default: module.UpdateDialog })))
import type { ProjectRecord, SessionSummary } from './types'

/** 轨道图标入场的错峰序号:shell.css 用它算 transition-delay。 */
const railIndex = (index: number) => ({ '--rail-index': index } as CSSProperties)

/**
 * 应用外壳:布局 + 全局事件订阅(SSE 推送)+ URL 导航 + 启动引导。
 * 业务状态与动作全部在 `appStore`,本组件只做编排,不持有会话数据。
 */
export type Notify = (kind: 'ok' | 'err', message: string) => void

export default function App() {
  const sessions = useSessions()
  const projects = useProjects()
  const activeId = useActiveId()
  const startedIds = useStartedIds()
  const localBlankIds = useLocalBlankIds()
  const sessionsLoaded = useSessionsLoaded()
  const connLost = useConnLost()
  const toast = useToast()

  // running 集合:服务端 SSE 推送驱动(侧栏圆点与状态栏同源)。
  const runningIds = useRunningIds()

  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(() => settingsTabFromHash(window.location.hash))
  const [versionOpen, setVersionOpen] = useState(() => window.location.hash === '#version')
  // 从设置里点进版本页时记住来源分类:版本页的"返回"回到设置,而不是
  // 直接掉回会话。从更新弹窗打开时没有来源,自然回不到设置。
  const [versionReturnTab, setVersionReturnTab] = useState<SettingsTab | null>(null)
  const [extensionTab, setExtensionTab] = useState<ExtensionTab | null>(() => extensionTabFromHash(window.location.hash))
  const updateDialogOpen = useUpdateDialogOpen()
  const openVersion = useCallback(() => {
    setVersionReturnTab(settingsTab)
    setSettingsTab(null)
    setExtensionTab(null)
    setVersionOpen(true)
    window.location.hash = 'version'
  }, [settingsTab])
  const closeVersion = useCallback(() => {
    setVersionOpen(false)
    setSettingsTab(versionReturnTab)
    setVersionReturnTab(null)
  }, [versionReturnTab])
  const openSettings = useCallback((tab: SettingsTab = 'general') => {
    setVersionOpen(false)
    setExtensionTab(null)
    setSettingsTab(tab)
    window.location.hash = settingsHash(tab)
  }, [])
  const changeSettingsTab = useCallback((tab: SettingsTab) => {
    setSettingsTab(tab)
    window.location.hash = settingsHash(tab)
  }, [])
  const closeSettings = useCallback(() => setSettingsTab(null), [])
  const openExtensions = useCallback((tab: ExtensionTab = 'skills') => {
    setVersionOpen(false)
    setSettingsTab(null)
    setExtensionTab(tab)
    window.location.hash = `extensions/${tab}`
  }, [])
  const leavePageViews = useCallback(() => {
    setVersionOpen(false)
    setSettingsTab(null)
    setExtensionTab(null)
  }, [])
  // 浏览器侧栏编排(会话绑定 / 收尾自动销毁 / 刷新恢复)全部在 hook 内。
  // 面板标签现在统一由 SidePane 承载:可视化请求到达时由下面的回调真正
  // 打开/激活浏览器标签并展开侧栏(此前只记录绑定,所以看不到画面)。
  const visualRequestRef = useRef<(sessionId: string) => void>(() => {})
  const { userClose: dismissBrowserSidebar } = useBrowserSidebar(
    activeId,
    (sessionId) => visualRequestRef.current(sessionId),
  )

  /* ---- 右侧面板(多标签项目) ---- */

  // 面板归属:当前会话的项目路径。会话头 cwd 不可变,所以直接取。
  const activeSessionForPane = activeId
    ? (sessions.find((s) => s.id === activeId) ?? null)
    : null
  // 没有活跃会话(空白态)时退回"待发项目":终端要有起点目录,
  // 而用户在空白页也已经选好了项目。
  const paneProject =
    (activeSessionForPane?.project_id
      ? projects.find((project) => project.id === activeSessionForPane.project_id)
      : undefined) ?? getActiveProject()
  const paneProjectPath = activeSessionForPane?.cwd ?? paneProject?.dirs[0] ?? null
  const paneProjectDirs =
    paneProject?.dirs ??
    (activeSessionForPane?.cwd ? [activeSessionForPane.cwd] : [])
  const pane = useSidePaneController(activeId, paneProjectPath)
  const [planReview, setPlanReview] = useState<{ title?: string; planText: string } | null>(null)

  /**
   * 可视化请求 → 面板动作。
   *
   * - 请求来自当前会话：直接打开/激活浏览器标签并展开面板——这就是
   *   "AI 调用浏览器工具时自动看到画面"的落点；
   * - 请求来自后台会话：只给那个会话的 scope 预开浏览器标签并展开，
   *   不抢当前会话的视图；用户切回去时画面已经在那里。
   * 同一会话重复请求走 upsert/激活路径，不会叠加多个浏览器标签。
   */
  visualRequestRef.current = (sessionId: string) => {
    if (sessionId === activeId) {
      pane.openPanel('browser')
      return
    }
    updateSidePane(sessionId, (current) => {
      const existing = current.tabs.find((tab) => tab.type === 'browser')
      if (existing) {
        return current.activeTabId === existing.id
          ? current
          : { ...current, activeTabId: existing.id }
      }
      return upsertTab(current, {
        id: `browser:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'browser',
        openedAt: Date.now(),
      })
    })
    setSidePaneCollapsed(sessionId, false)
  }

  /** 用户手动收起浏览器：解除 AI 自动展开绑定，并真正收起面板。 */
  const closeBrowserSidebar = useCallback(() => {
    dismissBrowserSidebar()
    pane.setCollapsed(true)
  }, [dismissBrowserSidebar, pane])
  // 对话区当前选择的模型:右侧「审查」面板的 AI 生成提交信息复用它
  // (同一个用户不该为同一件事选两次模型)。
  const modelSelection = useModelSelection()

  // 启动/切会话时对账终端:清掉指向已消失 PTY 的僵尸标签。
  useTerminalReconcile(activeId, true, (liveIds) => {
    const live = new Set(liveIds)
    pane.update((current) => {
      const stale = current.tabs.filter(
        (tab) => tab.type === 'terminal' && !live.has(tab.id),
      )
      if (stale.length === 0) return current
      const staleIds = new Set(stale.map((tab) => tab.id))
      const tabs = current.tabs.filter((tab) => !staleIds.has(tab.id))
      if (tabs.length === 0) return { tabs: [], activeTabId: '' }
      return {
        tabs,
        activeTabId: tabs.some((tab) => tab.id === current.activeTabId)
          ? current.activeTabId
          : (tabs[tabs.length - 1]?.id ?? ''),
      }
    })
  })

  /** 新建一个终端标签。 */
  const openTerminalTab = useCallback(() => {
    pane.openPanel('terminal', { cwd: paneProjectPath ?? undefined })
  }, [pane, paneProjectPath])

  /**
   * 把 `pane.openFile` 注册给模块级入口：Markdown 链接渲染是纯函数
   * （见 `fileOpen.ts` 注释），拿不到 hook，只能走这条注册通道。
   *
   * 依赖里带上 `pane.openFile`（它已按 sessionId/projectPath 记忆），
   * 切会话时会重新注册，指向新的项目。
   */
  useEffect(() => registerOpenFile(pane.openFile), [pane.openFile])

  /**
   * 收尾变更卡片的「查看变更」:打开审查面板,并把本轮改动交给它。
   *
   * 走 `pane.openPanel('review')` 而不是新建标签 —— 审查是单例面板,里面
   * 已经有项目的全部改动与逐文件 diff,本轮文件是它们的子集,再开一个
   * 面板只会让人对不上"哪份是权威"。
   *
   * 本轮文件另存到 `turnChangesStore`(内存态,不进 localStorage):审查
   * 面板据此多出一个**不依赖 git** 的来源。理由是审查面板的其余来源全
   * 走 `git status`/`git diff`,项目不是仓库时它们只有空态 —— 那时
   * 本轮这张卡就是唯一还讲得清"改了什么"的地方,却会因为点开的是空面板
   * 而白做。点文件行进来时额外传 focusPath,面板定位到该文件。
   */
  const openReviewPanel = useCallback(
    (options: OpenReviewOptions = {}) => {
      if (options.files !== undefined && options.files.length > 0) {
        setTurnChanges(scopeKey(activeId), {
          turn: options.turn ?? 0,
          files: options.files,
          at: Date.now(),
        })
      }
      pane.openPanel('review')
      return true
    },
    [pane.openPanel, activeId],
  )
  useEffect(() => registerOpenReview(openReviewPanel), [openReviewPanel])

  /** 终端进程退出:最后一个终端退出时连带收起面板。 */
  const handleTerminalExit = useCallback(
    (tabId: string, _exitCode: number) => {
      // 不自动关标签:用户可能还要看退出前的输出。只在最后一个终端退出
      // 且面板里没有别的标签时收起面板,避免留一个空壳。
      const current = pane.state
      const remaining = current.tabs.filter((tab) => tab.id !== tabId)
      if (remaining.length === 0) {
        // 没有别的标签:收起面板(标签保留,用户可以再展开看到退出画面)。
        pane.setCollapsed(true)
      }
    },
    [pane],
  )

  /** shell 解析出来后回填标签标题。 */
  const handleTerminalTitle = useCallback(
    (tabId: string, title: string) => {
      pane.update((current) => {
        const tab = current.tabs.find((item) => item.id === tabId)
        if (!tab || tab.title === title) return current
        return {
          ...current,
          tabs: current.tabs.map((item) =>
            item.id === tabId ? { ...item, title } : item,
          ),
        }
      })
    },
    [pane],
  )

  /** 关闭一个终端标签:同时关掉服务端 PTY(否则进程泄漏)。 */
  const handleCloseTerminalTab = useCallback((tabs: SidePaneTab[]) => {
    for (const tab of tabs) {
      if (tab.type !== 'terminal') continue
      void closeTerminal(tab.id).catch(() => {
        // 服务端已经没有这个终端(重启过/已被回收):不是错误。
      })
    }
  }, [])

  /**
   * 会话被删除后的面板收尾。
   *
   * 两件事都必须做,否则都会泄漏:
   * - **终端进程**:标签没了但 PTY 还在跑,进程与内存都不回收;
   * - **localStorage 桶**:该 scope 永远不会再被读到,却仍占着分桶上限名额
   *   (`SCOPE_LIMIT`),长期使用会把真正在用的 scope 挤出去。
   */
  const cleanupSessionPane = useCallback((sessionId: string) => {
    const tabs = peekSidePane(sessionId).tabs
    handleCloseTerminalTab(tabs)
    dropScope(sessionId)
  }, [handleCloseTerminalTab])
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false)
  const [sidebarExpandAllTick, setSidebarExpandAllTick] = useState(0)
  const [sidebarAllExpanded, setSidebarAllExpanded] = useState(false)

  /* ---- 侧栏收起(折叠控制栏) ---- */

  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    sidebarMoving,
    expandSidebarWithSearch,
  } = useSidebarCollapse(setSidebarSearchOpen)

  // 宽态与收起态两层常驻:动画由 CSS 交叉过渡驱动,这里只负责把非活动层
  // 真正移出焦点序列(inert)。visibility 已在 CSS 里兜底,但过渡期间两层
  // 都可见,键盘用户不该 Tab 进正在消失的那一层。
  const wideLayerRef = useRef<HTMLDivElement>(null)
  const railLayerRef = useRef<HTMLDivElement>(null)
  const sidebarHandleRef = useRef<HTMLButtonElement>(null)

  /* ---- 手机端侧栏抽屉 ---- */

  // 窄屏下侧栏不是"56px 控制栏",而是**覆盖式抽屉**:默认完全收起,让出
  // 整屏给对话;由顶栏汉堡按钮唤出,点遮罩或选中会话后自动关闭。
  // 这与桌面端的折叠语义不同(桌面端收起后仍留一条控制栏),所以单独用一个
  // 状态,不去复用 sidebarCollapsed —— 否则手机用户的选择会被写进桌面偏好。
  const isMobile = useIsMobile()
  const [drawerOpen, setDrawerOpen] = useState(false)
  // 只在桌面端按收起态切换 active 层;手机抽屉始终显示完整宽态。
  const wideInactive = sidebarCollapsed && !isMobile
  const railInactive = !sidebarCollapsed || isMobile
  useEffect(() => {
    const wide = wideLayerRef.current
    const rail = railLayerRef.current
    const focus = document.activeElement
    const focusFellInWide = wideInactive &&
      focus instanceof HTMLElement &&
      wide?.contains(focus) === true
    if (wide) wide.inert = wideInactive
    if (rail) rail.inert = railInactive
    // 键盘触发收起时,焦点不能留在 invisible 的宽态里。
    if (focusFellInWide) sidebarHandleRef.current?.focus({ preventScroll: true })
  }, [wideInactive, railInactive])
  // 切到桌面尺寸时抽屉状态必须清掉:否则从手机横屏切到平板宽度,抽屉会
  // 以一个"没有遮罩、也不该存在"的浮层留在屏幕上。
  useEffect(() => {
    if (!isMobile) setDrawerOpen(false)
  }, [isMobile])

  // Ctrl+B / Cmd+B 切换侧栏(VSCode 惯例)。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'b'
      ) {
        event.preventDefault()
        setSidebarCollapsed((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // URL 会话状态:挂载时读 hash;列表加载完成后判定恢复或放弃。
  const [pendingHashId] = useState<string | null>(() => {
    const match = window.location.hash.match(/^#s=([^#]+)$/)
    return match ? decodeURIComponent(match[1]) : null
  })
  const [hashSettled, setHashSettled] = useState(false)
  const hashRestoredRef = useRef(false)
  const firstRenderRef = useRef(true)

  // 创建项目弹窗:名称 + 任意数量的目录。
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)

  useEffect(() => {
    ensureStartupUpdateCheck()
  }, [])

  const applyConsoleSettings = useCallback(() => {
    api
      .getSettings()
      .then((data) => {
        const console = data.namespaces.find((ns) => ns.ns === 'console')
        const theme = (console?.value.theme as string) ?? 'system'
        if (theme === 'system') delete document.documentElement.dataset.theme
        else document.documentElement.dataset.theme = theme
        setLocale((console?.value.locale as string) ?? 'zh')
        setQueueDefaultAction(normalizeQueueDefaultAction(console?.value.queueDefaultAction))
        setConversationFoldMode(
          normalizeConversationFoldMode(console?.value.conversationFoldMode),
        )
        bumpCatalogTick()
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    applyConsoleSettings()
  }, [applyConsoleSettings])

  /* ---- 全局 SSE 推送:列表/设置失效通知 ---- */

  const sseOpenedRef = useRef(false)
  const sseWasLostRef = useRef(false)

  useEffect(() => {
    // 全应用共用一条 `/api/events`(见 serverEvents.ts):每条 EventSource
    // 都独占一个同源连接名额,浏览器上限 6 条,多开会让后续 fetch 永久排队。
    const unsubscribe = subscribeServerEvents((type, payload) => {
      const parsed = payload as {
        type?: string
        id?: string
        running?: boolean
        ids?: string[]
      }
      if (type === 'sessions-updated') void refreshList()
      else if (type === 'settings-updated') applyConsoleSettings()
      else if (type === 'running-snapshot' && Array.isArray(parsed.ids)) {
        const ids = parsed.ids.filter((id) => typeof id === 'string')
        replaceRunningIds(ids)
      } else if (type === 'running-changed' && parsed.id) {
        setRunningStatus(parsed.id, parsed.running === true)
      } else if (type === 'compaction-failed' && parsed.id) {
        // 压缩后台任务的失败/无物可压出口:清掉"正在压缩"标记。
        // 成功不走这里 —— 成功有 append-only 的 compaction-summary 事件。
        clearCompacting(parsed.id)
      }
    })
    const unsubscribeStatus = subscribeServerStatus((up) => {
      if (up) {
        setConnLost(false)
        // 仅首次连接与断线重连后重拉列表,避免 onopen 抖动造成无限刷新。
        if (!sseOpenedRef.current) {
          sseOpenedRef.current = true
          void refreshList()
        } else if (sseWasLostRef.current) {
          sseWasLostRef.current = false
          void refreshList()
        }
      } else {
        sseWasLostRef.current = true
        setConnLost(true)
      }
    })
    return () => {
      unsubscribe()
      unsubscribeStatus()
    }
  }, [applyConsoleSettings])

  // 首屏加载:一次全量列表(SSE onopen 也会触发,幂等)。
  useEffect(() => {
    void refreshList()
  }, [])

  // 队列自动发送按会话维度常驻调度:切走会话后原会话本轮结束仍会发送。
  // 放在 App 层而不是会话页:页面卸载不影响调度器，且全局只有一套 running
  // 订阅，不会为后台会话额外建 SSE 连接。
  useEffect(() => startQueueScheduler(), [])

  // 应用启动时预取一次公开模型清单,之后自动补全只读内存、不再发请求;
  // 界面刷新(整页重载)时本模块重新执行,自然再拉一次。
  useEffect(() => void prefetchModelMeta(), [])

  /* ---- URL 会话状态 ---- */

  useEffect(() => {
    if (!sessionsLoaded || hashRestoredRef.current) return
    hashRestoredRef.current = true
    if (pendingHashId !== null && sessions.some((s) => s.id === pendingHashId)) {
      setActiveId(pendingHashId)
    }
    setHashSettled(true)
  }, [sessions, sessionsLoaded, pendingHashId])

  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false
      return
    }
    const target = versionOpen
      ? '#version'
      : settingsTab
        ? settingsHash(settingsTab)
        : extensionTab
          ? `#extensions/${extensionTab}`
          : activeId === null
            ? ''
            : `#s=${encodeURIComponent(activeId)}`
    if (window.location.hash !== target) {
      window.history.replaceState(null, '', target || window.location.pathname)
    }
  }, [activeId, extensionTab, settingsTab, versionOpen])

  useEffect(() => {
    const onHashChange = () => {
      const version = window.location.hash === '#version'
      setVersionOpen(version)
      if (version) {
        setSettingsTab(null)
        setExtensionTab(null)
        return
      }
      // 整页视图互斥,hash 只记得住一个:设置优先于拓展,拓展优先于会话。
      const settings = settingsTabFromHash(window.location.hash)
      setSettingsTab(settings)
      if (settings) {
        setExtensionTab(null)
        return
      }
      const tab = extensionTabFromHash(window.location.hash)
      setExtensionTab(tab)
      if (tab) return
      const match = window.location.hash.match(/^#s=([^#]+)$/)
      const id = match ? decodeURIComponent(match[1]) : null
      if (id === null) {
        setActiveId(null)
      } else if (sessions.some((s) => s.id === id)) {
        setActiveId(id)
      }
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [sessions])

  /* ---- 会话/项目派生 ---- */

  const activeSession = activeId
    ? (sessions.find((s) => s.id === activeId) ?? null)
    : null

  const isBlank = useCallback(
    (s: SessionSummary) => !s.excerpt && !startedIds[s.id],
    [startedIds],
  )

  // 首条消息后(或已有历史)会话与项目绑定,不能换。分屏副窗格按它
  // 自己的会话判定(不能借用主会话的状态)。
  const lockedFor = useCallback(
    (id: string) => {
      const session = sessions.find((s) => s.id === id)
      return session !== null && session !== undefined && (!!startedIds[session.id] || !isBlank(session))
    },
    [sessions, startedIds, isBlank],
  )
  const locked = activeSession !== null && lockedFor(activeSession.id)

  const focusSession = useCallback((sessionId: string, projectId?: string) => {
    setActiveId(sessionId, projectId ?? null)
  }, [])

  /* ---- 启动自动导航 ---- */

  const recentProject = useCallback((): ProjectRecord | null => {
    let best: ProjectRecord | null = null
    let bestTime = -1
    for (const project of projects) {
      const memberTime = Math.max(
        project.createdAt,
        ...sessions
          .filter((session) => session.project_id === project.id)
          .map((session) => session.created_at),
      )
      if (memberTime > bestTime) {
        bestTime = memberTime
        best = project
      }
    }
    return best
  }, [projects, sessions])

  const connectProject = useCallback(
    (project: ProjectRecord) => {
      if (activeSession && activeSession.project_id === project.id) {
        setPendingProjectId(project.id)
        return
      }
      const blank = findProjectBlank(project.id)
      if (blank) {
        focusSession(blank.id, project.id)
        return
      }
      setActiveId(null, project.id)
    },
    [activeSession, focusSession],
  )

  const bootedRef = useRef(false)
  useEffect(() => {
    if (bootedRef.current || activeId) return
    if (!hashSettled) return
    if (projects.length === 0) return
    bootedRef.current = true
    const recent = recentProject()
    if (recent) connectProject(recent)
  }, [projects, activeId, hashSettled, recentProject, connectProject])

  /* ---- 空白会话不保留:仅清理本页面自己创建的空白会话 ---- */

  // 清理作用域必须是 `localBlankIds`(本页面创建的会话),绝不能按"全局列表
  // 里非活跃即空白"去扫:会话列表是跨页面/跨实例共享的(正式与开发实例还
  // 共用同一份数据目录),那样会把别的标签页刚创建、正在使用的会话当垃圾删掉,
  // 表现为"新建会话没选中项目 + 发不出消息 + 列表里看不到新会话",以及
  // 发消息时报 `session not found`。浏览器直接关闭留下的残留空白,由后端
  // 启动时一次性清扫(见 SessionStore::sweep_stale_blanks)。
  const prevActiveIdRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevActiveIdRef.current
    prevActiveIdRef.current = activeId
    if (prev === null || prev === activeId) return
    if (!localBlankIds[prev]) return
    // 焦点从本页面创建的空白会话切走:它没有任何内容,直接清理,不留账本残影。
    const left = sessions.find((s) => s.id === prev)
    if (left && isBlank(left)) {
      void loadComposer(`session:${prev}`).then((draft) => {
        if (draft.text || draft.images.length || draft.attachments.length || draft.quotes.length || draft.queue.length) return
        return deleteSessionAction(prev)
      }).catch(() => {
        // 草稿不可读或删除失败时保留会话，避免误删未发送内容。
      })
    }
  }, [activeId, sessions, localBlankIds, isBlank])

  /* ---- 显式"新建会话" ---- */

  const startSession = useCallback(
    async (targetProjectId?: string) => {
      leavePageViews()
      const activeProject = getActiveProject()
      const target =
        projects.find((project) => project.id === targetProjectId) ??
        (activeSession
          ? projects.find((project) => project.id === activeSession.project_id) ?? null
          : activeProject) ??
        recentProject() ??
        projects.find((project) => project.builtin === 'default') ??
        null
      if (!target) {
        setActiveId(null, null)
        return
      }
      // 侧栏"新建会话"总是创建全新会话,不复用空白(空白由"离开即删"
      // 与非活跃清扫自动清理,不会堆积)。
      try {
        const { session } = await api.createSession({ projectId: target.id })
        const summary: SessionSummary = {
          id: session.id,
          created_at: session.created_at,
          updated_at: session.updated_at ?? session.created_at,
          excerpt: null,
          title: null,
          cwd: session.cwd,
          sandbox: session.sandbox,
          cwd_alive: true,
          project_id: session.project_id,
        }
        addSessionLocal(summary, target.id)
        // 登记为本页面创建的空白会话:只有它允许被本页面的"切走即删"清理。
        markLocalBlank(summary.id)
        setActiveId(summary.id, target.id)
        // 分屏保持:新会话落在主窗格,注意力跟过去。
        setSplit((prev) => (prev ? { ...prev, focus: 'primary' } : prev))
        void refreshList()
      } catch (error) {
        notify('err', error instanceof Error ? error.message : String(error))
      }
    },
    [projects, activeSession, recentProject, leavePageViews],
  )

  /* ---- 创建项目 ---- */

  const createProject = useCallback(
    async (input: { title?: string; dirs: string[] }) => {
      const { project } = await api.createProject(input)
      await refreshList()
      connectProject(project)
      notify('ok', t('projectCreated'))
    },
    [connectProject],
  )

  /* ---- 删除(自定义确认框,替代 window.confirm) ---- */

  const [confirmReq, setConfirmReq] = useState<{
    title: string
    desc: string
    danger?: boolean
    onConfirm: () => void
  } | null>(null)

  const deleteProject = useCallback(
    (project: ProjectRecord) => {
      // 项目删除会级联删掉它的全部会话,所以它们的面板桶与终端
      // 进程也要一起收掉 —— 只删服务端数据会留下跑着的 PTY。
      const doomed = sessions
        .filter((session) =>
          session.project_id === project.id || project.sessionIds.includes(session.id))
        .map((session) => session.id)
      void deleteProjectAction(project.id)
        .then(() => {
          for (const id of doomed) cleanupSessionPane(id)
          notify('ok', t('projectDeleted'))
        })
        .catch((error) => notify('err', error instanceof Error ? error.message : String(error)))
    },
    [sessions, cleanupSessionPane],
  )

  // 删除确认在侧栏行内完成(删除图标 → 红色“确认删除”),这里只执行删除。
  const deleteSession = useCallback((session: SessionSummary) => {
    void deleteSessionAction(session.id)
      .then(() => {
        // 会话没了,它的面板桶也就永远不会再被读到:清掉,
        // 免得长期使用后 localStorage 里堆满孤儿桶、把在用的 scope
        // 挤出上限。同时把该会话的终端进程一并回收。
        cleanupSessionPane(session.id)
        notify('ok', t('sessionDeleted'))
      })
      .catch((error) => notify('err', error instanceof Error ? error.message : String(error)))
  }, [cleanupSessionPane])

  /* ---- 分屏:拖动侧栏会话到会话窗口 ---- */

  const {
    split,
    setSplit,
    splitRatio,
    dragHint,
    splitViewRef,
    splitActive,
    applySplitView,
    onPaneDragOver,
    onPaneDragLeave,
    onPaneDrop,
    beginSplitDrag,
    moveSplitDrag,
    endSplitDrag,
    keySplitDrag,
    focusPane,
    navigateSecondary,
  } = useSplitView({ activeId, sessions, sessionsLoaded, projects, isMobile, extensionTab })

  const openSession = useCallback(
    (id: string, projectId?: string) => {
      setVersionOpen(false)
      setSettingsTab(null)
      setExtensionTab(null)
      // 手机上选中会话后自动收起抽屉 —— 否则用户点完还得再点一次遮罩
      // 才能看到刚打开的对话。
      setDrawerOpen(false)
      applySplitView(openSessionInView({ primaryId: activeId, split }, id), projectId ?? null)
    },
    [activeId, split, applySplitView],
  )

  /* ---- 会话窗格渲染 ---- */

  /** 主窗格的项目切换(发消息前可切;已发消息后锁定)。 */
  const selectProjectForPane = (project: ProjectRecord) => {
    if (locked) {
      notify('err', t('lockedProject'))
      return
    }
    connectProject(project)
  }

  const openProjectPicker = () => {
    if (projects.length === 0) setProjectDialogOpen(true)
  }

  // 计划正文进入右侧工作台；分屏或手机放不下两列时，仍由会话页本地预览。
  const handlePlanReviewChange = useCallback((review: { title?: string; planText: string } | null) => {
    setPlanReview(review)
    if (!activeId) return
    if (review && !isMobile && !splitActive) {
      const current = peekSidePane(activeId)
      // 用户手动收起预览后不反复抢走视图；新的审批请求仍可重新打开。
      if (current.tabs.some((tab) => tab.type === 'plan')) return
      pane.openPanel('plan', { title: review.title })
      return
    }
    const current = peekSidePane(activeId)
    const planTab = current.tabs.find((tab) => tab.type === 'plan')
    if (!planTab) return
    updateSidePane(activeId, (value) => closeTab(value, planTab.id))
    if (current.tabs.length === 1) setSidePaneCollapsed(activeId, true)
  }, [activeId, isMobile, splitActive, pane.openPanel])

  const toggleSidePane = () => {
    // 从折叠态点开时,如果还没有任何标签,顺手开一个审查面板 ——
    // 否则用户点了按钮只看到引导页,还要再点一次才有内容。
    if (pane.collapsed && pane.state.tabs.length === 0) {
      pane.openPanel('review')
      return
    }
    pane.toggle()
  }

  /** 单窗格(未分屏)的会话页。 */
  const renderSingleSession = () => (
    <SessionsPage
      key={activeId ?? 'draft'}
      activeId={activeId}
      locked={locked}
      hasStarted={activeId ? !!startedIds[activeId] : false}
      onSelectProject={selectProjectForPane}
      onOpenPicker={openProjectPicker}
      onAddProject={() => setProjectDialogOpen(true)}
      sidePaneOpen={!pane.collapsed}
      onToggleSidePane={isMobile ? undefined : toggleSidePane}
      planPreviewInPane={!isMobile && !splitActive}
      onPlanReviewChange={handlePlanReviewChange}
    />
  )

  /** 分屏窗格:副窗格不渲染项目入口,会话切换约束在本窗格内。 */
  const renderSplitPane = (slot: PaneSlot) => {
    const id = slot === 'primary' ? activeId : split?.secondaryId ?? null
    if (id === null) return null
    const secondarySide: SplitSide = split?.side ?? 'right'
    const side: SplitSide =
      slot === 'secondary' ? secondarySide : secondarySide === 'left' ? 'right' : 'left'
    return (
      <div
        key={slot}
        className={`split-pane ${side}`}
        data-focus={split?.focus === slot ? 'true' : 'false'}
        onPointerDownCapture={() => focusPane(slot)}
      >
        <SessionsPage
          key={id}
          activeId={id}
          locked={lockedFor(id)}
          hasStarted={!!startedIds[id]}
          onSelectProject={selectProjectForPane}
          onOpenPicker={openProjectPicker}
          onAddProject={() => setProjectDialogOpen(true)}
          sidePaneOpen={false}
          secondary={slot === 'secondary'}
          navigate={slot === 'secondary' ? navigateSecondary : undefined}
        />
      </div>
    )
  }

  return (
    <div className="app-frame">
      <div
        className="shell"
      data-collapsed={sidebarCollapsed || undefined}
      data-mobile={isMobile || undefined}
      data-drawer={isMobile && drawerOpen ? 'open' : undefined}
      data-sidebar-moving={sidebarMoving || undefined}
      data-full-page={settingsTab || versionOpen ? true : undefined}
    >
      {isMobile && drawerOpen && (
        <div
          className="drawer-scrim"
          role="presentation"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      {/* 抽屉里的任何点击都收起抽屉:手机上点"设置""新建会话"之后,如果
          抽屉还盖在上面,用户会以为操作没生效(实测就是这样)。会话列表
          项自身也会关闭,这里兜住其余入口,不用逐个改 onClick。 */}
      <aside
        className="sidebar"
        aria-hidden={isMobile && !drawerOpen ? true : undefined}
        onClick={
          isMobile
            ? (event) => {
                // 折叠/展开等纯图标操作不关闭抽屉,避免点了箭头抽屉就消失。
                const target = event.target as HTMLElement
                if (target.closest('.sidebar-handle, .rail-btn')) return
                setDrawerOpen(false)
              }
            : undefined
        }
      >
        <div
          ref={wideLayerRef}
          className="sidebar-wide"
          aria-hidden={wideInactive || undefined}
        >
            {/* 品牌区；窗口拖动由主列标题栏负责。收起开关是 aside 层的
                .sidebar-handle,始终钉在移动的列边缘上。 */}
            <div className="sidebar-logo">
              <DeniaWordmark />
              <UpdateBadge />
            </div>
            <nav className="sidebar-primary" aria-label={t('newSession')}>
            <button
              type="button"
              className="sidebar-new-btn"
              onClick={() => void startSession()}
            >
              <IconNewSession size={16} />
              <span>{t('newSession')}</span>
            </button>
            <button type="button" className={`sidebar-new-btn sidebar-nav-btn sidebar-extensions-btn${extensionTab ? ' active' : ''}`}
              aria-current={extensionTab ? 'page' : undefined} onClick={() => openExtensions()}>
              <IconExtensions size={16} /><span>{t('extensionsTitle')}</span>
            </button>
            </nav>
            <div className="sidebar-region">
              <div className="sidebar-region-head">
                <span className="label">{t('projectsTitle')}</span>
                <div className="sidebar-region-actions">
                  <button
                    type="button"
                    className={`icon-btn${sidebarSearchOpen ? ' active' : ''}`}
                    title={t('searchSessions')}
                    aria-label={t('searchSessions')}
                    aria-pressed={sidebarSearchOpen}
                    onClick={() => setSidebarSearchOpen((open) => !open)}
                  >
                    <IconSessionSearch size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={sidebarAllExpanded ? t('collapseAllProjects') : t('expandAllProjects')}
                    aria-label={sidebarAllExpanded ? t('collapseAllProjects') : t('expandAllProjects')}
                    onClick={() => setSidebarExpandAllTick((tick) => tick + 1)}
                  >
                    {sidebarAllExpanded ? <IconCollapseAll size={14} /> : <IconExpandAll size={14} />}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={t('addProject')}
                    aria-label={t('addProject')}
                    onClick={() => setProjectDialogOpen(true)}
                  >
                    <IconFolderPlus size={14} />
                  </button>
                </div>
              </div>
              <SidebarProjects
                sessions={sessions}
                projects={projects}
                activeId={extensionTab || versionOpen || settingsTab ? null : activeId}
                secondaryId={extensionTab || versionOpen || settingsTab ? null : split?.secondaryId ?? null}
                runningIds={runningIds}
                searchOpen={sidebarSearchOpen}
                onSearchOpenChange={setSidebarSearchOpen}
                expandAllTick={sidebarExpandAllTick}
                onAllExpandedChange={setSidebarAllExpanded}
                onOpenSession={openSession}
                onNewSession={(projectId) => void startSession(projectId)}
                onDeleteProject={(project) => void deleteProject(project)}
                onDeleteSession={(session) => void deleteSession(session)}
              />
            </div>
            <nav className="sidebar-foot" aria-label={t('navSettings')}>
              <button
                type="button"
                className={`sidebar-nav${settingsTab ? ' active' : ''}`}
                aria-current={settingsTab ? 'page' : undefined}
                onClick={() => {
                  openSettings()
                  setDrawerOpen(false)
                }}
              >
                <IconGear size={16} />
                <span>{t('navSettings')}</span>
              </button>
            </nav>
        </div>
        <div
          ref={railLayerRef}
          className="sidebar-rail"
          aria-hidden={railInactive || undefined}
        >
          {/* 收起态顶带:与展开态的品牌行、主列的窗口条同高同底线。
              收起/展开开关不在这层里,而是 aside 上钉住列边缘的
              .sidebar-handle,列移动时它跟着边缘走,不会有一帧没有开关。 */}
          <div className="sidebar-rail-top" aria-hidden="true" />
          <button
            type="button"
            className="rail-btn"
            style={railIndex(0)}
            title={t('newSession')}
            aria-label={t('newSession')}
            onClick={() => void startSession()}
          >
            <IconNewSession size={16} />
          </button>
          <button type="button" className={`rail-btn${extensionTab ? ' accent' : ''}`}
            style={railIndex(1)}
            aria-label={t('extensionsTitle')} title={t('extensionsTitle')}
            aria-current={extensionTab ? 'page' : undefined} onClick={() => { openExtensions(); setDrawerOpen(false) }}>
            <IconExtensions size={18} />
          </button>
          <button
            type="button"
            className="rail-btn"
            style={railIndex(2)}
            title={t('addProject')}
            aria-label={t('addProject')}
            onClick={() => setProjectDialogOpen(true)}
          >
            <IconFolderPlus size={16} />
          </button>
          <button
            type="button"
            className="rail-btn"
            style={railIndex(3)}
            title={t('searchSessions')}
            aria-label={t('searchSessions')}
            onClick={expandSidebarWithSearch}
          >
            <IconSessionSearch size={16} />
          </button>
          <UpdateBadge collapsed />
          <div className="rail-spacer" />
          <div className="rail-foot" style={railIndex(5)}>
            <button
              type="button"
              className={`rail-btn${settingsTab ? ' accent' : ''}`}
              title={t('navSettings')}
              aria-label={t('navSettings')}
              aria-current={settingsTab ? 'page' : undefined}
              onClick={() => { openSettings(); setDrawerOpen(false) }}
            >
              <IconGear size={16} />
            </button>
          </div>
        </div>
        {/* 唯一的收起/展开开关:right 让它始终钉在列的右缘;列宽从 280
            收到 56 时,它从品牌行右侧滑到轨道顶部中央。两层都常驻,所以
            动画任意一帧都不会出现"没有开关"的空白。 */}
        <button
          ref={sidebarHandleRef}
          type="button"
          className="icon-btn sidebar-handle"
          title={sidebarCollapsed ? t('sidebarExpand') : t('sidebarCollapse')}
          aria-label={sidebarCollapsed ? t('sidebarExpand') : t('sidebarCollapse')}
          aria-expanded={!sidebarCollapsed}
          onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
        >
          <IconPanelClose size={16} className="handle-icon handle-icon-collapse" />
          <IconPanelOpen size={16} className="handle-icon handle-icon-expand" />
        </button>
      </aside>
      <main className="main">
        {/* 桌面壳的窗口条:只占**主列**宽度,不横穿侧栏。这样侧栏能从窗口
            最顶端一直贯到底、品牌 logo 留在原地,而窗口按钮与主列左边界对齐。
            浏览器形态下组件自己返回 null。 */}
        <DesktopTitleBar />
        {/* 手机端顶栏:抽屉开关 + 品牌。桌面端由 CSS 隐藏 —— 桌面有常驻
            侧栏,不需要这个入口。 */}
        {isMobile && !settingsTab && !versionOpen && (
          <div className="mobile-bar">
            <button
              type="button"
              className="mobile-bar-btn"
              aria-label={t('sidebarExpand')}
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen((open) => !open)}
            >
              <IconMenu size={18} />
            </button>
            <span className="mobile-bar-title">Denia</span>
          </div>
        )}
        <div className="main-row" data-split={splitActive || undefined}>
          <div
            className="page-pane"
            onDragOver={onPaneDragOver}
            onDragLeave={onPaneDragLeave}
            onDrop={onPaneDrop}
          >
            {versionOpen ? (
              <Suspense fallback={<div className="extensions-loading" role="status">{t('loading')}</div>}>
                <LazyVersionPage onBack={closeVersion} />
              </Suspense>
            ) : settingsTab ? (
              <Suspense fallback={<div className="extensions-loading" role="status">{t('loading')}</div>}>
                <LazySettingsPage
                  tab={settingsTab}
                  notify={notify}
                  onBack={closeSettings}
                  onTabChange={changeSettingsTab}
                  onOpenVersion={openVersion}
                />
              </Suspense>
            ) : extensionTab ? (
              <Suspense fallback={<div className="extensions-loading" role="status">{t('loading')}</div>}>
                <LazyExtensionsPage tab={extensionTab} cwd={paneProjectPath ?? undefined} onTabChange={openExtensions} notify={notify} />
              </Suspense>
            ) : splitActive && split ? (
              <div
                className="split-view"
                ref={splitViewRef}
                style={{ '--split-left': `${splitRatio * 100}%` } as CSSProperties}
              >
                {renderSplitPane(split.side === 'left' ? 'secondary' : 'primary')}
                <div className="split-divider">
                  <div
                    className="split-divider-grip"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={t('splitResize')}
                    aria-valuenow={Math.round(splitRatio * 100)}
                    aria-valuemin={Math.round(SPLIT_MIN_RATIO * 100)}
                    aria-valuemax={Math.round(SPLIT_MAX_RATIO * 100)}
                    tabIndex={0}
                    onPointerDown={beginSplitDrag}
                    onPointerMove={moveSplitDrag}
                    onPointerUp={endSplitDrag}
                    onPointerCancel={endSplitDrag}
                    onKeyDown={keySplitDrag}
                  />
                  <button
                    type="button"
                    className="split-divider-exit"
                    title={t('splitExit')}
                    aria-label={t('splitExit')}
                    data-testid="split-exit"
                    onClick={() => setSplit(null)}
                  >
                    <IconClose size={12} />
                  </button>
                </div>
                {renderSplitPane(split.side === 'left' ? 'primary' : 'secondary')}
              </div>
            ) : (
              renderSingleSession()
            )}
            {/* 拖动侧栏会话经过会话区:半透明遮罩标出松开后的落点。 */}
            {dragHint && <div className={`split-drop-hint ${dragHint}`} aria-hidden="true" />}
          </div>
          {/* 侧边面板在手机上不渲染:390px 宽放不下「对话 + 面板」两列,
              面板会把自己挤成一条缝,还会把主列的输入区顶出屏幕。
              手机用户要终端/文件,用抽屉里的入口或直接开新会话更实际。 */}
          {!isMobile && !extensionTab && !versionOpen && !settingsTab && (
          <SidePane
            sessionId={activeId}
            state={pane.state}
            collapsed={pane.collapsed || splitActive}
            projectPath={paneProjectPath}
            projectDirs={paneProjectDirs}
            supportsBrowser={true}
            modelSelection={modelSelection}
            recentClosed={pane.recentClosed}
            onChange={(updater) => pane.update(updater)}
            onCollapsedChange={(next) => pane.setCollapsed(next)}
            onRememberClosed={(tabs) => {
              // 终端标签关闭时连带关掉服务端 PTY:标签没了但进程还在跑
              // 就是泄漏。TerminalPanel 卸载时也会关一次(幂等),
              // 这里显式做是为了在"标签被移除但组件还没卸载"的窗口里
              // 立刻释放进程。
              handleCloseTerminalTab(tabs)
              pane.rememberClosed(tabs)
            }}
            onForgetClosed={(id) => pane.forgetClosed(id)}
            onOpenPanel={(type) => {
              if (type === 'terminal') openTerminalTab()
              else pane.openPanel(type)
            }}
            onOpenFile={(path) => void pane.openFile(path)}
            onActivateFile={(path) => pane.activateFile(path)}
            onCloseFile={(path) => pane.closeFile(path)}
            renderTerminals={(tabs: SidePaneTab[], activeId2: string, paneVisible: boolean) => (
              <TerminalHost
                tabs={tabs}
                activeId={activeId2}
                cwd={paneProjectPath ?? ''}
                paneVisible={paneVisible}
                onTitle={handleTerminalTitle}
                onExit={handleTerminalExit}
                onNewTerminal={openTerminalTab}
              />
            )}
            renderBrowser={(_tab, visible) => (
              <Suspense fallback={<div className="empty-hint">{t('loading')}</div>}>
                <LazyBrowserPanel visible={visible} onClose={closeBrowserSidebar} />
              </Suspense>
            )}
            planReview={planReview}
          />
          )}
        </div>
      </main>
      {updateDialogOpen && (
        <Suspense fallback={null}>
          <LazyUpdateDialog onOpenVersion={openVersion} />
        </Suspense>
      )}
      {projectDialogOpen && (
        <ProjectDialog
          onCreate={createProject}
          onClose={() => setProjectDialogOpen(false)}
          onError={(message) => notify('err', message)}
        />
      )}
      {connLost && <div className="conn-lost">{t('connectionLost')}</div>}
      {toast && <div className={`toast ${toast.kind}`}>{toast.message}</div>}
      <ConfirmDialog
        open={confirmReq !== null}
        title={confirmReq?.title ?? ''}
        desc={confirmReq?.desc ?? ''}
        danger={confirmReq?.danger}
        onConfirm={() => {
          confirmReq?.onConfirm()
          setConfirmReq(null)
        }}
        onCancel={() => setConfirmReq(null)}
      />
      </div>
    </div>
  )
}

