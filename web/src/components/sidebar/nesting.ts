import { t } from '../../i18n'
import { relativeTime } from '../../relativeTime'
import type { DropPlacement } from '../../sidebarOrder'
import type { SessionSummary } from '../../types'

export const UNGROUPED_KEY = 'ungrouped'
export const COLLAPSED_LIMIT = 5
/** 置顶任务货架的首屏条数;超过后由「显示更多」展开。 */
export const PINNED_LIMIT = 20
/** 最近更新视图的首屏条数。 */
export const TIMELINE_LIMIT = 20
export const WORKSPACE_DRAG_MIME = 'application/x-denia-workspace'

/** 侧栏拖拽中的源:项目行可以手动排序。 */
export type SidebarDrag = { kind: 'workspace'; id: string }

/** 拖拽落点与插入方向;仅在当前拖拽类型匹配时渲染指示线。 */
export type SidebarDropTarget = { kind: 'workspace'; id: string; placement: DropPlacement }

/** 指针在行内上半/下半:上半插到目标前,下半插到目标后。 */
export function placementFromPointer(event: { currentTarget: HTMLElement; clientY: number }): DropPlacement {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
}

/**
 * 血缘嵌套排序:子会话紧跟其父会话
 * 之后(先序遍历);父不在本组(跨组/已删)的子会话留在顶层。
 * `hideSubtreeOf` 里的会话只渲染自身,其整棵后代子树不进列表(折叠)。
 */
export function nestByParent(
  members: SessionSummary[],
  hideSubtreeOf?: ReadonlySet<string>,
): { session: SessionSummary; depth: number }[] {
  const ids = new Set(members.map((s) => s.id))
  const byParent = new Map<string, SessionSummary[]>()
  const roots: SessionSummary[] = []
  for (const session of members) {
    const parent = session.parent_session
    if (parent && ids.has(parent)) {
      const list = byParent.get(parent)
      if (list) list.push(session)
      else byParent.set(parent, [session])
    } else {
      roots.push(session)
    }
  }
  const out: { session: SessionSummary; depth: number }[] = []
  const walk = (list: SessionSummary[], depth: number) => {
    for (const session of list) {
      out.push({ session, depth })
      if (hideSubtreeOf?.has(session.id)) continue
      walk(byParent.get(session.id) ?? [], depth + 1)
    }
  }
  walk(roots, 0)
  return out
}

const TIME_UNIT_KEYS = {
  minutes: 'timeMinutes',
  hours: 'timeHours',
  days: 'timeDays',
  months: 'timeMonths',
  years: 'timeYears',
} as const

/** 会话行尾相对时间:now 桶不带"前"。 */
export function relativeTimeLabel(at: number, now: number): string {
  const { unit, n } = relativeTime(at, now)
  if (unit === 'now') return t('timeNow')
  return t('timeAgo', { t: t(TIME_UNIT_KEYS[unit], { n }) })
}

/** 一组会话的血缘计量:每个会话的后代总数与"有运行中后代"的祖先集合。 */
export function sessionUpdatedAt(session: SessionSummary): number {
  return session.updated_at ?? session.created_at
}

/**
 * 侧栏任务排序:运行中(含运行中的后代)优先,然后最近更新倒序。
 * 置顶货架、项目任务和未分组任务共用同一口径;最近更新视图关掉活跃优先。
 */
export function sortSessions(
  members: SessionSummary[],
  runningIds: Record<string, boolean>,
  activeAncestors?: ReadonlySet<string>,
  activeFirst = true,
): SessionSummary[] {
  const isActive = (session: SessionSummary) =>
    Boolean(runningIds[session.id]) || Boolean(activeAncestors?.has(session.id))
  return [...members].sort((a, b) => {
    if (activeFirst) {
      const activeA = isActive(a) ? 1 : 0
      const activeB = isActive(b) ? 1 : 0
      if (activeA !== activeB) return activeB - activeA
    }
    return sessionUpdatedAt(b) - sessionUpdatedAt(a) ||
      b.created_at - a.created_at ||
      a.id.localeCompare(b.id)
  })
}

function childrenByParent(
  members: SessionSummary[],
): Map<string, SessionSummary[]> {
  const present = new Set(members.map((session) => session.id))
  const byParent = new Map<string, SessionSummary[]>()
  for (const session of members) {
    const parent = session.parent_session
    if (!parent || !present.has(parent)) continue
    const list = byParent.get(parent)
    if (list) list.push(session)
    else byParent.set(parent, [session])
  }
  return byParent
}

/**
 * 置顶任务的单次归属:置顶一个会话时,连同它的整棵分支一起搬进「已置顶」,
 * 并从项目/未分组列表里整体隐藏。这样父子血缘不会在搬动后散掉;取消置顶
 * 时整棵分支原样回到原来的项目。
 */
export function collectPinnedSubtrees(
  members: SessionSummary[],
  pinnedIds: ReadonlySet<string>,
): { roots: SessionSummary[]; members: SessionSummary[]; hidden: Set<string> } {
  const byId = new Map(members.map((session) => [session.id, session]))
  const byParent = childrenByParent(members)
  const hasPinnedAncestor = (session: SessionSummary): boolean => {
    const seen = new Set<string>()
    let cursor = session.parent_session
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      if (pinnedIds.has(cursor)) return true
      cursor = byId.get(cursor)?.parent_session
    }
    return false
  }
  const roots = members.filter(
    (session) => pinnedIds.has(session.id) && !hasPinnedAncestor(session),
  )
  const hidden = new Set<string>()
  const visit = (session: SessionSummary) => {
    if (hidden.has(session.id)) return
    hidden.add(session.id)
    for (const child of byParent.get(session.id) ?? []) visit(child)
  }
  for (const root of roots) visit(root)
  return { roots, members: members.filter((session) => hidden.has(session.id)), hidden }
}

/** 给定根节点集合,收集它们的整棵子树 id(用于置顶货架分页)。 */
export function collectSubtreeIds(
  members: SessionSummary[],
  rootIds: Iterable<string>,
): Set<string> {
  const byParent = childrenByParent(members)
  const out = new Set<string>()
  const visit = (id: string) => {
    if (out.has(id)) return
    out.add(id)
    for (const child of byParent.get(id) ?? []) visit(child.id)
  }
  for (const id of rootIds) visit(id)
  return out
}

export function lineageStats(
  members: SessionSummary[],
  runningIds: Record<string, boolean>,
): { descendantCount: Map<string, number>; runningAncestors: Set<string> } {
  const ids = new Set(members.map((s) => s.id))
  const parentOf = new Map<string, string>()
  for (const session of members) {
    if (session.parent_session && ids.has(session.parent_session)) {
      parentOf.set(session.id, session.parent_session)
    }
  }
  const descendantCount = new Map<string, number>()
  for (const session of members) {
    const seen = new Set<string>()
    let cursor = parentOf.get(session.id)
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      descendantCount.set(cursor, (descendantCount.get(cursor) ?? 0) + 1)
      cursor = parentOf.get(cursor)
    }
  }
  const runningAncestors = new Set<string>()
  for (const session of members) {
    if (!runningIds[session.id]) continue
    const seen = new Set<string>()
    let cursor = parentOf.get(session.id)
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      runningAncestors.add(cursor)
      cursor = parentOf.get(cursor)
    }
  }
  return { descendantCount, runningAncestors }
}
