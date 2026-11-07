// Subagent vocabulary: profiles, descriptors and the hard runtime rules.
//
// A profile only describes the role supplement, tool selection, model and
// permission ceiling. It never replaces the parent persona and never defines
// the parent's feature switches — those are inherited.

import type { ModelSelection, ToolSchema } from '../core/wire.ts'

export const SUBAGENT_SCHEMA_VERSION = 1
export const SUBAGENT_SNAPSHOT_VERSION = 1
export const INSTRUCTIONS_MAX_BYTES = 64 * 1024
export const NAME_MAX_CHARS = 80
export const DESCRIPTION_MAX_CHARS = 2000
export const ID_MAX_CHARS = 64
export const SUBAGENT_SNAPSHOT_FILE = 'subagent.json'

export type ProfileSource = 'builtin' | 'user' | 'project'
export type ProfileWriteScope = 'user' | 'project'
export type PermissionCeiling = 'inherit' | 'read-only'
export type ProfileColor = 'blue' | 'green' | 'purple' | 'orange' | 'red' | 'gray'
export const PROFILE_COLORS: ProfileColor[] = ['blue', 'green', 'purple', 'orange', 'red', 'gray']

export type ToolSelection = { mode: 'inherit' } | { mode: 'allowlist'; names: string[] }
export type ModelChoice = { mode: 'inherit' } | { mode: 'explicit'; selection: ModelSelection }

export interface SubagentProfile {
  schemaVersion: number
  id: string
  name: string
  description: string
  instructions: string
  enabled: boolean
  tools: ToolSelection
  model: ModelChoice
  permissionCeiling: PermissionCeiling
  color?: ProfileColor
}

export interface SubagentInlineSpec {
  name: string
  description: string
  instructions: string
  tools: ToolSelection
  model: ModelChoice
  permissionCeiling: PermissionCeiling
}

export interface ProfileDiagnostic {
  code: string
  field?: string
  message: string
}

export interface SubagentProfileView {
  profile: SubagentProfile
  qualifiedId: string
  source: ProfileSource
  revision: number
  editable: boolean
  overridesBuiltin: boolean
  projectWritable: boolean
  diagnostics?: ProfileDiagnostic[]
}

export interface SubagentCatalogEntry {
  qualifiedId: string
  name: string
  description: string
  tools: string
  model: string
}

export interface SubagentProfileRef {
  qualifiedId: string
  source?: ProfileSource
  revision: number
  inline: boolean
}

export interface SubagentForkProjection {
  sourceSession: string
  cutSeq: number
  projectionVersion: number
  dropped: string[]
}

export interface SubagentDescriptor {
  label: string
  depth: number
  mode: string
  selection: ModelSelection
  persona?: string
  allowedTools?: string[]
  snapshotVersion: number
  name?: string
  description?: string
  profile?: SubagentProfileRef
  effectiveTools?: string[]
  permissionCeiling: PermissionCeiling
  createdPermissionMode?: string
  delegationAllowed: boolean
  instructionScope?: string
  parentPreset?: string
  parentPresetPersona?: string
  parentFeatures?: unknown
  instructionsRef?: string
  instructionsHash?: string
  fork?: SubagentForkProjection
}

export const SUBAGENT_CODES = {
  profileNotFound: 'subagent/profile-not-found',
  profileShadowed: 'subagent/profile-shadowed',
  profileInvalid: 'subagent/profile-invalid',
  profileDisabled: 'subagent/profile-disabled',
  profileExists: 'subagent/profile-exists',
  scopeForbidden: 'subagent/scope-forbidden',
  revisionConflict: 'subagent/revision-conflict',
  toolUnknown: 'subagent/tool-unknown',
  toolNotGranted: 'subagent/tool-not-granted',
  toolHardDenied: 'subagent/tool-hard-denied',
  delegationForbidden: 'subagent/delegation-forbidden',
  depthConfigRemoved: 'subagent/depth-config-removed',
  ambiguousSpec: 'subagent/ambiguous-spec',
  concurrencyExceeded: 'subagent/concurrency-exceeded',
  snapshotInvalid: 'subagent/snapshot-invalid',
  legacyResumeUnsupported: 'subagent/legacy-resume-unsupported',
  emptyTools: 'subagent/empty-tools',
} as const

export function isValidSubagentId(id: string): boolean {
  if (id === '' || Array.from(id).length > ID_MAX_CHARS) return false
  return /^[a-z0-9][a-z0-9-]*$/.test(id)
}

