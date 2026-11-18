import type { RewindRequest } from '../features/conversation/useSessionRewind'
import { t } from '../i18n'
import { ConfirmDialog } from './ConfirmDialog'

/** 回退确认:列出将恢复/删除的文件,运行中额外提示会先中断本轮。 */
export function RewindDialog({
  request,
  running,
  onConfirm,
  onCancel,
}: {
  request: RewindRequest
  running: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <ConfirmDialog
      open
      title={t('rewindConfirmTitle')}
      desc={
        (request.changes.length > 0
          ? t('rewindConfirmDesc', {
              removed: request.removedMessages,
              files: request.changes.length,
            })
          : t('rewindConfirmSimple', { removed: request.removedMessages })) +
        // 运行中回退会先替用户打断本轮:这件事必须在确认前说清楚。
        (running ? ` ${t('rewindConfirmInterrupt')}` : '')
      }
      danger
      confirmLabel={t('rewind')}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {request.changes.length > 0 && (
        <div className="rewind-file-list">
          {request.changes.map((change) => (
            <div key={change.path} className="rewind-file-row">
              <span className={`rewind-file-action ${change.action}`}>
                {change.action === 'restore' ? t('rewindRestore') : t('rewindDelete')}
              </span>
              <code title={change.root}>
                {change.root
                  ? `${change.root.split(/[\\/]/).filter(Boolean).pop() ?? change.root}/${change.path}`
                  : change.path}
              </code>
            </div>
          ))}
        </div>
      )}
    </ConfirmDialog>
  )
}
