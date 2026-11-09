// Dispatch resolution: definition/inline/legacy spec + parent grant → a frozen
// snapshot (tools, model, permission ceiling). Pure functions only.

import type { ModelSelection } from '../core/wire.ts'
import type { PermissionState } from '../core/permission.ts'
import { excludedPresetTools } from '../agent/presets.ts'
import type { ResolvedProfile } from './profiles.ts'
import { ProfileError } from './profiles.ts'
import type {
  PermissionCeiling,
  SubagentInlineSpec,
  SubagentProfile,
  ToolSelection,
  ToolCapability,
} from './types.ts'
import {
  SUBAGENT_CODES,
  ceilingDeniedTool,
  childHardDenied,
  dedup,
  effectivePermissionMode,
  legacyChildTools,
  parseQualifiedId,
  toolCapability,
  validateProfile,
} from './types.ts'

export type PermissionMode = 'read-only' | 'auto-edit' | 'plan' | 'full'
export type ModelOrigin = 'call-override' | 'profile-explicit' | 'parent'

export interface DelegateArgs {
  prompt: string
  description?: string
  profile_id?: string
  inline?: unknown
  provider?: string
  model?: string
  reasoning_effort?: string
  allowed_tools?: string[]
  run_in_background?: boolean
  persona?: string
  max_depth?: unknown
}

export interface ResolvedDispatch {
  qualifiedId: string
  source: 'builtin' | 'user' | 'project' | null
  revision: number
  inline: boolean
  fork: boolean
  name: string
  description: string
  instructions: string
  tools: string[]
  selection: ModelSelection
  modelOrigin: ModelOrigin
  permissionCeiling: PermissionCeiling
}

export interface ParentContext {
  registered: string[]
  mode: PermissionMode
  selection: ModelSelection
  presetTools?: string[]
  presetFeatures?: import('../agent/presets.ts').PresetFeatures
}

const READ_ONLY_EXCLUDED = new Set(['bash', 'write_file', 'edit', 'job_start'])

/** Tools the parent session may hand down (before child hard denials). */
export function parentGrant(
  registered: string[],
  presetTools?: string[],
  mode?: PermissionMode,
  features?: import('../agent/presets.ts').PresetFeatures,
): string[] {
  let names = registered
  if (features) {
    const excluded = new Set(excludedPresetTools(features))
    names = names.filter((name) => !excluded.has(name))
  }
  if (presetTools) {
    const allowed = new Set(presetTools)
    names = names.filter((name) => allowed.has(name))
  }
  if (mode === 'read-only') {
    names = names.filter((name) => !READ_ONLY_EXCLUDED.has(name))
  }
  return dedup(names).sort()
}

export function modeOfPermission(state: PermissionState): PermissionMode {
  if (state.collaboration === 'plan') return 'plan'
  if (state.sandbox === 'read-only') return 'read-only'
  if (state.sandbox === 'danger-full-access') return 'full'
  return 'auto-edit'
}

export function validateDelegateArgs(args: DelegateArgs): void {
  if (typeof args.prompt !== 'string' || args.prompt.trim() === '') {
    throw new ProfileError(SUBAGENT_CODES.profileInvalid, '派遣参数 prompt 不能为空', 'prompt')
  }
  if (args.max_depth !== undefined) {
    throw new ProfileError(
      SUBAGENT_CODES.depthConfigRemoved,
      'max_depth 已移除（subagent/depth-config-removed）：子代理禁止派遣子代理，不存在可配置的委派深度。',
      'max_depth',
    )
  }
  if (args.profile_id !== undefined && args.inline !== undefined) {
    throw new ProfileError(
      SUBAGENT_CODES.ambiguousSpec,
      'profile_id 与 inline 互斥：二选一，不能同时给出',
      'inline',
    )
  }
  if (
    (args.profile_id !== undefined || args.inline !== undefined) &&
    (args.persona !== undefined || args.allowed_tools !== undefined)
  ) {
    throw new ProfileError(
      SUBAGENT_CODES.ambiguousSpec,
      'profile_id/inline 不能与旧参数 persona/allowed_tools 混用；请改用定义的 instructions 与 tools',
      'persona',
    )
  }
  if (args.provider !== undefined && args.model === undefined) {
    throw new ProfileError(
      SUBAGENT_CODES.profileInvalid,
      '调用级模型覆盖必须同时给出 provider 与 model',
      'provider',
    )
  }
}

