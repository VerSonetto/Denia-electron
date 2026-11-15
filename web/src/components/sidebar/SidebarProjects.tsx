import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { bumpCatalogTick } from '../../appStore'
import { t } from '../../i18n'
import {
  readCollapsedChildren,
  readSidebarOrder,
  readSidebarPins,
  readSidebarView,
  restoredSidebarSession,
  writeCollapsedChildren,
  writeSidebarOrder,
  writeSidebarPins,
  writeSidebarView,
  type SidebarView,
} from '../../sidebarMemory'
import { applyManualOrder, moveId, toggleId } from '../../sidebarOrder'
import { sessionAlias, setSessionAlias } from '../../sessionAliases'
import { sessionDisplayTitle } from '../../sessionDisplay'
import type { ProjectRecord, SessionSummary } from '../../types'
import { IconClose, IconNewSession, IconPencil, IconPin, IconProject, IconSessionSearch, IconTrash } from '../icons'
import { SidebarContextMenu, type SidebarMenuState } from '../SidebarContextMenu'
import { ConfirmDialog } from '../ConfirmDialog'
import type { SidebarDrag, SidebarDropTarget } from './nesting'
import {
  COLLAPSED_LIMIT,
  collectPinnedSubtrees,
  collectSubtreeIds,
  lineageStats,
  nestByParent,
  PINNED_LIMIT,
  placementFromPointer,
  sortSessions,
  TIMELINE_LIMIT,
  PROJECT_DRAG_MIME,
} from './nesting'
import { SessionRow } from './SessionRow'

interface NestedRows {
  rows: { session: SessionSummary; depth: number }[]
  descendantCount: Map<string, number>
  runningAncestors: Set<string>
}

function SessionRows({
  view,
  activeId,
  secondaryId,
  runningIds,
  collapsedChildren,
  pinnedSessionIds,
  confirming,
  now,
  onToggleCollapse,
  onOpen,
  onRequestDelete,
  onConfirmDelete,
  onTogglePin,
  onContextMenu,
}: {
  view: NestedRows
  activeId: string | null
  secondaryId?: string | null
  runningIds: Record<string, boolean>
  collapsedChildren: Record<string, boolean>
  pinnedSessionIds: ReadonlySet<string>
  confirming: { kind: 'session' | 'project'; id: string } | null
  now: number
  onToggleCollapse: (id: string) => void
  onOpen: (session: SessionSummary) => void
  onRequestDelete: (id: string) => void
  onConfirmDelete: () => void
  onTogglePin: (id: string) => void
  onContextMenu: (event: React.MouseEvent, session: SessionSummary) => void
}) {
  return (
    <>
      {view.rows.map(({ session, depth }) => (
        <SessionRow
          key={session.id}
          session={session}
          depth={depth}
          active={session.id === activeId}
          secondaryActive={!!secondaryId && session.id === secondaryId}
          running={!!runningIds[session.id]}
          now={now}
          childCount={view.descendantCount.get(session.id) ?? 0}
          collapsed={collapsedChildren[session.id] === true}
          childRunning={view.runningAncestors.has(session.id)}
          onToggleCollapse={() => onToggleCollapse(session.id)}
          onOpen={() => onOpen(session)}
          pinned={pinnedSessionIds.has(session.id)}
          confirmingDelete={confirming?.kind === 'session' && confirming.id === session.id}
          onRequestDelete={() => onRequestDelete(session.id)}
          onConfirmDelete={onConfirmDelete}
          onTogglePin={() => onTogglePin(session.id)}
          onContextMenu={(event) => onContextMenu(event, session)}
        />
      ))}
    </>
  )
}

/** Project title: the built-in default project is localized in the UI. */
function projectTitle(project: ProjectRecord): string {
  return project.builtin === 'default' ? t('defaultProject') : project.title
}

