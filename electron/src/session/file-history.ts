// File rewind history: back up a file before a tool overwrites it, pin the
// state to every user message (a checkpoint), and restore it on rewind.
//
// Layout: `<home>/file-history/<session_id>/snapshots.json` plus backup files.
// The format matches the Rust host (`message_seq`/`time`/`files`, and
// `backup: null` for "the file did not exist"), so an existing home keeps
// working when the session was created by the other host.
//
// Safety rule for rewinding to a checkpoint that predates a file's first
// tracked edit: that checkpoint has no entry for the file, which does not mean
// "the file did not exist" — it just was never touched by a write tool yet.
// Deleting it would destroy a pre-existing file. Instead the oldest captured
// version of that file is used: files that existed then are restored to that
// content, and only files whose first captured state was "missing" are
// deleted.

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import type { FileHistoryBackend } from '../tools/types.ts'

/** One file at one snapshot time; `backup: null` means the file was missing. */
export interface FileVersion {
  backup: string | null
  version: number
}

/** File state pinned to one user message (seq of that message). */
export interface FileSnapshot {
  message_seq: number
  time: number
  files: Record<string, FileVersion>
}

export interface FileDiffEntry {
  path: string
  action: 'restore' | 'delete'
}

interface SessionHistory {
  cwd: string
  tracked: Set<string>
  /** Versions of the current (not yet closed) snapshot. */
  current: Map<string, FileVersion>
  snapshots: FileSnapshot[]
}

export class FileHistoryStore {
  private readonly root: string
  private readonly sessions = new Map<string, SessionHistory>()

  constructor(home: string) {
    this.root = path.join(home, 'file-history')
  }

  private dirFor(sessionId: string): string {
    return path.join(this.root, sessionId)
  }

  private snapshotsFile(sessionId: string): string {
    return path.join(this.dirFor(sessionId), 'snapshots.json')
  }

  private getOrCreate(sessionId: string, cwd: string): SessionHistory {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const snapshots = readSnapshots(this.snapshotsFile(sessionId))
    const tracked = new Set<string>()
    const current = new Map<string, FileVersion>()
    for (const snapshot of snapshots) {
      for (const [key, version] of Object.entries(snapshot.files)) {
        tracked.add(key)
        current.set(key, version)
      }
    }
    const session: SessionHistory = {
      cwd: path.resolve(cwd),
      tracked,
      current,
      snapshots,
    }
    this.sessions.set(sessionId, session)
    return session
  }

  /** Handle for write/edit tools; throws when a backup cannot be taken. */
  backend(sessionId: string, cwd: string): FileHistoryBackend {
    return {
      trackBeforeWrite: (file: string) => {
        this.trackBeforeWrite(sessionId, cwd, file)
      },
    }
  }

  /** Drop in-memory state when the session is deleted (backups stay on disk). */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  private trackBeforeWrite(sessionId: string, cwd: string, file: string): void {
    const session = this.getOrCreate(sessionId, cwd)
    const key = relativeKey(session.cwd, file)
    const version = captureCurrent(this.dirFor(sessionId), file, session.current.get(key))
    session.tracked.add(key)
    session.current.set(key, version)
    // Same message writing the same file twice keeps the first (pre-message)
    // version: that is the state the checkpoint has to restore.
    const last = session.snapshots[session.snapshots.length - 1]
    if (last && last.files[key] === undefined) {
      last.files[key] = version
      this.persist(sessionId, session)
    }
  }

  /**
   * Called right after a user message is appended: pin the on-disk state of
   * every tracked file to that message's seq.
   */
  snapshot(sessionId: string, cwd: string, messageSeq: number): void {
    const session = this.getOrCreate(sessionId, cwd)
    // Refresh tracked files from disk first: a file untouched by this message
    // still needs its then-current version in the new checkpoint.
    for (const key of [...session.current.keys()]) {
      const file = absolutePathOf(session.cwd, key)
      const version = captureCurrent(this.dirFor(sessionId), file, session.current.get(key))
      session.current.set(key, version)
    }
    const files: Record<string, FileVersion> = {}
    for (const [key, version] of session.current) files[key] = version
    session.snapshots.push({ message_seq: messageSeq, time: Date.now(), files })
    this.persist(sessionId, session)
  }

  /** Files that a rewind to `messageSeq` would change. */
  diff(sessionId: string, cwd: string, messageSeq: number): FileDiffEntry[] {
    const session = this.getOrCreate(sessionId, cwd)
    const targetIndex = this.targetIndex(session, messageSeq)
    if (targetIndex < 0) return []
    const target = session.snapshots[targetIndex]!
    const entries: FileDiffEntry[] = []
    for (const planned of planChanges(this.dirFor(sessionId), session, target)) {
      if (planned.action !== null) {
        entries.push({ path: planned.key, action: planned.action })
      }
    }
    return entries
  }