export function parseQualifiedId(raw: string): { source: ProfileSource; id: string } {
  const at = raw.indexOf(':')
  if (at < 0) throw new Error(`限定 id 必须形如 builtin:explore,实际:${raw}`)
  const source = raw.slice(0, at)
  const id = raw.slice(at + 1)
  if (source !== 'builtin' && source !== 'user' && source !== 'project') {
    throw new Error(`未知的定义来源:${source}(只支持 builtin/user/project)`)
  }
  if (!isValidSubagentId(id)) {
    throw new Error(
      `非法的定义 id:${id}（只允许小写字母、数字与连字符，不能以连字符开头，最长 ${ID_MAX_CHARS} 字符）`,
    )
  }
  return { source, id }
}

export function toolsSummary(tools: ToolSelection): string {
  if (tools.mode === 'inherit') return '继承父工具'
  return tools.names.length === 0 ? '无工具' : `${tools.names.length} 个工具`
}

export function modelSummary(model: ModelChoice): string {
  return model.mode === 'inherit' ? '继承父模型' : `${model.selection.provider}/${model.selection.model}`
}

/** Validate required fields and values (tool existence is checked by the host). */
export function validateProfile(profile: SubagentProfile): ProfileDiagnostic[] {
  const issues: ProfileDiagnostic[] = []
  const error = (field: string, message: string): void => {
    issues.push({ code: SUBAGENT_CODES.profileInvalid, field, message })
  }
  if (profile.schemaVersion !== SUBAGENT_SCHEMA_VERSION) {
    error('schemaVersion', `不支持的定义版本 ${profile.schemaVersion}（本版本只认识 ${SUBAGENT_SCHEMA_VERSION}）`)
  }
  if (!isValidSubagentId(profile.id)) {
    error('id', `非法的定义 id：${profile.id}（只允许小写字母、数字与连字符，最长 ${ID_MAX_CHARS} 字符）`)
  }
  const nameLength = Array.from(profile.name.trim()).length
  if (nameLength === 0 || nameLength > NAME_MAX_CHARS) {
    error('name', `name 必须是 1–${NAME_MAX_CHARS} 个字符`)
  }
  const descriptionLength = Array.from(profile.description.trim()).length
  if (descriptionLength === 0 || descriptionLength > DESCRIPTION_MAX_CHARS) {
    error('description', `description 必须是 1–${DESCRIPTION_MAX_CHARS} 个字符`)
  }
  if (Buffer.byteLength(profile.instructions, 'utf8') > INSTRUCTIONS_MAX_BYTES) {
    error('instructions', `instructions 不能超过 ${INSTRUCTIONS_MAX_BYTES} 字节`)
  }
  if (profile.tools.mode === 'allowlist') {
    const seen = new Set<string>()
    for (const name of profile.tools.names) {
      if (name.trim() === '') error('tools.names', '工具名不能为空')
      else if (seen.has(name)) error('tools.names', `工具名重复：${name}`)
      else seen.add(name)
    }
  }
  if (profile.model.mode === 'explicit') {
    const selection = profile.model.selection
    if (selection.provider.trim() === '' || selection.model.trim() === '') {
      error('model', '显式模型必须同时给出 provider 与 model')
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// Capability classification and hard denials
// ---------------------------------------------------------------------------

export type ToolCapability =
  | 'read'
  | 'write'
  | 'shell'
  | 'delegation'
  | 'host-administration'
  | 'session-control'
  | 'interaction'
  | 'jobs'
  | 'browser'
  | 'mcp'
  | 'other'

export function toolCapability(name: string): ToolCapability {
  if (name.startsWith('mcp__') || name === 'mcp_list') return 'mcp'
  switch (name) {
    case 'spawn_agent':
    case 'fork_agent':
    case 'interrupt_agent':
    case 'list_agents':
    case 'wait_agent':
    case 'send_message':
      return 'delegation'
    case 'create_preset':
    case 'create_subagent':
    case 'update_subagent':
      return 'host-administration'
    case 'exit_plan':
    case 'get_goal':
    case 'update_goal':
      return 'session-control'
    case 'bash':
    case 'job_start':
    case 'job_output':
    case 'job_kill':
    case 'job_list':
    case 'run_checks':
      return 'shell'
    case 'write_file':
    case 'edit':
    case 'todo_write':
      return 'write'
    case 'ask':
      return 'interaction'
    case 'browser':
      return 'browser'
    case 'read_file':
    case 'read_tool_output':
    case 'ls':
    case 'glob':
    case 'grep':
    case 'skill':
    case 'web_fetch':
      return 'read'
    default:
      return 'other'
  }
}

export const CHILD_HARD_DENIED_TOOLS = new Set([
  'spawn_agent',
  'fork_agent',
  'interrupt_agent',
  'list_agents',
  'wait_agent',
  'exit_plan',
  'get_goal',
  'update_goal',
  'create_preset',
  'create_subagent',
  'update_subagent',
])

export function childHardDenied(name: string): boolean {
  if (CHILD_HARD_DENIED_TOOLS.has(name)) return true
  const capability = toolCapability(name)
  if (capability === 'delegation') return name !== 'send_message'
  return capability === 'host-administration' || capability === 'session-control'
}

/** Tools a read-only ceiling always refuses (execution-side truth). */
export function ceilingDeniedTool(ceiling: PermissionCeiling, name: string): boolean {
  if (ceiling === 'inherit') return false
  return ['write_file', 'edit', 'bash', 'job_start', 'todo_write', 'run_checks'].includes(name)
}

export function effectivePermissionMode(
  ceiling: PermissionCeiling,
  parentMode: 'read-only' | 'auto-edit' | 'plan' | 'full',
): 'read-only' | 'auto-edit' | 'plan' | 'full' {
  return ceiling === 'read-only' ? 'read-only' : parentMode
}

/** Historical read-only grant (old descriptors / deprecated parameters). */
export const LEGACY_READ_ONLY_TOOLS = [
  'read_file',
  'read_tool_output',
  'ls',
  'glob',
  'grep',
  'skill',
  'browser',
  'web_fetch',
]

export function legacyChildTools(explicit?: string[]): string[] {
  const tools = explicit
    ? explicit.filter((name) => LEGACY_READ_ONLY_TOOLS.includes(name))
    : [...LEGACY_READ_ONLY_TOOLS]
  return dedup(tools.filter((name) => !childHardDenied(name))).sort()
}

export function dedup(names: string[]): string[] {
  const seen = new Set<string>()
  return names.filter((name) => {
    if (seen.has(name)) return false
    seen.add(name)
    return true
  })
}

/** The three shipped profiles. They are templates, not a global allowlist. */
export function builtinSubagentProfiles(): SubagentProfile[] {
  const readTools = [
    'read_file',
    'read_tool_output',
    'ls',
    'glob',
    'grep',
    'skill',
    'web_fetch',
    'send_message',
  ]
  const developTools = dedup([...readTools, 'write_file', 'edit', 'bash', 'todo_write'])
  const verifyTools = dedup([...readTools, 'bash', 'todo_write'])
  return [
    {
      schemaVersion: SUBAGENT_SCHEMA_VERSION,
      id: 'explore',
      name: '只读探索',
      description: '查找实现、理解调用链、定位影响范围；只读调查，不修改项目。',
      instructions:
        '先建立事实：用检索与阅读定位实现、调用链与影响范围。\n只报告有证据的结论：给出文件路径与关键行，明确标注未知项与推测。\n不要修改任何文件；需要改动时把建议交回父代理。',
      enabled: true,
      tools: { mode: 'allowlist', names: dedup(readTools) },
      model: { mode: 'inherit' },
      permissionCeiling: 'read-only',
      color: 'blue',
    },
    {
      schemaVersion: SUBAGENT_SCHEMA_VERSION,
      id: 'develop',
      name: '开发执行',
      description: '实现有明确范围的功能、修复，或按父代理提供/指定的已确认计划逐项落地。',
      instructions:
        '先确认范围与验收条件，再动手；只改动任务要求的模块。\n每完成一项就自检：读回改动、执行相关测试或最小验证。\n按计划执行时报告完成项、偏离原因与阻塞；不调用 exit_plan，不自行扩展计划。\n结束前交代：改了什么、怎么验证的、还剩什么问题。',
      enabled: true,
      tools: { mode: 'allowlist', names: developTools },
      model: { mode: 'inherit' },
      permissionCeiling: 'inherit',
      color: 'green',
    },
    {
      schemaVersion: SUBAGENT_SCHEMA_VERSION,
      id: 'verify',
      name: '验证',
      description: '审查改动、运行测试/构建、复现错误并核验验收条件。',
      instructions:
        '以验收条件为准逐项核验，优先运行真实命令而不是只读代码。\n如实报告：命令、退出码、关键输出与复现步骤；失败就报失败，不粉饰。\n发现实现问题只报告证据与最小修复建议，不自行改实现。',
      enabled: true,
      tools: { mode: 'allowlist', names: verifyTools },
      model: { mode: 'inherit' },
      permissionCeiling: 'inherit',
      color: 'purple',
    },
  ]
}

export function profileToolSchemas(): ToolSchema[] {
  return []
}