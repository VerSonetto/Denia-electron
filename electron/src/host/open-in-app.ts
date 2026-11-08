// 「用应用打开」:探测本机可用于打开工作区目录的应用,提取真实图标并按需启动。
//
// The endpoint contract mirrors the Rust host, so the shared web console's
// `OpenInApp` split button works unchanged:
//   GET  /api/open-in-app/apps       -> { apps: string[] } (menu order)
//   GET  /api/open-in-app/icon/:id   -> PNG or 404
//   POST /api/open-in-app/open       -> { ok: true } / open-in-app/* errors
//
// Probing is a live fact, but spawning `where` for every menu open is wasteful:
// the resolved catalog is cached for 30 seconds. Icons are extracted lazily
// through Electron's `app.getFileIcon` and cached (failures included).

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type LaunchOutcome = 'launched' | 'unknown' | 'failed'

interface AppEntry {
  id: string
  /** File or bundle used for the icon; null when this launcher has none. */
  iconPath: string | null
  /** null = hand the directory to the OS shell (Explorer / Finder). */
  command: string | null
  args?: (dir: string) => string[]
  /** Console-backed launchers (terminals) need their own window. */
  showWindow?: boolean
}

const APPS_TTL_MS = 30_000

let cache: { at: number; entries: AppEntry[] } | null = null
const iconCache = new Map<string, Buffer | null>()

function exists(target: string | null | undefined): target is string {
  if (!target) return false
  try {
    fs.statSync(target)
    return true
  } catch (error) {
    // Execution aliases under WindowsApps can deny stat/access while remaining
    // spawnable; the PATH scan found them, so treat the permission error as present.
    return (error as NodeJS.ErrnoException).code === 'EACCES'
  }
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile()
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EACCES'
  }
}

function firstExisting(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return null
}

function findOnPath(name: string): string | null {
  // Scan PATH ourselves instead of parsing `where`/`which`: the child process
  // would print non-ASCII paths in the OEM code page, while process.env is
  // already decoded correctly.
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '')
      : ['']
  const names = path.extname(name) !== '' ? [name] : [name, ...extensions.map((ext) => `${name}${ext}`)]
  for (const rawDir of (process.env.PATH ?? '').split(path.delimiter)) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1')
    if (dir === '') continue
    for (const candidate of names) {
      const file = path.join(dir, candidate)
      if (isFile(file)) return file
    }
  }
  return null
}

/**
 * A CLI shim (`code.cmd`, `cursor.cmd`) lives in a `bin` directory near the
 * real executable; walk a few levels up to find the `.exe` worth spawning and
 * extracting an icon from.
 */
function cliSibling(name: string, exeName: string): string | null {
  const cli = findOnPath(name)
  if (cli === null) return null
  const dir = path.dirname(cli)
  const candidates: string[] = []
  let current = dir
  for (let level = 0; level < 4; level += 1) {
    candidates.push(path.join(current, exeName))
    current = path.join(current, '..')
  }
  return firstExisting(candidates)
}

function windowsEntries(): AppEntry[] {
  const env = process.env
  const entries: AppEntry[] = []

  const explorer = firstExisting([
    env.SystemRoot ? path.join(env.SystemRoot, 'explorer.exe') : null,
    'C:\\Windows\\explorer.exe',
  ])
  if (explorer !== null) {
    // Opening a directory through the shell is the reliable way to bring
    // Explorer to the foreground; spawning explorer.exe directly is not.
    entries.push({ id: 'explorer', iconPath: explorer, command: null })
  }

  const vscode = firstExisting([
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe') : null,
    env.ProgramFiles ? path.join(env.ProgramFiles, 'Microsoft VS Code', 'Code.exe') : null,
    env['ProgramFiles(x86)'] ? path.join(env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe') : null,
    cliSibling('code', 'Code.exe'),
    findOnPath('Code.exe'),
  ])
  if (vscode !== null) {
    entries.push({ id: 'vscode', iconPath: vscode, command: vscode, args: (dir) => [dir] })
  }

  const cursor = firstExisting([
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'cursor', 'Cursor.exe') : null,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Cursor', 'Cursor.exe') : null,
    env.ProgramFiles ? path.join(env.ProgramFiles, 'Cursor', 'Cursor.exe') : null,
    cliSibling('cursor', 'Cursor.exe'),
    findOnPath('Cursor.exe'),
  ])
  if (cursor !== null) {
    entries.push({ id: 'cursor', iconPath: cursor, command: cursor, args: (dir) => [dir] })
  }

  const wt = firstExisting([
    findOnPath('wt.exe'),
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe') : null,
  ])
  if (wt !== null) {
    entries.push({
      id: 'windowsterminal',
      iconPath: wt,
      command: wt,
      args: (dir) => ['-d', dir],
      showWindow: true,
    })
  }

  const gitBash = firstExisting([
    env.ProgramFiles ? path.join(env.ProgramFiles, 'Git', 'git-bash.exe') : null,
    env['ProgramFiles(x86)'] ? path.join(env['ProgramFiles(x86)'], 'Git', 'git-bash.exe') : null,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'git-bash.exe') : null,
    findOnPath('git-bash.exe'),
    // A non-standard Git install (e.g. C:\Dev\git) still ships git-bash.exe
    // next to usr\bin\bash.exe, which is on PATH.
    cliSibling('bash.exe', 'git-bash.exe'),
  ])
  const bash = gitBash ?? findOnPath('bash.exe')
  if (bash !== null) {
    const isGitBash = path.basename(bash).toLowerCase() === 'git-bash.exe'
    entries.push({
      id: 'gitbash',
      iconPath: bash,
      command: bash,
      args: isGitBash ? (dir) => [`--cd=${dir}`] : () => ['--login', '-i'],
      showWindow: true,
    })
  }

  return entries
}

