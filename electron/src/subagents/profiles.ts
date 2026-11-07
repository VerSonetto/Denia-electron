// Subagent definition store: files, overlay, revisions and diagnostics.
//
// Storage is strict YAML frontmatter + Markdown body (the body is
// `instructions`):
//   <home>/subagents/<id>.md
//   <project>/.denia/subagents/<id>.md
//
// Merge order is builtin → user → project; a later layer shadows an earlier
// one with the same logical id. Shadowed definitions stay on disk.

import fs from 'node:fs'
import path from 'node:path'

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import type {
  ProfileColor,
  ProfileDiagnostic,
  ProfileSource,
  ProfileWriteScope,
  SubagentProfile,
  SubagentProfileView,
  ToolSelection,
  ModelChoice,
  PermissionCeiling,
} from './types.ts'
import {
  PROFILE_COLORS,
  SUBAGENT_CODES,
  SUBAGENT_SCHEMA_VERSION,
  builtinSubagentProfiles,
  isValidSubagentId,
  parseQualifiedId,
  validateProfile,
} from './types.ts'

export const USER_DIR = 'subagents'
export const PROJECT_DIR = '.denia/subagents'
const BODY_FIELDS = ['instructions', 'body']

export class ProfileError extends Error {
  readonly code: string
  readonly field?: string
  readonly candidates: string[]

  constructor(code: string, message: string, field?: string, candidates: string[] = []) {
    super(message)
    this.code = code
    if (field !== undefined) this.field = field
    this.candidates = candidates
  }

  render(): string {
    let text = `${this.message}（${this.code}）`
    if (this.field) text += `；字段：${this.field}`
    if (this.candidates.length > 0) text += `；可用候选：${this.candidates.join('、')}`
    return text
  }
}

export interface ResolvedProfile {
  qualifiedId: string
  source: ProfileSource
  revision: number
  profile: SubagentProfile
}

export interface Catalog {
  effective: SubagentProfileView[]
  shadowed: SubagentProfileView[]
  diagnostics: ProfileDiagnostic[]
  revision: number
  userDir: string
  projectDir: string | null
  projectRoot: string | null
}

interface ParsedDefinition {
  profile: SubagentProfile
  revision: number
}

export class ProfileStore {
  readonly home: string
  private readonly builtin: SubagentProfile[]

  constructor(home: string) {
    this.home = home
    this.builtin = builtinSubagentProfiles()
  }

  userDir(): string {
    return path.join(this.home, USER_DIR)
  }

  static projectRoot(cwd: string): string {
    let current = path.resolve(cwd)
    while (true) {
      if (fs.existsSync(path.join(current, '.git'))) return current
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(cwd)
      current = parent
    }
  }

  projectDir(projectRoot: string | null): string | null {
    return projectRoot === null ? null : path.join(projectRoot, PROJECT_DIR)
  }

  catalog(projectRoot: string | null): Catalog {
    const userDir = this.userDir()
    const projectDir = this.projectDir(projectRoot)
    const diagnostics: ProfileDiagnostic[] = []
    const userFiles = this.scanDir(userDir)
    diagnostics.push(...userFiles.diagnostics)
    const projectFiles = projectDir === null ? { definitions: [], diagnostics: [] } : this.scanDir(projectDir)
    diagnostics.push(...projectFiles.diagnostics)

    const layers: SubagentProfileView[] = []
    const builtinIds = new Set(this.builtin.map((profile) => profile.id))
    for (const profile of this.builtin) {
      layers.push(
        viewOf(
          profile,
          'builtin',
          revisionOfBuiltin(profile),
          false,
          projectDir !== null,
        ),
      )
    }
    for (const definition of userFiles.definitions) {
      layers.push(
        viewOf(
          definition.profile,
          'user',
          definition.revision,
          builtinIds.has(definition.profile.id),
          projectDir !== null,
        ),
      )
    }
    for (const definition of projectFiles.definitions) {
      layers.push(
        viewOf(
          definition.profile,
          'project',
          definition.revision,
          builtinIds.has(definition.profile.id),
          projectDir !== null,
        ),
      )
    }

    const groups = new Map<string, SubagentProfileView[]>()
    for (const view of layers) {
      const group = groups.get(view.profile.id)
      if (group) group.push(view)
      else groups.set(view.profile.id, [view])
    }
    const effective: SubagentProfileView[] = []
    const shadowed: SubagentProfileView[] = []
    for (const id of [...groups.keys()].sort()) {
      const group = groups.get(id)!
      const winner = group[group.length - 1]!
      shadowed.push(...group.slice(0, -1))
      effective.push(winner)
    }
    return {
      effective,
      shadowed,
      diagnostics,
      revision: catalogRevision(effective, shadowed),
      userDir,
      projectDir,
      projectRoot,
    }
  }

