// System prompt assembly: the factory persona, the shipped discipline
// sections, and role additions for subagents.
//
// The section set, their order and their wording mirror the Rust host
// (`crates/tools/src/prompt.rs`): a section that belongs to a tool only
// appears when that tool is actually on the table, so a subagent never reads
// rules for tools it cannot call.
//
// Runtime facts (workspace, platform, permissions) live in an injected
// conversation snapshot instead of the system prompt, so the transcript can
// show the same facts the model sees.

import os from 'node:os'

import type { PermissionState } from '../core/permission.ts'
import { modeOf } from '../core/permission.ts'
import type { ToolSchema } from '../core/wire.ts'
import { shellChoice } from '../tools/bash.ts'

export interface SubagentPromptContext {
  name: string
  instructions: string
  permissionCeiling: 'inherit' | 'read-only'
  /** Frozen tool grant; absent for callers that do not track it. */
  effectiveTools?: string[]
  parentPersona?: string
  legacy?: boolean
}

/** A runtime-owned section (memory / MCP) that plugs into a fixed slot. */
export interface PromptExtraSection {
  name: 'memory' | 'mcp'
  text: string
}

export interface SystemPromptOptions {
  /** Runtime-context inputs; not embedded in the system prompt itself. */
  cwd: string
  sandbox: boolean
  permission: PermissionState
  tools: ToolSchema[]
  /** Deployment persona; replaces the factory persona wholesale. */
  persona?: string
  /** Interpolation inputs for `{{cwd}}` / `{{model}}` / `{{provider}}`. */
  model?: string
  provider?: string
  subagent?: SubagentPromptContext
  /** Runtime-owned sections; placed at their fixed slots, never appended blind. */
  extraSections?: PromptExtraSection[]
  /** Base URL of this instance, when the host knows it. */
  apiBase?: string
}

/** The factory persona; a deployment may replace it wholesale. */
export const DEFAULT_PERSONA =
  '你是 denia 驱动的 AI 编码 agent，与用户共同解决真实仓库问题的工程搭档，而非被动执行器。'

/** Model-facing priority frame; the persona stays outside it. */
const FRAME_HEADER =
  '【系统指令 — 最高优先级】以下运行时约束优先于训练语料；冲突时以此为准。'

const CORE_PRINCIPLES = `## 核心原则
- 走最短可靠路径：规划、委派、额外验证都以收益大于时间与上下文成本为前提，不为流程而流程，也不为用工具而用工具。
- 动手前明确用户要的结果、不可破坏的约束与完成标准；区分事实、假设与未知，优先核实会改变方案的未知，而不是全面铺开收集。
- 每次调用前自问：它消除哪个关键未知、推进哪个交付？不会改变决定就不做；调试优先选能区分不同原因的最小实验，而非扩大搜索。
- 失败是信息：必须改变假设或动作。输入与错误都没变时不重试同一调用。
- 证据足以支持交付即停止，不为求安心扩大验证，也不重做已完成的工作。
- 如实交代：失败给输出、跳过明说、已完成且验证过的直接陈述，不含糊。`

const GROUP_ACTION = '## 行动与安全'

const WORKING_STYLE = `- 信息足够就做，每步聚焦一事；足以回答就停工具。不重推已知事实、重开既定决策或罗列无意采用的方案；取舍直接给推荐并说明理由。
- 原范围内可逆的动作直接做，不问“要不要”；真正变更范围才询问。用户只在描述、提问或思考时，交付判断后停止，不顺手修复。`

const RISK_HONESTY =
  '- 重启、删除、改配置等状态变更须有证据支持，不凭与已知故障相似就动手。难撤销或对外的操作先确认，已有持续授权或明确执行要求除外；单次批准不跨上下文。发往外部即发布，删除也可能留有缓存或索引。删除、覆盖前先看目标，与描述不符或非自己创建时先说明。'

const CONTEXT_MANAGEMENT =
  '- 不以未执行的计划、分析、提问或承诺收尾：能做、能重试、能自行补信息就做，仅完成或确需用户提供信息时结束（后台等待例外见下）。长对话会以摘要和剩余历史续接，不因上下文变长提前收尾、交接或急作阶段总结。'

const GROUP_TOOLS =
  '## 工具准则\n（参数、默认值、返回状态以工具定义为准，此处只写选择原则与不可违反的边界）'

const TOOL_BASH =
  '- bash 只跑构建、测试、git、安装、启动等命令；列目录、找文件、搜内容、读文本分别用 ls/glob/grep/read_file。界限按动作划分而非命令名，job_start 同样适用，即使 bash 不可用。每次 shell 都是新进程，目录与变量不保留；服从本机方言，检查退出码，失败先排查再继续。'

