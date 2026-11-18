import { useComposerPersistence } from '../features/conversation/useComposerPersistence'
import { useComposerAttachments } from '../features/conversation/useComposerAttachments'
import { useInputHistory } from '../features/conversation/useInputHistory'
import { saveComposer, type ComposerSnapshot } from '../composerMemory'
import { useSessionContext } from '../features/conversation/useSessionContext'
import { useComposerMentions } from '../features/conversation/useComposerMentions';
import { useComposerSlash } from '../features/conversation/useComposerSlash';
import { queuedPayload, type OutgoingPayload } from '../features/conversation/sessionState';
import { usePermissions } from '../features/conversation/usePermissions';
import { usePromptOptimize } from '../features/conversation/usePromptOptimize';
import { usePromptKeyboard } from '../features/conversation/usePromptKeyboard';
import { useMessageQueue, type PostMessageFn } from '../features/conversation/useMessageQueue';
import { peekQueueDefaultAction } from '../features/conversation/queueDefaults';
import { useSessionGoal } from '../features/conversation/useSessionGoal';
import { useSessionModelSelection } from '../features/conversation/useSessionModelSelection';
import { useSessionRuntime } from '../features/conversation/useSessionRuntime';
import { useSessionRewind } from '../features/conversation/useSessionRewind';
import { useSessionTranscriptStats } from '../features/conversation/useSessionTranscriptStats';
import { SessionHeader, HeroProjectRow } from '../components/SessionHeader';
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';
import * as api from '../api';
import { flushSync } from 'react-dom'

import { addSessionLocal, ensureSession, getActiveProject, markStarted, notify, refreshList, markCompacting, setActiveId, setRunningStatus, useCatalogTick, useCompactingFor, useRunningFor, useProjects, useSessions } from '../appStore';
import { t } from '../i18n';
import { ensureFollowing } from '../sessionStreams';
import { subagentModelLabel, subagentSnapshotFacts, subagentSnapshotText } from '../sessionDisplay';
import type { TranscriptNode } from '../fold';
import type { TrajectoryQuote } from '../trajectory';
import { SessionView } from '../components/SessionView';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { StatsBar } from '../components/StatsBar';
import { ComposerAttachments } from '../components/ComposerAttachments';
import { ComposerEditor } from '../components/ComposerEditor';
import { ComposerMenus } from '../components/ComposerMenus';
import { ComposerToolbar } from '../components/ComposerToolbar';
import { ChildSubagentBanner } from '../components/ChildSubagentBanner';
import { RewindDialog } from '../components/RewindDialog';
import { buildSessionContextQuote, validateContextQuotes } from '../features/conversation/composerContext';
import { PlanReviewPanel } from '../components/PlanReviewPanel';
import { PlanPreviewPanel } from '../components/PlanPreviewPanel';
import { ApprovalDialog } from '../components/ApprovalDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { IconArrowDown, IconPanelOpen } from '../components/icons';
import { useFollow } from '../streaming/useFollow';
import { SmoothStreamContext } from '../streaming/pressure';
import { useContainedWheel } from '../hooks/useContainedWheel';

import { collectSkillTokens, parseLeadingCommand } from './slash';
import { insertFileChip, selectionOffsetsIn, serializeEditor, setCaretOffset, syncEmptyMark } from './editor';
import { REFERENCE_MIME } from '../fileTree';
import { TodoPanel } from '../components/TodoPanel';
import { RuntimePanel } from '../components/RuntimePanel';
import { GoalBar } from '../components/GoalBar';
import { QueuedMessagePanel } from '../components/QueuedMessagePanel';
import { ConversationAxis } from '../components/ConversationAxis';
import type { AskAnswer, PendingAttachment, QueuedMessage, SessionSummary, UserMessageImage, ProjectRecord } from '../types';