  catalogEntries(projectRoot: string | null): {
    qualifiedId: string
    name: string
    description: string
    tools: string
    model: string
  }[] {
    return this.catalog(projectRoot)
      .effective.filter((view) => view.profile.enabled && (view.diagnostics ?? []).length === 0)
      .map((view) => ({
        qualifiedId: view.qualifiedId,
        name: view.profile.name,
        description: view.profile.description,
        tools:
          view.profile.tools.mode === 'inherit'
            ? '继承父工具'
            : view.profile.tools.names.length === 0
              ? '无工具'
              : `${view.profile.tools.names.length} 个工具`,
        model:
          view.profile.model.mode === 'inherit'
            ? '继承父模型'
            : `${view.profile.model.selection.provider}/${view.profile.model.selection.model}`,
      }))
      .sort((a, b) => a.qualifiedId.localeCompare(b.qualifiedId))
  }

  resolve(projectRoot: string | null, raw: string): ResolvedProfile {
    let requested: { source: ProfileSource; id: string }
    try {
      requested = parseQualifiedId(raw)
    } catch (error) {
      throw new ProfileError(
        SUBAGENT_CODES.profileInvalid,
        error instanceof Error ? error.message : String(error),
        'profile_id',
        this.effectiveIds(projectRoot),
      )
    }
    const catalog = this.catalog(projectRoot)
    const effective = catalog.effective.find((view) => view.profile.id === requested.id)
    if (!effective) {
      throw new ProfileError(
        SUBAGENT_CODES.profileNotFound,
        `未知的子代理定义：${raw}`,
        'profile_id',
        this.effectiveIds(projectRoot),
      )
    }
    if (effective.source !== requested.source) {
      throw new ProfileError(
        SUBAGENT_CODES.profileShadowed,
        `${raw} 已被更高优先级的定义覆盖，不能绕过覆盖直接派遣（有效项：${effective.qualifiedId}）`,
        'profile_id',
        [effective.qualifiedId],
      )
    }
    if ((effective.diagnostics ?? []).length > 0) {
      throw new ProfileError(
        SUBAGENT_CODES.profileInvalid,
        `${effective.qualifiedId} 的定义文件无法解析，已拒绝使用：${(effective.diagnostics ?? [])
          .map((issue) => issue.message)
          .join(';')}`,
        'profile_id',
      )
    }
    if (!effective.profile.enabled) {
      throw new ProfileError(
        SUBAGENT_CODES.profileDisabled,
        `${effective.qualifiedId} 已被禁用，不能派遣；请选择其他类型或先在设置里启用`,
        'profile_id',
        this.effectiveIds(projectRoot),
      )
    }
    return {
      qualifiedId: effective.qualifiedId,
      source: effective.source,
      revision: effective.revision,
      profile: effective.profile,
    }
  }