export function normalizeInlineSpec(raw: unknown): SubagentInlineSpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProfileError(SUBAGENT_CODES.profileInvalid, 'inline 必须是对象', 'inline')
  }
  const record = raw as Record<string, unknown>
  const tools = record.tools
  if (typeof tools !== 'object' || tools === null) {
    throw new ProfileError(SUBAGENT_CODES.profileInvalid, 'inline.tools 必须是对象', 'inline.tools')
  }
  const toolRecord = tools as Record<string, unknown>
  const toolSelection: ToolSelection =
    toolRecord.mode === 'inherit'
      ? { mode: 'inherit' }
      : toolRecord.mode === 'allowlist'
        ? {
            mode: 'allowlist',
            names: Array.isArray(toolRecord.names)
              ? toolRecord.names.filter((name): name is string => typeof name === 'string')
              : [],
          }
        : (() => {
            throw new ProfileError(
              SUBAGENT_CODES.profileInvalid,
              'inline.tools.mode 只支持 inherit / allowlist',
              'inline.tools',
            )
          })()
  const modelRaw = record.model
  let model: SubagentInlineSpec['model'] = { mode: 'inherit' }
  if (modelRaw !== undefined) {
    if (typeof modelRaw !== 'object' || modelRaw === null) {
      throw new ProfileError(SUBAGENT_CODES.profileInvalid, 'inline.model 必须是对象', 'inline.model')
    }
    const modelRecord = modelRaw as Record<string, unknown>
    if (modelRecord.mode === 'explicit') {
      const selection = modelRecord.selection
      if (typeof selection !== 'object' || selection === null) {
        throw new ProfileError(
          SUBAGENT_CODES.profileInvalid,
          'inline.model.selection 必须是对象',
          'inline.model',
        )
      }
      const sel = selection as Record<string, unknown>
      model = {
        mode: 'explicit',
        selection: {
          provider: typeof sel.provider === 'string' ? sel.provider : '',
          model: typeof sel.model === 'string' ? sel.model : '',
          ...(typeof sel.reasoningEffort === 'string' ? { reasoningEffort: sel.reasoningEffort } : {}),
        },
      }
    } else if (modelRecord.mode !== 'inherit') {
      throw new ProfileError(
        SUBAGENT_CODES.profileInvalid,
        'inline.model.mode 只支持 inherit / explicit',
        'inline.model',
      )
    }
  }
  const ceiling =
    record.permissionCeiling === 'read-only'
      ? 'read-only'
      : record.permissionCeiling === 'inherit' || record.permissionCeiling === undefined
        ? 'inherit'
        : (() => {
            throw new ProfileError(
              SUBAGENT_CODES.profileInvalid,
              'inline.permissionCeiling 只支持 inherit / read-only',
              'inline.permissionCeiling',
            )
          })()
  const spec: SubagentInlineSpec = {
    name: typeof record.name === 'string' ? record.name.trim() : '',
    description: typeof record.description === 'string' ? record.description.trim() : '',
    instructions: typeof record.instructions === 'string' ? record.instructions : '',
    tools: toolSelection,
    model,
    permissionCeiling: ceiling,
  }
  const issues = validateProfile({
    schemaVersion: 1,
    id: 'inline',
    name: spec.name,
    description: spec.description,
    instructions: spec.instructions,
    enabled: true,
    tools: spec.tools,
    model: spec.model,
    permissionCeiling: spec.permissionCeiling,
  })
  if (issues.length > 0) {
    throw new ProfileError(
      SUBAGENT_CODES.profileInvalid,
      issues.map((issue) => issue.message).join(';'),
      issues[0]?.field,
    )
  }
  return spec
}

