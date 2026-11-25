// Interactive PTY terminals for the console side pane.
//
// This is deliberately separate from the `bash` tool: the tool is a one-shot
// non-interactive command pipeline, while the terminal pane needs a real TTY
// for prompts, colours, Ctrl+C, vim/top and TUI redraws. On Windows that means
// ConPTY, which is what @lydell/node-pty's prebuilt binary uses.
//
// The manager is transport-agnostic: HTTP owns lifecycle, and each WebSocket
// subscriber receives the same event stream. Output is kept as bytes and sent
// as base64 because PTY chunks are not guaranteed to be valid UTF-8 at every
// boundary.

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

import { spawn } from '@lydell/node-pty'
import type { IPty } from '@lydell/node-pty'

import { shellChoice } from '../tools/bash.ts'
import type { ShellChoice } from '../tools/bash.ts'

/** Keep one terminal from exhausting process limits when the UI leaks tabs. */
export const TERMINAL_LIMIT = 32

/** Replay buffer per terminal; enough for a build log, bounded in memory. */
export const SCROLLBACK_LIMIT = 512 * 1024

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const MIN_COLS = 2
const MAX_COLS = 1000
const MIN_ROWS = 1
const MAX_ROWS = 500

const CURSOR_POSITION_QUERY = '\x1b[6n'
const CURSOR_POSITION_REPLY = '\x1b[1;1R'

export interface TerminalInfo {
  id: string
  /** Human-readable shell label, e.g. `PowerShell 7 (pwsh)`. */
  shell: string
  cwd: string
  cols: number
  rows: number
  /** Epoch milliseconds, used for stable ordering and relative labels. */
  createdAt: number
  exitCode?: number
}

export type TerminalEvent =
  | { type: 'terminals-changed' }
  | { type: 'data'; terminalId: string; data: string }
  | { type: 'exit'; terminalId: string; exitCode: number }
  | { type: 'closed'; terminalId: string; reason: string }

type TerminalListener = (event: TerminalEvent) => void

interface TerminalRecord {
  info: TerminalInfo
  process: IPty
  scrollback: Buffer
  /** Guards late onExit notifications after an explicit close. */
  closed: boolean
  /** Tail of the previous output chunk, for a split `CSI 6n`. */
  queryCarry: string
}

export interface TerminalManagerOptions {
  /** Default cwd when the client does not pass one. */
  home: string
  /** Test/deployment seam; defaults to the same shell the `bash` tool uses. */
  shell?: () => ShellChoice
  /** Environment for the PTY; defaults to the host process environment. */
  env?: NodeJS.ProcessEnv
}

/** Append output and trim to the byte limit without cutting a UTF-8 character. */
export function appendScrollback(
  current: Buffer,
  chunk: Buffer,
  limit = SCROLLBACK_LIMIT,
): Buffer {
  if (chunk.length === 0) return current
  const merged = Buffer.concat([current, chunk])
  if (merged.length <= limit) return merged
  let cut = merged.length - limit
  // 0b10xxxxxx is a continuation byte; move forward to the next lead byte.
  while (cut < merged.length && (merged[cut]! & 0xc0) === 0x80) cut += 1
  return merged.subarray(cut)
}

/**
 * Find terminal cursor-position queries and return how many replies are due.
 *
 * PowerShell/PSReadLine blocks on `CSI 6n` before drawing its first prompt.
 * The real terminal emulator (xterm) would answer, but the server has already
 * consumed the query on its way through, so the PTY waits forever unless the
 * server replies. `1;1` is the same safe conservative answer tmux uses.
 */
export function findCursorQueries(
  carry: string,
  chunk: string,
): { replies: number; carry: string } {
  const scan = carry + chunk
  let replies = 0
  let index = 0
  while (true) {
    const found = scan.indexOf(CURSOR_POSITION_QUERY, index)
    if (found === -1) break
    replies += 1
    index = found + CURSOR_POSITION_QUERY.length
  }
  // A query is four characters; keep the largest possible prefix tail.
  return { replies, carry: scan.slice(-(CURSOR_POSITION_QUERY.length - 1)) }
}

export function encodeBase64(bytes: Buffer): string {
  return bytes.toString('base64')
}

/** Strict enough that a malformed WebSocket frame cannot silently become bytes. */
export function decodeBase64(text: string): Buffer {
  const normalized = text.replace(/\s+/g, '')
  if (normalized === '') return Buffer.alloc(0)
  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error('输入不是合法 base64')
  }
  const bytes = Buffer.from(normalized, 'base64')
  if (bytes.toString('base64') !== normalized) throw new Error('输入不是合法 base64')
  return bytes
}

function clampCols(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_COLS
  return Math.max(MIN_COLS, Math.min(MAX_COLS, Math.round(value)))
}

function clampRows(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_ROWS
  return Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.round(value)))
}

/** The shell label the terminal pane shows in its tab. */
export function terminalShellLabel(choice: ShellChoice): string {
  const base = choice.file.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? ''
  switch (base) {
    case 'pwsh':
    case 'pwsh.exe':
      return 'PowerShell 7 (pwsh)'
    case 'powershell':
    case 'powershell.exe':
      return 'Windows PowerShell 5.1'
    case 'cmd':
    case 'cmd.exe':
      return 'cmd'
    case 'wsl':
    case 'wsl.exe':
      return 'WSL'
    case 'bash':
    case 'bash.exe':
      return choice.file.replaceAll('\\', '/').toLowerCase().includes('/git/')
        ? 'Git Bash (bash.exe)'
        : 'bash (bash.exe)'
    default:
      return choice.label || base || choice.file
  }
}

