import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import * as api from '../../api'
import { notify } from '../../appStore'
import { t } from '../../i18n'
import { resolveSessionReasoningEffort } from '../../modelCatalog'
import { setModelSelection as setSharedModelSelection } from '../../modelSelectionStore'
import { attach } from '../../sessionStreams'
import type { CatalogModel, ModelCatalog, ModelSelection, SessionSummary } from '../../types'
import { readSessionModel, rememberSessionModel } from './sessionModelMemory'
import {
  firstAvailableSelection,
  LAST_MODEL_KEY,
  LAST_MODEL_KEY_LEGACY,
  latestRequestSelection,
  normalizeSelection,
} from './sessionState'

/**
 * 模型目录、会话级模型恢复与草稿模型记忆。
 *
 * 模型选择的事实源仍在页面,但读写规则集中在这里:目录刷新、草稿初始化、
 * 会话切换恢复、手动选择记忆,以及右侧面板共享选择的同步。
 */
export function useSessionModelSelection({
  activeId,
  catalogTick,
  activeSessionRef,
}: {
  activeId: string | null
  catalogTick: number
  activeSessionRef: { current: SessionSummary | null }
}) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const catalogRef = useRef<ModelCatalog | null>(null)
  const [selection, setSelection] = useState<ModelSelection | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .getCatalog()
      .then((next) => {
        if (!cancelled) {
          catalogRef.current = next
          setCatalog(next)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          notify('err', error instanceof Error ? error.message : String(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [catalogTick])

  const loadLastModel = (current: ModelCatalog): ModelSelection | null => {
    try {
      let raw = window.localStorage.getItem(LAST_MODEL_KEY)
      if (!raw) {
        // 改名 denia → Denia 前的旧 key:搬一次后清掉,用户选择不丢。
        raw = window.localStorage.getItem(LAST_MODEL_KEY_LEGACY)
        if (raw) {
          window.localStorage.setItem(LAST_MODEL_KEY, raw)
          window.localStorage.removeItem(LAST_MODEL_KEY_LEGACY)
        }
      }
      if (!raw) return null
      const parsed = JSON.parse(raw) as ModelSelection
      const group = current.groups.find((g) => g.id === parsed.provider)
      if (!group?.models.some((m) => m.id === parsed.model)) return null
      return normalizeSelection(current, parsed)
    } catch {
      return null
    }
  }

  /**
   * 草稿态(还没有会话)的初始模型:上一次用过的模型(localStorage 全局记忆),
   * 没有则目录里第一个可用模型。
   *
   * 只服务草稿态 —— 一旦进入某个会话,模型由那个会话决定(见下方的会话模型
   * 恢复效应),两者不共用来源,否则所有会话会退化成共用一个模型。
   */
  useEffect(() => {
    if (!catalog || selection) return
    const initial = loadLastModel(catalog) ?? firstAvailableSelection(catalog)
    if (initial) setSelection(normalizeSelection(catalog, initial))
  }, [catalog, selection])

  useEffect(() => {
    if (!catalog || !selection) return
    const valid = catalog.groups.some(
      (g) => g.id === selection.provider && g.models.some((m) => m.id === selection.model),
    )
    if (!valid) {
      const next = loadLastModel(catalog) ?? firstAvailableSelection(catalog)
      setSelection(next ? normalizeSelection(catalog, next) : null)
    }
  }, [catalog, selection])

  // 当前会话 id 的镜像:applySelection 写会话记忆时要用最新值。
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  // 已经恢复过模型的会话 id。同一会话只恢复一次,之后的重放快照与列表刷新
  // 都不得把用户手动换的选择顶回去。
  const restoredSelectionRef = useRef<string | null>(null)

  /**
   * 用户显式换了模型:写全局记忆(下一个新草稿的起点),并记进当前会话。
   *
   * 会话记忆必须在这里写:会话"刚选完模型但还没发消息"的那一段,日志里
   * 还是上一次请求的模型,切走再切回来会被恢复成旧值 —— 用户看到的就是
   * "切换会话把模型改掉了"。
   */
  const applySelection = (next: ModelSelection) => {
    if (!catalog) return
    const normalized = normalizeSelection(catalog, next)
    setSelection(normalized)
    try {
      window.localStorage.setItem(LAST_MODEL_KEY, JSON.stringify(normalized))
    } catch {
      /* storage unavailable */
    }
    rememberSessionModel(activeIdRef.current, normalized)
    // 手动选择本身就是这个会话的正确状态,后续快照不该再改它。
    restoredSelectionRef.current = activeIdRef.current
  }

  // 把当前模型选择同步给右侧面板的「AI 生成提交信息」(见 modelSelectionStore):
  // 它复用同一个模型,不让用户再选一次。
  useEffect(() => {
    setSharedModelSelection(selection)
  }, [selection])

  // 当前模型的思考强度档位:模型没提供档位时没有可调空间,控件不渲染。
  const effortLevels = useMemo(() => {
    if (!catalog || !selection) return []
    const group = catalog.groups.find((entry) => entry.id === selection.provider)
    const model = group?.models.find((entry) => entry.id === selection.model)
    return model?.reasoning?.efforts ?? []
  }, [catalog, selection])
  const activeEffort = selection
    ? resolveSessionReasoningEffort(effortLevels, selection.reasoningEffort)
    : undefined

  /**
   * 模型选择恢复:切换会话时把编辑器上的模型切到**这个会话自己的**模型,
   * 而不是沿用上一会话的选择。
   *
   * 取值优先级:
   *   1. 会话里刚选过但还没发消息的那一次(本地记忆,见 sessionModelMemory);
   *   2. 会话日志投影出的最后模型(服务端 last_selection,覆盖全部历史);
   *   3. 会话摘要里带的同一份投影(列表接口,快照还没到时的兜底);
   *   4. 都没有 → 保持当前值(空会话沿用你在别处选好的模型)。
   *
   * 恢复只对每个会话做一次,之后的重放快照与列表刷新都不覆盖手动选择。
   * (权限模式同步与审批监听的那一半订阅在 usePermissions 里。)
   */

  /** 把一份候选选择落到编辑器;目录里已没有该模型时返回 false(交给上层兜底)。 */
  const restoreSelection = useCallback((candidate: ModelSelection | null | undefined): boolean => {
    const current = catalogRef.current
    if (!candidate || !current) return false
    const usable = current.groups.some(
      (group) => group.id === candidate.provider && group.models.some((m) => m.id === candidate.model),
    )
    if (!usable) return false
    setSelection(normalizeSelection(current, candidate))
    return true
  }, [])

  // 会话切换:先用本地记忆/摘要投影立刻落一次,不必等快照往返 ——
  // 否则切换瞬间编辑器会短暂显示上一个会话的模型。
  //
  // 守卫按会话 id 判等而不是"初始化为 null":效果执行顺序、目录刷新时机都
  // 不影响正确性 —— 同一个会话只落一次,换会话自然重新落。
  useEffect(() => {
    if (!activeId || !catalog) return
    if (restoredSelectionRef.current === activeId) return
    // 摘要只在这里读一次(切换时的那一份);列表刷新(标题/时间变化)不进
    // 依赖,否则会把用户刚换的模型顶回摘要里的旧值。
    const remembered = readSessionModel(activeId) ?? activeSessionRef.current?.last_selection
    if (restoreSelection(remembered)) restoredSelectionRef.current = activeId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, catalog, restoreSelection])

  useEffect(() => {
    if (!activeId) return
    const unsubscribe = attach(activeId, {
      onSnapshot: (_header, events, meta) => {
        if (restoredSelectionRef.current !== activeId) {
          // 目录未就绪时不消耗恢复机会,等后续自愈快照重试。
          if (!catalogRef.current) return
          const remembered = readSessionModel(activeId)
          if (remembered) {
            // 本地记忆更新(用户刚选过):它比日志新,快照不得覆盖。
            if (restoreSelection(remembered)) restoredSelectionRef.current = activeId
            return
          }
          // 快照里的 last_selection 是全会话投影;老后端没有这个字段时
          // 退回扫描窗口里的 request-header(仅 request-context 兜底)。
          const logged = meta?.lastSelection ?? latestRequestSelection(events)
          if (restoreSelection(logged)) restoredSelectionRef.current = activeId
        }
      },
      onEnvelope: () => {},
    })
    return () => {
      unsubscribe()
    }
  }, [activeId, restoreSelection])

  const visionModelInfo = useCallback((): CatalogModel | null => {
    if (!catalog || !selection) return null
    const group = catalog.groups.find((g) => g.id === selection.provider)
    return group?.models.find((m) => m.id === selection.model) ?? null
  }, [catalog, selection])

  const modelSupportsVision = useCallback((): boolean => {
    const model = visionModelInfo()
    return !!model?.inputModalities?.includes('image')
  }, [visionModelInfo])

  /** 检查模型能否识图;不能时提示并返回 false(拒绝粘贴/发送)。 */
  const ensureVision = useCallback((): boolean => {
    if (modelSupportsVision()) return true
    notify('err', `${t('imageNotSupportedTitle')}:${t('imageNotSupportedDesc')}`)
    return false
  }, [modelSupportsVision])

  return {
    catalog,
    selection,
    applySelection,
    restoreSelection,
    effortLevels,
    activeEffort,
    visionModelInfo,
    modelSupportsVision,
    ensureVision,
  }
}
