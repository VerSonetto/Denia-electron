// Layered skill discovery: project > user > bundled.
//
// A skill is a directory (or a single `.md`) with YAML frontmatter. Only the
// summary is cached; the body is re-read when `skill load` runs so an edited
// skill never runs stale text.

import fs from 'node:fs'
import path from 'node:path'

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

export interface Skill {
  name: string
  description: string
  source: string
  path: string
  resourceBase: string
  modelInvocable: boolean
  userInvocable: boolean
  builtinBody?: string
}

export interface ManagedSkill extends Skill {
  enabled: boolean
  editable: boolean
}

export interface SkillDiagnostic {
  path: string
  message: string
}

export interface SkillDiscovery {
  skills: Skill[]
  diagnostics: SkillDiagnostic[]
}

const MAX_SKILL_BYTES = 1024 * 1024
const MAX_RESOURCE_BYTES = 1024 * 1024
const BUILTIN_DIR = path.resolve(import.meta.dirname, '..', '..', 'builtin-skills')

interface Metadata {
  name?: string
  description?: string
  disableModelInvocation: boolean
  userInvocable?: boolean
}

export function discoverSkills(home: string, cwd?: string | null): SkillDiscovery {
  const diagnostics: SkillDiagnostic[] = []
  const disabled = readDisabled(home)
  const found = new Map<string, Skill>()
  const roots: { dir: string; source: string }[] = []
  if (cwd && fs.existsSync(cwd)) {
    const projectRoot = projectRootOf(cwd)
    roots.push(
      { dir: path.join(projectRoot, '.denia', 'skills'), source: 'project-denia' },
      { dir: path.join(projectRoot, '.dsh', 'skills'), source: 'project-dsh' },
      { dir: path.join(projectRoot, '.agents', 'skills'), source: 'project-agents' },
    )
  }
  roots.push({ dir: path.join(home, 'skills'), source: 'user-denia' })

  for (const root of roots) {
    for (const file of skillFiles(root.dir)) {
      const skill = parseSkillFile(file, root.source, diagnostics)
      if (!skill) continue
      if (!found.has(skill.name)) found.set(skill.name, skill)
    }
  }
  for (const skill of bundledSkills(diagnostics)) {
    if (!found.has(skill.name)) found.set(skill.name, skill)
  }
  return {
    skills: [...found.values()]
      .filter((skill) => !disabled.has(identityOf(skill)))
      .sort((a, b) => a.name.localeCompare(b.name)),
    diagnostics,
  }
}

export function projectRootOf(cwd: string): string {
  let current = path.resolve(cwd)
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(cwd)
    current = parent
  }
}

