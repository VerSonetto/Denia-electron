import { useCallback, useState } from 'react'

import type { SessionEnvelope, TodoItem } from '../../types'

/** 会话运行面板的展示状态:待办、运行事件、计数与折叠。 */
export function useSessionRuntime() {
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [runtimeEvents, setRuntimeEvents] = useState<SessionEnvelope[]>([])
  const [runtimeCounts, setRuntimeCounts] = useState({ agents: 0, jobs: 0 })
  const [runtimeCollapsed, setRuntimeCollapsed] = useState(false)
  const handleRuntimeCountsChange = useCallback((counts: { agents: number; jobs: number }) => {
    setRuntimeCounts((current) => current.agents === counts.agents && current.jobs === counts.jobs ? current : counts)
  }, [])

  const reset = useCallback(() => {
    setTodos([])
    setRuntimeEvents([])
    setRuntimeCounts({ agents: 0, jobs: 0 })
    setRuntimeCollapsed(false)
  }, [])

  return {
    todos,
    setTodos,
    runtimeEvents,
    setRuntimeEvents,
    runtimeCounts,
    runtimeCollapsed,
    setRuntimeCollapsed,
    handleRuntimeCountsChange,
    reset,
  }
}
