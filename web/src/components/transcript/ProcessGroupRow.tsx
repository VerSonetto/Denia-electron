import { useMemo, useState } from 'react'
import { t } from '../../i18n'
import { transcriptNodeKey, type ProcessGroupRow, type TranscriptNode } from '../../fold'
import { parseArgsObject } from '../../toolDisplay'
import type { AskAnswer } from '../../types'
import {
  IconAgentSpawn,
  IconChevron,
  IconEdit,
  IconGrep,
  IconRead,
  IconTerminal,
  IconThink,
  IconTodo,
  IconTool,
  IconWrite,
} from '../icons'
import { NodeView } from './NodeView'

type ProcessActivity =
  | 'thinking'
  | 'read'
  | 'search'
  | 'commands'
  | 'write'
  | 'edit'
  | 'subagents'
  | 'plan'
  | 'tools'

const RUNNING_LABELS = {
  thinking: 'processGroupRunningThinking',
  read: 'processGroupRunningRead',
  search: 'processGroupRunningSearch',
  commands: 'processGroupRunningCommands',
  write: 'processGroupRunningWrite',
  edit: 'processGroupRunningEdit',
  subagents: 'processGroupRunningSubagents',
  plan: 'processGroupRunningPlan',
  tools: 'processGroupRunningTools',
} as const

const DONE_LABELS = {
  thinking: 'processGroupDoneThinking',
  read: 'processGroupDoneRead',
  search: 'processGroupDoneSearch',
  commands: 'processGroupDoneCommands',
  write: 'processGroupDoneWrite',
  edit: 'processGroupDoneEdit',
  subagents: 'processGroupDoneSubagents',
  plan: 'processGroupDonePlan',
  tools: 'processGroupDoneTools',
} as const

function activityOf(name: string): ProcessActivity {
  if (name === 'read_file') return 'read'
  if (name === 'grep' || name === 'glob' || name === 'ls') return 'search'
  if (name === 'bash') return 'commands'
  if (name === 'write_file') return 'write'
  if (name === 'edit') return 'edit'
  if (
    name === 'spawn_agent' ||
    name === 'fork_agent' ||
    name === 'send_message' ||
    name === 'list_agents' ||
    name === 'wait_agent' ||
    name === 'interrupt_agent'
  ) {
    return 'subagents'
  }
  if (name === 'todo_write' || name === 'goal') return 'plan'
  return 'tools'
}

function iconOf(activity: ProcessActivity): JSX.Element {
  switch (activity) {
    case 'thinking':
      return <IconThink size={14} />
    case 'read':
      return <IconRead size={14} />
    case 'search':
      return <IconGrep size={14} />
    case 'commands':
      return <IconTerminal size={14} />
    case 'write':
      return <IconWrite size={14} />
    case 'edit':
      return <IconEdit size={14} />
    case 'subagents':
      return <IconAgentSpawn size={14} />
    case 'plan':
      return <IconTodo size={14} />
    default:
      return <IconTool size={14} />
  }
}

function cleanLine(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 160 ? `${normalized.slice(0, 159).trimEnd()}…` : normalized
}

function argumentDetail(name: string, args: string): string {
  const parsed = parseArgsObject(args)
  if (parsed === null) return ''
  const keys =
    name === 'bash'
      ? ['command', 'cmd']
      : name === 'grep' || name === 'glob'
        ? ['pattern', 'path']
        : name === 'spawn_agent' || name === 'fork_agent'
          ? ['description', 'prompt', 'name']
          : ['path', 'file_path', 'description', 'query']
  for (const key of keys) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim()) return cleanLine(value)
  }
  for (const value of Object.values(parsed)) {
    if (typeof value === 'string' && value.trim()) return cleanLine(value)
  }
  return ''
}

function latestReasoningLine(node: Extract<TranscriptNode, { kind: 'assistant' }>): string {
  for (let index = node.blocks.length - 1; index >= 0; index -= 1) {
    const block = node.blocks[index]
    if (block?.kind !== 'reasoning') continue
    const lines = block.text.replace(/\*\*/g, '').split(/\r?\n/)
    for (let line = lines.length - 1; line >= 0; line -= 1) {
      const text = lines[line]?.trim()
      if (text) return cleanLine(text)
    }
  }
  return ''
}

/** 当前正在执行的工具或正在流式输出的推理；均没有时返回 null。 */
function currentActivity(nodes: readonly TranscriptNode[]): { activity: ProcessActivity; detail: string } | null {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node === undefined) continue
    if (node.kind === 'tool' && node.result === undefined) {
      return { activity: activityOf(node.name), detail: argumentDetail(node.name, node.args) }
    }
    if (node.kind === 'assistant' && node.streaming) {
      return { activity: 'thinking', detail: latestReasoningLine(node) }
    }
  }
  return null
}

/** 完成态摘要只按工具类别计数；没有工具时回落到“已完成分析”。 */
function completedSummary(nodes: readonly TranscriptNode[]): string {
  const counts = new Map<ProcessActivity, number>()
  for (const node of nodes) {
    if (node.kind !== 'tool') continue
    const activity = activityOf(node.name)
    counts.set(activity, (counts.get(activity) ?? 0) + 1)
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([kind]) => kind)
  if (ranked.length === 0) return t(DONE_LABELS.thinking)
  const labels = ranked.slice(0, 3).map((kind) => t(DONE_LABELS[kind]))
  const title = labels.join(t('processGroupSummarySep'))
  return ranked.length > 3 ? t('processGroupSummaryMore', { title }) : title
}

export function ProcessGroup({
  row,
  onAskAnswer,
  onAskCancel,
}: {
  row: ProcessGroupRow
  onAskAnswer?: (requestId: string, answers: AskAnswer[]) => void
  onAskCancel?: (requestId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const live = useMemo(
    () => (row.running ? currentActivity(row.nodes) : null),
    [row.nodes, row.running],
  )
  const activity = live?.activity ?? 'thinking'
  const title = row.running ? t(RUNNING_LABELS[activity]) : completedSummary(row.nodes)
  const detail = live?.detail ?? ''
  return (
    <div className={`process-group work-process-group${row.running ? ' running' : ''}`}>
      <button className="process-head work-process-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`chev${open ? ' open' : ''}`}>
          <IconChevron size={11} />
        </span>
        <span className="work-process-icon">{iconOf(activity)}</span>
        <span className={`title${row.running ? ' work-process-live' : ''}`}>{title}</span>
        {detail && (
          <>
            <span className="sep work-process-sep" />
            <span className="work-process-detail">{detail}</span>
          </>
        )}
      </button>
      {open && (
        <div className="process-body work-process-body">
          {row.nodes.map((node) => (
            <NodeView
              key={transcriptNodeKey(node)}
              node={node}
              onAskAnswer={onAskAnswer}
              onAskCancel={onAskCancel}
            />
          ))}
        </div>
      )}
    </div>
  )
}