// Search tools: ls, glob, grep. Directory walks skip VCS metadata and
// dependency trees so a workspace-wide grep does not drown in node_modules.

import fs from 'node:fs'
import path from 'node:path'

import type { ToolContext } from './types.ts'
import {
  expectString,
  optionalBoolean,
  optionalNumber,
  optionalString,
  resolvePath,
  schema,
  textOutput,
  toolError,
} from './types.ts'

const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '.denia'])

interface WalkEntry {
  absolute: string
  relative: string
  isDirectory: boolean
}

function* walk(root: string, relative = '', depth = 0): Generator<WalkEntry> {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name
    const absolute = path.join(root, rel)
    if (entry.isDirectory()) {
      yield { absolute, relative: rel, isDirectory: true }
      if (!SKIP_DIRS.has(entry.name)) {
        yield* walk(root, rel, depth + 1)
      }
    } else if (entry.isFile()) {
      yield { absolute, relative: rel, isDirectory: false }
    }
  }
}

export const LsTool = {
  schema: schema(
    'ls',
    '列出目录包含哪些条目(目录名尾部带 "/"),目录在前、文件在后。默认只列一层;要看更深请显式给 depth(上限 5)。',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要列出的目录,默认会话工作区。' },
        depth: { type: 'integer', minimum: 1, maximum: 5, description: '递归深度,默认 1。' },
        max_results: { type: 'integer', minimum: 1, description: '最多返回的条目数,默认 200。' },
        offset: { type: 'integer', minimum: 0, description: '跳过排序后前 N 条(从 0 开始)。' },
      },
    },
  ),
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const raw = optionalString(args, 'path') ?? '.'
    const depth = Math.min(5, Math.max(1, Math.round(optionalNumber(args, 'depth') ?? 1)))
    const maxResults = Math.max(1, Math.round(optionalNumber(args, 'max_results') ?? 200))
    const skip = Math.max(0, Math.round(optionalNumber(args, 'offset') ?? 0))
    let dir: string
    try {
      dir = resolvePath(ctx.cwd, raw, ctx.confined)
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error))
    }
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      return toolError(`列出目录 ${raw} 失败:${error instanceof Error ? error.message : String(error)}`)
    }
    // `entries` is only read by the first level; recursion lists children directly.
    const collect = (
      base: string,
      prefix: string,
      level: number,
      currentEntries: fs.Dirent[],
      out: string[],
    ): void => {
      currentEntries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      for (const entry of currentEntries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        out.push(entry.isDirectory() ? `${rel}/` : rel)
        if (entry.isDirectory() && level < depth && !SKIP_DIRS.has(entry.name)) {
          let childEntries: fs.Dirent[]
          try {
            childEntries = fs.readdirSync(path.join(base, entry.name), { withFileTypes: true })
          } catch {
            continue
          }
          collect(path.join(base, entry.name), rel, level + 1, childEntries, out)
        }
      }
    }
    const lines: string[] = []
    collect(dir, '', 1, entries, lines)
    const window = lines.slice(skip, skip + maxResults)
    const header = `${raw} 下的条目（${window.length}/${lines.length}）:`
    const body = window.length > 0 ? window.join('\n') : '(空目录)'
    const more =
      skip + window.length < lines.length
        ? `\n\n(还有 ${lines.length - skip - window.length} 条;用 offset=${skip + window.length} 继续)`
        : ''
    return textOutput(`${header}\n${body}${more}`)
  },
}

function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else if (char === '{') {
      const end = pattern.indexOf('}', index)
      if (end > index) {
        const options = pattern.slice(index + 1, end).split(',')
        out += `(?:${options.map((option) => option.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`
        index = end
      } else {
        out += '\\{'
      }
    } else if ('\\^$+.[]()|'.includes(char)) {
      out += `\\${char}`
    } else {
      out += char
    }
  }
  return new RegExp(`^${out}$`)
}

