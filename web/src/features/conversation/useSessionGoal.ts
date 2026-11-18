import { useCallback, useEffect, useState } from 'react'

import * as api from '../../api'
import { t } from '../../i18n'
import { formatTokens } from '../../stats'

/** 会话目标(goal 模式):服务端权威视图 + 事件触发的重拉。 */
export function useSessionGoal(activeId: string | null) {
  const [goalView, setGoalView] = useState<api.GoalView | null>(null)

  const refreshGoal = useCallback(
    (id: string) => {
      api
        .getGoal(id)
        .then(setGoalView)
        .catch(() => setGoalView(null))
    },
    [],
  )

  /** 裸 /goal 的查看结果(多行 toast)。 */
  const goalSummaryText = (view: api.GoalView): string => {
    const goal = view.goal
    if (!goal) return t('goalNone')
    const budget = goal.tokenBudget !== null
      ? `${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}`
      : formatTokens(goal.tokensUsed)
    const statusLabel =
      goal.status === 'active'
        ? t('goalPhaseActive')
        : goal.status === 'paused'
          ? t('goalPhasePaused')
          : goal.status === 'budget-limited'
            ? t('goalPhaseBudgetLimited')
            : t('goalPhaseComplete')
    return t('goalSummary', {
      objective: goal.objective,
      status: statusLabel,
      budget,
      iteration: String(goal.iteration),
      elapsed: `${goal.timeUsedSeconds}s`,
    })
  }

  // 会话切换:拉取当前目标;SessionView 的 onGoalTouch(goal 事件/轮次
  // 闭合/快照)也走这里,用量与状态始终以服务端为准。
  useEffect(() => {
    if (!activeId) {
      setGoalView(null)
      return
    }
    refreshGoal(activeId)
  }, [activeId, refreshGoal])

  return { goalView, refreshGoal, goalSummaryText }
}
