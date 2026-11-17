import { useCallback, useEffect, useRef, useState } from 'react'

// 侧栏收起偏好与过渡时长(与 styles/shell.css 的 --sidebar-motion-dur 同步)。
const SIDEBAR_COLLAPSED_KEY = 'denia.sidebar-collapsed'
const SIDEBAR_TRANSITION_MS = 300
/** 装饰态存活时间:覆盖最后一枚图标(200ms 延迟 + 240ms)与正文视差。 */
const SIDEBAR_MOTION_MS = 540
/** 宽态各区块的 transform 最晚 400ms 落位,搜索框在那之后再聚焦。 */
const SIDEBAR_SEARCH_FOCUS_MS = SIDEBAR_TRANSITION_MS + 120

/**
 * 侧栏收起(56px 图标控制栏)。
 *
 * 收起/展开本身是纯 CSS 状态动画(见 styles/shell.css):宽态与轨道两层
 * 常驻 DOM、交叉淡入淡出,宽态冻结宽度被移动的列边缘裁切。这样:
 * - 动画可以在任意一帧反向,不会因为定时器拆/挂载出现空白帧;
 * - 项目树的展开状态、滚动位置在收起后仍然保留;
 * - 收起控件始终钉在移动的列边缘上,不会跟着宽态内容一起被裁掉。
 *
 * 这里只保留持久化偏好、动画期间的装饰态(moving)和"展开后聚焦搜索"的
 * 时序。setSidebarSearchOpen 是 App 的搜索框状态:滑动落位后再弹搜索框。
 */
export function useSidebarCollapse(setSidebarSearchOpen: (open: boolean) => void) {
  // 收起态是 56px 图标控制栏而不是零宽:常驻开关/新建/添加/搜索/设置,
  // 与展开态各行顺序一一对应。偏好进 localStorage(纯 UI 态,不进 console 配置)。
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0')
    } catch {
      /* 隐私模式等存储不可用:仅失去持久化,不影响交互 */
    }
  }, [sidebarCollapsed])

  // 只在真正的状态切换时点亮 moving:首屏是收起态也不播放入场动画。
  // 首屏两层的可见性由 data-collapsed 直接决定,不经过过渡。
  const [sidebarMoving, setSidebarMoving] = useState(false)
  const prevCollapsedRef = useRef(sidebarCollapsed)
  useEffect(() => {
    const toggled = prevCollapsedRef.current !== sidebarCollapsed
    prevCollapsedRef.current = sidebarCollapsed
    if (!toggled) return
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      setSidebarMoving(false)
      return
    }
    setSidebarMoving(true)
    // 连续切换时清掉上一枚计时器,装饰态保持到最后一轮落位。
    const timer = window.setTimeout(() => setSidebarMoving(false), SIDEBAR_MOTION_MS)
    return () => window.clearTimeout(timer)
  }, [sidebarCollapsed])

  // 滑动落位后再弹搜索框并聚焦,过渡中聚焦会被移动的输入框甩开。
  const searchTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current)
  }, [])
  const expandSidebarWithSearch = useCallback(() => {
    setSidebarCollapsed(false)
    if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current)
    searchTimerRef.current = window.setTimeout(
      () => setSidebarSearchOpen(true),
      SIDEBAR_SEARCH_FOCUS_MS,
    )
  }, [setSidebarSearchOpen])

  return {
    sidebarCollapsed,
    setSidebarCollapsed,
    sidebarMoving,
    expandSidebarWithSearch,
  }
}