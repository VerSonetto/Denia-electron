import {
  useCallback,
  type ClipboardEvent,
  type Dispatch,
  type SetStateAction,
} from 'react'

import * as api from '../../api'
import { notify } from '../../appStore'
import { t } from '../../i18n'
import type { PastedImage, PendingAttachment } from '../../types'

/** 粘贴图片与路径附件:识图校验、剪贴板图片转 data URL、文件选择。 */
export function useComposerAttachments({
  optimizing,
  ensureVision,
  setPastedImages,
  setAttachments,
}: {
  optimizing: boolean
  ensureVision: () => boolean
  setPastedImages: Dispatch<SetStateAction<PastedImage[]>>
  setAttachments: Dispatch<SetStateAction<PendingAttachment[]>>
}) {
  const readFileAsDataUrl = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
  }, [])

  const handlePaste = useCallback(
    async (event: ClipboardEvent<HTMLElement>) => {
      if (optimizing) return
      const items = event.clipboardData?.items
      if (!items) return
      const imageItems = Array.from(items).filter(
        (item) => item.kind === 'file' && item.type.startsWith('image/'),
      )
      if (imageItems.length === 0) return
      // 粘贴图片:模型必须标记为可识图,否则拒绝。
      if (!ensureVision()) {
        event.preventDefault()
        return
      }
      event.preventDefault()
      for (const item of imageItems) {
        const file = item.getAsFile()
        if (!file) continue
        try {
          const preview = await readFileAsDataUrl(file)
          const comma = preview.indexOf(',')
          setPastedImages((previous) => [
            ...previous,
            {
              name: file.name || `pasted-${Date.now()}.png`,
              mime: file.type || 'image/png',
              data: comma >= 0 ? preview.slice(comma + 1) : preview,
              bytes: file.size,
              preview,
            },
          ])
        } catch {
          /* unreadable clipboard image: ignored */
        }
      }
    },
    [ensureVision, readFileAsDataUrl, optimizing, setPastedImages],
  )

  /** 编辑器粘贴:图片走识图流程,其余一律降级纯文本(保持节点结构纪律)。 */
  const onEditorPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const items = event.clipboardData?.items
    if (
      items &&
      Array.from(items).some((item) => item.kind === 'file' && item.type.startsWith('image/'))
    ) {
      void handlePaste(event)
      return
    }
    event.preventDefault()
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (text) document.execCommand('insertText', false, text)
  }

  const onPickFiles = useCallback(async () => {
    let paths: string[]
    try {
      // 只取路径:不读文件内容,大文件也不会进内存或网络。
      ({ paths } = await api.pickFiles())
    } catch (error) {
      notify('err', `${t('pickFilesFailed')}:${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (paths.length === 0) return
    setAttachments((previous) => [
      ...previous,
      // 重名只影响显示;发送用的是完整路径,不会互相覆盖。
      ...paths.map((path) => ({ name: path.split(/[/\\]/).pop() || path, path })),
    ])
  }, [setAttachments])

  return { handlePaste, onEditorPaste, onPickFiles }
}