  resolveDefault(projectRoot: string | null): ResolvedProfile {
    const catalog = this.catalog(projectRoot)
    const effective = catalog.effective.find((view) => view.profile.id === 'develop')
    if (!effective) {
      throw new ProfileError(
        SUBAGENT_CODES.profileNotFound,
        '默认的 develop 定义不存在；请显式指定 profile_id 或 inline 规格',
      )
    }
    try {
      return this.resolve(projectRoot, effective.qualifiedId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new ProfileError(
        SUBAGENT_CODES.profileDisabled,
        `默认的 develop 定义当前不可用（${detail}）；请选择其他类型`,
        'profile_id',
        this.effectiveIds(projectRoot),
      )
    }
  }

  effectiveIds(projectRoot: string | null): string[] {
    return this.catalog(projectRoot)
      .effective.filter((view) => view.profile.enabled && (view.diagnostics ?? []).length === 0)
      .map((view) => view.qualifiedId)
  }

  create(
    scope: ProfileWriteScope,
    projectRoot: string | null,
    profile: SubagentProfile,
    body: string,
  ): SubagentProfileView {
    const written = { ...profile, schemaVersion: SUBAGENT_SCHEMA_VERSION, instructions: body }
    this.validateForWrite(written)
    const dir = this.dirForWrite(scope, projectRoot)
    const file = definitionPath(dir, written.id)
    if (fs.existsSync(file)) {
      throw new ProfileError(
        SUBAGENT_CODES.profileExists,
        `${sourceForScope(scope)}:${written.id} 已存在：${file}`,
      )
    }
    this.writeDefinition(dir, file, written)
    return this.viewFor(this.catalog(projectRoot), written.id)
  }

  update(
    projectRoot: string | null,
    qualifiedId: string,
    profile: SubagentProfile,
    body: string,
    expectedRevision: number,
  ): SubagentProfileView {
    const qualified = this.parseForWrite(qualifiedId)
    const written = { ...profile, schemaVersion: SUBAGENT_SCHEMA_VERSION, instructions: body }
    this.validateForWrite(written)
    if (written.id !== qualified.id) {
      throw new ProfileError(
        SUBAGENT_CODES.profileInvalid,
        `定义 id 不能从 ${qualified.id} 改成 ${written.id}；文件名即 id`,
        'id',
      )
    }
    const dir = this.dirForWrite(scopeForSource(qualified.source), projectRoot)
    const file = definitionPath(dir, qualified.id)
    const exists = fs.existsSync(file)
    let current: number
    if (exists) {
      current = fnv1a(fs.readFileSync(file))
    } else if (qualified.source === 'builtin') {
      // Editing a shipped definition writes a user-level override on first save.
      const view = this.catalog(projectRoot).effective.find(
        (entry) => entry.profile.id === qualified.id,
      )
      if (!view) {
        throw new ProfileError(
          SUBAGENT_CODES.profileNotFound,
          `未知的子代理定义：${qualifiedId}`,
        )
      }
      current = view.revision
    } else {
      throw new ProfileError(
        SUBAGENT_CODES.profileNotFound,
        `${qualifiedId} 在 ${sourceForScope(scopeForSource(qualified.source))} 作用域下没有可更新的定义`,
      )
    }
    if (current !== expectedRevision) {
      throw new ProfileError(
        SUBAGENT_CODES.revisionConflict,
        `${qualifiedId} 的定义已被外部修改（当前 revision ${current}，期望 ${expectedRevision}）；请刷新后重试`,
        'expectedRevision',
      )
    }
    this.writeDefinition(dir, file, written)
    return this.viewFor(this.catalog(projectRoot), written.id)
  }

  delete(
    projectRoot: string | null,
    qualifiedId: string,
    scope: ProfileWriteScope,
    expectedRevision?: number,
  ): SubagentProfileView | null {
    const qualified = this.parseForWrite(qualifiedId)
    const dir = this.dirForWrite(scope, projectRoot)
    const file = definitionPath(dir, qualified.id)
    if (!fs.existsSync(file)) {
      throw new ProfileError(
        SUBAGENT_CODES.profileNotFound,
        `${qualifiedId} 在 ${sourceForScope(scope)} 作用域下没有可删除的定义`,
        'scope',
      )
    }
    if (expectedRevision !== undefined) {
      const current = fnv1a(fs.readFileSync(file))
      if (current !== expectedRevision) {
        throw new ProfileError(
          SUBAGENT_CODES.revisionConflict,
          `${qualifiedId} 的定义已被外部修改（当前 revision ${current}，期望 ${expectedRevision}）；请刷新后重试`,
          'expectedRevision',
        )
      }
    }
    removeDefinition(file)
    const catalog = this.catalog(projectRoot)
    return catalog.effective.find((entry) => entry.profile.id === qualified.id) ?? null
  }

  reset(
    projectRoot: string | null,
    qualifiedId: string,
    scope: ProfileWriteScope,
  ): SubagentProfileView | null {
    return this.delete(projectRoot, qualifiedId, scope)
  }

  writeScopeFor(view: SubagentProfileView): ProfileWriteScope {
    return scopeForSource(view.source)
  }

  private parseForWrite(raw: string): { source: ProfileSource; id: string } {
    try {
      return parseQualifiedId(raw)
    } catch (error) {
      throw new ProfileError(
        SUBAGENT_CODES.profileInvalid,
        error instanceof Error ? error.message : String(error),
        'profile_id',
      )
    }
  }

  private viewFor(catalog: Catalog, logicalId: string): SubagentProfileView {
    const view = catalog.effective.find((entry) => entry.profile.id === logicalId)
    if (!view) {
      throw new ProfileError(SUBAGENT_CODES.profileNotFound, `定义 ${logicalId} 在合并后不存在`)
    }
    return view
  }

  private validateForWrite(profile: SubagentProfile): void {
    const issues = validateProfile(profile)
    if (issues.length > 0) {
      throw new ProfileError(
        SUBAGENT_CODES.profileInvalid,
        issues.map((issue) => issue.message).join(';'),
        issues[0]?.field,
      )
    }
  }

  private dirForWrite(scope: ProfileWriteScope, projectRoot: string | null): string {
    if (scope === 'user') return this.userDir()
    if (projectRoot === null) {
      throw new ProfileError(
        SUBAGENT_CODES.scopeForbidden,
        '当前上下文没有项目根，不能写项目级定义；请指定会话或改用用户作用域',
        'scope',
      )
    }
    return path.join(projectRoot, PROJECT_DIR)
  }

  private scanDir(dir: string): { definitions: ParsedDefinition[]; diagnostics: ProfileDiagnostic[] } {
    const definitions: ParsedDefinition[] = []
    const diagnostics: ProfileDiagnostic[] = []
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        diagnostics.push({
          code: SUBAGENT_CODES.profileInvalid,
          field: 'dir',
          message: `无法读取定义目录 ${dir}：${error instanceof Error ? error.message : String(error)}`,
        })
      }
      return { definitions, diagnostics }
    }
    const files = entries
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => path.join(dir, name))
    for (const file of files) {
      const stem = path.basename(file, '.md')
      const parsed = parseDefinitionFile(file, stem)
      if (parsed.issues) {
        for (const issue of parsed.issues) {
          diagnostics.push({ ...issue, message: `${path.basename(file)}：${issue.message}` })
        }
        continue
      }
      if (parsed.profile!.id !== stem) {
        diagnostics.push({
          code: SUBAGENT_CODES.profileInvalid,
          field: 'id',
          message: `${file} 里的 id \`${parsed.profile!.id}\` 与文件名不一致；文件名即 id`,
        })
        continue
      }
      definitions.push({ profile: parsed.profile!, revision: parsed.revision! })
    }
    return { definitions, diagnostics }
  }

  private writeDefinition(dir: string, file: string, profile: SubagentProfile): void {
    fs.mkdirSync(dir, { recursive: true })
    const dirStat = fs.lstatSync(dir)
    if (dirStat.isSymbolicLink()) {
      throw new ProfileError(SUBAGENT_CODES.scopeForbidden, `定义目录是符号链接，拒绝写入：${dir}`)
    }
    try {
      if (fs.lstatSync(file).isSymbolicLink()) {
        throw new ProfileError(SUBAGENT_CODES.scopeForbidden, `定义文件是符号链接，拒绝覆盖：${file}`)
      }
    } catch (error) {
      if (error instanceof ProfileError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const text = serializeDefinition(profile)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, text, 'utf8')
    try {
      fs.renameSync(tmp, file)
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* best effort */
      }
      throw new ProfileError(
        SUBAGENT_CODES.scopeForbidden,
        `替换定义文件失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

function scopeForSource(source: ProfileSource): ProfileWriteScope {
  return source === 'project' ? 'project' : 'user'
}

function sourceForScope(scope: ProfileWriteScope): ProfileSource {
  return scope === 'project' ? 'project' : 'user'
}

function definitionPath(dir: string, id: string): string {
  if (!isValidSubagentId(id)) {
    throw new ProfileError(SUBAGENT_CODES.profileInvalid, `非法的定义 id：${id}`, 'id')
  }
  return path.join(dir, `${id}.md`)
}

function removeDefinition(file: string): void {
  if (fs.lstatSync(file).isSymbolicLink()) {
    throw new ProfileError(SUBAGENT_CODES.scopeForbidden, `定义文件是符号链接，拒绝删除：${file}`)
  }
  fs.rmSync(file)
}

function viewOf(
  profile: SubagentProfile,
  source: ProfileSource,
  revision: number,
  overridesBuiltin: boolean,
  projectWritable: boolean,
  diagnostics: ProfileDiagnostic[] = [],
): SubagentProfileView {
  return {
    profile,
    qualifiedId: `${source}:${profile.id}`,
    source,
    revision,
    editable: true,
    overridesBuiltin,
    projectWritable,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  }
}

// ---------------------------------------------------------------------------
// File format
// ---------------------------------------------------------------------------

interface ParseResult {
  profile?: SubagentProfile
  revision?: number
  issues?: ProfileDiagnostic[]
}

export function parseDefinitionFile(file: string, fileId: string): ParseResult {
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(file)
  } catch (error) {
    return { issues: [diagnostic(undefined, `无法读取定义文件：${error instanceof Error ? error.message : String(error)}`)] }
  }
  const revision = fnv1a(bytes)
  const raw = bytes.toString('utf8')
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const split = splitFrontmatter(normalized)
  if (split.error) return { issues: [diagnostic('frontmatter', split.error)] }
  return parseFrontmatter(split.frontmatter!, fileId, split.body!, revision)
}

function splitFrontmatter(text: string): { frontmatter?: string; body?: string; error?: string } {
  if (!text.startsWith('---\n')) {
    return { error: '定义文件必须以 `---` 开头的 YAML frontmatter 起始' }
  }
  const rest = text.slice(4)
  const end = rest.indexOf('\n---')
  if (end < 0) return { error: '定义文件缺少结束的 `---`' }
  const frontmatter = rest.slice(0, end)
  const after = rest.slice(end + 4)
  return { frontmatter, body: after.startsWith('\n') ? after.slice(1) : after }
}

function parseFrontmatter(
  frontmatter: string,
  fileId: string,
  body: string,
  revision: number,
): ParseResult {
  let value: unknown
  try {
    value = parseYaml(frontmatter)
  } catch (error) {
    return { issues: [diagnostic('frontmatter', `frontmatter 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`)] }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { issues: [diagnostic('frontmatter', 'frontmatter 必须是一个映射')] }
  }
  const record = value as Record<string, unknown>
  const issues: ProfileDiagnostic[] = []
  const allowed = ['schemaVersion', 'id', 'name', 'description', 'enabled', 'tools', 'model', 'permissionCeiling', 'color']
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) issues.push(diagnostic('frontmatter', `frontmatter 不认识的字段：${key}`))
  }
  for (const key of BODY_FIELDS) {
    if (key in record) issues.push(diagnostic(key, `${key} 属于 Markdown 正文，不能写在 frontmatter 里`))
  }
  const schemaVersion = typeof record.schemaVersion === 'number' ? record.schemaVersion : NaN
  const id = typeof record.id === 'string' ? record.id : fileId
  const name = typeof record.name === 'string' ? record.name : ''
  const description = typeof record.description === 'string' ? record.description : ''
  const enabled = typeof record.enabled === 'boolean' ? record.enabled : true
  const tools = parseTools(record.tools, issues)
  const model = parseModel(record.model, issues)
  const permissionCeiling = parseCeiling(record.permissionCeiling, issues)
  const color = parseColor(record.color, issues)
  const profile: SubagentProfile = {
    schemaVersion,
    id,
    name,
    description,
    instructions: body,
    enabled,
    tools,
    model,
    permissionCeiling,
    ...(color ? { color } : {}),
  }
  issues.push(...validateProfile(profile))
  if (issues.length > 0) return { issues }
  return { profile, revision }
}

function parseTools(raw: unknown, issues: ProfileDiagnostic[]): ToolSelection {
  if (raw === undefined) {
    issues.push(diagnostic('tools', 'tools 是必填字段（{mode:"inherit"} 或 {mode:"allowlist",names:[...]}）'))
    return { mode: 'inherit' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    issues.push(diagnostic('tools', 'tools 必须是映射'))
    return { mode: 'inherit' }
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'mode' && key !== 'names') issues.push(diagnostic('tools', `tools 不认识的字段：${key}`))
  }
  const mode = record.mode
  if (mode === 'inherit') {
    if ('names' in record) issues.push(diagnostic('tools.names', 'tools.mode=inherit 时不能同时给出 names'))
    return { mode: 'inherit' }
  }
  if (mode === 'allowlist') {
    if (!Array.isArray(record.names) || record.names.some((name) => typeof name !== 'string')) {
      issues.push(diagnostic('tools.names', 'tools.mode=allowlist 时 names 必须是字符串数组'))
      return { mode: 'allowlist', names: [] }
    }
    return { mode: 'allowlist', names: record.names as string[] }
  }
  issues.push(diagnostic('tools', `tools.mode 不支持 \`${String(mode)}\`（允许：inherit、allowlist）`))
  return { mode: 'inherit' }
}

