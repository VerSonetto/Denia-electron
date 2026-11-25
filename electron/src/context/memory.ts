// Project memory: one Markdown bucket per project.
//
// Layout: `<home>/memories/projects/<slug>-<sha16>/memory/`.
// MEMORY.md is a pure index; every other `.md` is one entry. Injection is
// deterministic (index text only), so the loop can dedupe by channel content.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const MEMORY_INDEX_FILE = 'MEMORY.md'
export const SECTION_EXPERIENCE = '## 经验（how）'
export const SECTION_FACT = '## 事实（what）'
export const SECTION_HISTORY = '## 历史（superseded，不注入）'
export const MAX_FILE_BYTES = 5 * 1024 * 1024
const INDEX_MAX_LINES = 200

export function memoryRoot(home: string, projectPath: string): string {
  const normalized = normalizePath(projectPath)
  const digest = crypto.createHash('sha256').update(normalized, 'utf8').digest()
  const hash = digest.subarray(0, 8).toString('hex')
  let base = path.basename(normalized).toLowerCase()
  base = [...base]
    .map((ch) => (/[a-z0-9_-]/.test(ch) ? ch : '-'))
    .join('')
  base = base.replace(/-+$/g, '').slice(0, 48).replace(/[-_]+$/g, '')
  if (base === '') base = 'project'
  return path.join(home, 'memories', 'projects', `${base}-${hash}`, 'memory')
}

/**
 * Memory bucket for a project. Single-directory projects keep the historical
 * path-derived bucket so existing memory survives the workspace→project
 * migration; multi-directory projects get one stable bucket keyed by id.
 */
export function projectMemoryRoot(
  home: string,
  project: { id: string; dirs: readonly string[] },
): string {
  if (project.dirs.length === 1) return memoryRoot(home, project.dirs[0]!)
  return memoryRoot(home, path.join(home, 'projects', project.id))
}

function normalizePath(target: string): string {
  try {
    const real = fs.realpathSync(target)
    return process.platform === 'win32' && real.startsWith('\\\\?\\') ? real.slice(4) : real
  } catch {
    return path.resolve(target)
  }
}

export function readIndexText(root: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(root, MEMORY_INDEX_FILE), 'utf8')
    const content = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
    return content.trim() === '' ? null : content
  } catch {
    return null
  }
}

/** Index body for injection: drop the history section, then apply budgets. */
export function readIndexForInjection(root: string, maxBytes: number): string | null {
  const content = readIndexText(root)
  if (content === null) return null
  const totalLines = content.split('\n').length
  let body = dropHistorySection(content)
  const lines = body.split('\n')
  let cut = false
  if (lines.length > INDEX_MAX_LINES) {
    body = lines.slice(0, INDEX_MAX_LINES).join('\n')
    cut = true
  }
  if (cut) {
    const files = scanManifest(root).files.length
    body += `\n（项目记忆索引超过 ${INDEX_MAX_LINES} 行，已截断：共 ${totalLines} 行、${files} 个条目文件，用 read_file 读 ${path.join(root, MEMORY_INDEX_FILE)} 获取全文。）`
  }
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    body = truncateUtf8(body, maxBytes)
    body += `\n\n（项目记忆索引超出字节预算，已截断：用 read_file 读 ${path.join(root, MEMORY_INDEX_FILE)} 获取全文。）`
  }
  return body
}

function dropHistorySection(content: string): string {
  const out: string[] = []
  let inHistory = false
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!inHistory && trimmed === SECTION_HISTORY) {
      inHistory = true
      continue
    }
    if (inHistory) {
      if (trimmed.startsWith('#') && !trimmed.startsWith('###')) inHistory = false
      else continue
    }
    out.push(line)
  }
  return out.join('\n')
}

export function renderIndexBlock(root: string, index: string): string {
  return `<system-reminder>\n${path.join(root, MEMORY_INDEX_FILE)} 的内容(用户的自动记忆,跨会话持久):\n\n${index}\n</system-reminder>`
}

