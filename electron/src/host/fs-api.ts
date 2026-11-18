import fs from 'node:fs'
import path from 'node:path'

import { isDirectory } from './http.ts'

export function listDirectories(
  target: string | null,
): { path: string; parent: string | null; dirs: string[] } {
  if (!target) {
    if (process.platform === 'win32') {
      const drives: string[] = []
      for (let code = 65; code <= 90; code += 1) {
        const drive = `${String.fromCharCode(code)}:\\`
        if (isDirectory(drive)) drives.push(drive)
      }
      return { path: '', parent: null, dirs: drives }
    }
    return { path: '/', parent: null, dirs: listChildDirs('/') }
  }
  const dir = path.resolve(target)
  if (!isDirectory(dir)) throw new Error(`不是目录:${dir}`)
  const parent = path.dirname(dir)
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    dirs: listChildDirs(dir),
  }
}

function listChildDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('$'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

export function listMentions(
  root: string,
  query: string,
): { path: string; kind: 'file' | 'directory' }[] {
  if (!root || !isDirectory(root)) return []
  const items: { path: string; kind: 'file' | 'directory' }[] = []
  const lower = query.toLowerCase()
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (items.length >= 50 || depth > 6) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (items.length >= 50) return
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (lower === '' || rel.toLowerCase().includes(lower)) {
        items.push({ path: rel, kind: entry.isDirectory() ? 'directory' : 'file' })
      }
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel, depth + 1)
    }
  }
  walk(root, '', 0)
  return items
}

export function treeListing(root: string, dir: string): unknown {
  const base = path.resolve(root)
  if (!isDirectory(base)) throw new Error('项目路径不是目录')
  const target = path.resolve(base, dir || '.')
  if (!target.startsWith(base)) throw new Error('路径越出项目目录')
  if (!isDirectory(target)) throw new Error('不是目录')
  const entries = fs
    .readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules')
    .map((entry) => ({
      name: entry.name,
      path: dir ? `${dir}/${entry.name}` : entry.name,
      kind: entry.isDirectory() ? 'directory' : 'file',
    }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  return { root: base, dir, entries: entries.slice(0, 500), truncated: entries.length > 500 }
}

export function projectFile(root: string, file: string): unknown {
  const base = path.resolve(root)
  const target = path.resolve(base, file)
  if (!target.startsWith(base)) throw new Error('路径越出项目目录')
  const stat = fs.statSync(target)
  if (!stat.isFile()) throw new Error('不是文件')
  if (stat.size > 4 * 1024 * 1024) throw new Error('文件超过 4MB,无法预览')
  const content = fs.readFileSync(target, 'utf8')
  if (content.includes('\u0000')) throw new Error('二进制文件无法预览')
  const language = path.extname(target).slice(1) || null
  return {
    path: file,
    name: path.basename(target),
    content,
    size: stat.size,
    language,
    modifiedMs: stat.mtimeMs,
    lines: content.split('\n').length,
  }
}