/** A PTY must not inherit the model toolchain's no-colour switches. */
function terminalEnv(base: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...base,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  }
  delete env.NO_COLOR
  delete env.CLICOLOR
  delete env.CLICOLOR_FORCE
  return env
}

export class TerminalManager {
  private readonly home: string
  private readonly shell: () => ShellChoice
  private readonly env: NodeJS.ProcessEnv
  private readonly terminals = new Map<string, TerminalRecord>()
  private readonly events = new EventEmitter()
  private sequence = 0

  constructor(options: TerminalManagerOptions) {
    this.home = options.home
    this.shell = options.shell ?? shellChoice
    this.env = options.env ?? process.env
    this.events.setMaxListeners(0)
  }

  /** Subscribe to the cross-terminal event stream; returns an unsubscribe fn. */
  subscribe(listener: TerminalListener): () => void {
    this.events.on('event', listener)
    return () => this.events.off('event', listener)
  }

  private emit(event: TerminalEvent): void {
    this.events.emit('event', event)
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()]
      .map((record) => ({ ...record.info }))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  snapshot(): { terminals: TerminalInfo[] } {
    return { terminals: this.list() }
  }

  get(id: string): TerminalInfo | undefined {
    const record = this.terminals.get(id)
    return record ? { ...record.info } : undefined
  }

  scrollback(id: string): Buffer | undefined {
    return this.terminals.get(id)?.scrollback
  }

  create(cwd: string | undefined, cols?: number, rows?: number): TerminalInfo {
    const target = path.resolve(cwd?.trim() || this.home)
    let stat: fs.Stats
    try {
      stat = fs.statSync(target)
    } catch {
      throw new Error(`工作目录不存在:${target}`)
    }
    if (!stat.isDirectory()) throw new Error(`工作目录不是目录:${target}`)
    if (this.terminals.size >= TERMINAL_LIMIT) {
      throw new Error(`终端数量已达上限(${TERMINAL_LIMIT} 个)`)
    }

    const size = { cols: clampCols(cols), rows: clampRows(rows) }
    const choice = this.shell()
    const child = spawn(choice.file, choice.interactiveArgs ?? [], {
      name: 'xterm-256color',
      cwd: target,
      cols: size.cols,
      rows: size.rows,
      env: terminalEnv(this.env),
    })

    const info: TerminalInfo = {
      id: `term-${Date.now()}-${this.sequence++}`,
      shell: terminalShellLabel(choice),
      cwd: target,
      cols: size.cols,
      rows: size.rows,
      createdAt: Date.now(),
    }
    const record: TerminalRecord = {
      info,
      process: child,
      scrollback: Buffer.alloc(0),
      closed: false,
      queryCarry: '',
    }
    this.terminals.set(info.id, record)
    this.emit({ type: 'terminals-changed' })

    child.onData((data: string) => {
      if (record.closed) return
      const bytes = Buffer.from(data, 'utf8')
      record.scrollback = appendScrollback(record.scrollback, bytes)
      const query = findCursorQueries(record.queryCarry, data)
      record.queryCarry = query.carry
      if (query.replies > 0) {
        try {
          child.write(CURSOR_POSITION_REPLY.repeat(query.replies))
        } catch {
          /* the shell may have exited between the read and the reply */
        }
      }
      this.emit({ type: 'data', terminalId: info.id, data: encodeBase64(bytes) })
    })

    child.onExit(({ exitCode }) => {
      if (record.closed) return
      record.info.exitCode = exitCode
      this.emit({ type: 'exit', terminalId: info.id, exitCode })
      this.emit({ type: 'terminals-changed' })
    })

    return { ...info }
  }

  write(id: string, data: Buffer): void {
    const record = this.terminals.get(id)
    if (!record) throw new Error(`终端不存在:${id}`)
    if (record.closed || record.info.exitCode !== undefined) throw new Error('终端进程已退出')
    record.process.write(data.toString('utf8'))
  }

  resize(id: string, cols: number, rows: number): void {
    const record = this.terminals.get(id)
    if (!record) throw new Error(`终端不存在:${id}`)
    const next = { cols: clampCols(cols), rows: clampRows(rows) }
    if (record.info.cols === next.cols && record.info.rows === next.rows) return
    record.process.resize(next.cols, next.rows)
    record.info.cols = next.cols
    record.info.rows = next.rows
  }

  close(id: string): void {
    const record = this.terminals.get(id)
    if (!record) throw new Error(`终端不存在:${id}`)
    this.terminals.delete(id)
    record.closed = true
    try {
      record.process.kill()
    } catch {
      /* already exited */
    }
    this.emit({ type: 'closed', terminalId: id, reason: 'closed' })
    this.emit({ type: 'terminals-changed' })
  }

  /** Host shutdown guard: do not leave shell processes behind. */
  closeAll(): void {
    for (const id of [...this.terminals.keys()]) {
      try {
        this.close(id)
      } catch {
        /* best effort during shutdown */
      }
    }
  }
}
