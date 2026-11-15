/**
 * 审查面板:Git 来源切换 + 改动文件列表 + 展开看 Diff。
 *
 * 这里有两处**有意的简化**:
 *
 * 1. **不做虚拟列表**。denia 的定位是单机项目,一次几百个文件已是极端情况,
 *    而虚拟列表会带来"展开状态与虚拟窗口不同步"的一类 bug。先做朴素列表,
 *    真遇到性能问题再换 —— 数据结构已经按"按需懒加载 diff"设计好了。
 *    项目有多个目录时按目录分组；同一 Git 仓库只展示一次。
 * 2. **Diff 用 `<pre>` + 行着色**,不引 diff 渲染库。patch 本身已经是
 *    带 `+`/`-`/` ` 前缀的文本,按前缀上色就够读;引库会带来主题适配、
 *    大文件卡顿、包体积三个负担。
 *
 * Diff 的三级降级保持不变:
 *   patch(有 patch 文本) → 全文对比(有前后内容) → 提示(二进制/过大/不可用)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../i18n'
import {
  GIT_SOURCES,
  GitApiError,
  canCommit,
  canPush,
  commitChanges,
  failureHint,
  fetchGitDiff,
  fetchGitStatus,
  generateCommitMessage,
  pushChanges,
  sectionize,
  type GitDiff,
  type GitEntry,
  type GitSource,
  type GitStatus,
} from '../gitApi'
import { IconBranch, IconChevronDown, IconFile, IconRefresh, IconSparkles, IconSpinner, IconTool } from './icons'
import { DiffCard, DiffStat } from './DiffCard'
import { PanelEmpty, PanelHead, PanelSearch, PanelToolbar } from './PanelChrome'
import { useTurnChanges } from '../turnChangesStore'
import { scopeKey } from '../sidePane'
import type { TurnProducedFile } from '../fold'
import './ReviewPanel.css'

/** 单个文件行的展开态。 */
interface RowState {
  expanded: boolean
  loading: boolean
  diff: GitDiff | null
  error: string
}

/** 提交/推送的一次性结果反馈(显示后自动消失)。 */
interface ActionFeedback {
  kind: 'ok' | 'error'
  text: string
  hint?: string
}

export interface ReviewPanelProps {
  /** 项目主目录。保留给单目录项目和「本轮」来源。 */
  projectPath: string
  /** 项目的全部目录；缺省时只审查 projectPath。 */
  projectDirs?: string[]
  /** 会话 id:状态按会话缓存,切会话重拉。 */
  sessionId: string | null
  /** 当前对话选择的模型(AI 生成提交信息复用同一条链路);未选则禁用该入口。 */
  selection?: { provider: string; model: string; reasoningEffort?: string } | null
}

interface DirectoryStatus {
  /** Git operation root (repo root when available). */
  dir: string
  /** Project directory label the user picked. */
  label: string
  status: GitStatus | null
  error?: string
}

