const CHILDREN_KEY = 'denia.sidebar-collapsed-children.v1'
const ORDER_KEY = 'denia.sidebar-order.v1'
const VIEW_KEY = 'denia.sidebar-view.v1'
const PINS_KEY = 'denia.sidebar-pins.v1'

/** 侧栏手动排序账本:目前只保留项目顺序;任务顺序由活跃度/更新时间决定。 */
export interface SidebarOrder {
  workspaces: string[]
}

/** 侧栏主视图:按项目,或按最近更新平铺。 */
export type SidebarView = 'projects' | 'timeline'

/** 置顶账本:项目与会话各一份 id 列表,顺序不影响显示(显示按当前排序)。 */
export interface SidebarPins {
  workspaces: string[]
  sessions: string[]
}

export function readCollapsedChildren(): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(CHILDREN_KEY) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, collapsed]) => collapsed === true))
  } catch {
    return {}
  }
}

export function writeCollapsedChildren(value: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(CHILDREN_KEY, JSON.stringify(
      Object.fromEntries(Object.entries(value).filter(([, collapsed]) => collapsed === true)),
    ))
  } catch {
    // 禁用存储或配额不足不影响本次页面内的折叠操作。
  }
}

function readIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/** 读取项目手动顺序;损坏/类型不符的字段按空处理,不影响默认服务端顺序。 */
export function readSidebarOrder(): SidebarOrder {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(ORDER_KEY) ?? 'null')
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { workspaces: [] }
    }
    return { workspaces: readIdList((value as Record<string, unknown>).workspaces) }
  } catch {
    return { workspaces: [] }
  }
}

export function writeSidebarOrder(value: SidebarOrder): void {
  try {
    window.localStorage.setItem(ORDER_KEY, JSON.stringify({
      workspaces: value.workspaces,
    }))
  } catch {
    // 写入失败只影响刷新后的顺序,本次页面内的拖动结果仍然生效。
  }
}

/** 视图偏好:默认按项目;未知值一律回落到按项目。 */
export function readSidebarView(): SidebarView {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'timeline' ? 'timeline' : 'projects'
  } catch {
    return 'projects'
  }
}

export function writeSidebarView(value: SidebarView): void {
  try {
    if (value === 'projects') window.localStorage.removeItem(VIEW_KEY)
    else window.localStorage.setItem(VIEW_KEY, value)
  } catch {
    // 存储不可用只影响刷新后的视图。
  }
}

/** 读取置顶账本;损坏/类型不符的字段按空处理。 */
export function readSidebarPins(): SidebarPins {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(PINS_KEY) ?? 'null')
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { workspaces: [], sessions: [] }
    }
    const doc = value as Record<string, unknown>
    return {
      workspaces: readIdList(doc.workspaces),
      sessions: readIdList(doc.sessions),
    }
  } catch {
    return { workspaces: [], sessions: [] }
  }
}

export function writeSidebarPins(value: SidebarPins): void {
  try {
    window.localStorage.setItem(PINS_KEY, JSON.stringify({
      workspaces: value.workspaces,
      sessions: value.sessions,
    }))
  } catch {
    // 写入失败只影响刷新后的置顶状态。
  }
}

export function restoredSidebarSession(activeId: string | null): string | null {
  if (activeId) return activeId
  try {
    const match = window.location.hash.match(/^#s=([^#]+)$/)
    return match ? decodeURIComponent(match[1]) : null
  } catch {
    return null
  }
}