export default function SessionsPage({
  activeId,
  locked,
  hasStarted,
  onSelectProject,
  onOpenPicker,
  onAddProject,
  sidePaneOpen = false,
  onToggleSidePane,
  secondary = false,
  navigate,
  planPreviewInPane = false,
  onPlanReviewChange,
}: {
  activeId: string | null
  locked: boolean
  hasStarted: boolean
  onSelectProject: (project: ProjectRecord) => void
  onOpenPicker: () => void
  onAddProject: () => void
  /** 右侧面板是否展开(切换按钮的激活态)。 */
  sidePaneOpen?: boolean
  /** 切换右侧面板。 */
  onToggleSidePane?: () => void
  /** 分屏副窗格:不渲染项目选择这类会触发全局动作的入口。 */
  secondary?: boolean
  /**
   * 组件内切换会话的出口。默认切全局 activeId;分屏副窗格由 App 注入,
   * 把切换(回退重挂/fork/会话消失)约束在本窗格内。
   */
  navigate?: (id: string | null, wsId?: string | null) => void
  /** 右侧工作台可用时，由 App 自动打开计划标签并承载正文。 */
  planPreviewInPane?: boolean
  onPlanReviewChange?: (review: { title?: string; planText: string } | null) => void
}) {
  const sessions = useSessions()
  const projects = useProjects()
  const catalogTick = useCatalogTick()
  // 切换会话的统一出口:主窗格走全局 activeId,分屏副窗格由 App 注入
  // navigate 把切换约束在本窗格内(窗格语义见 splitView.ts)。
  const go = navigate ?? setActiveId
  const activeSession: SessionSummary | null = activeId
    ? (sessions.find((s) => s.id === activeId) ?? null)
    : null
  // 会话摘要的镜像:模型恢复在 React 效果里读它,避免把 activeSession 放进
  // 依赖 —— 列表刷新(标题/时间变化)会让摘要对象整个换新,进了依赖就会
  // 反复触发恢复,把用户手动换的模型顶回摘要里的旧值。
  const activeSessionRef = useRef<SessionSummary | null>(activeSession)
  activeSessionRef.current = activeSession
  // 子代理身份摘要（定义、冻结工具数、权限上限、仅项目级指令、不能派遣）：
  // 只读运行快照的事实，子会话页与父侧面板共用同一份纯函数。
  const descriptorText = useMemo(
    () => subagentSnapshotText(activeSession?.subagent),
    [activeSession?.subagent],
  )
  // 子会话横幅：标题名与键值对同出一份运行快照（与父侧面板同源）。
  const subagentFacts = useMemo(
    () => subagentSnapshotFacts(activeSession?.subagent),
    [activeSession?.subagent],
  )
  const subagentModel = useMemo(
    () => subagentModelLabel(activeSession?.subagent),
    [activeSession?.subagent],
  )
  const {
    catalog,
    selection,
    applySelection,
    effortLevels,
    activeEffort,
    ensureVision,
  } = useSessionModelSelection({ activeId, catalogTick, activeSessionRef })

  // 运行状态直接订阅引擎(侧栏/状态栏同源)。
  const running = useRunningFor(activeId)
  // 最新 running 的 ref 镜像:异步函数(轮询等 running 变 false)读它,
  // 避免闭包捕获渲染时的旧值。
  const runningRef = useRef(running)
  runningRef.current = running

  const [prompt, setPrompt] = useState('')
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [planPreviewDismissed, setPlanPreviewDismissed] = useState(false)
  // 提示词优化状态在 usePromptOptimize 里;applyDraft 由 useComposerSlash
  // 产出,晚于该 hook,故走 ref 转发(页面每渲染重赋)。
  const applyDraftRef = useRef<(text: string) => void>(() => {})
  // 已发送未获服务端确认的用户消息(乐观行)。
  const [pendingMessages, setPendingMessages] = useState<
    { text: string; images?: UserMessageImage[] }[]
  >([])
  // 回退成功后递增,强制重挂载 SessionView 重新拉快照。
  const [transcriptReloadTick, setTranscriptReloadTick] = useState(0)
  /**
   * 压缩中:来自全局 store(sessionStorage 持久化),刷新后仍可恢复。
   * 早先放在组件 useState 里,一刷新就丢 —— 而后端任务其实还在跑。
   */
  const compactingAt = useCompactingFor(activeId)
  const {
    transcriptNodes,
    sessionTotals,
    openTurnAt,
    axisAnchors,
    setAxisAnchors,
    axisJump,
    setAxisJump,
    nodesRef,
    applyNodes,
    clearNodes,
    reset: resetTranscriptStats,
  } = useSessionTranscriptStats(activeId)
  const {
    todos,
    setTodos,
    runtimeEvents,
    setRuntimeEvents,
    runtimeCounts,
    runtimeCollapsed,
    setRuntimeCollapsed,
    handleRuntimeCountsChange,
    reset: resetRuntime,
  } = useSessionRuntime()
  const { goalView, refreshGoal, goalSummaryText } = useSessionGoal(activeId)
  // 消息队列:AI 运行中输入的新消息,等本轮结束后自动发送(状态与操作在 useMessageQueue)。
  // 会话内容视图:对话 / 轨迹。组件按
  // activeId 重挂(key),视图状态随会话切换自然复位。
  const [view, setView] = useState<'chat' | 'trajectory'>('chat')
  // 导出菜单状态:exportOpen 控制下拉显隐,exportBusy 阻及双击。
  const [exportOpen, setExportOpen] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const sendingRef = useRef(false)
  // contentEditable 输入器(原 textarea):DOM 是草稿的事实源,prompt 状态
  // 只作镜像(input 事件同步),外部写路径统一走 applyDraft 重建 DOM。
  const promptRef = useRef<HTMLDivElement | null>(null)
  const composerPanelRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // 对话内容列:增长(工具卡展开/图片加载/markdown 回流)不一定伴随 nodes 变化,
  // ResizeObserver 观察它才能兜住所有内容增高路径。
  const viewRef = useRef<HTMLDivElement | null>(null)
  const seatRef = useRef<HTMLDivElement | null>(null)
  // 布局根:回底按钮等多处需要读/写挂在共同祖先上的尺寸变量。
  const layoutRef = useRef<HTMLDivElement | null>(null)

  /* ---- 对话流贴底跟随 ---- *
   * 判定与驱动都在 useFollow 里(见 streaming/useFollow 顶部注释),这里只管把
   * 「内容变了」与「程序性跳转」两个信号接进去。 */
  const follower = useFollow(scrollRef, { active: running || compactingAt !== null })
  const stick = follower.stick
  const snapToBottom = follower.snapToBottom
  const releaseFollow = follower.release
  const resetFollow = follower.reset
  const follow = follower.follow

  const activeProject: ProjectRecord | null = getActiveProject()

  const syncPromptHeight = useCallback(() => {
    const el = promptRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  const inert = !activeId && !activeProject

  /* 占位提示跟内容走,不跟 DOM 结构走:浏览器删掉最后一段文字后会补一个
   * 占位 `<br>`,`:empty` 因此不再匹配、提示消失。看观察器而不是只改输入
   * 回调,是因为改写子树的入口不止输入:slash 菜单回填、历史回退、粘贴与
   * 撤销都在这一层。 */
  useEffect(() => {
    const el = promptRef.current
    if (!el) return
    syncEmptyMark(el)
    const observer = new MutationObserver(() => syncEmptyMark(el))
    observer.observe(el, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [])
  const composingRef = useRef(false)
  const inputHistory = useInputHistory({ sessionId: activeId })
  const {
    optimizing, setOptimizing, optimizingRef, optimizedPrompt, setOptimizedPrompt,
    originalPromptRef, optimizeAbortRef, handleOptimize, handleUndoOptimize,
  } = usePromptOptimize({ activeId, selection, inert, running, sending, prompt, applyDraftRef })
  const onDraftChange = useCallback((text: string) => {
    inputHistory.resetBrowse()
    setPrompt(text)
    setOptimizedPrompt(null)
    originalPromptRef.current = ''
  }, [inputHistory.resetBrowse])
  const contextProjectPath = activeId ? activeSession?.cwd ?? null : activeProject?.dirs[0] ?? null
  const mentionCwd = activeSession?.cwd_alive === false ? null : contextProjectPath
  const { mentionOpen, mentionItems, mentionLoading, mentionQuery, mentionActive, setMentionActive,
    mentionMenuRef, closeMention, refreshMentions, pickMention } = useComposerMentions({
      mentionCwd, promptRef, onDraftChange, syncPromptHeight,
    })
  const { slashOpen, slashItems, slashActive, setSlashActive, slashMenuRef, skillEntries,
    applyDraft, closeSlash, refreshMenus, pickSlash, onEditorDrop, runCompactRef } = useComposerSlash({
      activeId, inert, prompt, promptRef, setPrompt, setOptimizedPrompt, originalPromptRef,
      syncPromptHeight, closeMention, refreshMentions, composingRef,
    })
  applyDraftRef.current = applyDraft

  /* ---- 从侧栏「项目文件」树拖入的引用 ---- */

  /** 拖拽悬停:只有本应用树里拖来的引用才接受,其余(外部文本/文件)交回浏览器。 */
  const onEditorDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(REFERENCE_MIME)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  // 会话切换仅复位派生视图；草稿和队列由持久化通道恢复。
  //
  // 依赖只挂 activeId —— 这是一次"换会话"的复位,不是"回调换了个引用"的
  // 复位。closeMention / resetFollow 走 ref 转发:它们挂在别的 hook 上,
  // 身份会随着项目、cwd、运行状态在挂载过程中变化,一旦进了依赖数组,
  // 这个 effect 会在会话加载**之后**再跑一次,把刚收到的 transcriptNodes
  // 清空 —— 表现就是输入框下方的状态栏(StatsBar)整场不再出现(它只吃
  // nodes,而此刻已无新节点推送)。
  const resetFollowRef = useRef(resetFollow)
  resetFollowRef.current = resetFollow
  const closeMentionRef = useRef(closeMention)
  closeMentionRef.current = closeMention
  useEffect(() => {
    optimizeAbortRef.current?.abort()
    optimizeAbortRef.current = null
    optimizingRef.current = false
    setOptimizing(false)
    setOptimizedPrompt(null)
    originalPromptRef.current = ''
    setSending(false)
    setPendingMessages([])
    sendingRef.current = false
    closeMentionRef.current()
    resetTranscriptStats()
    resetRuntime()
    // 新会话从顶部开始且重新吸底:复位归属,不写 DOM(scrollTop 归零)。
    resetFollowRef.current()
    const el = scrollRef.current
    if (el !== null) el.scrollTop = 0
  }, [activeId])

  useEffect(() => {
    if (running && sending) {
      setSending(false)
    }
  }, [running, sending])

  const hasHistory = Boolean(activeSession?.excerpt)
  const showTranscript = Boolean(
    activeId &&
      (hasStarted ||
        sending ||
        hasHistory ||
        pendingMessages.length > 0 ||
        // A goal continuation produces no visible user message; the session
        // must still leave the hero state so the goal bar and turns show.
        goalView?.goal),
  )
  const phase = showTranscript ? 'active' : 'hero'

  /* ---- 粘贴图片 / 附件上传 / 权限与审批 ---- */

  const [pastedImages, setPastedImages] = useState<{
    name: string
    mime: string
    data: string
    bytes: number
    preview: string
  }[]>([])
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  // 轨迹引用(芯片挂在输入框上方,随消息以 injected 上下文注入)。
  const [trajQuotes, setTrajQuotes] = useState<TrajectoryQuote[]>([])
  const composerScope = activeId ? `session:${activeId}` : activeProject ? `project:${activeProject.id}` : null
  const composerSnapshotRef = useRef<ComposerSnapshot>({ text: '', images: [], attachments: [], quotes: [], queue: [] })
  const composerReadyRef = useRef(false)
  // postMessage 镜像:每渲染重赋(赋值处在 postMessage 定义之后),
  // 队列自动发送 effect 与立即发送读它拿最新闭包。
  const postMessageRef = useRef<PostMessageFn>(async () => false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const {
    queuedMessages, setQueuedMessages, setAutoFlushSuppressed, sendNow, editQueued, deleteQueued,
    confirmedRef, settlePending, pushPending, enqueueMessage, updateQueued,
  } = useMessageQueue({
    activeId, running, composerReadyRef, composerScope, postMessageRef, composerSnapshotRef,
    runningRef, mountedRef, applyDraft, promptRef, setPastedImages, setAttachments, setTrajQuotes,
    pastedImages, attachments, trajQuotes, setPendingMessages,
  })
  const { rewindReq, setRewindReq, handleRewind, confirmRewind } = useSessionRewind({
    activeId,
    runningRef,
    nodesRef,
    inputHistoryRefresh: inputHistory.refresh,
    applyDraft,
    setPastedImages,
    setAttachments,
    setQueuedMessages,
    setPendingMessages,
    clearNodes,
    confirmedRef,
    setAutoFlushSuppressed,
    onRewound: () => setTranscriptReloadTick((tick) => tick + 1),
  })
  const composerSnapshot = useMemo<ComposerSnapshot>(() => ({
    text: prompt, images: pastedImages, attachments, quotes: trajQuotes, queue: queuedMessages,
  }), [prompt, pastedImages, attachments, trajQuotes, queuedMessages])
  composerSnapshotRef.current = composerSnapshot
  const { ready: composerReady, flush: flushComposer } = useComposerPersistence({
    scope: composerScope,
    snapshot: composerSnapshot,
    restore: (saved) => {
      applyDraft(saved.text)
      setPastedImages(saved.images)
      setAttachments(saved.attachments)
      setTrajQuotes(saved.quotes)
      setQueuedMessages(saved.queue)
    },
    onError: (message) => notify('err', message),
  })
  composerReadyRef.current = composerReady
  const promptEmpty =
    !prompt.trim() &&
    pastedImages.length === 0 &&
    attachments.length === 0 &&
    trajQuotes.length === 0
  const primaryStops = running && promptEmpty
  // 权限档位与审批(三态、后端写入口、审批弹窗、计划审批)与会话预设
  // (同一"已建会话写日志,未建会话先记本地"的套路)整体在 usePermissions。
  const {
    permission, setPermission, permissionBusy, fullAccessConfirm, confirmFullAccess,
    cancelFullAccess, approvalReq, requestPermissionChange,
    handleApproval, planReview, handlePlanDecision, handlePlanExit, showApproveForMe,
    agentPresetCatalog, agentPresetChoice, agentPresetBusy, agentPresetId, changeAgentPreset,
  } = usePermissions({ activeId, activeSession, catalogTick, applySelection })
  useEffect(() => {
    onPlanReviewChange?.(planReview)
  }, [planReview, onPlanReviewChange])
  useEffect(() => () => onPlanReviewChange?.(null), [onPlanReviewChange])
  useEffect(() => setPlanPreviewDismissed(false), [planReview?.requestId])
  const contextSelectionRef = useRef({ start: 0, end: 0 })
  const contextQuotesRef = useRef(trajQuotes)
  contextQuotesRef.current = trajQuotes

  const openContextMenu = () => {
    const editor = promptRef.current
    if (editor) contextSelectionRef.current = selectionOffsetsIn(editor)
    closeMention()
    closeSlash()
  }

  const insertContextFile = (candidate: api.MentionCandidate) => {
    const editor = promptRef.current
    if (!editor) return
    const draft = serializeEditor(editor)
    const start = Math.min(contextSelectionRef.current.start, draft.length)
    const end = Math.min(contextSelectionRef.current.end, draft.length)
    editor.focus({ preventScroll: true })
    if (!insertFileChip(editor, candidate, start, end)) return
    onDraftChange(serializeEditor(editor))
    syncPromptHeight()
    closeMention()
    closeSlash()
  }

  const insertContextCommand = (name: string) => {
    const editor = promptRef.current
    if (!editor) return
    const draft = serializeEditor(editor)
    const existing = parseLeadingCommand(draft)
    const body = existing?.kind === 'goal' || existing?.kind === 'plan' ? existing.rest ?? '' : draft
    applyDraft(`/${name} ${body}`)
    editor.focus({ preventScroll: true })
    setCaretOffset(editor, name.length + 2 + body.length)
    closeMention()
    closeSlash()
  }

  const addContextSession = async (session: SessionSummary, signal: AbortSignal) => {
    const page = await api.getSessionPage(session.id, { limit: 300 }, signal)
    if (signal.aborted) return
    const quote = buildSessionContextQuote(session, page.events, page.hasMoreBefore)
    const next = [...contextQuotesRef.current.filter(item => item.id !== quote.id), quote]
    validateContextQuotes(next)
    contextQuotesRef.current = next
    setTrajQuotes(next)
    promptRef.current?.focus({ preventScroll: true })
    closeMention()
    closeSlash()
  }

  const { onEditorPaste, onPickFiles } = useComposerAttachments({
    optimizing,
    ensureVision,
    setPastedImages,
    setAttachments,
  })

  const onEditorCopy = (event: ClipboardEvent<HTMLDivElement>, cut = false) => {
    const editor = promptRef.current
    const selection = window.getSelection()
    if (!editor || !selection?.rangeCount || selection.isCollapsed) return
    const range = selection.getRangeAt(0)
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return
    const fragment = document.createElement('div')
    fragment.append(range.cloneContents())
    event.preventDefault()
    event.clipboardData.setData('text/plain', serializeEditor(fragment))
    if (cut && editor.isContentEditable) {
      document.execCommand('delete')
      onDraftChange(serializeEditor(editor))
      syncPromptHeight()
      refreshMenus()
    }
  }

  // 回合启动推一把:首块内容到达前先落到底,后续由 onNodesChange 接管。
  useEffect(() => {
    follow()
  }, [running, follow])

  // 运行中或正在压缩的会话才需要 SSE follow 长连接;普通浏览走分页快照,
  // 避免打开长会话就把完整历史加载进服务端 live cache。压缩期间保持 follow
  // 才能收到收尾的 compaction-summary 事件。
  useEffect(() => {
    if (activeId && (running || compactingAt !== null)) ensureFollowing(activeId)
  }, [activeId, running, compactingAt])

  useEffect(() => {
    syncPromptHeight()
  }, [prompt, phase])

  /* ---- 布局宽度档位(窄容器响应) ----
   * 视口媒体查询覆盖不到"视口宽、容器窄"的场景(分屏两窗格、主列被面板
   * 挤窄)。这里量的是布局自身的宽度,写进 data 属性,由 CSS 让输入区
   * 提前进入紧凑/两行布局,而不是等视口断点。 */
  const [layoutFit, setLayoutFit] = useState<'wide' | 'compact' | 'tight'>('wide')
  useEffect(() => {
    const el = layoutRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const width = el.getBoundingClientRect().width
      setLayoutFit(width < 560 ? 'tight' : width < 720 ? 'compact' : 'wide')
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /* ---- 输入框自动聚焦 ----
   * 进入欢迎态/切换会话后,只要输入框可编辑就自动获得焦点,用户不必先点一下
   * 才能打字。三类情况不抢:输入框不可编辑(inert/优化中)、有弹窗在等用户
   * 决策(审批/计划评审/回退与全权确认)、用户当前焦点在别的输入控件上
   * (搜索框、浏览器面板的地址栏等)。视图切回对话也算一次"进入",一并聚焦。 */
  useEffect(() => {
    if (inert || optimizing) return
    if (approvalReq || rewindReq || fullAccessConfirm || planReview) return
    const el = promptRef.current
    if (el === null) return
    const active = document.activeElement
    if (active === el) return
    // 已有别的可输入控件握着焦点(搜索框/地址栏/弹窗输入):不抢。
    if (
      active instanceof HTMLElement &&
      (active.isContentEditable ||
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'SELECT')
    ) {
      return
    }
    el.focus({ preventScroll: true })
  }, [
    activeId,
    phase,
    view,
    inert,
    optimizing,
    approvalReq,
    rewindReq,
    fullAccessConfirm,
    planReview,
  ])

  // composer seat / 内容列 / 滚动口尺寸变化时,贴底读者保持视野。
  // 内容列观察兜住不伴随 nodes 变化的增高(展开工具卡、图片加载等)。
  //
  // 依赖必须带上 view:轨迹视图下输入区整体卸载,切回对话时拿到的是**另一个**
  // DOM 节点。只依赖 phase 时 observer 会一直盯着已卸载的旧节点,而它对被
  // 移除的元素仍会补发一次回调 —— 那次读到 offsetHeight 为 0,把
  // --composer-height 写成 0px;新节点又从未被 observe,高度再也量不回来。
  // 回底按钮靠这个变量定位,0px 会让它退到容器底部、压在状态栏上。
  useEffect(() => {
    const scroller = scrollRef.current
    const view = viewRef.current
    const layout = layoutRef.current
    if (scroller === null || view === null || layout === null) return
    const measure = () => {
      // 输入区高度要写到布局根上:回底按钮是滚动容器的兄弟节点,只有挂在
      // 共同祖先(session-layout)才继承得到 —— 挂在滚动容器上时按钮拿不到
      // 真实高度,只能用兜底值定位,于是被 sticky 输入区盖住,既看不见也
      // 点不到。滚动容器那份保留:对话轴与滚动口内部还按它算。
      const seat = seatRef.current
      // 输入区不在(轨迹视图)或节点已脱离文档时不写:对已卸载的节点读
      // offsetHeight 得 0,会把按钮按到底部。保留上一次的真实高度即可 ——
      // 这两个消费者此刻本来也不渲染。
      if (seat !== null && seat.isConnected) {
        const height = `${seat.offsetHeight}px`
        layout.style.setProperty('--composer-height', height)
        scroller.style.setProperty('--composer-height', height)
      }
      scroller.style.setProperty('--conversation-viewport-height', `${scroller.clientHeight}px`)
      follow()
    }
    const observer = new ResizeObserver(() => measure())
    const seat = seatRef.current
    if (seat !== null) observer.observe(seat)
    observer.observe(scroller)
    observer.observe(view)
    // 立即量一次:observe() 的首次回调要等下一帧,而切回对话视图时变量
    // 可能还留着上一轮的 0px,按钮会在那一帧里错位。
    measure()
    return () => observer.disconnect()
  }, [phase, view])

  /* ---- 分支:从收尾消息分叉出全新会话并立即切换 ---- */

  const forkBusyRef = useRef(false)

  const handleFork = useCallback(
    async (seq: number) => {
      if (!activeId || forkBusyRef.current) return
      forkBusyRef.current = true
      try {
        const { session } = await api.forkSession(activeId, seq)
        // 子会话挂同一项目(fork 后立即 open 子会话)。
        addSessionLocal({ ...session, cwd_alive: true }, activeProject?.id)
        go(session.id, activeProject?.id ?? null)
        void refreshList()
      } catch (error) {
        notify('err', error instanceof Error ? error.message : String(error))
      } finally {
        forkBusyRef.current = false
      }
    },
    [activeId, activeProject, go],
  )

  /* ---- 轨迹引用:芯片挂到输入框上方,随消息注入(与粘贴图片一致) ---- */

  const handleQuote = useCallback((quote: TrajectoryQuote) => {
    setTrajQuotes((previous) => [...previous, quote])
    // 引用动作来自轨迹视图:切回对话视图,在输入框上方补写问题后发送。
    setView('chat')
    notify('ok', t('trajQuoted'))
  }, [])

  /* ---- 传给 SessionView 的回调:引用必须稳定 ----
   * 这些回调一路透传到 transcript 的 NodeView(memo 化)。若在 JSX 里写内联
   * 箭头,每次页面渲染都是新引用,浅比较必然失败 —— 所有历史行都会跟着
   * 重渲染,memo 形同虚设。 */

  const handleNodesChange = useCallback(
    (nodes: TranscriptNode[]) => {
      applyNodes(nodes)
      follow()
    },
    [applyNodes, follow],
  )

  const handleJumpSettled = useCallback(() => setAxisJump(null), [])

  const handleRewindClick = useCallback(
    (seq: number) => {
      void handleRewind(seq)
    },
    [handleRewind],
  )

  const handleForkClick = useCallback(
    (seq: number) => {
      void handleFork(seq)
    },
    [handleFork],
  )

  const handleLoopContinue = useCallback(() => {
    // 死循环保护提示行的「继续」:程序化发送继续消息。
    void postMessageRef.current('继续', { clearInput: false })
  }, [])

  const handleAskAnswer = useCallback(
    (requestId: string, answers: AskAnswer[]) => {
      if (!activeId) return
      api
        .answerAsk(activeId, requestId, answers)
        .catch((error) => notify('err', error instanceof Error ? error.message : String(error)))
    },
    [activeId, notify],
  )

  const handleAskCancel = useCallback(
    (requestId: string) => {
      if (!activeId) return
      api
        .cancelAsk(activeId, requestId)
        .catch((error) => notify('err', error instanceof Error ? error.message : String(error)))
    },
    [activeId, notify],
  )

  const handleGoalTouch = useCallback(() => {
    if (activeId) refreshGoal(activeId)
  }, [activeId, refreshGoal])

  const handleNotFound = useCallback(() => {
    // 会话已被删除(其他窗口/流 404):清空视图。分屏副窗格由 App 的
    // navigate 实现退到单窗格,而不是清掉主会话。
    go(null, null)
  }, [go])

  const { context } = useSessionContext(activeId)

  const showAttachRow =
    pastedImages.length > 0 || attachments.length > 0 || trajQuotes.length > 0

  /**
   * 发送流程(乐观):
   * 1. 确保会话存在(复用/创建);
   * 2. postPrompt 成功 → 立即注入乐观用户行 + running,界面零等待;
   * 3. 服务端事件(同文本 user-message)到达 → 移除乐观行(由 Server 流确认);
   * 4. 失败 → 移除乐观行、恢复输入框、报错。
   */
  /** 清空输入区(文本/优化缓存/图片/附件/轨迹引用),手动发送与命令消费共用。 */
  const clearComposerState = () => {
    applyDraft('')
    setPastedImages([])
    setAttachments([])
    setTrajQuotes([])
  }

  /**
   * 手动压缩上下文:对话流尾部挂"正在压缩"占位行,结束(成功/无可压缩/
   * 失败)一律撤掉 —— 成功时真正的摘要会作为 compaction 事件到达并就地
   * 出现在原位,占位行不抢它的位置。
   *
   * 后端是一次 await、没有中间进度事件,所以这里只表达"进行中";
   * 不画假进度条 —— 不知道百分比就不该装作知道。
   */
  const compactingRef = useRef(false)
  /**
   * 发起压缩:后端 202 接单后立即返回,不 await 结果。
   *
   * 压缩现在与发轮次同构(spawn 到后台),刷新页面不再打断它;这里只负责
   * 打上"正在压缩"标记,收尾由三处驱动:成功 → compaction-summary 事件
   * 到达;无可压缩/失败 → `compaction-failed` 广播;页面刷新 → 标记从
   * sessionStorage 恢复,再由 running 快照判定是否已结束。
   */
  const runCompact = async (id: string): Promise<void> => {
    if (compactingRef.current) return
    compactingRef.current = true
    try {
      await api.compactSession(id)
      markCompacting(id, Date.now())
    } catch (error) {
      notify('err', error instanceof Error ? error.message : t('contextCompactFailed'))
    } finally {
      compactingRef.current = false
    }
  }
  runCompactRef.current = runCompact

  /**
   * 核心发送:把指定消息发往当前会话(复用乐观行/附件/引用的完整流程)。
   * 供输入框 send 与队列自动发送共用。
   */
  const postMessage = async (
    text: string,
    options?: {
      clearInput?: boolean
      payload?: OutgoingPayload
      source?: 'user' | 'queue' | 'interject' | 'guide'
    },
  ): Promise<boolean> => {
    if (sendingRef.current || !composerReady) return false
    // 载荷:显式传入优先(队列消息),否则取输入区当前内容。
    const outgoingImages = options?.payload?.images ?? pastedImages
    const outgoingAttachments = options?.payload?.attachments ?? attachments
    const outgoingQuotes = options?.payload?.quotes ?? trajQuotes
    // 正文兜底:后端拒绝空 prompt,而纯图片/纯附件/纯引用的消息本身合法。
    // 只在确实无正文时造一句占位文案,用户写过的字一律原样保留。
    const outgoingText =
      text.trim() ||
      (outgoingImages.length > 0
        ? t('pastedImageLabel')
        : outgoingAttachments.length > 0
          ? outgoingAttachments[0].name
          : outgoingQuotes.length > 0
            ? outgoingQuotes[0].title
            : text)
    // 粘贴图片:模型必须标记为可识图,否则拒绝整条发送。
    if (outgoingImages.length > 0 && !ensureVision()) return false
    // 发送 = 用户要看回复:立即恢复吸底,不等 202——服务端可能先于
    // postPrompt 响应就开始推流,此刻不吸底,后续内容全会落在视口之外。
    snapToBottom()
    sendingRef.current = true
    setSending(true)
    let ok = false
    let createdId: string | null = null
    try {
      // 从欢迎页发首条消息时,活动会话尚未创建;把当前选择的权限带到新会话。
      const wasHero = !activeId
      await flushComposer()
      const id = activeId ?? await ensureSession(activeProject, false)
      if (!activeId) createdId = id
      if (!id) {
        onOpenPicker()
        return false
      }
      markStarted(id)
      if (wasHero && permission !== 'auto-edit') {
        await api.setSessionPermission(id, permission)
      }
      // 欢迎页选过预设而那时还没有会话:现在补上,与权限同一处应用。
      if (wasHero && agentPresetChoice) {
        await api.setSessionAgentPreset(id, agentPresetChoice)
      }
      // 斜杠命令裁定(单一发送咽喉:手动发送/队列自动发送/立即发送共用);
      // 命令优先于技能(行认领)。
      const command = parseLeadingCommand(text)
      // 命令裁定看原文(占位文案不该被当成命令);实际发往模型的正文用
      // outgoingText —— 无正文时它已经兜底成图片/附件/引用的可读摘要。
      let body = outgoingText
      if (command?.kind === 'plan') {
        if (permission !== 'plan') {
          await api.setSessionPermission(id, 'plan')
          setPermission('plan')
          try {
            window.localStorage.setItem('denia.permission', 'plan')
          } catch {
            /* storage unavailable */
          }
          notify('ok', t('slashPlanOn'))
        } else {
          notify('ok', t('slashPlanAlready'))
        }
        const rest = (command.rest ?? '').trim()
        if (!rest) {
          // 裸 /plan:只切模式,不发消息;手动发送时清空输入区(队列刷新不清)。
          if (options?.clearInput !== false) clearComposerState()
          ok = true
          return true
        }
        body = rest
      } else if (command?.kind === 'compact') {
        if ((command.rest ?? '').trim()) throw new Error(t('slashCompactNoArgs'))
        await runCompact(id)
        if (options?.clearInput !== false) clearComposerState()
        ok = true
        return true // 裸 /compact:直接压缩,不发消息
      } else if (command?.kind === 'goal') {
        // /goal [<objective>|edit <objective>|pause|resume|clear]
        // 命令原文随请求落 command-run 事件:回显按真实 seq 排进对话流。
        const rest = (command.rest ?? '').trim()
        const sub = rest.split(/\s+/u, 1)[0] ?? ''
        try {
          if (!rest) {
            // 裸 /goal:查看当前目标(本地只读,无副作用不落事件)。
            const view = await api.getGoal(id)
            notify('ok', view.goal ? goalSummaryText(view) : t('goalNone'))
          } else if (sub === 'pause' || sub === 'resume' || sub === 'clear') {
            if (rest !== sub) throw new Error(t('slashGoalTrailing'))
            await api.goalAction(id, { action: sub }, selection ?? undefined, text)
            notify('ok', sub === 'pause' ? t('goalPaused') : sub === 'resume' ? t('goalResumed') : t('goalCleared'))
            refreshGoal(id)
          } else if (sub === 'edit') {
            const objective = rest.slice('edit'.length).trim()
            if (!objective) throw new Error(t('slashGoalNeedObjective'))
            await api.goalAction(id, { action: 'edit', objective }, selection ?? undefined, text)
            notify('ok', t('goalEdited'))
            refreshGoal(id)
          } else {
            // 其余文本整体作为新目标(set;complete 目标直接覆盖重开)。
            await api.goalAction(id, { action: 'set', objective: rest }, selection ?? undefined, text)
            notify('ok', t('goalCreated'))
            refreshGoal(id)
          }
        } catch (error) {
          notify('err', error instanceof Error ? error.message : String(error))
        }
        if (options?.clearInput !== false) clearComposerState()
        ok = true
        return true // /goal 系列都是本地命令,不发消息
      }
      // 技能直调:首行裸 /name 由后端 skill_gesture 注入(collectSkillTokens
      // 已剔除该场景防双重注入);其余命中 user-invocable 词典的 token 收进
      // skills 数组,由后端以「用户显式调用技能」注入。
      const skillNames = collectSkillTokens(
        body,
        skillEntries.map((skill) => skill.name),
      )
      validateContextQuotes(outgoingQuotes)
      // 附件:直接引用本机路径,不再读内容上传。大文件只是路径一条,不占带宽。
      const uploadedPaths = outgoingAttachments.map((attachment) => attachment.path)
      await api.postPrompt(id, {
        prompt: body,
        provider: selection?.provider,
        model: selection?.model,
        reasoningEffort: selection?.reasoningEffort,
        images: outgoingImages.map(({ name, mime, data }) => ({ name, mime, data })),
        files: uploadedPaths,
        quoted: outgoingQuotes.map(({ title, text }) => ({ title, text })),
        skills: skillNames.length > 0 ? skillNames : undefined,
        source: options?.source ?? 'user',
      })
      // 发送成功后立即打开 follow,收流式增量;不要等 running SSE 才建连。
      ensureFollowing(id)
      void inputHistory.refresh()
      const sentImages: UserMessageImage[] = outgoingImages.map(({ mime, data }) => ({ mime, data }))
      // 收到 202:服务端已接单,立即乐观反馈(running 也由服务端 SSE 推送)。
      pushPending(body, sentImages.length > 0 ? sentImages : undefined)
      setRunningStatus(id, true)
      if (options?.clearInput !== false) {
        // 仅"输入框发送"清空输入区;队列自动发送不清空(用户可能正在打字)。
        clearComposerState()
      }
      ok = true
    } catch (error) {
      notify('err', error instanceof Error ? error.message : String(error))
      // 保留输入框内容;若会话侧已经创建但发送失败,等待用户重试。
    } finally {
      if (createdId) {
        try {
          const empty: ComposerSnapshot = { text: '', images: [], attachments: [], quotes: [], queue: [] }
          const retained = ok ? empty : composerSnapshotRef.current
          await saveComposer(`session:${createdId}`, retained)
          if (mountedRef.current) {
            flushSync(() => clearComposerState())
            await flushComposer()
          }
          if (composerScope) await saveComposer(composerScope, empty)
          if (mountedRef.current) go(createdId, activeProject?.id)
        } catch (error) { notify('err', String(error)) }
      } else if (ok && options?.clearInput !== false && !mountedRef.current && composerScope) {
        await saveComposer(composerScope, { ...composerSnapshotRef.current, text: '', images: [], attachments: [], quotes: [] })
      }
      sendingRef.current = false
      setSending(false)
    }
    return ok
  }

  const send = async () => {
    const trimmed = prompt.trim()
    // 可发判定:正文、图片、附件、轨迹引用任一非空即可发(空正文由
    // postMessage 在发往后端前兜底成一句话,队列里保留用户真实输入)。
    const hasPayload =
      pastedImages.length > 0 || attachments.length > 0 || trajQuotes.length > 0
    if (!composerReady || optimizing || (!trimmed && !hasPayload) || sendingRef.current) return
    if (inert) {
      onOpenPicker()
      return
    }
    // AI 正在运行:照旧入队,本轮结束自动发送。常规设置里的默认方式决定
    // 是否立即投递:插话打断当前轮次后发送,引导交给模型在步骤边界接收;
    // 「每次询问」保留原行为,由队列条目上的选择器决定。
    if (running) {
      const defaultAction = peekQueueDefaultAction()
      const queued = enqueueMessage(trimmed)
      if (defaultAction === 'interject') {
        // 插话失败时消息会留在队列，mode 一并记成 interject 以保留来源。
        updateQueued(queued.id, { mode: 'interject' })
        await sendNow(queued)
      } else if (defaultAction === 'guide') {
        await guideQueued(queued)
      } else {
        notify('ok', t('queueSentHint'))
      }
      return
    }
    // 不运行时:附件随消息一起发。
    await postMessage(trimmed)
    // postMessage 成功后已清空输入框/附件;发送失败时保留,等待重试。
  }

  /** 队列条目「插话」：打断当前轮次后立即发送。 */
  const interjectQueued = async (message: QueuedMessage) => {
    updateQueued(message.id, { mode: 'interject' })
    await sendNow({ ...message, mode: 'interject' })
  }

  /**
   * 队列条目「引导」：立即交给服务端，在当前动作结束后、下一次模型请求前注入。
   *
   * 不打断当前输出/工具调用；纯文本走 steer 接口，服务端在**下一个 step
   * 边界**落成真实用户消息，而不是等整轮结束。图片/附件暂不支持中途注入，
   * 保留在队列中按普通消息发送。步骤刚好结束时回落到普通发送。
   */
  const guideQueued = async (message: QueuedMessage) => {
    if (!activeId) return
    const textOnly = !message.images && !message.attachments && !message.quotes
    if (runningRef.current && textOnly) {
      try {
        await api.steerSession(activeId, { id: message.id, prompt: message.text })
        updateQueued(message.id, { state: 'steering', mode: 'guide' })
        notify('ok', t('queueSteerAccepted'))
        return
      } catch (error) {
        if (!(error instanceof api.ApiError && error.status === 409)) {
          notify('err', error instanceof Error ? error.message : String(error))
          return
        }
        // 409 = 轮次刚好结束：按普通消息立即发送。
      }
    }
    if (runningRef.current) {
      notify('ok', t('queueGuideAttachments'))
      return
    }
    const ok = await postMessage(message.text, {
      clearInput: false,
      payload: queuedPayload(message),
      source: 'guide',
    })
    if (ok) {
      setQueuedMessages((previous) => previous.filter((item) => item.id !== message.id))
    }
  }

  // postMessage 镜像:每渲染重赋,队列自动发送 effect(在 useMessageQueue)
  // 与"立即发送"读它拿最新闭包。
  postMessageRef.current = postMessage

  const stop = async () => {
    if (!activeId) return
    try {
      await api.cancelSession(activeId)
    } catch (error) {
      notify('err', error instanceof Error ? error.message : String(error))
    }
  }

  const onPromptKeyDown = usePromptKeyboard({
    mentionOpen,
    composingRef,
    mentionItems,
    mentionLoading,
    mentionActive,
    setMentionActive,
    pickMention,
    closeMention,
    slashOpen,
    slashItems,
    slashActive,
    setSlashActive,
    pickSlash,
    closeSlash,
    running,
    stop,
    optimizing,
    composerReady,
    promptRef,
    inputHistory,
    applyDraft,
    promptEmpty,
    queuedMessages,
    interjectQueued,
    sending,
    send,
  })

  const promptScrollRef = useContainedWheel<HTMLDivElement>()

  const projectRow = (
    <HeroProjectRow
      projects={projects}
      activeProject={activeProject}
      locked={locked}
      inert={inert}
      projectMenuOpen={projectMenuOpen}
      setProjectMenuOpen={setProjectMenuOpen}
      agentPresetCatalog={agentPresetCatalog}
      agentPresetId={agentPresetId}
      agentPresetBusy={agentPresetBusy}
      changeAgentPreset={changeAgentPreset}
      onSelectProject={onSelectProject}
      onAddProject={onAddProject}
      onOpenPicker={onOpenPicker}
    />
  )

  const placeholderText = inert ? t('placeholderProject') : t('chatPlaceholder')

  const composerCard = (
    <div
      className={`prompt-panel${inert ? ' pick-target' : ''}${optimizing ? ' optimizing' : ''}`}
      ref={composerPanelRef}
      onClick={inert ? onOpenPicker : undefined}
    >
      <ApprovalDialog request={approvalReq} onDecide={handleApproval} />
      <ComposerAttachments
        quotes={trajQuotes}
        images={pastedImages}
        attachments={attachments}
        onRemoveQuote={(id) => setTrajQuotes((previous) => previous.filter((q) => q.id !== id))}
        onRemoveImage={(index) => setPastedImages((previous) => previous.filter((_, i) => i !== index))}
        onRemoveAttachment={(index) => setAttachments((previous) => previous.filter((_, i) => i !== index))}
      />
      <ComposerEditor
        promptScrollRef={promptScrollRef}
        editorRef={promptRef}
        placeholderText={placeholderText}
        inert={inert}
        optimizing={optimizing}
        composerReady={composerReady}
        mentionOpen={mentionOpen}
        mentionLoading={mentionLoading}
        mentionItems={mentionItems}
        mentionActive={mentionActive}
        composingRef={composingRef}
        onDraftChange={onDraftChange}
        syncPromptHeight={syncPromptHeight}
        refreshMenus={refreshMenus}
        onCopy={onEditorCopy}
        onCut={(event) => onEditorCopy(event, true)}
        onPaste={onEditorPaste}
        onDragOver={onEditorDragOver}
        onDrop={onEditorDrop}
        onKeyDown={onPromptKeyDown}
        onOpenPicker={onOpenPicker}
      />
      <ComposerMenus
        mentionOpen={mentionOpen}
        mentionItems={mentionItems}
        mentionLoading={mentionLoading}
        mentionQuery={mentionQuery}
        mentionActive={mentionActive}
        setMentionActive={setMentionActive}
        mentionMenuRef={mentionMenuRef}
        closeMention={closeMention}
        pickMention={pickMention}
        slashOpen={slashOpen}
        slashItems={slashItems}
        slashActive={slashActive}
        setSlashActive={setSlashActive}
        slashMenuRef={slashMenuRef}
        closeSlash={closeSlash}
        pickSlash={pickSlash}
      />
      <ComposerToolbar
        panelAnchorRef={composerPanelRef}
        inert={inert}
        optimizing={optimizing}
        sending={sending}
        running={running}
        prompt={prompt}
        promptEmpty={promptEmpty}
        primaryStops={primaryStops}
        contextProjectPath={contextProjectPath}
        filesAvailable={activeSession?.cwd_alive !== false}
        activeId={activeId}
        sessions={sessions}
        showAttachRow={showAttachRow}
        permission={permission}
        permissionBusy={permissionBusy}
        showApproveForMe={showApproveForMe}
        selection={selection}
        catalog={catalog}
        activeEffort={activeEffort}
        effortLevels={effortLevels}
        optimizedPrompt={optimizedPrompt}
        context={context}
        onOpenContextMenu={openContextMenu}
        onPickFiles={() => { void onPickFiles() }}
        onInsertFile={insertContextFile}
        onAddContextSession={addContextSession}
        onInsertCommand={insertContextCommand}
        onPermissionChange={requestPermissionChange}
        onSelectionChange={applySelection}
        onUndoOptimize={handleUndoOptimize}
        onOptimize={() => { void handleOptimize() }}
        onStop={() => { void stop() }}
        onSend={() => { void send() }}
      />
    </div>
  )

  return (
    <div
      className="session-layout"
      data-phase={phase}
      ref={layoutRef}
      data-compact={layoutFit !== 'wide' || undefined}
      data-tight={layoutFit === 'tight' || undefined}
    >
      {phase === 'hero' && !secondary && activeProject && onToggleSidePane && (
        <button
          type="button"
          className={`icon-btn session-pane-btn hero-pane-btn${sidePaneOpen ? ' active' : ''}`}
          title={t('sidePaneToggle')}
          aria-label={sidePaneOpen ? t('sidePaneCollapse') : t('sidePaneExpand')}
          aria-pressed={sidePaneOpen}
          data-testid="side-pane-toggle"
          onClick={onToggleSidePane}
        >
          <IconPanelOpen size={15} />
        </button>
      )}
      {phase === 'active' && (
        <SessionHeader
          activeSession={activeSession}
          activeId={activeId}
          agentPresetId={agentPresetId}
          agentPresetCatalog={agentPresetCatalog}
          view={view}
          setView={setView}
          sidePaneOpen={sidePaneOpen}
          onToggleSidePane={onToggleSidePane}
          runtimeCounts={runtimeCounts}
          runtimeCollapsed={runtimeCollapsed}
          onExpandRuntime={() => setRuntimeCollapsed(false)}
          exportOpen={exportOpen}
          exportBusy={exportBusy}
          setExportOpen={setExportOpen}
          setExportBusy={setExportBusy}
        />
      )}
      <div className="runtime-view" data-runtime-visible={runtimeCounts.agents + runtimeCounts.jobs > 0 && !runtimeCollapsed || undefined}
        data-plan-preview={planReview && (!planPreviewInPane || planPreviewDismissed) ? 'local' : undefined}>
      <div
        className="conversation-scroll"
        ref={follower.setPort}
        data-conversation-scroll=""
      >
        {phase === 'active' && view === 'chat' && (
          <ConversationAxis
            anchors={axisAnchors}
            nodes={transcriptNodes}
            scrollRef={scrollRef}
            onJump={releaseFollow}
            onJumpMiss={(seq, behavior) => {
              // 锚点在分页窗口外:先脱跟,翻页补齐后 SessionView 再定位,
              // 否则每来一页内容都会被心跳拉回底部。
              releaseFollow()
              setAxisJump((prev) => ({
                seq,
                nonce: (prev?.nonce ?? 0) + 1,
                behavior,
              }))
            }}
          />
        )}
        <div
          className={view === 'trajectory' ? 'conversation-view full-bleed' : 'conversation-view'}
          ref={viewRef}
        >
          {/* 揭示引擎从这里取压压通道:正文与思考正文的揭示速度由本次对话流的
              跟随滞后决定(见 streaming/pressure)。 */}
          <SmoothStreamContext.Provider value={follower.pressure}>
            {showTranscript && activeId ? (
              // 局部边界:transcript 子树崩了不该带走侧栏/输入框(只降级这一块)。
              // key 与会话/重挂 tick 对齐,回退重挂时边界一并重置。
              <ErrorBoundary key={`${activeId}-${transcriptReloadTick}`}>
                <SessionView
                  key={`${activeId}-${transcriptReloadTick}`}
                  id={activeId}
                  view={view}
                  pendingMessages={pendingMessages}
                  compacting={compactingAt}
                  onTodosChange={setTodos}
                  onRuntimeEvents={setRuntimeEvents}
                  onGoalTouch={handleGoalTouch}
                  onPendingSettled={settlePending}
                  onNotFound={handleNotFound}
                  onNodesChange={handleNodesChange}
                  onAnchorsChange={setAxisAnchors}
                  jumpRequest={axisJump}
                  onJumpSettled={handleJumpSettled}
                  onRewind={handleRewindClick}
                  onFork={handleForkClick}
                  onQuote={handleQuote}
                  onLoopContinue={handleLoopContinue}
                  onAskAnswer={handleAskAnswer}
                  onAskCancel={handleAskCancel}
                />
              </ErrorBoundary>
            ) : (
              <div className="session-hero">
                <div className="hero-headline">
                  <span className="hero-headline-text">{t('heroTitle')}</span>
                </div>
              </div>
            )}
          </SmoothStreamContext.Provider>
        </div>
        {(phase === 'hero' || view === 'chat') && (
          <div className="composer-seat" ref={seatRef} data-composer-seat="">
            <div className={`composer-stack${phase === 'hero' ? ' composer-hero' : ''}`}>
              {phase === 'hero' && !secondary && projectRow}
              {phase === 'active' && (
                <QueuedMessagePanel
                  messages={queuedMessages}
                  onInterject={(message) => void interjectQueued(message)}
                  onGuide={(message) => void guideQueued(message)}
                  onEdit={editQueued}
                  onDelete={deleteQueued}
                />
              )}
              {phase === 'active' && <TodoPanel todos={todos} />}
              {phase === 'active' && activeId && !activeSession?.subagent && (
                <GoalBar
                  sessionId={activeId}
                  view={goalView}
                  selection={selection ?? undefined}
                  onChanged={() => refreshGoal(activeId)}
                />
              )}
              {planReview && !planPreviewInPane && (
                <PlanPreviewPanel title={planReview.title} planText={planReview.planText} />
              )}
              {planReview ? (
                <PlanReviewPanel
                  title={planReview.title}
                  planText={planReview.planText}
                  catalog={catalog}
                  selection={selection}
                  onDecision={handlePlanDecision}
                  onExit={handlePlanExit}
                />
              ) : activeSession?.subagent ? (
                /* 外形沿用输入面板(.prompt-panel):这块坐的就是输入框的位置,
                   长得像输入框才不突兜;元信息是自解释的短句,不画标签表单。 */
                <ChildSubagentBanner
                  descriptorText={descriptorText}
                  subagentModel={subagentModel}
                  subagentFacts={subagentFacts}
                  onBack={() => activeSession.parent_session && go(activeSession.parent_session, null)}
                />
              ) : composerCard}
              {phase === 'active' && (
                <StatsBar nodes={transcriptNodes} totals={sessionTotals} openTurnStartedAt={openTurnAt} />
              )}
            </div>
          </div>
        )}
      </div>
      {planReview && planPreviewInPane && planPreviewDismissed && (
        <aside className="plan-preview-fallback">
          <PlanPreviewPanel title={planReview.title} planText={planReview.planText} />
        </aside>
      )}
      {phase === 'active' && activeId && (
        <RuntimePanel key={activeId} id={activeId} cwd={activeSession?.cwd} events={runtimeEvents} pendingCount={pendingMessages.length} collapsed={runtimeCollapsed} onCollapse={() => setRuntimeCollapsed(true)} onCountsChange={handleRuntimeCountsChange} />
      )}
      </div>
      {phase === 'active' && view === 'chat' && !stick && (
        <button
          type="button"
          className="jump-bottom"
          onClick={snapToBottom}
          title={t('jumpToBottom')}
          aria-label={t('jumpToBottom')}
        >
          <IconArrowDown size={16} />
        </button>
      )}
      {fullAccessConfirm && (
        <ConfirmDialog
          open
          title={t('permissionFullConfirmTitle')}
          desc={t('permissionFullConfirmDesc')}
          confirmLabel={t('permissionFullConfirmEnable')}
          onConfirm={confirmFullAccess}
          onCancel={cancelFullAccess}
        />
      )}
      {rewindReq && (
        <RewindDialog
          request={rewindReq}
          running={running}
          onConfirm={() => void confirmRewind()}
          onCancel={() => setRewindReq(null)}
        />
      )}
    </div>
  )
}
