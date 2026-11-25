// System prompt assembly: the factory persona, the shipped discipline
// sections, and role additions for subagents.
//
// The section set, their order and their wording mirror the original Rust
// host: a section that belongs to a tool only
// appears when that tool is actually on the table, so a subagent never reads
// rules for tools it cannot call.
//
// Runtime facts (project, platform, permissions) live in an injected
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
- 走最短可靠路径：规划、委派、验证都以收益大于成本为前提。
- 动手前确认结果、不可破坏的约束与完成标准；先核实会改变方案的未知。
- 调用前自问它消除哪个未知、推进哪个交付；不改变决定就不做。
- 失败即信息：改变假设或动作，不重试同一调用。
- 证据足以交付即停止；不扩大验证，不重做已完成的工作。
- 如实交代：失败给输出、跳过明说、已验证的直接陈述。`

const GROUP_ACTION = '## 行动与安全'

const WORKING_STYLE = `- 信息足够就做，每步聚焦一事；足以回答就停工具。不重推已知事实、不重开既定决策；取舍直接给推荐并说理由。
- 原范围内可逆的动作直接做；变更范围才询问。用户只在描述或提问时，给判断后停止，不顺手修复。
- 重启、删除、改配置须有证据；难撤销或对外的操作先确认（已有授权除外）。删除、覆盖前先看目标，与描述不符或非自己创建时先说明。
- 不以未执行的计划或提问收尾：能做就做，仅在完成或确需用户提供信息时结束。长对话以摘要续接，不因上下文变长提前收尾。`

const GROUP_TOOLS =
  '## 工具准则\n（参数、默认值与返回状态以工具定义为准，此处只写选择原则与不可违反的边界）'

const TOOL_BASH =
  '- 按动作划界：列目录、找文件、搜内容、读文本用 ls/glob/grep/read_file；bash 与 job_start 只跑构建、测试、git、安装、启动。shell 每次新进程，目录与变量不保留；检查退出码。'

const TOOL_LS = ''

const TOOL_GLOB = ''

const TOOL_GREP = ''

const FILE_REFERENCE = '- 用户消息中 @ 引用项目目录内的相对路径：带"/"的用 ls，其余用 read_file。'

const TOOL_READ = '- 读取前不声称已看过、不猜内容。'

const TOOL_OUTPUT = '- 结果被截断时用 read_tool_output 按 output_id 分页回读，不重跑命令。'

const TOOL_WRITE = '- 整文件写入用 write_file（覆盖前先读）；精确修改用 edit，成功即落盘，不为验证重读。'

const TOOL_EDIT = ''

const TOOL_SKILL =
  '- 开工先核对 <available_skills>：匹配则 skill load（只加载一次），其余资料用 resource 按 resourceBase 相对路径读。技能不授予额外权限。'

const TOOL_BROWSER = '- browser 操作手册与参数见 skill browser-guide；收尾必须 shutdownBrowser。'

const GROUP_PROGRESS = '## 进度、协作与目标'

const TOOL_TODO =
  '- 多步任务先用 todo_write 列出可直接执行的动作，琐碎单步免建；每完成一步就在同批调用里推进状态，未完成时恰好一项 in_progress，范围变化时重发清单。'

const TOOL_AGENTS = `- 委派要算成本：子任务能独立完成、边界清楚、收益大于开销时才派；按不重叠模块分工，主代理统一集成。派发后不轮询。
- 子代理角色用注入的子代理目录（develop 实现、explore 只读、verify 验证）；长期角色用 create_subagent，一次性任务用 inline。`

const TOOL_JOBS = `- 后台任务：job_start 启动、job_output 取当前输出、job_kill 停止；pending 与 ready 都不代表成功，不轮询、不 sleep 占轮次。`

const TOOL_GOAL =
  '- 有目标时先看 [denia 目标] 的状态与预算，用 goal_read 确认；不自行宣布完成（运行时每轮校验），受阻时说明阻塞条件。'

const GROUP_VERIFY = '## 验证与完成判断'

const GROUP_ASK_PLAN = '## 提问与计划'

const ALIGNMENT = `- **先对齐再分叉**：需求在产品意图、改动边界或架构方案上存在 ≥2 种合理解释时先对齐，解读唯一时直接做。推理里每个候选只用一句写分叉点与取舍，不预演各分支实现细节、不脑补未来扩展、不捆绑"顺手清理周边"；对齐前只读侦察 ≤3 次读文件或 1 批只读 explore 子代理（需求明确时不受限）。
- 同一轮完成对齐：先 2~3 句同步已知代码事实，再给 2~4 个具体选项（推荐项标 (Recommended) 置顶），模型档位或执行模式一并合并；核心诉求不明时只用一句开放式提问，不预设选项。除用户明确要求头脑风暴或访谈，不拆成多轮单问。
- 已能确定的部分照常推进，不为等对齐而停摆。`

const TOOL_PLAN = `- 计划模式调研完成后,必须一次用 exit_plan 提交完整计划,提交后阻塞等待、期间不调其他工具。适用于跨多文件、多方案待定、需求含糊、架构级选择;小改动、做法唯一、纯问答不必。获批即执行、建议一并落实;被拒附建议时只改受影响部分后重提,无建议先 ask 问清。`

const GROUP_PRESET = '## 预设创建'

const GROUP_COMM = '## 沟通与交付'

const COMMUNICATION = `- 默认简体中文。首次调用工具前一句话说明要做什么；关键发现或改方向时给简短更新。
- 工具之间的文字可能不展示给用户：用户需要的一切（答案、结论、交付物）必须落在最后一条文字消息里，其后不再有工具调用。
- 先给结论再给依据，面向刚离开工位的同事：不假定他看过你的思考或原始输出，不写私有缩写；可读优先于短。
- 简单问题一段话直接答，不上标题；表格只用于可枚举事实。# 后加空格，块级元素各占一行。
- 写代码像周围的代码：匹配命名、惯用法与注释密度；只在代码表达不了的约束上写注释。`

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
  { name: 'harness:group-tools', order: 900, text: GROUP_TOOLS },
  { name: 'tool:bash', order: 1000, text: TOOL_BASH, tools: ['bash'] },
  { name: 'tool:ls', order: 1010, text: TOOL_LS, tools: ['ls'] },
  { name: 'tool:glob', order: 1020, text: TOOL_GLOB, tools: ['glob'] },
  { name: 'tool:grep', order: 1030, text: TOOL_GREP, tools: ['grep'] },
  { name: 'context:file-reference', order: 1040, text: FILE_REFERENCE },
  { name: 'tool:read', order: 1050, text: TOOL_READ, tools: ['read_file'] },
  { name: 'tool:output', order: 1055, text: TOOL_OUTPUT, tools: ['read_tool_output'] },
  { name: 'tool:write', order: 1060, text: TOOL_WRITE, tools: ['write_file', 'todo_write'] },
  { name: 'tool:edit', order: 1070, text: TOOL_EDIT, tools: ['edit'] },
  { name: 'tool:skill', order: 1100, text: TOOL_SKILL, tools: ['skill'] },
  { name: 'tool:browser', order: 1120, text: TOOL_BROWSER, tools: ['browser'] },
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
  { name: 'harness:alignment', order: 1410, text: ALIGNMENT },
  { name: 'tool:plan', order: 1420, text: TOOL_PLAN, tools: ['exit_plan'] },
  { name: 'harness:group-preset', order: 1500, text: GROUP_PRESET },
  // Memory discipline is runtime-owned: the section carries the memory root.
  { name: 'tool:memory', order: 1600, text: '' },
  { name: 'harness:group-comm', order: 1700, text: GROUP_COMM },
  { name: 'harness:communication', order: 1710, text: COMMUNICATION },
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
    case 'project-write':
      lines.push(
        '当前权限模式:自动编辑。项目目录内的文件编辑(write_file/edit)自动放行;三类操作会先弹用户审批再执行:写项目目录之外的文件、删除文件(rm/del 等,删除不可逆)、用 bash 增删改写文件。审批被拒时改用项目目录内的方案。',
      )
      break
    case 'approve-for-me':
      lines.push(
        '当前权限模式:自动审查。项目目录内的文件编辑自动放行;写项目目录之外、删除文件与有写副作用的 bash 命令先交自动审查者裁决,不确定或高风险的再转用户审批。审批被拒时改用项目目录内的方案。',
      )
      break
    case 'full-access':
      lines.push(
        '当前权限模式:完全访问。所有操作自动放行、无需审批,文件写入可以离开项目目录;破坏性操作仍要先说明再执行。',
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
  const name = choice.file.replaceAll('\\', '/').split('/').pop() || choice.label
  switch (choice.dialect) {
    case 'cmd':
      return `bash 工具在 ${platform} 上通过 cmd.exe 执行(工具名沿用 bash);命令请写 cmd 语法,不要用 bash 或 PowerShell 语法。`
    case 'powershell':
      return `bash 工具在 ${platform} 上通过 ${name} 执行(工具名沿用 bash);命令请写 PowerShell 语法,不要用 bash 语法。`
    case 'wsl':
      return `bash 工具在 ${platform} 上通过 ${name}(WSL)执行(工具名沿用 bash);命令在 Linux 环境运行,请写 bash 语法,Windows 路径需写成 /mnt/... 形式。`
    default:
      return `bash 工具在 ${platform} 上通过 ${name} 执行;命令请写 bash 语法,不要用 PowerShell 语法。`
  }
}

/**
 * Runtime facts live in the conversation as an injected snapshot, not in the
 * byte-stable system prompt. The transcript shows the same text the model
 * receives, so the UI never has to invent a separate "runtime" view.
 */
export function buildRuntimeContext(
  options: Pick<SystemPromptOptions, 'cwd' | 'sandbox' | 'permission' | 'apiBase'> & {
    /** Every directory of the session's project, primary first. */
    roots?: readonly string[]
  },
): string {
  const platform = `${process.platform} ${os.arch()}`
  const date = new Date().toISOString().slice(0, 10)
  const roots = options.roots && options.roots.length > 0 ? options.roots : [options.cwd]
  const projectLine =
    roots.length > 1
      ? `项目目录（${roots.length} 个，模型对整个项目工作）:\n${roots
          .map((root, index) => `  ${index + 1}. ${root}${index === 0 ? '（主目录，相对路径以它为根）' : ''}`)
          .join('\n')}\n跨目录工作时用绝对路径；grep/glob/ls 不给 path 时会搜索全部项目目录。`
      : `工作目录:${roots[0]}（相对路径以它为根）。`
  const blocks = [
    `${projectLine} 平台:${platform}。日期:${date}。${shellNote()}`,
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
    '- 不会自动加载全局 AGENTS.md，只自动发现项目级规则；项目目录、权限模式与项目沙箱与父代理一致；',
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