export function resolveDispatch(input: {
  args: DelegateArgs
  fork: boolean
  parent: ParentContext
  profile?: ResolvedProfile
  defaulted: boolean
}): ResolvedDispatch {
  const { args, fork, parent, profile, defaulted } = input
  validateDelegateArgs(args)

  const legacyPath =
    profile === undefined &&
    args.inline === undefined &&
    (args.persona !== undefined || args.allowed_tools !== undefined)

  let qualifiedId: string
  let source: ResolvedDispatch['source'] = null
  let revision = 0
  let inline = false
  let name: string
  let description: string
  let instructions: string
  let requestedTools: ToolSelection
  let ceiling: PermissionCeiling
  let profileModel: ModelSelection | null = null

  if (legacyPath) {
    qualifiedId = `legacy:${args.allowed_tools?.length ? 'custom' : 'default'}`
    name = '子代理'
    description = '旧参数派遣（已按保守历史上限解释）'
    instructions = args.persona ?? ''
    requestedTools = { mode: 'allowlist', names: legacyChildTools(args.allowed_tools) }
    ceiling = 'inherit'
  } else if (args.inline !== undefined) {
    const spec = normalizeInlineSpec(args.inline)
    qualifiedId = `inline:${spec.name}`
    source = null
    revision = 0
    inline = true
    name = spec.name
    description = describeOf(args, spec.description)
    instructions = spec.instructions
    requestedTools = spec.tools
    ceiling = spec.permissionCeiling
    profileModel = spec.model.mode === 'explicit' ? spec.model.selection : null
  } else if (profile) {
    qualifiedId = profile.qualifiedId
    source = profile.source
    revision = profile.revision
    name = profile.profile.name
    description = describeOf(args, profile.profile.description)
    instructions = profile.profile.instructions
    requestedTools = profile.profile.tools
    ceiling = profile.profile.permissionCeiling
    profileModel =
      profile.profile.model.mode === 'explicit' ? profile.profile.model.selection : null
  } else if (defaulted) {
    throw new ProfileError(
      SUBAGENT_CODES.profileNotFound,
      '默认的 develop 定义不存在；请显式指定 profile_id 或 inline 规格',
      'profile_id',
    )
  } else {
    throw new ProfileError(
      SUBAGENT_CODES.ambiguousSpec,
      '派遣需要 profile_id、inline 或旧参数 persona/allowed_tools 之一',
    )
  }

  const tools = computeToolGrant(
    requestedTools,
    parent.registered,
    parentGrant(parent.registered, parent.presetTools, parent.mode, parent.presetFeatures),
    // Shipped profiles are templates: a deployment missing an optional tool
    // (skills, fetch, output stores) still runs the rest instead of failing
    // every dispatch. User/inline allowlists stay strict.
    profile?.source === 'builtin',
  )
    .filter((tool) => !ceilingDeniedTool(ceiling, tool))
    .sort()
  const selection = resolveSelection(args, parent.selection, profileModel, fork)
  return {
    qualifiedId,
    source,
    revision,
    inline,
    fork,
    name,
    description,
    instructions,
    tools,
    selection,
    modelOrigin: modelOriginOf(args, profileModel),
    permissionCeiling: ceiling,
  }
}

function describeOf(args: DelegateArgs, fallback: string): string {
  const text = args.description?.trim()
  return text && text !== '' ? text : fallback
}

function computeToolGrant(
  requested: ToolSelection,
  registered: string[],
  grant: string[],
  allowMissing = false,
): string[] {
  if (requested.mode === 'inherit') {
    return dedup(grant.filter((name) => !childHardDenied(name)))
  }
  const registeredSet = new Set(registered)
  const grantSet = new Set(grant)
  const unknown: string[] = []
  const missing: string[] = []
  const denied: string[] = []
  const notGranted: string[] = []
  for (const name of requested.names) {
    if (!registeredSet.has(name)) {
      if (allowMissing) missing.push(name)
      else unknown.push(name)
    } else if (childHardDenied(name)) denied.push(name)
    else if (!grantSet.has(name)) notGranted.push(name)
  }
  if (unknown.length > 0) {
    throw new ProfileError(
      SUBAGENT_CODES.toolUnknown,
      `工具未注册：${unknown.join('、')}`,
      'tools.names',
      [...registered].sort(),
    )
  }
  if (denied.length > 0) {
    throw new ProfileError(
      SUBAGENT_CODES.toolHardDenied,
      `这些工具子代理永远不能使用：${denied.join('、')}`,
      'tools.names',
    )
  }
  if (notGranted.length > 0) {
    throw new ProfileError(
      SUBAGENT_CODES.toolNotGranted,
      `父会话当前未授予这些工具：${notGranted.join('、')}`,
      'tools.names',
    )
  }
  return dedup([...requested.names]).filter(
    (name) => !childHardDenied(name) && !missing.includes(name),
  )
}

function resolveSelection(
  args: DelegateArgs,
  parent: ModelSelection,
  profileModel: ModelSelection | null,
  fork: boolean,
): ModelSelection {
  let selection: ModelSelection
  if (args.provider !== undefined || args.model !== undefined) {
    selection = {
      provider: args.provider ?? parent.provider,
      model: args.model ?? parent.model,
      ...(args.reasoning_effort ? { reasoningEffort: args.reasoning_effort } : {}),
    }
  } else if (profileModel) {
    selection = {
      ...profileModel,
      ...(args.reasoning_effort ? { reasoningEffort: args.reasoning_effort } : {}),
    }
  } else {
    selection = {
      ...parent,
      ...(args.reasoning_effort ? { reasoningEffort: args.reasoning_effort } : {}),
    }
  }
  if (fork) {
    const same =
      selection.provider === parent.provider &&
      selection.model === parent.model &&
      (selection.reasoningEffort ?? '') === (parent.reasoningEffort ?? '')
    if (!same) {
      throw new ProfileError(
        SUBAGENT_CODES.profileInvalid,
        'fork_agent 必须沿用父模型（provider/model/reasoningEffort 完全一致）；跨模型 fork 会被拒绝',
        'model',
      )
    }
  }
  return selection
}