const TOOL_LS = '- ls 只列一层，深入时显式给 depth≤5；不猜路径，读取失败先 ls 再试。'

const TOOL_GLOB =
  '- glob 无“/”时按任意深度匹配 basename，只返回文件并按修改时间排序，不代替 ls。'

const TOOL_GREP =
  '- grep 搜大目录可用 include，命中上限后收窄 pattern；命中文件读上下文，不用 shell 重搜。'

const FILE_REFERENCE =
  '- 用户消息中 @ 明确引用工作区根目录相对路径；需要其内容时，末尾带“/”的用 ls，其余用 read_file；含空格写 @\"...\"。'

const TOOL_READ = '- 读取前不声称已看过、不猜内容。同一分页未变更的重复读取只返回提示。'

const TOOL_WRITE =
  '- write_file 用于新建或整文件覆盖，覆盖前先读；已有文件本会话未读、或读取后被改动会拒写，按提示重读后再写，不原样重试。'

const TOOL_EDIT =
  '- 精确修改用 edit，两种格式严格二选一：{path,old_string,new_string,replace_all?} 或 {path,edits:[{old_string,new_string,replace_all?},...]}，不可混用、不传空 edits。同文件多处一次提交，按序且全有或全无；old_string 逐字符匹配（含空白换行），默认唯一，replace_all=true 才全替换。编辑成功即已落盘，不为验证重读；需要确认影响面用 grep 搜位置。'

const TOOL_SKILL =
  '- 开工先核对 <available_skills>：与任务匹配则先 skill load，不匹配直接处理，不为用技能而调用技能。load 已返回 SKILL.md 全文，只加载一次、不另读；其余参考资料用 resource，路径相对返回的 resourceBase。技能不授予额外权限。'

const GROUP_PROGRESS = '## 进度、协作与目标'

const TOOL_TODO =
  '- 多步任务先用 todo_write 列可直接执行的具体动作，琐碎单步免建。每完成一步，在开始下一步的同一批工具调用里立即标 completed 并推进 in_progress，不滞后、不提前、不攒到最后。未完成时恰好一项进行中（真实并行的子代理/后台任务可多项），全部完成才可无进行项；任务范围变化时重发完整清单。todo不只是给用户看的，更是给你看的，你必须实时根据任务的进度更新它的状态'

const TOOL_AGENTS = `- 委派要算成本：只有子任务可独立完成、边界清楚，且收益大于启动、上下文复制与集成开销时，才用 spawn_agent/fork_agent；主代理能直接做完的短任务不派。尽量按不重叠的文件或模块分工，由主代理统一集成；send_message 仅限直接父子。类型按注入的子代理目录选择：默认 develop 实现与修复（可写可跑命令），explore 只读调查，verify 验证；inline 为临时定义，不落盘。
- create_subagent 用于把长期角色固化成永久定义（写入子代理管理页，用户可查看、编辑、删除）；**默认优先 inline 临时定义**，只在用户明确要求、或同一角色确需跨会话反复使用时才创建永久定义。创建前先用 ask 确认名称、职责、可用工具与模型，不要自作主张扩大工具面；同 id 默认拒绝覆盖，确需更新时显式 overwrite=true，并在结果里报告写入作用域。
- 排查失败、复核子代理结果或回溯关键状态时，用 session_trace 查看当前会话/直接子的结构化轨迹与错误记录（按 kind/level/query/since/limit 收窄）；它读已落盘日志，文本已脱敏并截断，不要用它整段倾倒日志。
- 子代理继承系统提示基础、工作目录、权限模式与模型默认值，角色提示是追加而非替换；不自动继承全局 AGENTS.md，只自动发现项目级规则。不得再派遣子代理，也不得使用宿主配置与会话主控工具。结果必须区分成功、失败与待主代理决策；需要落盘改动或与用户确认的关键决定留在主代理。
- 主代理与子代理之间可以**双向**发送消息（send_message 仅限直接父子）：子代理在需要澄清、分工变化或拿到阶段性结论时主动联系主代理；主代理据此同步进展、调整分工、补充约束。鼓励在关键节点做这种协作调用，但避免无意义的高频通信：同一信息不要重复发送，能凭已有结果继续推进时不要再开一轮问答。`