  /** Restore files to the checkpoint state and drop later snapshots. */
  rewind(sessionId: string, cwd: string, messageSeq: number): string[] {
    const session = this.getOrCreate(sessionId, cwd)
    const targetIndex = this.targetIndex(session, messageSeq)
    if (targetIndex < 0) {
      // A checkpoint without a snapshot (e.g. a steering message appended
      // mid-turn) can still truncate the conversation; files are left alone
      // because there is no state to restore. Drop snapshots of the removed
      // branch so a later checkpoint cannot pick up their versions.
      const kept = session.snapshots.filter((snapshot) => snapshot.message_seq <= messageSeq)
      if (kept.length !== session.snapshots.length) {
        session.snapshots = kept
        this.persist(sessionId, session)
      }
      return []
    }
    const target = session.snapshots[targetIndex]!
    const planned = planChanges(this.dirFor(sessionId), session, target)
    const changed: string[] = []
    // Fail before touching anything when a backup vanished: a half-restored
    // workspace is worse than an explicit error the user can retry after the
    // host rebuilds its history.
    for (const item of planned) {
      if (item.action !== 'restore') continue
      const backup = path.join(this.dirFor(sessionId), item.version.backup!)
      if (!fs.existsSync(backup)) throw new Error(`文件备份缺失: ${item.key}`)
    }
    for (const item of planned) {
      if (item.action === 'restore') {
        const backup = path.join(this.dirFor(sessionId), item.version.backup!)
        fs.mkdirSync(path.dirname(item.file), { recursive: true })
        fs.copyFileSync(backup, item.file)
        changed.push(item.key)
      } else if (item.action === 'delete') {
        fs.rmSync(item.file)
        changed.push(item.key)
      }
    }
    // Keep the target snapshot and everything before it; the rest of the
    // branch no longer exists in the session log.
    session.snapshots.length = targetIndex + 1
    // The next user message starts from the restored state. Files resolved
    // through their oldest version are carried over so they stay tracked.
    session.current = new Map(planned.map((item) => [item.key, item.version]))
    this.persist(sessionId, session)
    return changed
  }

  private targetIndex(session: SessionHistory, messageSeq: number): number {
    for (let index = session.snapshots.length - 1; index >= 0; index -= 1) {
      if (session.snapshots[index]!.message_seq === messageSeq) return index
    }
    return -1
  }

  private persist(sessionId: string, session: SessionHistory): void {
    const dir = this.dirFor(sessionId)
    fs.mkdirSync(dir, { recursive: true })
    const file = this.snapshotsFile(sessionId)
    const temporary = `${file}.${randomUUID()}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(session.snapshots), 'utf8')
    fs.renameSync(temporary, file)
  }
}

interface PlannedChange {
  key: string
  file: string
  version: FileVersion
  action: 'restore' | 'delete' | null
}

/** Resolve what every known file should look like at `target`. */
function planChanges(
  dir: string,
  session: SessionHistory,
  target: FileSnapshot,
): PlannedChange[] {
  const keys = new Set<string>(session.tracked)
  for (const key of Object.keys(target.files)) keys.add(key)
  const planned: PlannedChange[] = []
  for (const key of keys) {
    // A checkpoint from before the file's first tracked edit has no entry.
    // Fall back to the oldest captured state instead of assuming "missing",
    // so a pre-existing file is restored rather than deleted.
    const version = target.files[key] ?? oldestVersion(session, key)
    if (!version) continue
    const file = absolutePathOf(session.cwd, key)
    const stat = statOf(file)
    let action: PlannedChange['action'] = null
    if (version.backup !== null) {
      // Only regular files are overwritten: a path that became a directory
      // (or a dangling symlink target) is left untouched instead of failing
      // the whole rewind halfway through.
      if (stat === null) action = 'restore'
      else if (stat.isFile() && !filesEqual(file, path.join(dir, version.backup))) {
        action = 'restore'
      }
    } else if (stat?.isFile()) {
      action = 'delete'
    }
    planned.push({ key, file, version, action })
  }
  return planned
}

function oldestVersion(session: SessionHistory, key: string): FileVersion | undefined {
  for (const snapshot of session.snapshots) {
    const version = snapshot.files[key]
    if (version) return version
  }
  return undefined
}

/** Workspace-relative key with forward slashes; absolute when outside cwd. */
function relativeKey(cwd: string, file: string): string {
  const relative = path.relative(cwd, file)
  const outside =
    relative === '' ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  const chosen = relative === '' || outside ? path.normalize(file) : relative
  return chosen.split(path.sep).join('/')
}

function absolutePathOf(cwd: string, key: string): string {
  return path.isAbsolute(key) ? path.normalize(key) : path.resolve(cwd, key)
}

function statOf(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

function isRegularFile(file: string): boolean {
  return statOf(file)?.isFile() === true
}

function filesEqual(a: string, b: string): boolean {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b))
  } catch {
    return false
  }
}

/**
 * Normalize the on-disk state of one file into a version. Reuses the current
 * backup when bytes are unchanged, otherwise stores a new backup. A missing
 * file (or a path that is not a regular file) is recorded as `backup: null`.
 */
function captureCurrent(
  dir: string,
  file: string,
  current: FileVersion | undefined,
): FileVersion {
  if (isRegularFile(file)) {
    if (current?.backup) {
      const backup = path.join(dir, current.backup)
      if (filesEqual(file, backup)) return current
    }
    const next = (current?.version ?? 0) + 1
    const name = `${next}-${randomUUID()}`
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(file, path.join(dir, name))
    return { backup: name, version: next }
  }
  if (!current) return { backup: null, version: 1 }
  if (current.backup === null) return current
  return { backup: null, version: current.version + 1 }
}

function readSnapshots(file: string): FileSnapshot[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const snapshots: FileSnapshot[] = []
  for (const item of parsed) {
    if (!isRecord(item)) continue
    if (typeof item.message_seq !== 'number') continue
    if (!isRecord(item.files)) continue
    const files: Record<string, FileVersion> = {}
    for (const [key, value] of Object.entries(item.files)) {
      if (!isRecord(value)) continue
      const backup = typeof value.backup === 'string' ? value.backup : null
      const version = typeof value.version === 'number' ? value.version : 0
      files[key] = { backup, version }
    }
    snapshots.push({
      message_seq: item.message_seq,
      time: typeof item.time === 'number' ? item.time : 0,
      files,
    })
  }
  return snapshots
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}