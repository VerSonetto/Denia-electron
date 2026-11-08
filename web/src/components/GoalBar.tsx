import { useEffect, useRef, useState } from 'react'
import { goalAction, type GoalState, type GoalView } from '../api'
import { t } from '../i18n'
import { formatTokens } from '../stats'
import { IconCheck, IconClose, IconPencil } from './icons'

/** 目标横条图标(靶心)。 */
function IconGoal({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
    </svg>
  )
}

function goalStatusLabel(status: GoalState['status']): string {
  switch (status) {
    case 'active':
      return t('goalPhaseActive')
    case 'paused':
      return t('goalPhasePaused')
    case 'budget-limited':
      return t('goalPhaseBudgetLimited')
    case 'complete':
      return t('goalPhaseComplete')
  }
}

/** 最近一次完成校验的结论:放在标题上,不占横条宽度。 */
function lastVerificationHint(goal: GoalState): string | undefined {
  const last = goal.verifications[goal.verifications.length - 1]
  if (!last) return undefined
  const lines = [last.reason, last.nextAction].filter(
    (line): line is string => typeof line === 'string' && line.trim() !== '',
  )
  return lines.length > 0 ? lines.join('\n') : undefined
}

function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m${String(rest).padStart(2, '0')}s`
  return `${rest}s`
}

/**
 * 会话目标指示条:输入框上方的 36px 圆角横条,
 * 图标 + 状态标签 + 截断的目标文本 + 预算胶囊 + 迭代/耗时 + 操作按钮。
 *
 * 交互:编辑是条内内联表单(Enter 保存 / Esc 取消,只有成功才
 * 关表单);暂停/恢复/清除直接执行无确认弹窗;single-flight 防重复提交。
 * 完成的目标保留横条,让用户能看到完成校验的结论,再手动清除。
 */
export function GoalBar({
  sessionId,
  view,
  selection,
  onChanged,
}: {
  sessionId: string
  view: GoalView | null
  /** 当前模型选择:随操作传给服务端,goal 续跑据此回推。 */
  selection?: { provider?: string; model?: string; reasoningEffort?: string }
  onChanged: () => void
}) {
  const goal = view?.goal ?? null
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [budgetDraft, setBudgetDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const pendingRef = useRef(false)
  const objectiveRef = useRef<HTMLInputElement | null>(null)
  const selectionRef = useRef(selection)
  selectionRef.current = selection

  // 目标被外部变化(清除/重建/状态跳变)时重置编辑态,防止残留草稿覆盖
  // 新目标;服务端每次变化都会推进 updated。
  const goalUpdated = goal?.time.updated ?? null
  useEffect(() => {
    setEditing(false)
    setError(null)
  }, [goalUpdated, goal === null])

  useEffect(() => {
    if (editing) objectiveRef.current?.focus()
  }, [editing])

  // 运行中的目标每秒推进一次显示;tick 只存在于渲染层,不写回会话。
  const running = goal?.status === 'active' && goal.activeRunStartedAtMs !== null
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running, goal?.activeRunStartedAtMs])

  if (!goal) return null

  const beginEdit = () => {
    setDraft(goal.objective)
    setBudgetDraft(goal.tokenBudget === null ? '' : String(goal.tokenBudget))
    setError(null)
    setEditing(true)
  }

  const act = async (body: {
    action: 'set' | 'edit' | 'pause' | 'resume' | 'clear'
    objective?: string
    tokenBudget?: number
  }): Promise<boolean> => {
    if (pendingRef.current) return false
    pendingRef.current = true
    setPending(true)
    setError(null)
    try {
      await goalAction(sessionId, body, selectionRef.current)
      onChanged()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  const saveEdit = async () => {
    const objective = draft.trim()
    if (!objective) return
    const raw = budgetDraft.trim()
    // 空输入 = 预算不变;0 = 清除预算;非法数字保持表单打开。
    let tokenBudget: number | undefined
    if (raw) {
      const parsed = Number(raw)
      if (!Number.isFinite(parsed) || parsed < 0) {
        setError(t('goalBudgetInvalid'))
        return
      }
      tokenBudget = Math.floor(parsed)
    }
    const ok = await act({ action: 'edit', objective, tokenBudget })
    if (ok) setEditing(false)
  }

  const status = goalStatusLabel(goal.status)
  const budgetLabel =
    goal.tokenBudget === null
      ? formatTokens(goal.tokensUsed)
      : `${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}`
  const elapsedSeconds =
    goal.timeUsedSeconds +
    (running && goal.activeRunStartedAtMs !== null
      ? Math.max(0, Math.floor((now - goal.activeRunStartedAtMs) / 1000))
      : 0)

  if (editing) {
    return (
      <div className="goal-bar goal-bar-editing" data-goal-bar="">
        <input
          ref={objectiveRef}
          className="goal-objective-input"
          value={draft}
          placeholder={t('goalObjectivePlaceholder')}
          aria-label={t('goalObjectiveAria')}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void saveEdit()
            else if (event.key === 'Escape') setEditing(false)
          }}
        />
        <input
          className="goal-budget-input"
          value={budgetDraft}
          placeholder={t('goalBudgetPlaceholder')}
          title={t('goalBudgetHint')}
          aria-label={t('goalBudgetAria')}
          inputMode="numeric"
          onChange={(event) => setBudgetDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void saveEdit()
            else if (event.key === 'Escape') setEditing(false)
          }}
        />
        {error && (
          <span className="goal-error" role="alert">
            {error}
          </span>
        )}
        <button
          type="button"
          className="goal-action"
          title={t('goalActionSave')}
          aria-label={t('goalActionSave')}
          disabled={pending || !draft.trim()}
          onClick={() => void saveEdit()}
        >
          <IconCheck size={14} />
        </button>
        <button
          type="button"
          className="goal-action"
          title={t('goalActionCancel')}
          aria-label={t('goalActionCancel')}
          onClick={() => setEditing(false)}
        >
          <IconClose size={14} />
        </button>
      </div>
    )
  }

  return (
    <div
      className="goal-bar"
      data-goal-bar=""
      data-goal-status={goal.status}
      title={lastVerificationHint(goal)}
    >
      <span className="goal-icon">
        <IconGoal size={14} />
      </span>
      <span className="goal-status-label">{status}</span>
      <span className="goal-objective">{goal.objective}</span>
      <span className="goal-budget-pill">{budgetLabel}</span>
      <span className="goal-budget-pill" title={t('goalIterationHint')}>
        #{goal.iteration}
      </span>
      <span className="goal-budget-pill">{formatElapsed(elapsedSeconds)}</span>
      <span className="goal-spacer" />
      {error && (
        <span className="goal-error" role="alert">
          {error}
        </span>
      )}
      {goal.status === 'active' && (
        <button
          type="button"
          className="goal-action"
          title={t('goalActionPause')}
          aria-label={t('goalActionPause')}
          disabled={pending}
          onClick={() => void act({ action: 'pause' })}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <rect x="3.5" y="2.5" width="3" height="11" rx="1" />
            <rect x="9.5" y="2.5" width="3" height="11" rx="1" />
          </svg>
        </button>
      )}
      {(goal.status === 'paused' || goal.status === 'budget-limited') && (
        <button
          type="button"
          className="goal-action"
          title={t('goalActionResume')}
          aria-label={t('goalActionResume')}
          disabled={pending}
          onClick={() => void act({ action: 'resume' })}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M4.5 3.2a1 1 0 0 1 1.53-.85l7 4.8a1 1 0 0 1 0 1.7l-7 4.8a1 1 0 0 1-1.53-.85V3.2Z" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className="goal-action"
        title={t('goalActionEdit')}
        aria-label={t('goalActionEdit')}
        disabled={pending}
        onClick={beginEdit}
      >
        <IconPencil size={14} />
      </button>
      <button
        type="button"
        className="goal-action goal-action-danger"
        title={t('goalActionClear')}
        aria-label={t('goalActionClear')}
        disabled={pending}
        onClick={() => void act({ action: 'clear' })}
      >
        <IconClose size={14} />
      </button>
    </div>
  )
}