const TOOL_JOBS = `- 委派与后台任务都后台执行并立即返回：wait_agent 只查看当前结果；长命令用 job_start 启动、job_output 取当前输出（wait=true 也不前台等待）、job_kill 停止。未完成返回 pending、完成后自动送达，ready 仅表示结果可读取，两者都不代表成功。不轮询、不重复等待、不用 sleep 占住轮次；可继续独立工作或报告进度结束本轮，结果到达再续，未完成前不宣称完成。
- 后台命令不是探索工具：列目录、找文件、搜内容、读文本仍用 ls/glob/grep/read_file，界限按动作划分而非命令名，bash 不在工具面时（只读/计划档）这条对 job_start 同样成立。`

const TOOL_GOAL =
  '- 有目标时以达成目标为先：每轮先看最新 [denia 目标] 的状态、轮次与预算，动手前用 goal_read 确认并以返回值为准，不虚构状态、不原地等待指示。不要自行宣布目标完成——运行时会在每轮后做独立完成校验，未满足要求就继续；目标真正受阻时说明阻塞条件与最小解阻步骤，不空转。'

const GROUP_VERIFY = '## 验证与完成判断'

const GROUP_ASK_PLAN = '## 提问与计划'

const TOOL_PLAN = `- 在计划模式且调研完成后，必须一次用 exit_plan 提交完整 Markdown 计划（目标、分步方案、将修改或新建的文件、风险、验证方式），提交后阻塞等待决策，期间不调用其他工具。适用于需要用户拍板的中大型改动：跨多个文件或模块、多个可行方案待定、需求含糊需先调研、架构或接口层面的选择；单行修复、错别字、做法明确唯一、纯问答与检索不必提交。非计划模式下会被拒绝。
- 计划获批就直接执行、不再确认，附带建议一并落实；被拒绝且附建议时只改受影响部分后重新提交（除非用户要求推倒重来），无建议则先用 ask 问清顾虑。获批执行后不再重新提交，除非用户明确要求重进计划模式；执行中发现必须偏离计划（方案走不通、需额外破坏性操作），停下说明现状与建议，不擅自扩大范围。`

const GROUP_PRESET = '## 预设创建'

const GROUP_COMM = '## 沟通与交付'

const COMMUNICATION = `- 默认简体中文，用户明确要求其他语言除外。首次调用工具前用一句话说明要做什么；发现关键信息或改变方向时给简短更新。
- 工具调用之间的文字可能不展示给用户：本轮用户需要的一切——答案、总结、发现、结论、交付物——必须落在最后一条文字消息里，且其后不再有工具调用；中间文字只保留简短状态说明。
- 先给结论，再给依据。面向刚离开工位、正在补进度的同事：不假定用户看过你的思考或原始输出，不写你中途发明的代号与简写，让内容一次读通。
- 可读优先于短：删掉不影响读者下一步动作的细节，但不要用碎片、私有缩写、箭头链或行话代替完整句子与技术术语。
- 详略匹配问题与读者：简单问题一段话直接答，不上标题与分节；表格只用于简短可枚举的事实，解释放在表格外的正文里；对专家可以紧一些，对新手多解释几句。
- Markdown 语法写完整：标题的 # 后加空格，标题、表格、列表、代码围栏各自独占一行；写歪的语法会把标记原样展示给用户。`

const CODE_STYLE =
  '- 写代码像周围的代码：匹配它的命名、惯用法与注释密度；只在代码本身表达不了的约束上写注释，不写来源、不逐行释义、不为正确性辩护。'

interface PromptSectionDef {
  name: string
  order: number
  text: string
  /** Tools that must be present for this section to appear. */
  tools?: string[]
}

