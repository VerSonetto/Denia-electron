import type { RefObject } from 'react'

import type * as api from '../api'
import { t } from '../i18n'
import type {
  ModelCatalog,
  ModelSelection,
  PermissionChoice,
  ReasoningEffortInfo,
  SessionSummary,
} from '../types'
import { ComposerContextMenu } from './ComposerContextMenu'
import { ComposerEffortControl } from './ComposerEffortControl'
import { ComposerModelMenu } from './ComposerModelMenu'
import { ContextRing } from './ContextRing'
import { PermissionSelector } from './PermissionSelector'
import { IconPromptOptimize, IconSend, IconSpinner, IconStop, IconUndo } from './icons'

/** 输入框底部工具条:上下文、权限、模型、思考强度、优化、上下文环与发送。 */
export function ComposerToolbar({
  panelAnchorRef,
  inert,
  optimizing,
  sending,
  running,
  canOptimize,
  promptEmpty,
  primaryStops,
  contextProjectPath,
  filesAvailable,
  activeId,
  sessions,
  showAttachRow,
  permission,
  permissionBusy,
  showApproveForMe,
  selection,
  catalog,
  activeEffort,
  effortLevels,
  optimizedPrompt,
  context,
  onOpenContextMenu,
  onPickFiles,
  onInsertFile,
  onAddContextSession,
  onInsertCommand,
  onPermissionChange,
  onSelectionChange,
  onUndoOptimize,
  onOptimize,
  onStop,
  onSend,
}: {
  panelAnchorRef: RefObject<HTMLDivElement | null>
  inert: boolean
  optimizing: boolean
  sending: boolean
  running: boolean
  canOptimize: boolean
  promptEmpty: boolean
  primaryStops: boolean
  contextProjectPath: string | null
  filesAvailable: boolean
  activeId: string | null
  sessions: SessionSummary[]
  showAttachRow: boolean
  permission: PermissionChoice
  permissionBusy: boolean
  showApproveForMe: boolean
  selection: ModelSelection | null
  catalog: ModelCatalog | null
  activeEffort: string | undefined
  effortLevels: ReasoningEffortInfo[]
  optimizedPrompt: string | null
  context: api.ContextBreakdownResponse | null
  onOpenContextMenu: () => void
  onPickFiles: () => void
  onInsertFile: (candidate: api.MentionCandidate) => void
  onAddContextSession: (session: SessionSummary, signal: AbortSignal) => Promise<void>
  onInsertCommand: (name: string) => void
  onPermissionChange: (level: PermissionChoice) => void
  onSelectionChange: (next: ModelSelection) => void
  onUndoOptimize: () => void
  onOptimize: () => void
  onStop: () => void
  onSend: () => void
}) {
  return (
    <div className="prompt-bar">
      {/* 左组:添加上下文与权限档位。 */}
      <div className="composer-left">
        <ComposerContextMenu
          panelAnchorRef={panelAnchorRef}
          disabled={inert || optimizing || sending}
          projectPath={contextProjectPath}
          filesAvailable={filesAvailable}
          activeId={activeId}
          sessions={sessions}
          commands={!showAttachRow ? [
            { name: 'goal', label: t('contextGoal'), description: t('cmdGoalDesc') },
            { name: 'plan', label: t('contextPlan'), description: t('cmdPlanDesc') },
          ] : []}
          onOpen={onOpenContextMenu}
          onUpload={onPickFiles}
          onFile={onInsertFile}
          onSession={onAddContextSession}
          onCommand={onInsertCommand}
        />
        <PermissionSelector
          value={permission}
          onChange={onPermissionChange}
          disabled={inert || permissionBusy}
          showApproveForMe={showApproveForMe}
        />
      </div>
      {/* 右组:模型 → 思考强度 → 优化 → 上下文 → 发送,一条从左到右的链。 */}
      <div className="composer-right">
        {selection && (
          <div className="composer-model-group">
            {catalog && selection && (
              <ComposerModelMenu
                catalog={catalog}
                selection={selection}
                disabled={inert || optimizing}
                onChange={onSelectionChange}
              />
            )}
            {selection && activeEffort && effortLevels.length > 0 && (
              <ComposerEffortControl
                key={`${activeId}:${selection.provider}:${selection.model}`}
                efforts={effortLevels}
                value={activeEffort}
                disabled={inert || optimizing}
                onChange={(effort) => onSelectionChange({ ...selection, reasoningEffort: effort })}
              />
            )}
          </div>
        )}
        <button
          type="button"
          className={`icon-btn composer-opt-btn${optimizedPrompt ? ' undo' : ''}${optimizing ? ' busy' : ''}`}
          title={optimizedPrompt ? t('optimizeUndo') : t('optimizePromptHint')}
          aria-label={optimizing ? t('optimizing') : optimizedPrompt ? t('optimizeUndo') : t('optimizePrompt')}
          disabled={!canOptimize}
          onClick={() => {
            if (optimizedPrompt) onUndoOptimize()
            else onOptimize()
          }}
        >
          {optimizing ? (
            <IconSpinner size={16} />
          ) : optimizedPrompt ? (
            <IconUndo size={16} />
          ) : (
            <IconPromptOptimize size={16} />
          )}
        </button>
        <ContextRing
          pressure={context?.pressure}
          breakdown={context?.breakdown}
          sessionId={activeId ?? undefined}
          running={running}
        />
        {primaryStops ? (
          <button
            type="button"
            className="btn-send stop"
            onClick={onStop}
            title={t('stop')}
            aria-label={t('stop')}
          >
            <IconStop size={14} />
          </button>
        ) : (
          <button
            type="button"
            className="btn-send"
            disabled={promptEmpty || sending || optimizing || inert}
            onClick={onSend}
            title={t('run')}
            aria-label={t('run')}
          >
            <IconSend size={16} />
          </button>
        )}
      </div>
    </div>
  )
}