function modelOriginOf(args: DelegateArgs, profileModel: ModelSelection | null): ModelOrigin {
  if (args.provider !== undefined || args.model !== undefined) return 'call-override'
  return profileModel ? 'profile-explicit' : 'parent'
}

// ---------------------------------------------------------------------------
// Tool catalog for the management page
// ---------------------------------------------------------------------------

export interface ToolCatalogRow {
  name: string
  source: string
  category: string
  effect: string
  readOnlyDenied: boolean
  granted: boolean | null
  grantable: boolean
  hardDenied: boolean
  reason: string
}

export function toolCatalogRows(registered: string[], grant: string[] | null): ToolCatalogRow[] {
  return [...registered].sort().map((name) => {
    const capability = toolCapability(name)
    const hardDenied = childHardDenied(name)
    const granted = grant === null ? null : grant.includes(name)
    let grantable: boolean
    let reason: string
    if (hardDenied) {
      grantable = false
      reason = '子代理不能使用该工具（禁止派遣子代理 / 宿主配置 / 会话主控）'
    } else if (grant === null) {
      grantable = true
      reason = '未指定父会话：此处只表示定义可请求，最终可用性以预览为准'
    } else if (granted) {
      grantable = true
      reason = '父会话当前可授予'
    } else {
      grantable = false
      reason = '父会话当前未授予（preset、features 或权限档收窄）'
    }
    return {
      name,
      source: name.startsWith('mcp__') ? 'mcp' : 'builtin',
      category: categoryLabel(capability),
      effect: effectNote(name, capability),
      readOnlyDenied: ceilingDeniedTool('read-only', name),
      granted,
      grantable,
      hardDenied,
      reason,
    }
  })
}

function categoryLabel(capability: ToolCapability): string {
  switch (capability) {
    case 'read':
      return '读取'
    case 'write':
      return '写入'
    case 'shell':
      return '命令与后台任务'
    case 'delegation':
      return '代理派遣'
    case 'host-administration':
      return '宿主配置'
    case 'session-control':
      return '会话主控'
    case 'interaction':
      return '用户交互'
    case 'jobs':
      return '后台任务'
    case 'browser':
      return '浏览器'
    case 'mcp':
      return 'MCP'
    default:
      return '其他'
  }
}

function effectNote(name: string, capability: ToolCapability): string {
  if (name.startsWith('mcp__') || name === 'mcp_list') {
    return '外部 MCP 服务器操作：副作用由该服务器决定，可能改远端数据。'
  }
  switch (name) {
    case 'write_file':
      return '覆盖整份工作区文件（写入前需先读过且内容新鲜）。'
    case 'edit':
      return '局部替换工作区文件内容。'
    case 'todo_write':
      return '只更新本会话的待办清单，不改动文件。'
    case 'bash':
      return '启动进程：可读写文件、访问网络，并承担超时与清理义务。'
    case 'read_file':
    case 'read_tool_output':
    case 'ls':
    case 'glob':
    case 'grep':
      return '只读工作区内容。'
    case 'web_fetch':
      return '只读网络内容（会发起外部请求）。'
    case 'skill':
      return '只读技能文件。'
    case 'send_message':
      return '向直接父/子代理发送消息，进入对方收件箱。'
    case 'ask':
      return '阻塞等待用户作答（有超时与明确结局）。'
    case 'browser':
      return '操控本机浏览器：可导航、改页面状态、读写页面数据并访问网络；任务结束需回收进程。'
    default:
      switch (capability) {
        case 'read':
          return '只读取工作区或网络内容，不改动文件。'
        case 'write':
          return '会改写会话或工作区数据。'
        case 'shell':
          return '会启动进程：命令可读写文件、访问网络、承担超时与清理义务。'
        case 'delegation':
          return '与其他代理通信（子代理只能用 send_message 汇报）。'
        case 'host-administration':
          return '改动 denia 宿主配置，属人类配置面。'
        case 'session-control':
          return '改变会话主控模式或操作主会话目标。'
        case 'interaction':
          return '阻塞等待用户作答（有超时与结局区分）。'
        case 'mcp':
          return '外部 MCP 服务器操作。'
        default:
          return '副作用取决于工具实现。'
      }
  }
}

export { effectivePermissionMode }