/** Display labels for project directories; duplicate basenames get an index. */
function directoryLabels(dirs: readonly string[]): string[] {
  const counts = new Map<string, number>()
  for (const dir of dirs) {
    const base = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
    counts.set(base, (counts.get(base) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  return dirs.map((dir) => {
    const base = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
    if ((counts.get(base) ?? 0) <= 1) return base
    const index = (seen.get(base) ?? 0) + 1
    seen.set(base, index)
    return `${base} (${index})`
  })
}

function branchLine(status: GitStatus): string {
  const branch = status.detached
    ? `${t('sidePaneReviewDetached')} ${status.head ?? ''}`.trim()
    : (status.branch ?? t('sidePaneReviewNoBranch'))
  const counts =
    status.ahead != null && status.behind != null
      ? ` · ↑${status.ahead} ↓${status.behind}`
      : ''
  return `${branch}${counts}`
}

export function ReviewPanel({ projectPath, projectDirs, sessionId, selection }: ReviewPanelProps) {
  const dirs = useMemo(() => {
    const list = [projectPath, ...(projectDirs ?? [])]
      .map((dir) => dir.trim())
      .filter((dir) => dir !== '')
    return [...new Set(list)]
  }, [projectPath, projectDirs])
  const dirsKey = dirs.join('\u0000')
  const [statuses, setStatuses] = useState<DirectoryStatus[]>([])
  const [selectedDir, setSelectedDir] = useState<string>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /**
   * 来源。`turn` 是**不依赖 git** 的那一个:数据来自对话里那张变更卡片
   * (工具参数算出的行级 diff),项目不是仓库时它是唯一还能看到 diff
   * 的地方。三个 git 来源覆盖项目全量改动,两者并存不替代。
   */
  const [source, setSource] = useState<GitSource | 'turn'>('unstaged')
  const [rows, setRows] = useState<Record<string, RowState>>({})
  const [filter, setFilter] = useState('')
  /** 本轮来源的展开态(与 git 来源的行状态分开存,避免键互相覆盖)。 */
  const [turnOpen, setTurnOpen] = useState<Record<string, boolean>>({})
  /** 本轮改动的内存快照:由变更卡片点击时写入(见 turnChangesStore)。 */
  const turnChanges = useTurnChanges(scopeKey(sessionId))
  /** 请求代号:防止慢响应覆盖新状态(切来源/刷新时的竞态)。 */
  const revisionRef = useRef(0)
  /** 提交信息草稿:跨刷新保留(用户可能写了半天才提交)。 */
  const [message, setMessage] = useState('')
  /** 正在跑的写操作:提交与推送互斥,期间按钮禁用。 */
  const [busy, setBusy] = useState<'commit' | 'push' | 'generate' | null>(null)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string; hint?: string } | null>(null)
  /** 生成请求的中止句柄(切项目/卸载时取消在途请求)。 */
  const generateAbortRef = useRef<AbortController | null>(null)

  const dirLabels = useMemo(() => directoryLabels(dirs), [dirs])
  const dirOptions = useMemo(
    () =>
      statuses.length > 0
        ? statuses.map((entry) => ({ value: entry.dir, label: entry.label }))
        : dirs.map((dir, index) => ({ value: dir, label: dirLabels[index] ?? dir })),
    [statuses, dirs, dirLabels],
  )
  const selectedStatuses = useMemo(
    () => (selectedDir === 'all' ? statuses : statuses.filter((entry) => entry.dir === selectedDir)),
    [statuses, selectedDir],
  )
  const nonRepoCount = selectedStatuses.filter(
    (entry) => entry.status !== null && !entry.status.isRepository,
  ).length
  const isRepo = selectedStatuses.some((entry) => entry.status?.isRepository === true)
  const onTurn = source === 'turn'
  const hasTurn = turnChanges !== null && turnChanges.files.length > 0
  const effectiveGitSource: GitSource = source === 'turn' ? 'unstaged' : source

  const refresh = useCallback(async () => {
    revisionRef.current += 1
    const revision = revisionRef.current
    setLoading(true)
    setError('')
    const results = await Promise.all(
      dirs.map(async (dir): Promise<DirectoryStatus> => {
        try {
          return {
            dir,
            label: dirLabels[dirs.indexOf(dir)] ?? dir,
            status: await fetchGitStatus(dir),
          }
        } catch (cause) {
          return {
            dir,
            label: dirLabels[dirs.indexOf(dir)] ?? dir,
            status: null,
            error: cause instanceof Error ? cause.message : String(cause),
          }
        }
      }),
    )
    if (revisionRef.current !== revision) return
    // Two project directories can live in the same repository. Review once,
    // from the repository root, so commit/push do not run twice.
    const seen = new Set<string>()
    const unique: DirectoryStatus[] = []
    for (const entry of results) {
      const key = (entry.status?.repoRoot ?? entry.dir).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      unique.push({
        ...entry,
        dir: entry.status?.repoRoot ?? entry.dir,
      })
    }
    setStatuses(unique)
    // 状态变了:丢弃所有已缓存的 diff(行内容可能已过期)。
    setRows({})
    setLoading(false)
  }, [dirsKey])

  useEffect(() => {
    void refresh()
  }, [refresh, sessionId])

  // 非仓库项目:自动落到「本轮」。git 状态到位后才知道是不是仓库,而三个
  // git 来源在非仓库里必然是空的 —— 停在默认的"未暂存"就等于对着空面板。
  // 有本轮数据才落;没有就维持原样,让"不是 Git 仓库"的空态说话。
  useEffect(() => {
    if (!loading && statuses.length > 0 && !isRepo && hasTurn && source !== 'turn') {
      setSource('turn')
    }
  }, [loading, statuses.length, isRepo, hasTurn, source])

  // 切会话/切目录:来源回到默认。原因有两个 —— 新会话的「本轮」数据还没
  // 写进来,停在 turn 上只会看到一句"本轮没有文件改动";而且上一个会话
  // 选的是「已暂存」之类,直接套到新项目是错位的默认。
  useEffect(() => {
    setSource('unstaged')
    setFilter('')
    setTurnOpen({})
    setRows({})
    setSelectedDir('all')
  }, [sessionId, dirsKey])

  useEffect(() => {
    if (selectedDir !== 'all' && !dirOptions.some((entry) => entry.value === selectedDir)) {
      setSelectedDir('all')
    }
  }, [dirOptions, selectedDir])

  /* ---- 提交 / 推送 / AI 生成 ---- */

  // 反馈几秒后自动消失:它是一次性结果,不该长期占着面板底部。
  useEffect(() => {
    if (!feedback) return
    const timer = window.setTimeout(() => setFeedback(null), 6000)
    return () => window.clearTimeout(timer)
  }, [feedback])

  // 卸载/切项目时取消在途的生成请求。
  useEffect(() => {
    return () => generateAbortRef.current?.abort()
  }, [dirsKey])

  const groups = useMemo(
    () =>
      selectedStatuses
        .filter((entry): entry is DirectoryStatus & { status: GitStatus } =>
          entry.status?.isRepository === true)
        .map((entry) => ({
          dir: entry.dir,
          status: entry.status,
          sections: sectionize(entry.status.entries, effectiveGitSource),
        })),
    [selectedStatuses, effectiveGitSource],
  )

  const totalFiles = useMemo(
    () => groups.reduce((sum, group) => sum + group.sections.reduce((n, section) => n + section.entries.length, 0), 0),
    [groups],
  )
  const hasChanges = totalFiles > 0

  const visibleGroups = useMemo(() => {
    const query = filter.trim().toLowerCase()
    if (!query) return groups
    return groups
      .map((group) => ({
        ...group,
        sections: group.sections
          .map((section) => ({
            ...section,
            entries: section.entries.filter((entry) =>
              entry.path.toLowerCase().includes(query),
            ),
          }))
          .filter((section) => section.entries.length > 0),
      }))
      .filter((group) => group.sections.length > 0)
  }, [groups, filter])

  /** 本轮来源的文件列表(按当前筛选词过滤,空筛选即全量)。 */
  const visibleTurnFiles = useMemo<readonly TurnProducedFile[]>(() => {
    if (turnChanges === null) return []
    const query = filter.trim().toLowerCase()
    if (!query) return turnChanges.files
    return turnChanges.files.filter((file) => file.path.toLowerCase().includes(query))
  }, [turnChanges, filter])

  const selectedLabel =
    selectedDir === 'all'
      ? t('reviewAllDirs')
      : (dirOptions.find((entry) => entry.value === selectedDir)?.label ?? selectedDir)
  const commitDirs = useMemo(
    () =>
      selectedStatuses
        .filter((entry) => entry.status?.isRepository && entry.status.entries.length > 0)
        .map((entry) => entry.dir),
    [selectedStatuses],
  )
  const pushDirs = useMemo(
    () =>
      selectedStatuses
        .filter((entry) => entry.status?.isRepository)
        .map((entry) => entry.dir),
    [selectedStatuses],
  )

  /** 提交:成功后刷新(改动列表清空、ahead 计数 +1)。 */
  const submit = useCallback(async () => {
    if (busy) return
    if (commitDirs.length === 0) {
      setFeedback({ kind: 'error', text: t('reviewNothingToCommit') })
      return
    }
    setBusy('commit')
    setFeedback(null)
    const done: string[] = []
    let current = ''
    try {
      for (const dir of commitDirs) {
        current = dir
        const result = await commitChanges(dir, message)
        done.push(result.head)
      }
      setMessage('')
      setFeedback({
        kind: 'ok',
        text: done.length > 1
          ? t('reviewCommittedDirs', { n: done.length })
          : t('reviewCommitted', { head: done[0] ?? '' }),
      })
      await refresh()
    } catch (cause) {
      const code = cause instanceof GitApiError ? cause.code : ''
      const label = dirOptions.find((entry) => entry.value === current)?.label ?? current
      setFeedback({
        kind: 'error',
        text: `${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
        hint: failureHint(code),
      })
      await refresh()
    } finally {
      setBusy(null)
    }
  }, [busy, commitDirs, message, refresh, dirOptions])

  const runPush = useCallback(async () => {
    if (busy) return
    if (pushDirs.length === 0) {
      setFeedback({ kind: 'error', text: t('reviewNothingToPush') })
      return
    }
    setBusy('push')
    setFeedback(null)
    const upstreams: string[] = []
    let current = ''
    try {
      for (const dir of pushDirs) {
        current = dir
        const result = await pushChanges(dir)
        upstreams.push(result.upstream)
      }
      setFeedback({
        kind: 'ok',
        text: upstreams.length > 1
          ? t('reviewPushedDirs', { n: upstreams.length })
          : `${t('reviewPushSuccess')} · ${upstreams[0] ?? ''}`,
      })
      await refresh()
    } catch (cause) {
      const code = cause instanceof GitApiError ? cause.code : ''
      const label = dirOptions.find((entry) => entry.value === current)?.label ?? current
      setFeedback({
        kind: 'error',
        text: `${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
        hint: failureHint(code),
      })
      await refresh()
    } finally {
      setBusy(null)
    }
  }, [busy, pushDirs, refresh, dirOptions])

  /** AI 生成:结果填入编辑框,用户可改后再提交(不自动提交)。 */
  const generate = useCallback(async () => {
    if (busy) return
    if (!selection) {
      setFeedback({ kind: 'error', text: t('reviewGenerateNeedsModel') })
      return
    }
    const target = selectedDir !== 'all' ? selectedDir : commitDirs[0] ?? dirs[0]
    if (!target) return
    generateAbortRef.current?.abort()
    const controller = new AbortController()
    generateAbortRef.current = controller
    setBusy('generate')
    setFeedback(null)
    try {
      const result = await generateCommitMessage(
        {
          path: target,
          provider: selection.provider,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort,
        },
        controller.signal,
      )
      if (controller.signal.aborted) return
      setMessage(result.message)
    } catch (cause) {
      if (controller.signal.aborted) return
      const code = cause instanceof GitApiError ? cause.code : ''
      setFeedback({
        kind: 'error',
        text: `${t('reviewGenerateFailed')}:${cause instanceof Error ? cause.message : String(cause)}`,
        hint: failureHint(code),
      })
    } finally {
      if (generateAbortRef.current === controller) generateAbortRef.current = null
      setBusy(null)
    }
  }, [busy, selection, selectedDir, commitDirs, dirs])

  /** 展开/收起一行,首次展开时懒加载 diff。 */
  const toggle = useCallback(
    (dir: string, entry: GitEntry) => {
      const key = `${dir}\u0000${entry.path}`
      const current = rows[key]
      if (current?.expanded) {
        setRows((prev) => ({ ...prev, [key]: { ...current, expanded: false } }))
        return
      }
      setRows((prev) => ({
        ...prev,
        [key]: {
          expanded: true,
          // 已经有 diff 就不重复拉(收起再展开是常见操作)。
          loading: !current?.diff,
          diff: current?.diff ?? null,
          error: '',
        },
      }))
      if (current?.diff) return
      const revision = revisionRef.current
      fetchGitDiff(dir, entry.path, effectiveGitSource)
        .then((diff) => {
          // 期间刷新过状态:结果已过期,丢弃。
          if (revisionRef.current !== revision) return
          setRows((prev) => ({
            ...prev,
            [key]: { expanded: true, loading: false, diff, error: '' },
          }))
        })
        .catch((cause: unknown) => {
          if (revisionRef.current !== revision) return
          setRows((prev) => ({
            ...prev,
            [key]: {
              expanded: true,
              loading: false,
              diff: null,
              error: cause instanceof Error ? cause.message : String(cause),
            },
          }))
        })
    },
    [rows, effectiveGitSource],
  )

  const sourceLabel = (value: GitSource) =>
    value === 'staged'
      ? t('sidePaneReviewStaged')
      : value === 'branch'
        ? t('sidePaneReviewBranch')
        : t('sidePaneReviewUnstaged')

  const subtitle = onTurn
    ? t('reviewSourceTurn')
    : loading && statuses.length === 0
      ? undefined
      : selectedDir === 'all'
        ? t('reviewDirsSummary', { dirs: dirs.length, files: totalFiles })
        : branchLine(selectedStatuses.find((entry) => entry.status)?.status ?? { isRepository: false, entries: [] })

  return (
    <div className="review-panel pane-panel">
      <PanelHead
        icon={<IconTool size={16} />}
        title={t('sidePaneReview')}
        subtitle={subtitle}
        actions={
          <button
            type="button"
            className="pane-icon-btn review-refresh"
            title={t('sidePaneReviewRefresh')}
            aria-label={t('sidePaneReviewRefresh')}
            disabled={loading || onTurn}
            onClick={() => void refresh()}
          >
            {loading ? <IconSpinner size={14} /> : <IconRefresh size={14} />}
          </button>
        }
      />

      <PanelToolbar className="review-toolbar">
        <div className="pane-seg review-sources" role="tablist" aria-label={t('sidePaneReviewSource')}>
          {/* 「本轮」排在最前:它是变更卡片的直达入口,也是非仓库项目里
              唯一有内容的来源。 */}
          <button
            type="button"
            role="tab"
            aria-selected={onTurn}
            className="pane-seg-btn review-source"
            onClick={() => {
              setSource('turn')
              setFilter('')
            }}
          >
            {t('reviewSourceTurn')}
          </button>
          {GIT_SOURCES.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={source === value}
              className="pane-seg-btn review-source"
              onClick={() => {
                setSource(value)
                setRows({})
              }}
            >
              {sourceLabel(value)}
            </button>
          ))}
        </div>
        {isRepo && !onTurn && totalFiles > 0 && (
          <PanelSearch
            className="review-filter"
            inputClassName="review-filter-input"
            value={filter}
            onChange={setFilter}
            placeholder={t('sidePaneReviewFilter')}
            ariaLabel={t('sidePaneReviewFilter')}
          />
        )}
      </PanelToolbar>

      {dirOptions.length > 1 && !onTurn && (
        <div className="review-dir-tabs" role="tablist" aria-label={t('reviewProjectDirs')}>
          <button
            type="button"
            role="tab"
            aria-selected={selectedDir === 'all'}
            className="review-dir-tab"
            onClick={() => setSelectedDir('all')}
          >
            {t('reviewAllDirs')}
          </button>
          {dirOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={selectedDir === option.value}
              className="review-dir-tab"
              title={option.value}
              onClick={() => setSelectedDir(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      {!onTurn && isRepo && nonRepoCount > 0 && (
        <p className="review-empty-line">
          {t('reviewSomeDirsNotRepo', { n: nonRepoCount })}
        </p>
      )}

      {error && (
        <p className="review-error" role="alert">
          {error}
        </p>
      )}
      {!onTurn && statuses.filter((entry) => entry.error).map((entry) => (
        <p className="review-error" role="alert" key={entry.dir}>
          {directoryLabels([entry.dir])[0]}: {entry.error}
        </p>
      ))}

      {onTurn && (
        <TurnChangesList
          files={visibleTurnFiles}
          open={turnOpen}
          onToggle={(path) => setTurnOpen((prev) => ({ ...prev, [path]: !prev[path] }))}
          emptyLabel={
            hasTurn
              ? filter.trim().length > 0
                ? t('sidePaneReviewNoMatch')
                : null
              : t('reviewTurnEmpty')
          }
        />
      )}

      {!onTurn && !loading && statuses.length === 0 && (
        <div className="review-empty">
          <IconFile size={26} />
          <p className="review-empty-title">{t('sidePaneReviewNotRepo')}</p>
          <p className="review-empty-desc">{t('sidePaneReviewNotRepoHint')}</p>
        </div>
      )}

      {!onTurn && visibleGroups.length === 0 && totalFiles === 0 && !loading && statuses.some((entry) => entry.status?.isRepository) && (
        <div className="review-empty">
          <IconFile size={26} />
          <p className="review-empty-title">{t('sidePaneReviewClean')}</p>
          <p className="review-empty-desc">{t('sidePaneReviewCleanHint')}</p>
        </div>
      )}

      {!onTurn && visibleGroups.length > 0 && (
        <div className="review-list">
          {visibleGroups.map((group) => (
        <section className="review-dir-group" key={group.dir}>
          {dirs.length > 1 && (
            <h3 className="review-dir-title">
              <span className="review-dir-name" title={group.dir}>
                {dirOptions.find((entry) => entry.value === group.dir)?.label ?? group.dir}
              </span>
              {group.status.isRepository && (
                <span className="review-dir-branch">{branchLine(group.status)}</span>
              )}
            </h3>
          )}
          {group.sections.length === 0 ? (
            <p className="review-empty-line">{t('sidePaneReviewClean')}</p>
          ) : (
            group.sections.map((section) => (
              <div key={`${group.dir}:${section.id}`} className="review-section">
                <h4 className="review-section-title">
                  {section.id === 'staged'
                    ? t('sidePaneReviewSectionStaged')
                    : section.id === 'untracked'
                      ? t('sidePaneReviewSectionUntracked')
                      : section.id === 'conflicted'
                        ? t('sidePaneReviewSectionConflicted')
                        : t('sidePaneReviewSectionUnstaged')}
                  <span className="review-section-count">{section.entries.length}</span>
                </h4>
                {section.entries.map((entry) => {
                  const key = `${group.dir}\u0000${entry.path}`
                  const state = rows[key]
                  const expanded = state?.expanded ?? false
                  return (
                    <div className="review-row" key={`${section.id}:${key}`}>
                      <button
                        type="button"
                        className="review-row-head"
                        aria-expanded={expanded}
                        onClick={() => toggle(group.dir, entry)}
                      >
                        <span className="review-row-icon" aria-hidden="true">
                          <IconFile size={14} />
                        </span>
                        <span className="review-row-path" title={entry.path}>
                          {entry.path}
                          {entry.renamedFrom && (
                            <span className="review-row-renamed"> ← {entry.renamedFrom}</span>
                          )}
                        </span>
                        <span className="review-row-status" aria-hidden="true">
                          {statusLabel(entry)}
                        </span>
                        <IconChevronDown
                          size={14}
                          className={`review-row-chevron${expanded ? ' open' : ''}`}
                        />
                      </button>
                      {expanded && (
                        <div className="review-diff">
                          {state?.loading && (
                            <div className="review-diff-hint">
                              <IconSpinner size={14} />
                              {t('loading')}
                            </div>
                          )}
                          {state?.error && (
                            <div className="review-diff-hint error">{state.error}</div>
                          )}
                          {state?.diff && <DiffBody diff={state.diff} />}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </section>
          ))}
        </div>
      )}

      {!onTurn && visibleGroups.length === 0 && filter.trim() !== '' && totalFiles > 0 && (
        <p className="review-empty-line">{t('sidePaneReviewNoMatch')}</p>
      )}

      {loading && statuses.length === 0 && (
        <PanelEmpty icon={<IconSpinner size={22} />} title={t('loading')} />
      )}

      {/* 提交区:常驻在面板底部。
          放在底部而不是顶部,是因为阅读顺序是"先看改动、再写信息、最后提交";
          常驻而不是点击展开,是因为它就是这个面板的主操作 —— 藏起来会让人
          以为审查面板仍然只读。 */}
      {isRepo && !onTurn && (
        <CommitArea
          message={message}
          onMessageChange={setMessage}
          busy={busy}
          feedback={feedback}
          commitEnabled={canCommit({ hasChanges, message, busy: busy !== null })}
          pushEnabled={
            busy === null &&
            pushDirs.length > 0 &&
            selectedStatuses
              .filter((entry) => entry.status?.isRepository)
              .every((entry) => canPush(entry.status, busy !== null))
          }
          canGenerate={selection != null}
          dirLabel={selectedLabel}
          allDirs={selectedDir === 'all'}
          onSubmit={() => void submit()}
          onPush={() => void runPush()}
          onGenerate={() => void generate()}
        />
      )}

      {!onTurn && !isRepo && !loading && statuses.length > 0 && statuses.every((entry) => !entry.error) && (
        <div className="review-empty">
          <IconFile size={26} />
          <p className="review-empty-title">{t('sidePaneReviewNotRepo')}</p>
          <p className="review-empty-desc">{t('sidePaneReviewNotRepoHint')}</p>
        </div>
      )}
    </div>
  )
}

/** 提交区:信息编辑框 + AI 生成 + 提交 + 推送。 */
function CommitArea({
  message,
  onMessageChange,
  busy,
  feedback,
  commitEnabled,
  pushEnabled,
  canGenerate,
  dirLabel,
  allDirs,
  onSubmit,
  onPush,
  onGenerate,
}: {
  message: string
  onMessageChange(value: string): void
  busy: 'commit' | 'push' | 'generate' | null
  feedback: ActionFeedback | null
  commitEnabled: boolean
  pushEnabled: boolean
  canGenerate: boolean
  dirLabel: string
  allDirs: boolean
  onSubmit(): void
  onPush(): void
  onGenerate(): void
}) {
  return (
    <div className="review-commit">
      {feedback && (
        <div
          className={`review-commit-feedback${feedback.kind === 'error' ? ' error' : ''}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          <span className="review-commit-feedback-text">{feedback.text}</span>
          {feedback.hint && <span className="review-commit-feedback-hint">{feedback.hint}</span>}
        </div>
      )}
      <textarea
        className="review-commit-input"
        value={message}
        rows={2}
        placeholder={t('reviewCommitPlaceholder')}
        aria-label={t('reviewCommitPlaceholder')}
        onChange={(event) => onMessageChange(event.target.value)}
        onKeyDown={(event) => {
          // Ctrl/Cmd+Enter 提交:与大多数 Git 客户端一致,避免误触回车。
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && commitEnabled) {
            event.preventDefault()
            onSubmit()
          }
        }}
      />
      <div className="review-commit-actions">
        <button
          type="button"
          className="review-commit-generate"
          title={canGenerate ? t('reviewGenerateAction') : t('reviewGenerateNeedsModel')}
          disabled={busy !== null || !canGenerate}
          onClick={onGenerate}
        >
          {busy === 'generate' ? <IconSpinner size={13} /> : <IconSparkles size={13} />}
          <span>{busy === 'generate' ? t('reviewGenerateBusy') : t('reviewGenerateAction')}</span>
        </button>
        <span className="review-commit-spacer" />
        <button
          type="button"
          className="review-commit-push"
          title={t('reviewPushAction')}
          disabled={!pushEnabled}
          onClick={onPush}
        >
          {busy === 'push' ? <IconSpinner size={13} /> : <IconBranch size={13} />}
          <span>{busy === 'push' ? t('reviewPushBusy') : t('reviewPushAction')}</span>
        </button>
        <button
          type="button"
          className="review-commit-submit"
          title={allDirs ? t('reviewCommitAllDirs') : t('reviewCommitIn', { name: dirLabel })}
          disabled={!commitEnabled}
          onClick={onSubmit}
        >
          {busy === 'commit' ? <IconSpinner size={13} /> : null}
          <span>{busy === 'commit' ? t('reviewCommitBusy') : t('reviewCommitAction')}</span>
        </button>
      </div>
    </div>
  )
}

/** 状态字符 → 短标签(`M` 修改 / `A` 新增 / `D` 删除 / `?` 未跟踪 / `R` 重命名)。 */
function statusLabel(entry: GitEntry): string {
  if (entry.conflicted) return 'U'
  if (entry.untracked) return '?'
  const code = entry.staged ? entry.indexStatus : entry.worktreeStatus
  return code.trim() || '·'
}

/**
 * Diff 正文:三级降级。
 *
 * 顺序:有 patch 就渲染 patch(信息最全);
 * 否则用前后全文自建对比;都没有就按 `availability` 给一句可读的说明。
 */
function DiffBody({ diff }: { diff: GitDiff }) {
  if (diff.availability === 'binary') {
    return <div className="review-diff-hint">{t('sidePaneDiffBinary')}</div>
  }
  if (diff.availability === 'truncated') {
    return <div className="review-diff-hint">{t('sidePaneDiffTruncated')}</div>
  }
  if (diff.availability === 'unavailable') {
    return (
      <div className="review-diff-hint">
        {t('sidePaneDiffUnavailable')}
        {diff.summary ? ` · ${diff.summary}` : ''}
      </div>
    )
  }

  if (diff.patch) return <PatchView patch={diff.patch} />

  // 没有 patch 但有全文:新增文件的场景(未跟踪文件没有 diff 基线)。
  if (diff.afterContent != null && diff.beforeContent == null) {
    return <FullTextAdd content={diff.afterContent} />
  }
  if (diff.beforeContent != null && diff.afterContent != null) {
    return <SideBySide before={diff.beforeContent} after={diff.afterContent} />
  }
  return <div className="review-diff-hint">{t('sidePaneDiffUnavailable')}</div>
}

/** 逐行给 patch 上色。 */
function PatchView({ patch }: { patch: string }) {
  const lines = useMemo(() => patch.split('\n'), [patch])
  return (
    <pre className="review-patch">
      {lines.map((line, index) => {
        const kind = line.startsWith('+++') || line.startsWith('---')
          ? 'meta'
          : line.startsWith('@@')
            ? 'hunk'
            : line.startsWith('+')
              ? 'add'
              : line.startsWith('-')
                ? 'del'
                : line.startsWith('diff ') || line.startsWith('index ')
                  ? 'meta'
                  : 'ctx'
        return (
          // patch 行没有稳定 key(内容可能重复),用下标 —— 列表是只读且不重排的。
          <div className={`review-line ${kind}`} key={index}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}

/** 整文件新增(未跟踪文件):全部按"新增"着色。 */
function FullTextAdd({ content }: { content: string }) {
  const lines = useMemo(() => content.split('\n'), [content])
  return (
    <pre className="review-patch">
      {lines.map((line, index) => (
        <div className="review-line add" key={index}>
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}

/**
 * 前后全文对比:用最朴素的 LCS 逐行 diff。
 *
 * 为什么不引 diff 库:这里只需要"能看出改了哪几行",而 patch 路径已经
 * 覆盖了绝大多数场景(有 git 基线时)。全文对比只在"git 给不出 patch"时
 * 兜底,朴素算法足够;引库的收益不抵它的包体积与主题适配成本。
 *
 * 复杂度 O(n*m) 在超大文件上会炸,所以先按行数截断 —— 超过就直接平铺,
 * 不做对齐。
 */
const LCS_LINE_LIMIT = 1500

function SideBySide({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => {
    const left = before.split('\n')
    const right = after.split('\n')
    if (left.length > LCS_LINE_LIMIT || right.length > LCS_LINE_LIMIT) {
      return [
        ...left.map((line) => ({ kind: 'del' as const, text: line })),
        ...right.map((line) => ({ kind: 'add' as const, text: line })),
      ]
    }
    return diffLines(left, right)
  }, [before, after])

  return (
    <pre className="review-patch">
      {rows.map((row, index) => (
        <div className={`review-line ${row.kind}`} key={index}>
          {row.text || ' '}
        </div>
      ))}
    </pre>
  )
}

interface DiffRow {
  kind: 'ctx' | 'add' | 'del'
  text: string
}

/** 标准 LCS 回溯。 */
function diffLines(left: string[], right: string[]): DiffRow[] {
  const rows = left.length
  const cols = right.length
  // 二维表按 (rows+1) x (cols+1);用 Int32Array 扁平化省内存。
  const table = new Int32Array((rows + 1) * (cols + 1))
  const at = (i: number, j: number) => i * (cols + 1) + j
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[at(i, j)] =
        left[i] === right[j]
          ? table[at(i + 1, j + 1)]! + 1
          : Math.max(table[at(i + 1, j)]!, table[at(i, j + 1)]!)
    }
  }
  const out: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (left[i] === right[j]) {
      out.push({ kind: 'ctx', text: left[i]! })
      i += 1
      j += 1
    } else if (table[at(i + 1, j)]! >= table[at(i, j + 1)]!) {
      out.push({ kind: 'del', text: left[i]! })
      i += 1
    } else {
      out.push({ kind: 'add', text: right[j]! })
      j += 1
    }
  }
  while (i < rows) {
    out.push({ kind: 'del', text: left[i]! })
    i += 1
  }
  while (j < cols) {
    out.push({ kind: 'add', text: right[j]! })
    j += 1
  }
  return out
}

/**
 * 「本轮」来源的文件列表。
 *
 * 复用面板既有的行样式(`.review-row*`),但 diff 不用 git 的 patch 渲染,
 * 而是直接用对话流算出的 `EditDiff[]` —— 那些数据在点击卡片时就交过来了,
 * 不必再问后端要一次,也不必要求项目是 git 仓库。
 *
 * 行内不重复显示路径(外层标题已有),与卡片内的悬停预览同一种取舍。
 */
function TurnChangesList({
  files,
  open,
  onToggle,
  emptyLabel,
}: {
  files: readonly TurnProducedFile[]
  open: Record<string, boolean>
  onToggle: (path: string) => void
  /** 空态文案;null 表示"有筛选但无匹配"由调用方决定是否渲染。 */
  emptyLabel: string | null
}) {
  if (files.length === 0) {
    if (emptyLabel === null) return null
    return (
      <div className="review-empty">
        <IconFile size={28} />
        <p className="review-empty-title">{emptyLabel}</p>
      </div>
    )
  }
  return (
    <div className="review-list">
      {files.map((file) => {
        const expanded = open[file.path] ?? false
        return (
          <div className="review-row" key={file.path}>
            <button
              type="button"
              className="review-row-head"
              aria-expanded={expanded}
              onClick={() => onToggle(file.path)}
            >
              <span className="review-row-icon" aria-hidden="true">
                <IconFile size={14} />
              </span>
              <span className="review-row-path" title={file.path}>
                {file.path}
              </span>
              <span className="review-row-status" aria-hidden="true">
                <DiffStat added={file.added} removed={file.removed} compact />
              </span>
              <IconChevronDown
                size={14}
                className={`review-row-chevron${expanded ? ' open' : ''}`}
              />
            </button>
            {expanded && (
              <div className="review-diff">
                {file.diffs.length === 0 ? (
                  <div className="review-diff-hint">{t('reviewTurnNoDiff')}</div>
                ) : (
                  file.diffs.map((diff, index) => (
                    <DiffCard key={index} diff={diff} hidePath />
                  ))
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default ReviewPanel