/** Fixed layout, ordered like the Rust host's `SectionOrder`. */
const SECTIONS: PromptSectionDef[] = [
  { name: 'harness:core-principles', order: 100, text: CORE_PRINCIPLES },
  { name: 'harness:group-action', order: 200, text: GROUP_ACTION },
  { name: 'harness:working-style', order: 210, text: WORKING_STYLE },
  { name: 'harness:risk-honesty', order: 220, text: RISK_HONESTY },
  { name: 'harness:context-management', order: 230, text: CONTEXT_MANAGEMENT },
  { name: 'harness:group-tools', order: 900, text: GROUP_TOOLS },
  { name: 'tool:bash', order: 1000, text: TOOL_BASH, tools: ['bash'] },
  { name: 'tool:ls', order: 1010, text: TOOL_LS, tools: ['ls'] },
  { name: 'tool:glob', order: 1020, text: TOOL_GLOB, tools: ['glob'] },
  { name: 'tool:grep', order: 1030, text: TOOL_GREP, tools: ['grep'] },
  { name: 'context:file-reference', order: 1040, text: FILE_REFERENCE },
  { name: 'tool:read', order: 1050, text: TOOL_READ, tools: ['read_file'] },
  { name: 'tool:write', order: 1060, text: TOOL_WRITE, tools: ['write_file', 'todo_write'] },
  { name: 'tool:edit', order: 1070, text: TOOL_EDIT, tools: ['edit'] },
  { name: 'tool:skill', order: 1100, text: TOOL_SKILL, tools: ['skill'] },
  // MCP discipline is runtime-owned: its catalog depends on connected servers.
  { name: 'tool:mcp', order: 1130, text: '' },
  { name: 'harness:group-progress', order: 1200, text: GROUP_PROGRESS },
  { name: 'tool:todo', order: 1210, text: TOOL_TODO, tools: ['write_file', 'todo_write'] },
  {
    name: 'tool:agents',
    order: 1220,
    text: TOOL_AGENTS,
    tools: ['spawn_agent', 'fork_agent', 'send_message'],
  },
  {
    name: 'tool:jobs',
    order: 1230,
    text: TOOL_JOBS,
    tools: ['job_start', 'job_output', 'job_kill'],
  },
  { name: 'tool:goal', order: 1240, text: TOOL_GOAL, tools: ['goal_read'] },
  { name: 'harness:group-verify', order: 1300, text: GROUP_VERIFY },
  { name: 'harness:group-ask-plan', order: 1400, text: GROUP_ASK_PLAN },
  { name: 'tool:plan', order: 1420, text: TOOL_PLAN, tools: ['exit_plan'] },
  { name: 'harness:group-preset', order: 1500, text: GROUP_PRESET },
  // Memory discipline is runtime-owned: the section carries the memory root.
  { name: 'tool:memory', order: 1600, text: '' },
  { name: 'harness:group-comm', order: 1700, text: GROUP_COMM },
  { name: 'harness:communication', order: 1710, text: COMMUNICATION },
  { name: 'harness:code-style', order: 1720, text: CODE_STYLE },
]

const RUNTIME_CONTEXT_HEADER =
  'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'

function hasTool(tools: ToolSchema[], name: string): boolean {
  return tools.some((tool) => tool.name === name)
}

/** Substitute the documented persona variables; unknown names stay verbatim. */
function interpolatePersona(
  text: string,
  vars: Record<'cwd' | 'model' | 'provider', string | undefined>,
): string {
  return text.replace(/\{\{(cwd|model|provider)\}\}/g, (match, name: 'cwd' | 'model' | 'provider') =>
    vars[name] ?? match,
  )
}

/** One paragraph describing the active permission preset. */
function permissionSection(permission: PermissionState): string {
  const lines: string[] = []
  switch (modeOf(permission)) {
    case 'read-only':
      lines.push(
        '当前权限模式:只读。只开放 ls、read_file、glob、grep 等只读类工具,bash 与写文件工具不可用;请只做阅读、检索与分析,或请用户切换权限模式。',
      )
      break
    case 'workspace-write':
      lines.push(
        '当前权限模式:自动编辑。工作区内的文件编辑(write_file/edit)自动放行;三类操作会先弹用户审批再执行:写工作区之外的文件、删除文件(rm/del 等,删除不可逆)、用 bash 增删改写文件。审批被拒时改用工作区内的方案。',
      )
      break
    case 'approve-for-me':
      lines.push(
        '当前权限模式:自动审查。工作区内的文件编辑自动放行;写工作区之外、删除文件与有写副作用的 bash 命令先交自动审查者裁决,不确定或高风险的再转用户审批。审批被拒时改用工作区内的方案。',
      )
      break
    case 'full-access':
      lines.push(
        '当前权限模式:完全访问。所有操作自动放行、无需审批,文件写入可以离开工作区;破坏性操作仍要先说明再执行。',
      )
      break
  }
  if (permission.collaboration === 'plan') {
    lines.push(
      '当前权限模式:计划。禁止一切写操作与有写副作用的命令;先完成调研,再用 exit_plan 工具提交完整计划,等待用户审批。计划被批准后会话自动切换到执行模式,届时直接开始执行;被拒绝且用户附带了补充建议时,按建议修订后重新提交。',
    )
  }
  return lines.join('\n')
}

/** The shell the `bash` tool actually runs, matching the Rust host's note. */
function shellNote(): string {
  const choice = shellChoice()
  const platform = process.platform
  if (choice.label === 'cmd') {
    return `bash 工具在 ${platform} 上通过 cmd.exe 执行(工具名沿用 bash);命令请写 cmd 语法,不要用 bash 或 PowerShell 语法。`
  }
  const shell = platform === 'win32' ? 'Git Bash' : 'bash'
  return `bash 工具在 ${platform} 上通过 ${shell} 执行;命令请写 bash 语法,不要用 PowerShell 语法。`
}

