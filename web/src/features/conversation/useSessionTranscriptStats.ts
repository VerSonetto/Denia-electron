import { useCallback, useEffect, useRef, useState } from 'react'

import type { SessionAnchor } from '../../api'
import type { TranscriptNode } from '../../fold'
import { attach } from '../../sessionStreams'
import {
  applyTotalsEvent,
  emptyTotals,
  resetTotals,
  totalsFromPage,
  type TotalsAccumulator,
} from '../../stats'
import type { SessionTotals } from '../../types'
import { NODES_THROTTLE_MS } from './sessionState'

/** 对话流节点、累计统计与轮次轴状态;流式节点按节拍落 state。 */
export function useSessionTranscriptStats(activeId: string | null) {
  // 当前会话的 transcript 节点,供状态栏统计。
  //
  // 节流写入:流式期间 nodes 每帧都是新数组,若直接 setState,这个页面
  // (连同 composer/侧栏/统计条/对话轴)会跟着每帧重渲染一次 —— 帧内的
  // React 工作量从"会话流子树"放大成"整页"。这里只在节拍上落一次 state
  // (StatsBar 这类只吃统计的下游不需要 60Hz),其余时刻由 nodesRef 承载
  // 最新值给异步逻辑(回退找节点等)读。
  const [transcriptNodes, setTranscriptNodes] = useState<TranscriptNode[]>([])
  // 状态栏累计统计:服务端对整份会话日志的投影当基准(随分页 meta 到达),
  // 之后只叠加实时帧 —— 分页窗口里没有早期轮次,自己按窗口折叠会在刷新、
  // 翻页、长会话实时裁剪时缩水。
  const [sessionTotals, setSessionTotals] = useState<SessionTotals>(() => emptyTotals())
  const totalsRef = useRef<TotalsAccumulator>({ totals: emptyTotals(), openTurns: new Map() })
  const nodesRef = useRef<TranscriptNode[]>([])
  const nodesThrottleRef = useRef<number | null>(null)
  const applyNodes = useCallback((nodes: TranscriptNode[], flush = false) => {
    nodesRef.current = nodes
    if (flush) {
      if (nodesThrottleRef.current !== null) {
        window.clearTimeout(nodesThrottleRef.current)
        nodesThrottleRef.current = null
      }
      setTranscriptNodes(nodes)
      return
    }
    if (nodesThrottleRef.current !== null) return
    nodesThrottleRef.current = window.setTimeout(() => {
      nodesThrottleRef.current = null
      setTranscriptNodes(nodesRef.current)
    }, NODES_THROTTLE_MS)
  }, [])
  // 卸载时收掉待发的节拍。**必须同步把 ref 置回 null**:节拍用 ref 是否非空
  // 当"已有待发任务"的判据,清了定时器却留着 id,后续每一次 applyNodes 都会
  // 以为还有任务在排队而直接 return —— 统计条这类只吃 transcriptNodes 的下游
  // 就再也不会更新。
  //
  // 这条路径在 StrictMode 下必现:开发模式挂载会跑一遍"挂载→卸载→挂载",
  // 首次挂载时 SessionView 的 effect 已经用空数组调过一次 applyNodes(排了
  // 节拍),卸载那一步把定时器清掉,于是整个会话期间状态栏不再出现。
  useEffect(
    () => () => {
      if (nodesThrottleRef.current !== null) {
        window.clearTimeout(nodesThrottleRef.current)
        nodesThrottleRef.current = null
      }
    },
    [],
  )
  /**
   * 未闭合轮次的起点:直接吃事件,不等 transcript 节点的 200ms 节流。
   *
   * 只存布尔不够 —— 耗时胶囊还要本轮起点;而节点尚未刷到时,按节点推导
   * 的起点要么缺失,要么还是上一轮的尾巴。这里在 turn-start 写入事件时间,
   * turn-end 立即清空,重连快照从未闭合表重建。null 即"已闭合",状态栏
   * 用它给轮次计数补上进行中的这一轮。
   */
  const [liveTurnStartedAt, setLiveTurnStartedAt] = useState<number | null>(null)
  // 全会话用户消息锚点(轮次轴刻度,来自分页响应,不受窗口限制)。
  const [axisAnchors, setAxisAnchors] = useState<SessionAnchor[]>([])
  // 轮次轴跳转请求:点击未加载刻度时递增 nonce 触发视图翻页定位。
  const [axisJump, setAxisJump] = useState<{ seq: number; nonce: number; behavior?: ScrollBehavior } | null>(null)

  const clearNodes = useCallback(() => {
    nodesRef.current = []
    setTranscriptNodes([])
  }, [])

  const reset = useCallback(() => {
    nodesRef.current = []
    setTranscriptNodes([])
    // 累计统计先清零,等新会话的分页 meta 重新给基准;否则会短暂显示上一
    // 会话的耗时/token。
    totalsRef.current = { totals: emptyTotals(), openTurns: new Map() }
    setSessionTotals(emptyTotals())
    setLiveTurnStartedAt(null)
    setAxisAnchors([])
    setAxisJump(null)
  }, [])

  useEffect(() => {
    if (!activeId) return
    const unsubscribe = attach(activeId, {
      onSnapshot: (_header, events, meta) => {
        // 累计统计以服务端全会话投影为基准(分页窗口里没有早期轮次),
        // 未闭合轮次表用页面事件重建;之后的重连重快照同样以新基准校正。
        totalsRef.current = resetTotals(totalsFromPage(meta?.totals), events)
        setSessionTotals({ ...totalsRef.current.totals })
        const starts = [...totalsRef.current.openTurns.values()]
        setLiveTurnStartedAt(starts.length > 0 ? Math.max(...starts) : null)
      },
      onEnvelope: (event) => {
        // 累计统计的实时增量:结算/工具调用/轮次闭合才动累计值,流式帧不动。
        if (applyTotalsEvent(totalsRef.current, event)) {
          setSessionTotals({ ...totalsRef.current.totals })
        }
        // 轮次开关与起点不吃节流:turn-start 立即写入,turn-end 立即清空。
        if (event.type === 'turn-start' || event.type === 'turn-end') {
          const starts = [...totalsRef.current.openTurns.values()]
          setLiveTurnStartedAt(starts.length > 0 ? Math.max(...starts) : null)
        }
      },
    })
    return () => {
      unsubscribe()
    }
  }, [activeId])

  return {
    transcriptNodes,
    sessionTotals,
    openTurn: liveTurnStartedAt !== null,
    openTurnStartedAt: liveTurnStartedAt,
    axisAnchors,
    setAxisAnchors,
    axisJump,
    setAxisJump,
    nodesRef,
    applyNodes,
    clearNodes,
    reset,
  }
}