function darwinEntries(): AppEntry[] {
  const entries: AppEntry[] = []
  const home = process.env.HOME ?? ''
  const finder = '/System/Library/CoreServices/Finder.app'
  if (exists(finder)) {
    entries.push({ id: 'finder', iconPath: finder, command: null })
  }

  const vscode = firstExisting([
    '/Applications/Visual Studio Code.app',
    home ? path.join(home, 'Applications', 'Visual Studio Code.app') : null,
  ])
  if (vscode !== null) {
    entries.push({
      id: 'vscode',
      iconPath: vscode,
      command: '/usr/bin/open',
      args: (dir) => ['-a', 'Visual Studio Code', dir],
    })
  }

  const cursor = firstExisting([
    '/Applications/Cursor.app',
    home ? path.join(home, 'Applications', 'Cursor.app') : null,
  ])
  if (cursor !== null) {
    entries.push({
      id: 'cursor',
      iconPath: cursor,
      command: '/usr/bin/open',
      args: (dir) => ['-a', 'Cursor', dir],
    })
  }

  const terminal = firstExisting([
    '/System/Applications/Utilities/Terminal.app',
    '/Applications/Utilities/Terminal.app',
  ])
  if (terminal !== null) {
    entries.push({
      id: 'terminal',
      iconPath: terminal,
      command: '/usr/bin/open',
      args: (dir) => ['-a', 'Terminal', dir],
    })
  }

  return entries
}

function linuxEntries(): AppEntry[] {
  const entries: AppEntry[] = []

  const filemanager = findOnPath('xdg-open')
  if (filemanager !== null) {
    entries.push({ id: 'filemanager', iconPath: null, command: filemanager, args: (dir) => [dir] })
  }

  const vscode = findOnPath('code')
  if (vscode !== null) {
    entries.push({ id: 'vscode', iconPath: vscode, command: vscode, args: (dir) => [dir] })
  }

  const cursor = findOnPath('cursor')
  if (cursor !== null) {
    entries.push({ id: 'cursor', iconPath: cursor, command: cursor, args: (dir) => [dir] })
  }

  const gnome = findOnPath('gnome-terminal')
  if (gnome !== null) {
    entries.push({
      id: 'gnometerminal',
      iconPath: gnome,
      command: gnome,
      args: (dir) => [`--working-directory=${dir}`],
      showWindow: true,
    })
  }

  const konsole = findOnPath('konsole')
  if (konsole !== null) {
    entries.push({
      id: 'konsole',
      iconPath: konsole,
      command: konsole,
      args: (dir) => ['--workdir', dir],
      showWindow: true,
    })
  }

  return entries
}

function resolveEntries(): AppEntry[] {
  if (cache !== null && Date.now() - cache.at < APPS_TTL_MS) return cache.entries
  const entries =
    process.platform === 'win32'
      ? windowsEntries()
      : process.platform === 'darwin'
        ? darwinEntries()
        : linuxEntries()
  cache = { at: Date.now(), entries }
  return entries
}

/** Resolved app ids in menu order (file managers, editors, terminals). */
export function availableApps(): string[] {
  return resolveEntries().map((entry) => entry.id)
}

/** A PNG icon for one resolved app; null when it has none or extraction failed. */
export async function iconFor(id: string): Promise<Buffer | null> {
  if (iconCache.has(id)) return iconCache.get(id) ?? null
  const entry = resolveEntries().find((item) => item.id === id)
  if (!entry || entry.iconPath === null) {
    iconCache.set(id, null)
    return null
  }
  try {
    // Loaded lazily: unit tests run under plain Node, where Electron's app
    // module is unavailable. The route then answers 404 and the UI falls back
    // to its generic app glyph.
    const { app } = await import('electron')
    const image = await app.getFileIcon(entry.iconPath, { size: 'normal' })
    const png = image.isEmpty() ? null : image.toPNG()
    iconCache.set(id, png)
    return png
  } catch {
    iconCache.set(id, null)
    return null
  }
}

/**
 * Open `dir` with a resolved app. Unknown ids are rejected before spawning;
 * a short spawn observation window turns "command disappeared" into a failed
 * launch instead of a false success.
 */
export async function launchApp(id: string, dir: string): Promise<LaunchOutcome> {
  const entry = resolveEntries().find((item) => item.id === id)
  if (!entry) return 'unknown'

  if (entry.command === null) {
    try {
      const { shell } = await import('electron')
      const failure = await shell.openPath(dir)
      return failure === '' ? 'launched' : 'failed'
    } catch {
      return 'failed'
    }
  }

  try {
    const child = spawn(entry.command, entry.args ? entry.args(dir) : [dir], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: entry.showWindow !== true,
    })
    const failed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 300)
      child.once('error', () => {
        clearTimeout(timer)
        resolve(true)
      })
      child.once('spawn', () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
    child.unref()
    return failed ? 'failed' : 'launched'
  } catch {
    return 'failed'
  }
}