function skillFiles(dir: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const file = path.join(full, 'SKILL.md')
      if (fs.existsSync(file) && fs.statSync(file).isFile()) out.push(file)
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

function bundledSkills(diagnostics: SkillDiagnostic[]): Skill[] {
  if (!fs.existsSync(BUILTIN_DIR)) return []
  return skillFiles(BUILTIN_DIR)
    .map((file) => {
      const skill = parseSkillFile(file, 'bundled', diagnostics)
      if (!skill) return null
      try {
        const body = splitSkillText(fs.readFileSync(file, 'utf8')).body
        return { ...skill, builtinBody: body }
      } catch {
        return skill
      }
    })
    .filter((skill): skill is Skill => skill !== null)
}

export function parseSkillFile(
  file: string,
  source: string,
  diagnostics: SkillDiagnostic[] = [],
): Skill | null {
  try {
    const stat = fs.statSync(file)
    if (stat.size > MAX_SKILL_BYTES) {
      throw new Error(`技能文件过大：${file}`)
    }
    const raw = fs.readFileSync(file, 'utf8')
    return parseSkillText(raw, file, source)
  } catch (error) {
    diagnostics.push({ path: file, message: error instanceof Error ? error.message : String(error) })
    return null
  }
}

export function parseSkillText(raw: string, file: string, source: string): Skill {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const split = splitSkillText(normalized)
  let metadata: Metadata = { disableModelInvocation: false }
  if (split.header !== null) {
    const parsed = parseYaml(split.header)
    if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
      throw new Error(`技能元数据无效 ${file}：frontmatter 必须是映射`)
    }
    const record = (parsed ?? {}) as Record<string, unknown>
    metadata = {
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      disableModelInvocation: record['disable-model-invocation'] === true,
      ...(typeof record['user-invocable'] === 'boolean'
        ? { userInvocable: record['user-invocable'] }
        : {}),
    }
  }
  const fallback = path.basename(file) === 'SKILL.md'
    ? path.basename(path.dirname(file))
    : path.basename(file, '.md')
  const name = metadata.name ?? fallback
  if (!isValidSkillName(name)) {
    throw new Error(`技能名称必须为小写 kebab-case：${name}`)
  }
  const description = metadata.description ??
    split.body.split('\n').find((line) => line.trim() !== '')?.replace(/^#/, '').trim() ??
    ''
  if (description === '') throw new Error(`技能 ${name} 缺少描述`)
  return {
    name,
    description,
    source,
    path: file,
    resourceBase: path.dirname(file),
    modelInvocable: !metadata.disableModelInvocation,
    userInvocable: metadata.userInvocable ?? true,
  }
}

function splitSkillText(normalized: string): { header: string | null; body: string } {
  if (!normalized.startsWith('---\n')) return { header: null, body: normalized }
  const rest = normalized.slice(4)
  const end = rest.indexOf('\n---\n')
  if (end < 0) throw new Error('技能元数据缺少结束标记')
  return { header: rest.slice(0, end), body: rest.slice(end + 5) }
}

export function isValidSkillName(name: string): boolean {
  if (name === '' || name.length > 100) return false
  return name.split('-').every(
    (part) => part !== '' && /^[a-z0-9]+$/.test(part),
  )
}

export function loadSkill(
  skills: Skill[],
  name: string,
  user: boolean,
): { skill: Skill; body: string } {
  const skill = skills.find((entry) => entry.name === name)
  if (!skill) throw new Error(`找不到技能：${name}`)
  const fresh = skill.builtinBody !== undefined
    ? { skill, body: skill.builtinBody }
    : (() => {
        const parsed = parseSkillFile(skill.path, skill.source)
        if (!parsed) throw new Error(`技能已变更，请刷新目录：${name}`)
        if (parsed.name !== name) throw new Error('技能已变更，请刷新目录')
        const body = splitSkillText(
          fs.readFileSync(skill.path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'),
        ).body
        return { skill: parsed, body }
      })()
  if (user ? !fresh.skill.userInvocable : !fresh.skill.modelInvocable) {
    throw new Error('该技能不允许此调用方式')
  }
  return fresh
}

export function readSkillResource(
  skills: Skill[],
  name: string,
  resourcePath: string,
): { path: string; text: string } {
  loadSkill(skills, name, false)
  const skill = skills.find((entry) => entry.name === name)!
  const root = fs.realpathSync(skill.resourceBase)
  const resolved = fs.realpathSync(path.resolve(root, resourcePath))
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('技能资源路径超出技能目录')
  }
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) throw new Error('技能资源不是文件')
  if (stat.size > MAX_RESOURCE_BYTES) throw new Error('技能资源超过 1 MiB 读取上限')
  return { path: resolved, text: fs.readFileSync(resolved, 'utf8') }
}

/** Catalog injected as a user message; only summaries, never the body. */
export function renderSkillCatalog(skills: Skill[], maxDescriptionChars = 500): string | null {
  const invocable = skills.filter((skill) => skill.modelInvocable)
  if (invocable.length === 0) return null
  const lines = [
    '<system-reminder>',
    '技能目录:本会话可用的技能如下:',
    '',
    '<available_skills>',
    '技能是可复用的任务指令集。若用户点名某技能，或任务与某技能的描述明确匹配，先调用 skill 工具（action=load）加载其完整指令，再执行任务；可同时加载多个适用技能。目录只含摘要：未加载前不得凭摘要推断或执行技能内容。用户也可能以 /技能名 直接调用技能，其正文会以注入消息出现，此时无需再调 skill 工具。',
    ...invocable.map((skill) => `- \`${skill.name}\`: ${truncateChars(skill.description, maxDescriptionChars)}`),
    '</available_skills>',
    '</system-reminder>',
  ]
  return lines.join('\n')
}

/** Replacement text when a previously published catalog becomes empty. */
export function renderEmptySkillCatalog(): string {
  return [
    '<system-reminder>',
    '技能目录:此技能目录取代之前发布的技能目录。当前没有可用的技能。',
    '</system-reminder>',
  ].join('\n')
}

export function truncateChars(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…'
}

// ---------------------------------------------------------------------------
// management
// ---------------------------------------------------------------------------

export function listManagedSkills(home: string, cwd?: string | null): ManagedSkill[] {
  const disabled = readDisabled(home)
  return discoverAll(home, cwd).map((skill) => ({
    ...skill,
    enabled: !disabled.has(identityOf(skill)),
    editable: skill.source !== 'bundled',
  }))
}