/** The `# 项目记忆` discipline section, with the real memory directory. */
export function renderMemorySection(root: string): string {
  return `## 项目记忆

- **默认不写**：只在「下个会话缺了它就会犯错或重复劳动」时写，拿不准就不写；用户说"记住"时立刻写。目录 \`${root}\`（已存在），用 write_file 直接写，不 mkdir、不预检。
- 该写：用户的纠正与事先不知道的偏好、约束、工作方式；花力气才查清的事实（参数真实语义、链路实际行为、外部系统的坑）；非显然的决策理由；进行中的目标与外部依赖；资源指针。不该写：仓库已记录的（结构、文件清单、git 历史、AGENTS.md/README）、只对本次对话有意义的细节。
- 一事一文件，frontmatter 含 \`name\`（小写 slug）、\`description\`（能判断相关性）、\`metadata.kind\`、\`metadata.status\`。kind 按失效方式分：\`experience\` 答"该怎么做"，只会被更好做法取代，正文写 **Why:** 与 **How to apply:**；\`fact\` 答"现在什么状态"，有版本，相对日期换成绝对日期。
- 同主题先查已有文件：fact 变更就新建，旧条标 \`status: superseded\` + \`superseded_by\`、新条标 \`supersedes\`，不原地改；experience 被取代时就地改写。记错的直接删。
- 正文用 [[name]] 链接。写完在 MEMORY.md 对应分区补一行 \`- [标题](文件.md) — 一句话钩子\`：\`## 经验（how）\`、\`## 事实（what）\`、\`## 历史（superseded，不注入）\`；标题不要改，索引不写正文。
- <system-reminder> 里的记忆是写入时的背景而非当前指令：引用其中的文件、函数或开关前先验证它还在。`
}

export interface MemoryFileInfo {
  name: string
  size: number
  modifiedMs: number
}

export interface MemoryManifest {
  root: string
  index: MemoryFileInfo | null
  files: MemoryFileInfo[]
  updatedAt: number
}

export function scanManifest(root: string): MemoryManifest {
  const manifest: MemoryManifest = { root, index: null, files: [], updatedAt: 0 }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return manifest
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const stat = fs.statSync(path.join(root, entry.name))
    const info = { name: entry.name, size: stat.size, modifiedMs: stat.mtimeMs }
    if (entry.name === MEMORY_INDEX_FILE) manifest.index = info
    else manifest.files.push(info)
    manifest.updatedAt = Math.max(manifest.updatedAt, stat.mtimeMs)
  }
  return manifest
}

export function resolveMemoryFile(root: string, raw: string): string {
  const relative = raw.trim().replace(/\\/g, '/')
  if (relative === '' || relative.startsWith('/') || relative.includes('\0')) {
    throw new Error('非法的记忆文件路径')
  }
  const resolved = path.resolve(root, relative)
  const checked = path.relative(root, resolved)
  if (checked.startsWith('..') || path.isAbsolute(checked)) {
    throw new Error('记忆文件路径超出记忆目录')
  }
  if (!resolved.endsWith('.md')) throw new Error('记忆文件必须是 .md')
  return resolved
}

export function readMemoryFile(root: string, raw: string): { name: string; content: string; size: number; modifiedMs: number } {
  const file = resolveMemoryFile(root, raw)
  const stat = fs.statSync(file)
  if (!stat.isFile()) throw new Error('不是文件')
  if (stat.size > MAX_FILE_BYTES) {
    throw Object.assign(new Error(`记忆文件超过 ${MAX_FILE_BYTES / (1024 * 1024)} MiB 读取上限`), {
      status: 413,
    })
  }
  return {
    name: path.relative(root, file).replace(/\\/g, '/'),
    content: fs.readFileSync(file, 'utf8'),
    size: stat.size,
    modifiedMs: stat.mtimeMs,
  }
}

