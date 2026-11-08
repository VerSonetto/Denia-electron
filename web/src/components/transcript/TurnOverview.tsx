import { useMemo, useState } from 'react'
import { t } from '../../i18n'
import { useConversationFoldMode } from '../../features/conversation/foldMode'
import {
  groupProcessNodes,
  groupToolNodes,
  transcriptNodeKey,
  type OverviewRow,
} from '../../fold'
import { formatDuration } from './formatDuration'
import { IconChevron } from '../icons'
import { NodeView } from './NodeView'
import { ProcessGroup } from './ProcessGroupRow'
import { ToolGroup } from './ToolGroupRow'

export function TurnOverview({ row }: { row: OverviewRow }) {
  const [open, setOpen] = useState(row.defaultOpen)
  const mode = useConversationFoldMode()
  const children = useMemo(() => {
    if (mode === 'standard') {
      return groupProcessNodes(row.hidden).map((child) =>
        child.kind === 'process-group' ? { ...child, running: false } : child,
      )
    }
    if (mode === 'tool-group') return groupToolNodes(row.hidden)
    return row.hidden.map((node) => ({ kind: 'node' as const, node }))
  }, [mode, row.hidden])
  return (
    <div className="process-group">
      <button className="process-head" onClick={() => setOpen((o) => !o)}>
        <span className={`chev${open ? ' open' : ''}`}>
          <IconChevron size={11} />
        </span>
        <span className="title">
          {t('processOverview', {
            duration: formatDuration(row.durationMs),
            n: row.toolCount,
          })}
        </span>
      </button>
      {open && (
        <div className="process-body">
          {children.map((child) =>
            child.kind === 'process-group' ? (
              <ProcessGroup
                key={`process-group:${child.nodes[0] ? transcriptNodeKey(child.nodes[0]) : 'empty'}`}
                row={child}
              />
            ) : child.kind === 'tool-group' ? (
              <ToolGroup
                key={`tool-group:${child.group}:${child.tools[0]?.callId}`}
                row={child}
              />
            ) : (
              <NodeView key={transcriptNodeKey(child.node)} node={child.node} />
            ),
          )}
        </div>
      )}
    </div>
  )
}