export const GlobTool = {
  schema: schema(
    'glob',
    '按 glob 模式查找文件,返回匹配的文件路径(不含目录),按修改时间从新到旧排序。模式里没有 "/" 时匹配任意深度的文件名,所以 "*.ts" 会搜索整棵树;path 可传目录,缺省为会话工作区。',
    {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式(如 "**/*.ts"、"src/**/*.test.js"、"*.{rs,toml}")。' },
        path: { type: 'string', description: '搜索目录,默认会话工作区。' },
        max_results: { type: 'integer', minimum: 1, description: '最多返回的路径数,默认 100。' },
        offset: { type: 'integer', minimum: 0, description: '跳过排序后前 N 条。' },
      },
      required: ['pattern'],
    },
  ),
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const pattern = expectString(args, 'pattern')
    const raw = optionalString(args, 'path') ?? '.'
    const maxResults = Math.max(1, Math.round(optionalNumber(args, 'max_results') ?? 100))
    const skip = Math.max(0, Math.round(optionalNumber(args, 'offset') ?? 0))
    let root: string
    try {
      root = resolvePath(ctx.cwd, raw, ctx.confined)
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error))
    }
    const matcher = globToRegExp(pattern)
    const matches: { relative: string; mtimeMs: number }[] = []
    for (const entry of walk(root)) {
      if (entry.isDirectory) continue
      const target = pattern.includes('/') ? entry.relative : path.posix.basename(entry.relative)
      if (!matcher.test(target)) continue
      let mtimeMs = 0
      try {
        mtimeMs = fs.statSync(entry.absolute).mtimeMs
      } catch {
        /* raced with a delete */
      }
      matches.push({ relative: entry.relative, mtimeMs })
    }
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const window = matches.slice(skip, skip + maxResults)
    if (window.length === 0) return textOutput(`没有匹配 ${pattern} 的文件。`)
    const more =
      skip + window.length < matches.length
        ? `\n\n(还有 ${matches.length - skip - window.length} 条;用 offset=${skip + window.length} 继续)`
        : ''
    return textOutput(window.map((match) => match.relative).join('\n') + more)
  },
}

function matchesInclude(relative: string, include: string | undefined): boolean {
  if (!include) return true
  const matcher = globToRegExp(include)
  return matcher.test(path.posix.basename(relative)) || matcher.test(relative)
}

export const GrepTool = {
  schema: schema(
    'grep',
    '用正则表达式搜索文件内容,结果按 path:line:content 逐行返回。默认尊重常见忽略目录(.git、node_modules);命中多时用 offset/max_matches 分页。',
    {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的正则表达式(JS 正则语法)。' },
        path: { type: 'string', description: '搜索的文件或目录,默认会话工作区。' },
        include: { type: 'string', description: '单个文件 glob 过滤(如 "*.ts")。' },
        ignore_case: { type: 'boolean', description: '大小写不敏感匹配,默认 false。' },
        max_matches: { type: 'integer', minimum: 1, description: '最多返回的命中行数,默认 200。' },
        offset: { type: 'integer', minimum: 0, description: '跳过排序后前 N 条命中。' },
      },
      required: ['pattern'],
    },
  ),
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const pattern = expectString(args, 'pattern')
    const raw = optionalString(args, 'path') ?? '.'
    const include = optionalString(args, 'include')
    const ignoreCase = optionalBoolean(args, 'ignore_case') === true
    const maxMatches = Math.max(1, Math.round(optionalNumber(args, 'max_matches') ?? 200))
    const skip = Math.max(0, Math.round(optionalNumber(args, 'offset') ?? 0))
    let regex: RegExp
    try {
      regex = new RegExp(pattern, ignoreCase ? 'i' : '')
    } catch (error) {
      return toolError(`正则表达式无效:${error instanceof Error ? error.message : String(error)}`)
    }
    let root: string
    try {
      root = resolvePath(ctx.cwd, raw, ctx.confined)
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error))
    }
    const hits: string[] = []
    let scanned = 0
    const visit = (absolute: string, relative: string): void => {
      if (hits.length >= skip + maxMatches) return
      let stat: fs.Stats
      try {
        stat = fs.statSync(absolute)
      } catch {
        return
      }
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(path.basename(absolute))) return
        let entries: fs.Dirent[]
        try {
          entries = fs.readdirSync(absolute, { withFileTypes: true })
        } catch {
          return
        }
        entries.sort((a, b) => a.name.localeCompare(b.name))
        for (const entry of entries) {
          visit(path.join(absolute, entry.name), relative ? `${relative}/${entry.name}` : entry.name)
          if (hits.length >= skip + maxMatches) return
        }
        return
      }
      if (stat.size > 2 * 1024 * 1024) return
      if (!matchesInclude(relative, include)) return
      let text: string
      try {
        text = fs.readFileSync(absolute, 'utf8')
      } catch {
        return
      }
      if (text.includes('\u0000')) return
      scanned += 1
      const lines = text.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        if (regex.test(lines[index]!)) {
          hits.push(`${relative}:${index + 1}:${lines[index]!.slice(0, 400)}`)
          if (hits.length >= skip + maxMatches) return
        }
      }
    }
    visit(root, path.relative(root, root) || '.')
    const window = hits.slice(skip, skip + maxMatches)
    if (window.length === 0) return textOutput(`没有匹配 ${pattern} 的行(扫描 ${scanned} 个文件)。`)
    const more =
      skip + window.length < hits.length
        ? `\n\n(还有 ${hits.length - skip - window.length} 条;用 offset=${skip + window.length} 继续)`
        : ''
    return textOutput(window.join('\n') + more)
  },
}

export const searchTools = [LsTool, GlobTool, GrepTool]