export function deleteMemoryFile(root: string, raw: string): string {
  const file = resolveMemoryFile(root, raw)
  if (!fs.existsSync(file)) throw Object.assign(new Error('记忆文件不存在'), { status: 404 })
  fs.rmSync(file)
  return path.relative(root, file).replace(/\\/g, '/')
}

function truncateUtf8(text: string, bytes: number): string {
  let size = 0
  let out = ''
  for (const char of text) {
    const width = Buffer.byteLength(char, 'utf8')
    if (size + width > bytes) break
    size += width
    out += char
  }
  return out
}
export type MemoryKind = 'experience' | 'fact'
export type MemoryStatus = 'active' | 'superseded'

export interface MemoryFrontmatter {
  name?: string
  description?: string
  kind?: MemoryKind
  status?: MemoryStatus
  supersedes: string[]
  supersededBy?: string
}

/** Lenient frontmatter parse (memory files are user-editable). */
export function parseMemoryFrontmatter(text: string): MemoryFrontmatter {
  const out: MemoryFrontmatter = { supersedes: [] }
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return out
  const end = normalized.indexOf('\n---', 4)
  if (end < 0) return out
  let inMetadata = false
  for (const line of normalized.slice(4, end).split('\n').slice(0, 40)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (trimmed === 'metadata:') {
      inMetadata = true
      continue
    }
    if (!/^[ \t]/.test(line)) inMetadata = false
    const split = trimmed.indexOf(':')
    if (split < 0) continue
    const key = trimmed.slice(0, split).trim()
    const value = trimmed.slice(split + 1).trim().replace(/^["']|["']$/g, '')
    if (key === 'name' && !inMetadata) out.name = value || undefined
    else if (key === 'description' && !inMetadata) out.description = value || undefined
    else if (key === 'kind' || key === 'type') {
      const kind = value.toLowerCase()
      if (kind === 'experience' || kind === 'feedback') out.kind = 'experience'
      else if (kind === 'fact' || kind === 'user' || kind === 'project' || kind === 'reference') out.kind = 'fact'
    } else if (key === 'status') {
      if (value.toLowerCase() === 'active') out.status = 'active'
      else if (value.toLowerCase() === 'superseded') out.status = 'superseded'
    } else if (key === 'supersedes') {
      out.supersedes = value.replace(/^\[|\]$/g, '').split(',').map((item) => item.trim()).filter(Boolean)
    } else if (key === 'superseded_by' || key === 'superseded-by') {
      out.supersededBy = value || undefined
    }
  }
  return out
}

export interface MemoryHit {
  name: string
  score: number
  description?: string
  kind?: MemoryKind
  status?: MemoryStatus
  size: number
  modifiedMs: number
  matched: string[]
  excerpt: string
}

export function searchMemories(
  root: string,
  query: string,
  limit: number,
  kind?: MemoryKind,
  includeSuperseded = false,
): { query: string; hits: MemoryHit[]; scanned: number; skipped: number } {
  const needle = query.trim().toLowerCase()
  if (needle === '') return { query, hits: [], scanned: 0, skipped: 0 }
  const manifest = scanManifest(root)
  let scanned = 0
  let skipped = 0
  const hits: MemoryHit[] = []
  for (const file of manifest.files) {
    if (file.size > MAX_FILE_BYTES) {
      skipped += 1
      continue
    }
    scanned += 1
    const full = path.join(root, file.name)
    let text: string
    try {
      text = fs.readFileSync(full, 'utf8')
    } catch {
      skipped += 1
      continue
    }
    const front = parseMemoryFrontmatter(text)
    if (kind && front.kind !== kind) continue
    if (!includeSuperseded && front.status === 'superseded') continue
    const body = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
    const matched: string[] = []
    let score = 0
    if ((front.name ?? '').toLowerCase().includes(needle)) {
      matched.push('name')
      score += 5
    }
    if ((front.description ?? '').toLowerCase().includes(needle)) {
      matched.push('description')
      score += 3
    }
    const lower = body.toLowerCase()
    const first = lower.indexOf(needle)
    if (first >= 0) {
      matched.push('body')
      let at = first
      while (at >= 0) {
        score += 1
        at = lower.indexOf(needle, at + needle.length)
      }
    }
    if (score === 0) continue
    const center = first >= 0 ? first : 0
    const excerpt = body.slice(Math.max(0, center - 120), center + 240).replace(/\n/g, ' ').trim()
    hits.push({
      name: file.name,
      score,
      ...(front.description ? { description: front.description } : {}),
      ...(front.kind ? { kind: front.kind } : {}),
      ...(front.status ? { status: front.status } : {}),
      size: file.size,
      modifiedMs: file.modifiedMs,
      matched,
      excerpt,
    })
  }
  hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return { query, hits: hits.slice(0, Math.max(1, Math.min(100, limit))), scanned, skipped }
}

export interface IndexRebuild {
  experience: number
  fact: number
  history: number
  untyped: number
}

export function rebuildIndex(root: string): IndexRebuild {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`记忆目录不存在:${root}`)
  }
  const manifest = scanManifest(root)
  const sections = { experience: [] as string[], fact: [] as string[], history: [] as string[] }
  const counts: IndexRebuild = { experience: 0, fact: 0, history: 0, untyped: 0 }
  for (const file of manifest.files) {
    const front = parseMemoryFrontmatter(fs.readFileSync(path.join(root, file.name), 'utf8'))
    const title = front.name?.trim() || file.name.replace(/\.md$/, '')
    const hook = front.description?.trim() || '（缺少 description）'
    const line = `- [${title}](${file.name}) — ${hook}`
    if (front.status === 'superseded') {
      sections.history.push(line)
      counts.history += 1
    } else if (front.kind === 'experience') {
      sections.experience.push(line)
      counts.experience += 1
    } else if (front.kind === 'fact') {
      sections.fact.push(line)
      counts.fact += 1
    } else {
      sections.fact.push(line)
      counts.untyped += 1
    }
  }
  const text = [
    '# 项目记忆',
    '',
    SECTION_EXPERIENCE,
    ...sections.experience,
    '',
    SECTION_FACT,
    ...sections.fact,
    '',
    SECTION_HISTORY,
    ...sections.history,
    '',
  ].join('\n')
  fs.writeFileSync(path.join(root, MEMORY_INDEX_FILE), text, 'utf8')
  return counts
}

