import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'

import * as api from '../../api'
import { notify } from '../../appStore'
import type { TranscriptNode } from '../../fold'
import { t } from '../../i18n'
import { invalidateSession } from '../../sessionStreams'
import type {
  PastedImage,
  PendingAttachment,
  QueuedMessage,
  UserMessageImage,
} from '../../types'

export interface RewindRequest {
  seq: number
  text: string
  images?: UserMessageImage[]
  changes: api.FileDiffEntry[]
  removedMessages: number
}

interface SessionRewindOptions {
  activeId: string | null
  runningRef: { current: boolean }
  nodesRef: { current: TranscriptNode[] }
  inputHistoryRefresh: () => unknown
  applyDraft: (text: string) => void
  setPastedImages: Dispatch<SetStateAction<PastedImage[]>>
  setAttachments: Dispatch<SetStateAction<PendingAttachment[]>>
  setQueuedMessages: Dispatch<SetStateAction<QueuedMessage[]>>
  setPendingMessages: Dispatch<SetStateAction<{ text: string; images?: UserMessageImage[] }[]>>
  clearNodes: () => void
  confirmedRef: { current: Map<string, number> }
  setAutoFlushSuppressed: (value: boolean) => void
  onRewound: () => void
}

/** 回退:预览文件变化 → 确认 → 物理截断 + 恢复文件。 */
export function useSessionRewind({
  activeId,
  runningRef,
  nodesRef,
  inputHistoryRefresh,
  applyDraft,
  setPastedImages,
  setAttachments,
  setQueuedMessages,
  setPendingMessages,
  clearNodes,
  confirmedRef,
  setAutoFlushSuppressed,
  onRewound,
}: SessionRewindOptions) {
  const [rewindReq, setRewindReq] = useState<RewindRequest | null>(null)
  const [rewindBusy, setRewindBusy] = useState(false)

  const handleRewind = useCallback(async (seq: number) => {
    if (!activeId || rewindBusy) return
    const node = nodesRef.current.find(
      (n): n is Extract<TranscriptNode, { kind: 'user' }> =>
        n.kind === 'user' && n.anchor === seq,
    )
    try {
      const [checkpointsRes, diffRes] = await Promise.all([
        api.getCheckpoints(activeId),
        api.getCheckpointDiff(activeId, seq),
      ])
      const index = checkpointsRes.checkpoints.findIndex((c) => c.seq === seq)
      if (index < 0) {
        notify('err', t('rewindNotFound'))
        return
      }
      setRewindReq({
        seq,
        text: node?.text ?? checkpointsRes.checkpoints[index]?.text ?? '',
        images: node?.images,
        changes: diffRes.changes,
        removedMessages: checkpointsRes.checkpoints.length - index,
      })
    } catch (error) {
      notify('err', error instanceof Error ? error.message : String(error))
    }
  }, [activeId, nodesRef, rewindBusy])

  const confirmRewind = useCallback(async () => {
    if (!activeId || !rewindReq || rewindBusy) return
    setRewindBusy(true)
    // 回退期间抑制队列自动发送:上面的打断会让 running 转 false,若不抑制,
    // 队首消息会在日志即将被截断的瞬间被发出去。
    setAutoFlushSuppressed(true)
    try {
      // 运行中也能回退:先替用户打断当前轮次并等它真正退出。不再要求
      // 先手动暂停 —— 但打断必须发生在用户确认之后(取消确认框时 AI
      // 照旧跑完,不因一次误点丢掉正在产出的回答)。
      //
      // cancel 幂等(没有运行中的轮次时服务端直接返回),所以不先判前端
      // running:另一个标签页发起的轮次也能被这一步收住。
      try {
        await api.cancelSession(activeId)
      } catch (error) {
        notify('err', error instanceof Error ? error.message : String(error))
      }
      // cancel 是异步的:等 driver 退出 running 再回退(running 期间
      // 后端拒绝回退,且截断日志会与正在写入的流互相踩)。
      const deadline = Date.now() + 5000
      while (runningRef.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      if (runningRef.current) {
        notify('err', t('rewindStopFailed'))
        return
      }
      const result = await api.rewindSession(activeId, rewindReq.seq)
      void inputHistoryRefresh()
      // 后端物理截断后事件 seq 重新编号,本页流引擎的 cursor 与 follow
      // 连接已失真:显式重连对齐(重拉快照校正 cursor、按需重开 follow),
      // 不依赖 SessionView 重挂载这类间接效应——否则快照竞态失败或另一
      // 标签页回退时,新事件帧会整段落在旧 cursor 之下被静默吞掉。
      invalidateSession(activeId)
      // 恢复目标消息文本/图片到输入框,方便修改后重发。
      applyDraft(result.toMessage ?? rewindReq.text)
      if (rewindReq.images && rewindReq.images.length > 0) {
        setPastedImages(
          rewindReq.images.map((image) => ({
            name: 'pasted-image.png',
            mime: image.mime,
            data: image.data,
            bytes: Math.ceil((image.data.length * 3) / 4),
            preview: `data:${image.mime};base64,${image.data}`,
          })),
        )
      } else {
        setPastedImages([])
      }
      setAttachments([])
      // 时间线已截断:乐观行、确认记录与排队消息一并作废。
      confirmedRef.current.clear()
      setPendingMessages([])
      setQueuedMessages([])
      clearNodes()
      // 强制重挂载 SessionView,重新拉截断后的快照。
      onRewound()
      notify('ok', t('rewindDone'))
      setRewindReq(null)
    } catch (error) {
      notify('err', error instanceof Error ? error.message : String(error))
    } finally {
      setAutoFlushSuppressed(false)
      setRewindBusy(false)
    }
  }, [
    activeId,
    runningRef,
    inputHistoryRefresh,
    applyDraft,
    setPastedImages,
    setAttachments,
    setQueuedMessages,
    setPendingMessages,
    clearNodes,
    confirmedRef,
    setAutoFlushSuppressed,
    onRewound,
    rewindReq,
    rewindBusy,
  ])

  return { rewindReq, setRewindReq, rewindBusy, handleRewind, confirmRewind }
}
