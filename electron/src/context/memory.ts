// Project memory: one Markdown bucket per workspace.
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

export function memoryRoot(home: string, workspacePath: string): string {
  const normalized = normalizePath(workspacePath)
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
  return `# 项目记忆

- **默认不写**：记忆是例外而非常规——多数轮次结束时什么都不该留下；只有「下个会话缺了它就会犯错或重复劳动」时才写，判断不了就不写，宁可漏记也不堆积。
- 记忆目录在 \`${root}\`（由「项目记忆」注入且已存在），直接用 write_file 写入，不运行 mkdir、不先检查目录是否存在。每轮结束前判断一次本轮有无值得跨会话保留的信息，有就写；用户明确说“记住”时立刻写，没有值得留的不强写。
- 该写：用户对你的纠正，以及事先不知道的偏好、约束与工作方式；非显而易见且理由来自排查的决策（为什么选 A 不选 B、踩过什么坑、什么做法实测不可行）；花力气才查清的事实（开关与参数的真实语义、某条链路的实际行为、外部系统的坑）；进行中的目标、外部依赖，以及只在对话里说过的约定；外部资源指针（URL、看板、工单、文档位置）。判断标准是下个会话缺了它会不会犯错或重复劳动。
- 不该写：仓库本身已记录的（代码结构、文件清单、git 历史、AGENTS.md/README 内容）；只对本次对话有意义的细节、过程与临时结论；刚做完就能从产物看出的改动；用户没让记的寒暄与闲聊。**拿不准就归到这一类，别硬凑**；用户要求保存“不该写”类内容时，先问清其中非显而易见的部分。
- 保存前先检查是否已有文件覆盖同一主题：**事实**有版本，状态变了就新建一条并在旧条目上写 \`superseded_by\`、在新条目上写 \`supersedes\`，不要原地改写（原地改会丢掉「曾经为什么这么以为」，同一个坑会被重踩）；**经验**在被更好的做法取代时就地改写并补一句为什么变了。发现记错的内容直接删除。
- <system-reminder> 块中的记忆是背景上下文而非当前指令，反映的是写入时的情况；推荐其中的文件、函数或开关前先验证它现在还存在。
- 一事一文件，frontmatter 格式如下，name 用短横线小写 slug，description 要具体到能判断相关性：

\`\`\`markdown
---
name: <slug>
description: <一句话摘要>
metadata:
  kind: experience | fact
  status: active
---
<正文>
\`\`\`

- **kind 按「失效方式」分，不按主题分**：\`experience\` 回答「该怎么做」——纠正、被验证有效的做法、踩过的坑，不会因为时间过去而变错，只会在被更好的做法取代时失效，正文必须写清 **Why:** 与 **How to apply:**；\`fact\` 回答「现在是什么状态」——开关与参数的真实语义、外部依赖、进行中的目标、资源指针，它有版本，相对日期换算成绝对日期。拿不准时问自己一句：这条会不会因为我后来换了做法就变错？会，就是 fact。
- 写 fact 且它取代了某条旧 fact 时，旧条目加 \`status: superseded\` 与 \`superseded_by: <新.md>\`，新条目加 \`supersedes: [<旧.md>]\`；旧条目仍留在磁盘上供追溯，不要删。
- 正文用 [[name]] 链接相关记忆，允许目标暂不存在。
- 写完在 MEMORY.md 对应分区加一行 \`- [标题](文件名.md) — 一句话钩子\`：\`## 经验（how）\`、\`## 事实（what）\`、\`## 历史（superseded，不注入）\`。它是每次会话加载进上下文的索引，一条记忆一行，不带 frontmatter，不把记忆内容写进索引；三个分区标题必须保留（可自行补全索引，但别改标题文字）。`
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