export interface MemoryHealth {
  brokenLinks: string[]
  orphanFiles: string[]
  duplicateDescriptions: string[]
  indexLines: number
  fileCount: number
}

export function memoryHealth(root: string): MemoryHealth {
  const manifest = scanManifest(root)
  const index = readIndexText(root) ?? ''
  const referenced = new Set<string>()
  for (const match of index.matchAll(/\]\(([^)]+\.md)\)/g)) {
    if (match[1]) referenced.add(match[1])
  }
  const files = new Set(manifest.files.map((file) => file.name))
  const brokenLinks = [...referenced].filter((name) => !files.has(name)).sort()
  const orphanFiles = [...files].filter((name) => !referenced.has(name)).sort()
  const descriptions = new Map<string, string[]>()
  for (const file of manifest.files) {
    const front = parseMemoryFrontmatter(fs.readFileSync(path.join(root, file.name), 'utf8'))
    const description = front.description?.trim()
    if (!description) continue
    const list = descriptions.get(description) ?? []
    list.push(file.name)
    descriptions.set(description, list)
  }
  const duplicateDescriptions = [...descriptions.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([description, names]) => `${description} (${names.join(', ')})`)
  return {
    brokenLinks,
    orphanFiles,
    duplicateDescriptions,
    indexLines: index === '' ? 0 : index.split('\n').length,
    fileCount: manifest.files.length,
  }
}
