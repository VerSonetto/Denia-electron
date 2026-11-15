// Project instructions (AGENTS.md): discovery across every project
// directory, budgeted rendering and the idempotence rule (only inject when the
// body actually changed).

import fs from 'node:fs'
import path from 'node:path'

export type InstructionScope = 'global-and-project' | 'project-only'

export interface InstructionFile {
  displayPath: string
  content: string
  scope: InstructionScope
  sourcePath: string
}

const REMINDER_OPEN = '<system-reminder>'
const REMINDER_CLOSE = '</system-reminder>'
const INTRO_BASELINE =
  '项目指令:以下项目指令可能与当前工作相关，适用时作为指导。更具体的指令优先于更宽泛的指令；它们不覆盖系统提示词或用户直接下达的指令。'
const INTRO_REPLACEMENT =
  '项目指令:此完整项目指令基线取代之前所有项目指令基线。以下指令可能与当前工作相关，适用时作为指导。更具体的指令优先于更宽泛的指令；它们不覆盖系统提示词或用户直接下达的指令。'
const INTRO_EMPTY_REPLACEMENT =
  '项目指令:此完整项目指令基线取代之前所有项目指令基线。当前没有激活的项目指令。'
const TRUNCATED_NOTICE = '\n\n（项目指令超出字节预算，已截断。）'

export function projectRootOf(cwd: string): string {
  let current = path.resolve(cwd)
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(cwd)
    current = parent
  }
}

/**
 * Discover AGENTS.md files for one project.
 *
 * `roots` is the project's directory list; `touched` may live under any root.
 * Global (`~`) instructions are only included for top-level sessions.
 */
export function discoverProjectInstructions(
  home: string,
  roots: string | readonly string[],
  touched: string[],
  maxSourceBytes: number,
  scope: InstructionScope,
): InstructionFile[] {
  const homeKey = canonicalKey(home)
  const rootList = (typeof roots === 'string' ? [roots] : [...roots])
    .map((root) => path.resolve(root))
    .filter((root, index, list) => list.indexOf(root) === index)
  const dirs: string[] = []
  const projectRoots = new Map<string, string>()
  const push = (dir: string): void => {
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  if (scope === 'global-and-project') push(home)
  for (const root of rootList) {
    const projectRoot = projectRootOf(root)
    projectRoots.set(root, projectRoot)
    for (const dir of ancestorChain(projectRoot, root)) push(dir)
    for (const file of touched) {
      for (const dir of descendantDirs(root, file)) push(dir)
    }
  }
  const basenames = new Map<string, number>()
  for (const root of rootList) {
    const base = path.basename(root) || root
    basenames.set(base, (basenames.get(base) ?? 0) + 1)
  }
  const rootLabel = (root: string): string => {
    const base = path.basename(root) || root
    return (basenames.get(base) ?? 0) > 1 ? root : base
  }
  const files: InstructionFile[] = []
  for (const dir of dirs) {
    if (scope === 'project-only' && sameDir(dir, homeKey)) continue
    const owner = rootList.find((root) => isInside(root, dir))
    const projectRoot = owner ? projectRoots.get(owner)! : dir
    const file = loadFile(
      dir,
      projectRoot,
      home,
      scope,
      maxSourceBytes,
      rootList.length > 1 && owner ? rootLabel(owner) : undefined,
    )
    if (file) files.push(file)
  }
  return files
}

function canonicalKey(dir: string): string {
  try {
    return fs.realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

function sameDir(dir: string, homeKey: string): boolean {
  const key = canonicalKey(dir)
  return key === homeKey || key.toLowerCase() === homeKey.toLowerCase()
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (relative === '') return true
  if (path.isAbsolute(relative)) return false
  return relative !== '..' && !relative.startsWith('..' + path.sep)
}

function ancestorChain(root: string, cwd: string): string[] {
  const chain: string[] = []
  let current = path.resolve(cwd)
  while (isInside(root, current)) {
    chain.push(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return chain.reverse()
}

function descendantDirs(root: string, touched: string): string[] {
  const absolute = path.isAbsolute(touched) ? touched : path.join(root, touched)
  const parent = path.dirname(absolute)
  if (!isInside(root, parent) || parent === path.resolve(root)) return []
  const chain: string[] = []
  let current = parent
  while (isInside(root, current) && current !== path.resolve(root)) {
    chain.push(current)
    const next = path.dirname(current)
    if (next === current) break
    current = next
  }
  return chain.reverse()
}

function loadFile(
  dir: string,
  projectRoot: string,
  home: string,
  scope: InstructionScope,
  maxSourceBytes: number,
  rootLabel?: string,
): InstructionFile | null {
  const file = path.join(dir, 'AGENTS.md')
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.size > maxSourceBytes) return null
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const content = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const isGlobal = sameDir(dir, canonicalKey(home))
  const relative = path.relative(projectRoot, file).replace(/\\/g, '/')
  const displayPath = isGlobal
    ? '~/AGENTS.md'
    : rootLabel
      ? `${rootLabel}/${relative}`
      : relative
  return { displayPath, content, scope, sourcePath: file }
}

function extractBody(message: string): string {
  let inner = message
  if (inner.startsWith(REMINDER_OPEN)) inner = inner.slice(REMINDER_OPEN.length)
  if (inner.startsWith('\n')) inner = inner.slice(1)
  if (inner.endsWith(REMINDER_CLOSE)) inner = inner.slice(0, -REMINDER_CLOSE.length)
  if (inner.endsWith('\n')) inner = inner.slice(0, -1)
  const split = inner.indexOf('\n\n')
  return split < 0 ? '' : inner.slice(split + 2)
}

export function renderProjectInstructions(
  files: InstructionFile[],
  maxBytes: number,
  previous: string | null,
): string | null {
  let body = ''
  for (const file of files) {
    const block = `## ${file.displayPath}\n\n${file.content.trim()}\n`
    if (Buffer.byteLength(body + block, 'utf8') > maxBytes) {
      body += TRUNCATED_NOTICE
      break
    }
    body += block
  }
  body = body.trim()
  if (body === '') {
    // Once a baseline was injected, its removal must also be announced —
    // otherwise the model keeps following deleted instructions.
    if (previous === null) return null
    return `${REMINDER_OPEN}\n${INTRO_EMPTY_REPLACEMENT}\n${REMINDER_CLOSE}`
  }
  const previousBody = previous === null ? null : extractBody(previous)
  if (previousBody !== null && previousBody === body) return null
  const intro = previous === null ? INTRO_BASELINE : INTRO_REPLACEMENT
  return `${REMINDER_OPEN}\n${intro}\n\n${body}\n${REMINDER_CLOSE}`
}