export function SidebarProjects({
  sessions,
  projects,
  activeId,
  secondaryId,
  runningIds,
  searchOpen,
  onSearchOpenChange,
  expandAllTick,
  onAllExpandedChange,
  onOpenSession,
  onNewSession,
  onDeleteProject,
  onDeleteSession,
}: {
  sessions: SessionSummary[]
  projects: ProjectRecord[]
  activeId: string | null
  /** 分屏副窗格的会话 id(弱高亮;null = 未分屏)。 */
  secondaryId?: string | null
  runningIds: Record<string, boolean>
  searchOpen: boolean
  onSearchOpenChange: (open: boolean) => void
  expandAllTick: number
  onAllExpandedChange: (allExpanded: boolean) => void
  onOpenSession: (id: string, projectId?: string) => void
  onNewSession: (projectId?: string) => void
  onDeleteProject: (project: ProjectRecord) => void
  onDeleteSession: (session: SessionSummary) => void
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [showAll, setShowAll] = useState<Record<string, boolean>>({})
  // 血缘折叠:sessionId → 是否收起其后代子树(默认展开)。
  const [collapsedChildren, setCollapsedChildren] = useState(readCollapsedChildren)
  // 项目顺序与置顶都是本机侧栏偏好;任务顺序由活跃度/更新时间决定。
  const [order, setOrder] = useState(readSidebarOrder)
  const [pins, setPins] = useState(readSidebarPins)
  const [view, setView] = useState<SidebarView>(readSidebarView)
  const [showAllPinned, setShowAllPinned] = useState(false)
  const [timelineLimit, setTimelineLimit] = useState(TIMELINE_LIMIT)
  const [confirming, setConfirming] = useState<{ kind: 'session' | 'project'; id: string } | null>(null)
  const [contextMenu, setContextMenu] = useState<SidebarMenuState | null>(null)
  const [renameTarget, setRenameTarget] = useState<SessionSummary | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [dragState, setDragState] = useState<SidebarDrag | null>(null)
  const dragRef = useRef<SidebarDrag | null>(null)
  const [dropTarget, setDropTarget] = useState<SidebarDropTarget | null>(null)
  const pinnedProjects = useMemo(() => new Set(pins.projects), [pins.projects])
  const pinnedSessionIds = useMemo(() => new Set(pins.sessions), [pins.sessions])
  const revealedSessionRef = useRef(restoredSidebarSession(activeId))
  useEffect(() => { writeCollapsedChildren(collapsedChildren) }, [collapsedChildren])

  // 10k 会话时避免每次 get/sessionIds 都做 O(n) find;一次建 Map,O(1) 取行。
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  )
  // 项目顺序叠加本机手动排序;默认项目固定排在最后,新项目(服务端 prepend)排在最前。
  const orderedProjects = useMemo(() => {
    const ordered = applyManualOrder(projects, order.projects)
    const regular = ordered.filter((project) => project.builtin !== 'default')
    const fallback = ordered.filter((project) => project.builtin === 'default')
    return [...regular, ...fallback]
  }, [projects, order.projects])

  // 置顶任务连同它的整棵分支搬进「已置顶」,并从项目列表里隐藏。
  const shelf = useMemo(
    () => collectPinnedSubtrees(sessions, pinnedSessionIds),
    [sessions, pinnedSessionIds],
  )
  const hiddenSessionIds = shelf.hidden

  const membersOf = useCallback(
    (project: ProjectRecord) =>
      project.sessionIds
        .map((id) => sessionsById.get(id))
        .filter((session): session is SessionSummary =>
          !!session && !hiddenSessionIds.has(session.id)),
    [sessionsById, hiddenSessionIds],
  )

  const [now, setNow] = useState(() => Date.now())
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const lastExpandTickRef = useRef(0)

  useEffect(() => {
    if (!searchOpen) {
      setQuery('')
      return
    }
    const id = requestAnimationFrame(() => searchInputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [searchOpen])

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    setTimelineLimit(TIMELINE_LIMIT)
  }, [view, query])

  const normalizedQuery = query.trim().toLowerCase()
  const matchesQuery = useCallback(
    (session: SessionSummary) => {
      if (!normalizedQuery) return true
      return sessionDisplayTitle(session).toLowerCase().includes(normalizedQuery)
    },
    [normalizedQuery],
  )
  const searching = normalizedQuery.length > 0

  const buildNestedRows = useCallback((members: SessionSummary[], activeFirst = true): NestedRows => {
    const { descendantCount, runningAncestors } = lineageStats(members, runningIds)
    const sorted = activeFirst
      ? sortSessions(members, runningIds, runningAncestors)
      : sortSessions(members, {}, undefined, false)
    const collapsedSet = searching
      ? undefined
      : new Set(
          Object.keys(collapsedChildren).filter(
            (id) => collapsedChildren[id] && descendantCount.has(id),
          ),
        )
    return { rows: nestByParent(sorted, collapsedSet), descendantCount, runningAncestors }
  }, [collapsedChildren, runningIds, searching])

  const projectGroups = useMemo(
    () => orderedProjects.map((project) => ({
      project,
      members: membersOf(project).filter(matchesQuery),
    })),
    [orderedProjects, membersOf, matchesQuery],
  )
  const visibleProjectGroups = searching
    ? projectGroups.filter((group) => group.members.length > 0)
    : projectGroups
  const pinnedGroups = visibleProjectGroups.filter((group) => pinnedProjects.has(group.project.id))
  const regularGroups = visibleProjectGroups.filter((group) => !pinnedProjects.has(group.project.id))

  const visibleShelfRoots = searching || showAllPinned
    ? shelf.roots
    : shelf.roots.slice(0, PINNED_LIMIT)
  const visibleShelfIds = useMemo(
    () => collectSubtreeIds(shelf.members, visibleShelfRoots.map((session) => session.id)),
    [shelf.members, visibleShelfRoots],
  )
  const shelfMembers = useMemo(
    () => shelf.members.filter((session) =>
      visibleShelfIds.has(session.id) && matchesQuery(session)),
    [shelf.members, visibleShelfIds, matchesQuery],
  )
  const shelfView = buildNestedRows(shelfMembers)

  // 最近更新只在切到该视图时排序,避免按项目视图为每个会话重排一次。
  const timelineView = view === 'timeline'
    ? buildNestedRows(sessions.filter(matchesQuery), false)
    : { rows: [], descendantCount: new Map<string, number>(), runningAncestors: new Set<string>() }
  const timelineVisible = searching
    ? timelineView.rows
    : timelineView.rows.slice(0, timelineLimit)

  const projectsEmpty = shelfView.rows.length === 0 &&
    pinnedGroups.length === 0 &&
    regularGroups.length === 0
  const timelineEmpty = timelineView.rows.length === 0

  const projectIdFor = useCallback((session: SessionSummary): string | undefined => {
    if (session.project_id && projects.some((project) => project.id === session.project_id)) {
      return session.project_id
    }
    return projects.find((project) => project.sessionIds.includes(session.id))?.id
  }, [projects])

  const openSession = useCallback((session: SessionSummary, projectId?: string) => {
    onOpenSession(session.id, projectId)
  }, [onOpenSession])

  const isGroupOpen = useCallback(
    (key: string, fallback: boolean) => expanded[key] ?? fallback,
    [expanded],
  )

  const groupKeys = useCallback(() => orderedProjects.map((project) => project.id), [orderedProjects])

  useEffect(() => {
    const keys = groupKeys()
    if (keys.length === 0) {
      onAllExpandedChange(false)
      return
    }
    const allOpen = keys.every((key) => {
      const project = orderedProjects.find((item) => item.id === key)
      if (!project) return true
      const members = membersOf(project)
      return isGroupOpen(key, members.some((session) => session.id === activeId))
    })
    onAllExpandedChange(allOpen)
  }, [activeId, groupKeys, isGroupOpen, membersOf, onAllExpandedChange, orderedProjects])

  useEffect(() => {
    if (expandAllTick === 0 || expandAllTick === lastExpandTickRef.current) return
    lastExpandTickRef.current = expandAllTick
    const keys = groupKeys()
    const nextExpanded = keys.every((key) => {
      const project = orderedProjects.find((item) => item.id === key)
      if (!project) return true
      const members = membersOf(project)
      return isGroupOpen(key, members.some((session) => session.id === activeId))
    })
    const wantExpand = !nextExpanded
    const next: Record<string, boolean> = {}
    for (const key of keys) next[key] = wantExpand
    setExpanded((previous) => ({ ...previous, ...next }))
    // 全部展开时连带展开血缘折叠;收起只收组,不动子树。
    if (wantExpand) setCollapsedChildren({})
  }, [activeId, expandAllTick, groupKeys, isGroupOpen, membersOf, orderedProjects])

  useEffect(() => {
    if (!activeId) return
    // 置顶任务在货架里常显,不需要再展开它所在的项目。
    if (hiddenSessionIds.has(activeId)) return
    const project = orderedProjects.find((item) => item.sessionIds.includes(activeId))
    if (!project) return
    setExpanded((previous) => previous[project.id] ? previous : { ...previous, [project.id]: true })
  }, [activeId, hiddenSessionIds, orderedProjects])

  // 仅切换会话时展开祖先;刷新恢复与列表推送不覆盖用户的折叠选择。
  useEffect(() => {
    if (!activeId || activeId === revealedSessionRef.current || !sessionsById.has(activeId)) return
    revealedSessionRef.current = activeId
    setCollapsedChildren((previous) => {
      let changed = false
      const next = { ...previous }
      const seen = new Set<string>()
      let cursor = sessionsById.get(activeId)?.parent_session
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor)
        if (next[cursor]) {
          next[cursor] = false
          changed = true
        }
        cursor = sessionsById.get(cursor)?.parent_session
      }
      return changed ? next : previous
    })
  }, [activeId, sessionsById])

  const beginDrag = (next: SidebarDrag) => {
    dragRef.current = next
    setDragState(next)
    setDropTarget(null)
  }

  const endDrag = () => {
    dragRef.current = null
    setDragState(null)
    setDropTarget(null)
  }

  /** 离开行/组时收起指示线;真正进入子元素不算离开。 */
  const handleDragLeave = (event: React.DragEvent<HTMLElement>) => {
    const to = event.relatedTarget as Node | null
    if (to && event.currentTarget.contains(to)) return
    setDropTarget(null)
  }

  const beginProjectDrag = (event: React.DragEvent<HTMLButtonElement>, id: string) => {
    event.dataTransfer.setData(PROJECT_DRAG_MIME, id)
    event.dataTransfer.effectAllowed = 'move'
    beginDrag({ kind: 'project', id })
  }

  const handleProjectDragOver = (event: React.DragEvent<HTMLDivElement>, targetId: string) => {
    const current = dragRef.current
    if (!current || current.kind !== 'project' || current.id === targetId) return
    if (pinnedProjects.has(current.id) !== pinnedProjects.has(targetId)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const placement = placementFromPointer(event)
    setDropTarget((previous) =>
      previous?.kind === 'project' &&
      previous.id === targetId &&
      previous.placement === placement
        ? previous
        : { kind: 'project', id: targetId, placement },
    )
  }

  const handleProjectDrop = (event: React.DragEvent<HTMLDivElement>, targetId: string) => {
    const current = dragRef.current
    const placement = placementFromPointer(event)
    endDrag()
    if (!current || current.kind !== 'project' || current.id === targetId) return
    if (pinnedProjects.has(current.id) !== pinnedProjects.has(targetId)) return
    const ids = orderedProjects.map((project) => project.id)
    const next = moveId(ids, current.id, targetId, placement)
    if (next === ids) return
    event.preventDefault()
    const nextOrder = { ...order, projects: next }
    writeSidebarOrder(nextOrder)
    setOrder(nextOrder)
  }

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const togglePinned = useCallback((kind: 'session' | 'project', id: string) => {
    setPins((previous) => {
      const next = kind === 'session'
        ? { ...previous, sessions: toggleId(previous.sessions, id) }
        : { ...previous, projects: toggleId(previous.projects, id) }
      writeSidebarPins(next)
      return next
    })
  }, [])

  /** 删除改成行内二次确认:先请求,确认按钮出现后再真正执行。 */
  const requestDelete = (kind: 'session' | 'project', id: string) => {
    closeContextMenu()
    setConfirming({ kind, id })
  }

  const confirmDelete = () => {
    const target = confirming
    setConfirming(null)
    if (!target) return
    if (target.kind === 'session') {
      const session = sessionsById.get(target.id)
      if (session) onDeleteSession(session)
      return
    }
    const project = orderedProjects.find((item) => item.id === target.id)
    if (project) onDeleteProject(project)
  }

  // 确认按钮点下时不要被“点到外面”的清场逻辑先撤掉;其余位置/ESC 都取消。
  useEffect(() => {
    if (!confirming) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('.confirm-delete-btn')) return
      setConfirming(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirming(null)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [confirming])

  const beginRename = (session: SessionSummary) => {
    closeContextMenu()
    setRenameTarget(session)
    setRenameDraft(sessionAlias(session.id) ?? sessionDisplayTitle(session))
  }

  const cancelRename = () => {
    setRenameTarget(null)
    setRenameDraft('')
  }

  const commitRename = () => {
    if (!renameTarget) return
    setSessionAlias(renameTarget.id, renameDraft)
    setRenameTarget(null)
    setRenameDraft('')
    bumpCatalogTick()
  }

  const createSessionInProject = useCallback((projectId: string) => {
    onNewSession(projectId)
  }, [onNewSession])

  const openSessionMenu = (event: React.MouseEvent, session: SessionSummary) => {
    event.preventDefault()
    event.stopPropagation()
    setConfirming(null)
    const pinned = pinnedSessionIds.has(session.id)
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          key: 'pin',
          label: pinned ? t('unpin') : t('pinToTop'),
          icon: <IconPin size={13} />,
          onSelect: () => togglePinned('session', session.id),
        },
        {
          key: 'rename',
          label: t('renameSession'),
          icon: <IconPencil size={13} />,
          onSelect: () => beginRename(session),
        },
        {
          key: 'delete',
          label: t('deleteSession'),
          icon: <IconTrash size={13} />,
          danger: true,
          disabled: !!runningIds[session.id],
          onSelect: () => requestDelete('session', session.id),
        },
      ],
    })
  }

  const openProjectMenu = (event: React.MouseEvent, project: ProjectRecord) => {
    event.preventDefault()
    event.stopPropagation()
    setConfirming(null)
    const pinned = pinnedProjects.has(project.id)
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          key: 'new-session',
          label: t('newSession'),
          icon: <IconNewSession size={13} />,
          onSelect: () => createSessionInProject(project.id),
        },
        {
          key: 'pin',
          label: pinned ? t('unpin') : t('pinToTop'),
          icon: <IconPin size={13} />,
          onSelect: () => togglePinned('project', project.id),
        },
        {
          key: 'delete',
          label: t('deleteProject'),
          icon: <IconTrash size={13} />,
          danger: true,
          disabled: project.builtin === 'default',
          onSelect: () => requestDelete('project', project.id),
        },
      ],
    })
  }

  const toggleChildCollapse = useCallback((id: string) => {
    setCollapsedChildren((previous) => ({
      ...previous,
      [id]: !previous[id],
    }))
  }, [])

  const changeView = (next: SidebarView) => {
    setView(next)
    writeSidebarView(next)
  }

  const renderProject = ({ project, members }: { project: ProjectRecord; members: SessionSummary[] }) => {
    const open = searching || isGroupOpen(project.id, members.some((session) => session.id === activeId))
    const nested = buildNestedRows(members)
    const visible = searching || showAll[project.id]
      ? nested.rows
      : nested.rows.slice(0, COLLAPSED_LIMIT)
    const dragging = dragState?.kind === 'project' && dragState.id === project.id
    const drop = dropTarget?.kind === 'project' && dropTarget.id === project.id
      ? dropTarget.placement
      : null
    const isDefault = project.builtin === 'default'
    return (
      <div className={`project-group${open ? ' open' : ''}${dragging ? ' dragging' : ''}`} key={project.id} data-project-id={project.id}>
        <div
          className={`project-group-head-row${drop ? ` drop-${drop}` : ''}`}
          onDragOver={(event) => handleProjectDragOver(event, project.id)}
          onDragLeave={handleDragLeave}
          onDrop={(event) => handleProjectDrop(event, project.id)}
          onContextMenu={(event) => openProjectMenu(event, project)}
        >
          <button
            type="button"
            className={`project-group-head${members.some((session) => session.id === activeId) ? ' active' : ''}`}
            title={project.dirs.join('\n')}
            aria-expanded={open}
            draggable={!isDefault}
            onDragStart={(event) => beginProjectDrag(event, project.id)}
            onDragEnd={endDrag}
            onClick={() => {
              const fallback = members.some((session) => session.id === activeId)
              setExpanded((previous) => ({
                ...previous,
                [project.id]: !(previous[project.id] ?? fallback),
              }))
            }}
          >
            <span className="project-folder">
              <IconProject size={14} />
            </span>
            <span className="name">{projectTitle(project)}</span>
            {project.dirs.length > 1 && (
              <span className="project-dir-count" title={project.dirs.join('\n')}>
                {project.dirs.length}
              </span>
            )}
            {pinnedProjects.has(project.id) && (
              <span className="pin-mark" title={t('pinnedLabel')} aria-label={t('pinnedLabel')} data-testid="pin-mark">
                <IconPin size={12} />
              </span>
            )}
            <span className="count">{members.length}</span>
          </button>
          <span className="row-actions">
            <button
              type="button"
              className={`row-action-btn${pinnedProjects.has(project.id) ? ' active' : ''}`}
              title={pinnedProjects.has(project.id) ? t('unpin') : t('pinToTop')}
              aria-label={pinnedProjects.has(project.id) ? t('unpin') : t('pinToTop')}
              aria-pressed={pinnedProjects.has(project.id)}
              onClick={() => togglePinned('project', project.id)}
            >
              <IconPin size={12} />
            </button>
            <button
              type="button"
              className="row-action-btn"
              title={t('newSessionIn', { name: projectTitle(project) })}
              onClick={() => createSessionInProject(project.id)}
            >
              <IconNewSession size={12} />
            </button>
            {isDefault ? null : confirming?.kind === 'project' && confirming.id === project.id ? (
              <button
                type="button"
                className="confirm-delete-btn"
                onClick={confirmDelete}
              >
                {t('confirmDeleteInline')}
              </button>
            ) : (
              <button
                type="button"
                className="row-action-btn danger"
                title={t('deleteProject')}
                onClick={() => requestDelete('project', project.id)}
              >
                <IconTrash size={12} />
              </button>
            )}
          </span>
        </div>
        <div className={`project-group-body${open ? ' open' : ''}`}>
          <div className="project-group-body-inner">
            <SessionRows
              view={{ ...nested, rows: visible }}
              activeId={activeId}
              secondaryId={secondaryId}
              runningIds={runningIds}
              collapsedChildren={collapsedChildren}
              pinnedSessionIds={pinnedSessionIds}
              confirming={confirming}
              now={now}
              onToggleCollapse={toggleChildCollapse}
              onOpen={(session) => openSession(session, project.id)}
              onRequestDelete={(id) => requestDelete('session', id)}
              onConfirmDelete={confirmDelete}
              onTogglePin={(id) => togglePinned('session', id)}
              onContextMenu={openSessionMenu}
            />
            {!searching && members.length > COLLAPSED_LIMIT && (
              <button
                type="button"
                className="expand-rest"
                onClick={() => setShowAll((previous) => ({ ...previous, [project.id]: !previous[project.id] }))}
              >
                {showAll[project.id]
                  ? t('collapse')
                  : t('expandRest', { n: members.length - COLLAPSED_LIMIT })}
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="sidebar-section">
      <div className="sidebar-filter" role="tablist" aria-label={t('sidebarViewLabel')}>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'projects'}
          className={`sidebar-filter-tab${view === 'projects' ? ' active' : ''}`}
          onClick={() => changeView('projects')}
        >
          {t('sidebarViewProjects')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'timeline'}
          className={`sidebar-filter-tab${view === 'timeline' ? ' active' : ''}`}
          onClick={() => changeView('timeline')}
        >
          {t('sidebarViewTimeline')}
        </button>
      </div>
      {searchOpen && (
        <div className="sidebar-search">
          <IconSessionSearch size={13} />
          <input
            ref={searchInputRef}
            type="search"
            className="sidebar-search-input"
            value={query}
            placeholder={t('searchSessionsPlaceholder')}
            aria-label={t('searchSessions')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              setQuery('')
              onSearchOpenChange(false)
            }}
          />
          {query && (
            <button
              type="button"
              className="icon-btn sidebar-search-clear"
              title={t('searchSessionsClear')}
              aria-label={t('searchSessionsClear')}
              onClick={() => setQuery('')}
            >
              <IconClose size={12} />
            </button>
          )}
        </div>
      )}
      <div className="session-list">
        {view === 'projects' ? (
          <>
            {projectsEmpty && (
              <div className="empty-hint">
                {searching ? t('searchSessionsEmpty') : t('emptySessions')}
              </div>
            )}
            {shelfView.rows.length > 0 && (
              <section
                className="sidebar-pinned-shelf"
                data-testid="sidebar-pinned-shelf"
                aria-label={t('pinnedTasksSection')}
              >
                <div className="sidebar-section-head">
                  <span className="name">{t('pinnedTasksSection')}</span>
                  <span className="count">{shelf.roots.length}</span>
                </div>
                <div className="project-group-body-inner">
                  <SessionRows
                    view={shelfView}
                    activeId={activeId}
                    secondaryId={secondaryId}
                    runningIds={runningIds}
                    collapsedChildren={collapsedChildren}
                    pinnedSessionIds={pinnedSessionIds}
                    confirming={confirming}
                    now={now}
                    onToggleCollapse={toggleChildCollapse}
                    onOpen={(session) => openSession(session, projectIdFor(session))}
                    onRequestDelete={(id) => requestDelete('session', id)}
                    onConfirmDelete={confirmDelete}
                    onTogglePin={(id) => togglePinned('session', id)}
                    onContextMenu={openSessionMenu}
                  />
                  {!searching && shelf.roots.length > PINNED_LIMIT && (
                    <button
                      type="button"
                      className="expand-rest"
                      onClick={() => setShowAllPinned((previous) => !previous)}
                    >
                      {showAllPinned
                        ? t('collapse')
                        : t('expandRest', { n: shelf.roots.length - PINNED_LIMIT })}
                    </button>
                  )}
                </div>
              </section>
            )}
            {pinnedGroups.length > 0 && (
              <div className="sidebar-pinned-projects" data-testid="sidebar-pinned-projects">
                {pinnedGroups.map(renderProject)}
              </div>
            )}
            {regularGroups.length > 0 && (
              <section className="sidebar-project-section" data-testid="sidebar-projects">
                <div className="sidebar-section-head">
                  <span className="name">{t('projectsSection')}</span>
                  <span className="count">{regularGroups.length}</span>
                </div>
                {regularGroups.map(renderProject)}
              </section>
            )}
          </>
        ) : (
          <>
            {timelineEmpty && (
              <div className="empty-hint">
                {searching ? t('searchSessionsEmpty') : t('emptySessions')}
              </div>
            )}
            {!timelineEmpty && (
              <div className="project-group open" data-testid="sidebar-timeline">
                <div className="project-group-body open">
                  <div className="project-group-body-inner">
                    <SessionRows
                      view={{ ...timelineView, rows: timelineVisible }}
                      activeId={activeId}
                      secondaryId={secondaryId}
                      runningIds={runningIds}
                      collapsedChildren={collapsedChildren}
                      pinnedSessionIds={pinnedSessionIds}
                      confirming={confirming}
                      now={now}
                      onToggleCollapse={toggleChildCollapse}
                      onOpen={(session) => openSession(session, projectIdFor(session))}
                      onRequestDelete={(id) => requestDelete('session', id)}
                      onConfirmDelete={confirmDelete}
                      onTogglePin={(id) => togglePinned('session', id)}
                      onContextMenu={openSessionMenu}
                    />
                    {!searching && timelineView.rows.length > timelineLimit && (
                      <button
                        type="button"
                        className="expand-rest"
                        onClick={() => setTimelineLimit((previous) => previous + TIMELINE_LIMIT)}
                      >
                        {t('expandRest', { n: timelineView.rows.length - timelineLimit })}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <SidebarContextMenu menu={contextMenu} onClose={closeContextMenu} />
      <ConfirmDialog
        open={renameTarget !== null}
        title={t('renameSession')}
        desc={t('renameSessionDesc')}
        confirmLabel={t('save')}
        onConfirm={commitRename}
        onCancel={cancelRename}
      >
        <input
          className="confirm-input"
          value={renameDraft}
          maxLength={80}
          autoFocus
          aria-label={t('renameSession')}
          onChange={(event) => setRenameDraft(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            commitRename()
          }}
        />
      </ConfirmDialog>
    </div>
  )
}
