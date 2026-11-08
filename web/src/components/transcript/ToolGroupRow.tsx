import { useState } from 'react'
import { t } from '../../i18n'
import type { ToolGroupRow as ToolGroupData } from '../../fold'
import type { AskAnswer } from '../../types'
import { IconChevron, IconGrep, IconTerminal } from '../icons'
import { ToolRow } from './ToolRow'

/** 连续同类工具的聚合摘要；展开后仍是各自的普通工具行。 */
function groupSummary(row: ToolGroupData): string {
  if (row.group === 'terminal') {
    return t('toolGroupCommandCount', { n: row.tools.length })
  }
  let searches = 0
  let lists = 0
  let files = 0
  for (const tool of row.tools) {
    if (tool.name === 'grep' || tool.name === 'glob') searches += 1
    else if (tool.name === 'ls') lists += 1
    else if (tool.name === 'read_file') files += 1
  }
  const parts: string[] = []
  if (files > 0) parts.push(t('toolGroupFileCount', { n: files }))
  if (searches > 0) parts.push(t('toolGroupSearchCount', { n: searches }))
  if (lists > 0) parts.push(t('toolGroupListCount', { n: lists }))
  return parts.join(', ')
}

export function ToolGroup({
  row,
  onAskAnswer,
  onAskCancel,
}: {
  row: ToolGroupData
  onAskAnswer?: (requestId: string, answers: AskAnswer[]) => void
  onAskCancel?: (requestId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const running = row.tools.some((tool) => tool.result === undefined)
  return (
    <div className={`disc-row tool-row tool-group${open ? ' open' : ''}${running ? ' running' : ''}`}>
      <button className="disc-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="glyph">
          {running ? (
            <span className="dot run" />
          ) : row.group === 'terminal' ? (
            <IconTerminal size={14} />
          ) : (
            <IconGrep size={14} />
          )}
        </span>
        <span className="title">
          {row.group === 'terminal' ? t('toolGroupTerminal') : t('toolGroupExplore')}
        </span>
        <span className="sep" />
        <span className="summary">{groupSummary(row)}</span>
        <span className="chev">
          <IconChevron size={12} />
        </span>
      </button>
      {open && (
        <div className="disc-body tool-group-children">
          {row.tools.map((tool) => (
            <ToolRow
              key={tool.callId}
              node={tool}
              onAskAnswer={onAskAnswer}
              onAskCancel={onAskCancel}
            />
          ))}
        </div>
      )}
    </div>
  )
}