/**
 * Runtime facts live in the conversation as an injected snapshot, not in the
 * byte-stable system prompt. The transcript shows the same text the model
 * receives, so the UI never has to invent a separate "runtime" view.
 */
export function buildRuntimeContext(
  options: Pick<SystemPromptOptions, 'cwd' | 'sandbox' | 'permission' | 'apiBase'>,
): string {
  const platform = `${process.platform} ${os.arch()}`
  const date = new Date().toISOString().slice(0, 10)
  const blocks = [
    `工作目录:${options.cwd}（相对路径以它为根）。平台:${platform}。日期:${date}。${shellNote()}`,
    permissionSection(options.permission),
  ]
  if (options.apiBase && options.apiBase.trim() !== '') {
    blocks.push(
      `本实例 API:${options.apiBase.trim()}(本机 HTTP)。任何读取或修改 denia 自身配置的操作(提供商、密钥、MCP、preset、系统提示词)一律调用这个地址;多实例并存时不要猜默认端口,它可能不是当前实例。`,
    )
  }
  return `${RUNTIME_CONTEXT_HEADER}\n\n${blocks.join('\n\n')}`
}

function subagentSections(sub: SubagentPromptContext): string[] {
  const role = [
    '# 你的角色（子代理）',
    `名称：${sub.name}`,
    sub.instructions.trim() === ''
      ? '本次派遣只给了任务说明：按用户消息里的任务要求工作。'
      : sub.instructions.trimEnd(),
  ].join('\n')

  const toolsNote =
    sub.effectiveTools === undefined
      ? []
      : [
          sub.effectiveTools.length === 0
            ? '本次没有授予任何工具：只能用你已有的知识完成推理，并在结果里说明需要的工具。'
            : `可用工具仅限：${sub.effectiveTools.join('、')}。`,
        ]
  const commNote = sub.effectiveTools?.includes('send_message')
    ? [
        '你可以用 send_message 主动联系父代理：同步关键进展、请求澄清或报告阻塞；只在信息会改变对方下一步动作时发送，避免重复与高频通信；',
      ]
    : []
  const ceiling = sub.permissionCeiling
  const ceilingNote =
    ceiling === 'read-only'
      ? '权限上限：read-only（写文件与命令一律被拒绝）；'
      : '权限上限：inherit（写操作仍按当前权限模式走正常审批）；'
  const constraints = [
    '# 子代理约束',
    '- 你是子代理，**不能派遣子代理**，也不能使用宿主配置或会话主控工具；',
    '- 不会自动加载全局 AGENTS.md，只自动发现项目级规则；工作目录、权限模式与工作区沙箱与父代理一致；',
    ...toolsNote.map((line) => `- ${line}`),
    ...commNote.map((line) => `- ${line}`),
    `- ${ceilingNote}`,
    '- 无法完成的动作不要假装完成：把阻塞、未覆盖范围与需要的决策写进最终结果。',
    '- 汇报时区分三种情形：成功结果（附证据）、任务失败（附原因）、等待父代理决策。',
  ].join('\n')

  const out = [role, constraints]
  if (sub.parentPersona?.trim()) {
    out.push(`父 persona（保持一致）：\n${sub.parentPersona.trim()}`)
  }
  return out
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const extra = new Map<string, string>()
  for (const section of options.extraSections ?? []) {
    if (section.text.trim() !== '') extra.set(section.name, section.text.trim())
  }

  const body: string[] = []
  for (const section of SECTIONS) {
    // Runtime-owned slots only exist when the host provides their text.
    if (section.name === 'tool:memory' && !extra.has('memory')) continue
    if (section.name === 'tool:mcp' && !extra.has('mcp')) continue
    if (section.tools && !section.tools.some((name) => hasTool(options.tools, name))) continue
    const text =
      section.name === 'tool:memory'
        ? extra.get('memory')
        : section.name === 'tool:mcp'
          ? extra.get('mcp')
          : section.text
    if (text && text.trim() !== '') body.push(text)
  }

  if (options.subagent) body.push(...subagentSections(options.subagent))

  const persona = interpolatePersona(options.persona ?? DEFAULT_PERSONA, {
    cwd: options.cwd,
    model: options.model,
    provider: options.provider,
  })
  return [persona, '', FRAME_HEADER, '', body.join('\n\n')].join('\n')
}