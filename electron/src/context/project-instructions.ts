// Project instructions (AGENTS.md): one file per selected project root,
// budgeted rendering and the idempotence rule (only inject when the body
// actually changed).

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

/**
 * Discover one AGENTS.md per selected project root.
 *
 * `roots` are the directories the user selected for the project; only the
 * file directly inside each root is considered. Global (`~`) instructions
 * are only included for top-level sessions.
 */
export function discoverProjectInstructions(
  home: string,
  roots: string | readonly string[],
  maxSourceBytes: number,
  scope: InstructionScope,
): InstructionFile[] {
  const homeKey = canonicalKey(home)
  const rootList = (typeof roots === 'string' ? [roots] : [...roots])
    .map((root) => path.resolve(root))
    .filter((root, index, list) => list.indexOf(root) === index)
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
  if (scope === 'global-and-project') {
    const global = loadFile(home, home, scope, maxSourceBytes)
    if (global) files.push(global)
  }
  for (const root of rootList) {
    // The home directory is already covered as the global instruction above,
    // and subagents must not load it at all.
    if (sameDir(root, homeKey)) continue
    const file = loadFile(
      root,
      home,
      scope,
      maxSourceBytes,
      rootList.length > 1 ? rootLabel(root) : undefined,
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

function loadFile(
  dir: string,
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
  const displayPath = isGlobal
    ? '~/AGENTS.md'
    : rootLabel
      ? `${rootLabel}/AGENTS.md`
      : 'AGENTS.md'
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
