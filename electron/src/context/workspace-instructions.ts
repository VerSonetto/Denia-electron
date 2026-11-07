// Workspace instructions (AGENTS.md): discovery, budgeted rendering and the
// idempotence rule (only inject when the body actually changed).

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
  '工作区指令:以下工作区指令可能与当前工作相关，适用时作为指导。更具体的指令优先于更宽泛的指令；它们不覆盖系统提示词或用户直接下达的指令。'
const INTRO_REPLACEMENT =
  '工作区指令:此完整工作区指令基线取代之前所有工作区指令基线。以下指令可能与当前工作相关，适用时作为指导。更具体的指令优先于更宽泛的指令；它们不覆盖系统提示词或用户直接下达的指令。'
const INTRO_EMPTY_REPLACEMENT =
  '工作区指令:此完整工作区指令基线取代之前所有工作区指令基线。当前没有激活的工作区指令。'
const TRUNCATED_NOTICE = '\n\n（工作区指令超出字节预算，已截断。）'

export function projectRootOf(cwd: string): string {
  let current = path.resolve(cwd)
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(cwd)
    current = parent
  }
}

export function discoverWorkspaceInstructions(
  home: string,
  cwd: string,
  touched: string[],
  maxSourceBytes: number,
  scope: InstructionScope,
): InstructionFile[] {
  const homeKey = canonicalKey(home)
  const dirs: string[] = []
  const push = (dir: string): void => {
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  if (scope === 'global-and-project') push(home)
  const projectRoot = projectRootOf(cwd)
  for (const dir of ancestorChain(projectRoot, cwd)) push(dir)
  for (const file of touched) {
    for (const dir of descendantDirs(cwd, file)) push(dir)
  }
  const files: InstructionFile[] = []
  for (const dir of dirs) {
    if (scope === 'project-only' && sameDir(dir, homeKey)) continue
    const file = loadFile(dir, projectRoot, home, scope, maxSourceBytes)
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

function ancestorChain(root: string, cwd: string): string[] {
  const chain: string[] = []
  let current = path.resolve(cwd)
  while (current.startsWith(root)) {
    chain.push(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return chain.reverse()
}

function descendantDirs(cwd: string, touched: string): string[] {
  const absolute = path.isAbsolute(touched) ? touched : path.join(cwd, touched)
  const parent = path.dirname(absolute)
  if (!parent.startsWith(cwd) || parent === cwd) return []
  const chain: string[] = []
  let current = parent
  while (current.startsWith(cwd) && current !== cwd) {
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
  const displayPath = isGlobal
    ? '~/AGENTS.md'
    : path.relative(projectRoot, file).replace(/\\/g, '/')
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

export function renderWorkspaceInstructions(
  files: InstructionFile[],
  maxBytes: number,
  previous: string | null,
): string | null {
  let body = ''
  for (const file of files) {
    if (body !== '') body += '\n\n'
    body += `来自 ${file.displayPath} 的指令:\n\n${file.content}`
  }
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    body = truncateUtf8(body, maxBytes) + TRUNCATED_NOTICE
  }
  const frame = (intro: string, text: string): string =>
    text === ''
      ? `${REMINDER_OPEN}\n${intro}\n${REMINDER_CLOSE}`
      : `${REMINDER_OPEN}\n${intro}\n\n${text}\n${REMINDER_CLOSE}`
  if (previous === null) return body === '' ? null : frame(INTRO_BASELINE, body)
  if (extractBody(previous) === body) return null
  return frame(body === '' ? INTRO_EMPTY_REPLACEMENT : INTRO_REPLACEMENT, body)
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