function parseModel(raw: unknown, issues: ProfileDiagnostic[]): ModelChoice {
  if (raw === undefined) return { mode: 'inherit' }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    issues.push(diagnostic('model', 'model 必须是映射'))
    return { mode: 'inherit' }
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'mode' && key !== 'selection') issues.push(diagnostic('model', `model 不认识的字段：${key}`))
  }
  if (record.mode === 'inherit') return { mode: 'inherit' }
  if (record.mode !== 'explicit') {
    issues.push(diagnostic('model', `model.mode 不支持 \`${String(record.mode)}\`（允许：inherit、explicit）`))
    return { mode: 'inherit' }
  }
  const selection = record.selection
  if (typeof selection !== 'object' || selection === null || Array.isArray(selection)) {
    issues.push(diagnostic('model.selection', 'model.selection 必须是映射'))
    return { mode: 'inherit' }
  }
  const fields = selection as Record<string, unknown>
  for (const key of Object.keys(fields)) {
    if (key !== 'provider' && key !== 'model' && key !== 'reasoningEffort') {
      issues.push(diagnostic('model.selection', `model.selection 不认识的字段：${key}`))
    }
  }
  return {
    mode: 'explicit',
    selection: {
      provider: typeof fields.provider === 'string' ? fields.provider : '',
      model: typeof fields.model === 'string' ? fields.model : '',
      ...(typeof fields.reasoningEffort === 'string' ? { reasoningEffort: fields.reasoningEffort } : {}),
    },
  }
}

