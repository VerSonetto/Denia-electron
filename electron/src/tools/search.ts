// Search tools: ls, glob, grep. Directory walks skip VCS metadata and
// dependency trees so a project-wide grep does not drown in node_modules.

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

/** Yield to the event loop so a stop request can flip the abort signal mid-walk. */
function breathe(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function cancelled(tool: string) {
  return {
    content: '[工具错误] 命令被用户中断',
    isError: true,
    errorIdentity: { name: tool, code: 'cancelled' },
  }
}

/** Display labels for project roots; duplicate basenames keep their full path. */
function rootLabels(roots: readonly string[]): string[] {
  const counts = new Map<string, number>()
  for (const root of roots) {
    const base = path.basename(root) || root
    counts.set(base, (counts.get(base) ?? 0) + 1)
  }
  return roots.map((root) => {
    const base = path.basename(root) || root
    return (counts.get(base) ?? 0) > 1 ? `${base} (${root})` : base
  })
}

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
        path: { type: 'string', description: '要列出的目录,默认项目目录。' },
        depth: { type: 'integer', minimum: 1, maximum: 5, description: '递归深度,默认 1。' },
        max_results: { type: 'integer', minimum: 1, description: '最多返回的条目数,默认 200。' },
        offset: { type: 'integer', minimum: 0, description: '跳过排序后前 N 条(从 0 开始)。' },
      },
    },
  ),
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const rawArg = optionalString(args, 'path')
    const depth = Math.min(5, Math.max(1, Math.round(optionalNumber(args, 'depth') ?? 1)))
    const maxResults = Math.max(1, Math.round(optionalNumber(args, 'max_results') ?? 200))
    const skip = Math.max(0, Math.round(optionalNumber(args, 'offset') ?? 0))
    const roots = rawArg === undefined && ctx.roots.length > 1 ? ctx.roots : [ctx.cwd]
    const scopes: { dir: string; label: string }[] = []
    for (const root of roots) {
      try {
        scopes.push({
          dir: rawArg === undefined ? root : resolvePath(ctx.cwd, rawArg, ctx.confined, ctx.roots),
          label: rawArg ?? '.',
        })
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error))
      }
      if (rawArg !== undefined) break
    }
    // `entries` is only read by the first level; recursion lists children directly.
    const collect = async (
      base: string,
      prefix: string,
      level: number,
      currentEntries: fs.Dirent[],
      out: string[],
    ): Promise<void> => {
      currentEntries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      let visited = 0
      for (const entry of currentEntries) {
        if (ctx.cancel.aborted) return
        if (++visited % 32 === 0) await breathe()
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        out.push(entry.isDirectory() ? `${rel}/` : rel)
        if (entry.isDirectory() && level < depth && !SKIP_DIRS.has(entry.name)) {
          let childEntries: fs.Dirent[]
          try {
            childEntries = fs.readdirSync(path.join(base, entry.name), { withFileTypes: true })
          } catch {
            continue
          }
          await collect(path.join(base, entry.name), rel, level + 1, childEntries, out)
        }
      }
    }
    const labels = rootLabels(scopes.map((scope) => scope.dir))
    const sections: string[] = []
    let total = 0
    for (let index = 0; index < scopes.length; index += 1) {
      const scope = scopes[index]!
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(scope.dir, { withFileTypes: true })
      } catch (error) {
        if (scopes.length === 1) {
          return toolError(`列出目录 ${scope.label} 失败:${error instanceof Error ? error.message : String(error)}`)
        }
        sections.push(`${labels[index]}:\n(无法读取:${error instanceof Error ? error.message : String(error)})`)
        continue
      }
      const lines: string[] = []
      await collect(scope.dir, '', 1, entries, lines)
      total += lines.length
      const heading = scopes.length > 1 ? `${labels[index]}:` : `${scope.label} 下的条目（${lines.length}/${lines.length}）:`
      sections.push(`${heading}\n${lines.length > 0 ? lines.join('\n') : '(空目录)'}`)
    }
    if (ctx.cancel.aborted) return cancelled('ls')
    if (scopes.length === 1) {
      const lines = sections[0]!.split('\n').slice(1)
      const window = lines.slice(skip, skip + maxResults)
      const header = `${scopes[0]!.label} 下的条目（${window.length}/${lines.length}）:`
      const body = window.length > 0 ? window.join('\n') : '(空目录)'
      const more =
        skip + window.length < lines.length
          ? `\n\n(还有 ${lines.length - skip - window.length} 条;用 offset=${skip + window.length} 继续)`
          : ''
      return textOutput(`${header}\n${body}${more}`)
    }
    return textOutput(`项目目录（${scopes.length} 个，共 ${total} 条）:\n\n${sections.join('\n\n')}`)
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
    '按 glob 模式查找文件,返回匹配的文件路径(不含目录),按修改时间从新到旧排序。模式里没有 "/" 时匹配任意深度的文件名,所以 "*.ts" 会搜索整棵树;path 可传目录,缺省为项目目录。',
    {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式(如 "**/*.ts"、"src/**/*.test.js"、"*.{rs,toml}")。' },
        path: { type: 'string', description: '搜索目录,默认项目目录。' },
        max_results: { type: 'integer', minimum: 1, description: '最多返回的路径数,默认 100。' },
        offset: { type: 'integer', minimum: 0, description: '跳过排序后前 N 条。' },
      },
      required: ['pattern'],
    },
  ),
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const pattern = expectString(args, 'pattern')
    const rawArg = optionalString(args, 'path')
    const maxResults = Math.max(1, Math.round(optionalNumber(args, 'max_results') ?? 100))
    const skip = Math.max(0, Math.round(optionalNumber(args, 'offset') ?? 0))
    const roots = rawArg === undefined && ctx.roots.length > 1
      ? ctx.roots
      : [ctx.cwd]
    const scopes: string[] = []
    for (const root of roots) {
      try {
        scopes.push(rawArg === undefined ? root : resolvePath(ctx.cwd, rawArg, ctx.confined, ctx.roots))
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error))
      }
      if (rawArg !== undefined) break
    }
    const labels = rootLabels(scopes)
    const matcher = globToRegExp(pattern)
    const matches: { relative: string; mtimeMs: number }[] = []
    let walked = 0
    for (let index = 0; index < scopes.length; index += 1) {
      const root = scopes[index]!
      for (const entry of walk(root)) {
        if (ctx.cancel.aborted) return cancelled('glob')
        if (++walked % 32 === 0) await breathe()
        if (entry.isDirectory) continue
        const target = pattern.includes('/') ? entry.relative : path.posix.basename(entry.relative)
        if (!matcher.test(target)) continue
        let mtimeMs = 0
        try {
          mtimeMs = fs.statSync(entry.absolute).mtimeMs
        } catch {
          /* raced with a delete */
        }
        matches.push({
          relative: scopes.length > 1 ? `${labels[index]}/${entry.relative}` : entry.relative,
          mtimeMs,
        })
      }
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
        path: { type: 'string', description: '搜索的文件或目录,默认项目目录。' },
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
    const rawArg = optionalString(args, 'path')
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
    const roots = rawArg === undefined && ctx.roots.length > 1
      ? ctx.roots
      : [ctx.cwd]
    const scopes: string[] = []
    for (const root of roots) {
      try {
        scopes.push(rawArg === undefined ? root : resolvePath(ctx.cwd, rawArg, ctx.confined, ctx.roots))
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error))
      }
      if (rawArg !== undefined) break
    }
    const labels = rootLabels(scopes)
    const hits: string[] = []
    let visited = 0
    let scanned = 0
    const visit = async (absolute: string, relative: string): Promise<void> => {
      if (ctx.cancel.aborted) return
      if (++visited % 32 === 0) await breathe()
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
          await visit(path.join(absolute, entry.name), relative ? `${relative}/${entry.name}` : entry.name)
          if (hits.length >= skip + maxMatches) return
        }
        return
      }
      if (stat.size > 2 * 1024 * 1024) return
      if (!matchesInclude(relative, include)) return
      let text: string
      try {
        text = await fs.promises.readFile(absolute, 'utf8')
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
    for (let index = 0; index < scopes.length; index += 1) {
      const root = scopes[index]!
      await visit(root, scopes.length > 1 ? (labels[index] ?? root) : '')
      if (hits.length >= skip + maxMatches) break
    }
    if (ctx.cancel.aborted) return cancelled('grep')
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