function discoverAll(home: string, cwd?: string | null): Skill[] {
  const diagnostics: SkillDiagnostic[] = []
  const found = new Map<string, Skill>()
  const roots: { dir: string; source: string }[] = []
  if (cwd && fs.existsSync(cwd)) {
    const projectRoot = projectRootOf(cwd)
    roots.push(
      { dir: path.join(projectRoot, '.denia', 'skills'), source: 'project-denia' },
      { dir: path.join(projectRoot, '.dsh', 'skills'), source: 'project-dsh' },
      { dir: path.join(projectRoot, '.agents', 'skills'), source: 'project-agents' },
    )
  }
  roots.push({ dir: path.join(home, 'skills'), source: 'user-denia' })
  for (const root of roots) {
    for (const file of skillFiles(root.dir)) {
      const skill = parseSkillFile(file, root.source, diagnostics)
      if (skill && !found.has(skill.name)) found.set(skill.name, skill)
    }
  }
  for (const skill of bundledSkills(diagnostics)) {
    if (!found.has(skill.name)) found.set(skill.name, skill)
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function getManagedSkill(
  home: string,
  cwd: string | null,
  name: string,
): { skill: ManagedSkill; body: string; raw: string } {
  const item = listManagedSkills(home, cwd).find((skill) => skill.name === name)
  if (!item) throw new Error('找不到技能')
  const raw = item.source === 'bundled'
    ? fs.readFileSync(item.path, 'utf8')
    : fs.readFileSync(item.path, 'utf8')
  return { skill: item, body: splitSkillText(raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')).body, raw }
}

export function saveSkill(
  home: string,
  cwd: string | null,
  name: string,
  content: string,
  options: { create: boolean; scope: 'user' | 'project' },
): ManagedSkill {
  if (!isValidSkillName(name)) throw new Error('技能名称必须为不超过 100 字符的小写 kebab-case')
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) throw new Error('技能文件超过 1 MiB')
  const all = discoverAll(home, cwd)
  let target: string
  if (options.create) {
    if (all.some((skill) => skill.name === name)) throw new Error('同名技能已存在')
    target = path.join(skillRoot(home, cwd, options.scope), name, 'SKILL.md')
    fs.mkdirSync(path.dirname(target), { recursive: true })
  } else {
    const skill = all.find((entry) => entry.name === name)
    if (!skill) throw new Error('找不到技能')
    if (skill.source === 'bundled') throw new Error('内置技能不能编辑')
    const parsed = parseSkillText(content, skill.path, skill.source)
    if (parsed.name !== name) {
      throw new Error(`技能正文的 name 必须与 URL 一致（${name}）；文件名即技能名`)
    }
    target = skill.path
  }
  const temporary = path.join(path.dirname(target), `.skills-${process.pid}-${Date.now()}.tmp`)
  fs.writeFileSync(temporary, content, 'utf8')
  fs.renameSync(temporary, target)
  const saved = listManagedSkills(home, cwd).find((skill) => skill.name === name)
  if (!saved) throw new Error('保存后无法解析技能')
  return saved
}

export function setSkillEnabled(
  home: string,
  cwd: string | null,
  name: string,
  enabled: boolean,
): ManagedSkill {
  const skill = listManagedSkills(home, cwd).find((entry) => entry.name === name)
  if (!skill) throw new Error('找不到技能')
  const disabled = readDisabled(home)
  const id = identityOf(skill)
  if (enabled) disabled.delete(id)
  else disabled.add(id)
  fs.writeFileSync(
    path.join(home, 'disabled-skills.json'),
    JSON.stringify([...disabled].sort(), null, 2) + '\n',
    'utf8',
  )
  return listManagedSkills(home, cwd).find((entry) => entry.name === name)!
}

export function deleteSkill(home: string, cwd: string | null, name: string): void {
  const skill = listManagedSkills(home, cwd).find((entry) => entry.name === name)
  if (!skill) throw new Error('找不到技能')
  if (!skill.editable) throw new Error('内置技能不能删除')
  // Rust only removes SKILL.md; resource files stay for manual recovery.
  fs.rmSync(skill.path, { force: true })
}

export function importSkills(
  home: string,
  cwd: string | null,
  source: string,
  scope: 'user' | 'project',
): ManagedSkill[] {
  const sourceDir = path.resolve(source)
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error('导入路径不是目录')
  }
  const root = skillRoot(home, cwd, scope)
  fs.mkdirSync(root, { recursive: true })
  const imported: ManagedSkill[] = []
  for (const file of skillFiles(sourceDir)) {
    const skill = parseSkillFile(file, 'import')
    if (!skill) continue
    const target = path.join(root, skill.name, 'SKILL.md')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(file, target)
    for (const asset of fs.readdirSync(path.dirname(file))) {
      if (asset === 'SKILL.md') continue
      const from = path.join(path.dirname(file), asset)
      if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(path.dirname(target), asset))
    }
    const managed = listManagedSkills(home, cwd).find((entry) => entry.name === skill.name)
    if (managed) imported.push(managed)
  }
  return imported
}

function skillRoot(home: string, cwd: string | null, scope: 'user' | 'project'): string {
  if (scope === 'user') return path.join(home, 'skills')
  if (!cwd) throw new Error('项目作用域需要 cwd')
  return path.join(projectRootOf(cwd), '.denia', 'skills')
}

function identityOf(skill: Skill): string {
  if (skill.source === 'bundled') return `bundled:${skill.name}`
  try {
    return fs.realpathSync(skill.path)
  } catch {
    return skill.path
  }
}

function readDisabled(home: string): Set<string> {
  const file = path.join(home, 'disabled-skills.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((entry): entry is string => typeof entry === 'string'))
    }
  } catch {
    /* missing or broken: everything enabled */
  }
  return new Set()
}