function parseCeiling(raw: unknown, issues: ProfileDiagnostic[]): PermissionCeiling {
  if (raw === undefined) return 'inherit'
  if (raw === 'inherit' || raw === 'read-only') return raw
  issues.push(diagnostic('permissionCeiling', `permissionCeiling 不支持 \`${String(raw)}\`（允许：inherit、read-only）`))
  return 'inherit'
}

function parseColor(raw: unknown, issues: ProfileDiagnostic[]): ProfileColor | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === 'string' && (PROFILE_COLORS as string[]).includes(raw)) return raw as ProfileColor
  issues.push(diagnostic('color', `color 不支持 \`${String(raw)}\``))
  return undefined
}

function diagnostic(field: string | undefined, message: string): ProfileDiagnostic {
  return {
    code: SUBAGENT_CODES.profileInvalid,
    ...(field ? { field } : {}),
    message,
  }
}

export function serializeDefinition(profile: SubagentProfile): string {
  const front: Record<string, unknown> = {
    schemaVersion: profile.schemaVersion,
    id: profile.id,
    name: profile.name,
    description: profile.description,
    enabled: profile.enabled,
    tools: profile.tools,
    model: profile.model,
    permissionCeiling: profile.permissionCeiling,
  }
  if (profile.color) front.color = profile.color
  const yaml = stringifyYaml(front, { lineWidth: 0 })
  let out = `---\n${yaml}---\n${profile.instructions}`
  if (!out.endsWith('\n')) out += '\n'
  return out
}

function revisionOfBuiltin(profile: SubagentProfile): number {
  return fnv1a(Buffer.from(serializeDefinition(profile), 'utf8'))
}

function catalogRevision(
  effective: SubagentProfileView[],
  shadowed: SubagentProfileView[],
): number {
  let text = ''
  for (const view of [...effective, ...shadowed]) {
    text += `${view.qualifiedId}:${view.revision};`
  }
  return fnv1a(Buffer.from(text, 'utf8'))
}

export function fnv1a(bytes: Buffer): number {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return Number(hash & 0x1fffffffffffffn)
}