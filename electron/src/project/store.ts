// Projects: the single unit of work grouping one or more directories.
//
// A project replaces the old workspace concept. It owns:
//   - a stable id and a display title;
//   - one or more absolute directories (the model sees all of them);
//   - the sessions created inside it.
//
// Storage: `<home>/projects.json`:
//   { "version": 1, "order": ["<id>", …], "projects": { "<id>": { … } } }
//
// The built-in default project always exists. Sessions that cannot be attached
// to an explicit project (legacy ungrouped sessions, bare `cwd` API calls) land
// there instead of an "ungrouped" bucket.

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { isRecord } from '../core/util.ts'

const DEFAULT_PROJECT_ID = 'default'
const PROJECT_FILE_VERSION = 1

export interface ProjectRecord {
  id: string
  title: string
  /** Absolute directories. Never empty for a stored project. */
  dirs: string[]
  createdAt: number
  /** Session ids in this project, newest first. */
  sessionIds: string[]
  /** The built-in fallback project cannot be deleted. */
  builtin?: 'default'
}

interface ProjectFile {
  version: number
  order: string[]
  projects: Record<string, ProjectRecord>
}

export interface CreateProjectInput {
  title?: string
  /** Absolute directories picked by the user. Empty → a managed directory. */
  dirs?: string[]
}

function uniqueDirs(dirs: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    if (typeof dir !== 'string' || dir.trim() === '') continue
    const normalized = path.resolve(dir.trim())
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}

/** Filesystem-safe folder name derived from a project title. */
function folderName(title: string): string {
  const cleaned = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 48)
  if (cleaned === '') return 'project'
  // Windows device names are not valid directory names.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(cleaned)) return `project-${cleaned}`
  return cleaned
}

/** Pick a directory name that does not collide with an existing path. */
function freeDirectory(parent: string, base: string): string {
  let candidate = path.join(parent, base)
  let index = 2
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${base}-${index}`)
    index += 1
  }
  return candidate
}

/** Create the managed directory for a project that did not pick one. */
function createManagedProjectDir(root: string, title: string): string {
  fs.mkdirSync(root, { recursive: true })
  const dir = freeDirectory(root, folderName(title))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function titleFromDirs(dirs: readonly string[]): string {
  const first = dirs[0]
  if (!first) return '新项目'
  const base = path.basename(first)
  return base === '' ? first : base
}

function normalizeProject(raw: unknown, fallbackId?: string): ProjectRecord | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : fallbackId
  if (!id) return null
  const rawDirs = Array.isArray(raw.dirs)
    ? raw.dirs.filter((entry): entry is string => typeof entry === 'string')
    : []
  // Legacy workspace records stored a single `path`.
  if (rawDirs.length === 0 && typeof raw.path === 'string' && raw.path !== '') {
    rawDirs.push(raw.path)
  }
  const dirs = uniqueDirs(rawDirs)
  if (dirs.length === 0) return null
  const title =
    typeof raw.title === 'string' && raw.title.trim() !== ''
      ? raw.title.trim()
      : titleFromDirs(dirs)
  return {
    id,
    title,
    dirs,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    sessionIds: Array.isArray(raw.sessionIds)
      ? [...new Set(raw.sessionIds.filter((entry): entry is string => typeof entry === 'string'))]
      : [],
    ...(raw.builtin === 'default' || id === DEFAULT_PROJECT_ID
      ? { builtin: 'default' as const }
      : {}),
  }
}

/**
 * Project registry. Loads once at host startup, then persists on every change.
 *
 * Migration: when `projects.json` is absent but the old `workspaces.json`
 * exists, every workspace becomes a project with one directory and keeps its
 * id/session membership. The default project is always appended so the UI has
 * a fallback even on a fresh home.
 */
export class ProjectStore {
  private readonly home: string
  private readonly managedDir: string
  private readonly file: string
  private data: ProjectFile

  constructor(home: string, options: { managedRoot?: string } = {}) {
    this.home = home
    this.managedDir =
      options.managedRoot && options.managedRoot.trim() !== ''
        ? path.resolve(options.managedRoot)
        : path.join(home, 'projects')
    this.file = path.join(home, 'projects.json')
    const loaded = this.load()
    this.data = loaded.data
    const ensured = this.ensureDefaultProject()
    if (loaded.migrated || ensured) this.save()
  }

  private load(): { data: ProjectFile; migrated: boolean } {
    const empty: ProjectFile = { version: PROJECT_FILE_VERSION, order: [], projects: {} }
    if (fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown
        if (isRecord(parsed)) {
          const rawProjects = parsed.projects
          const map: Record<string, ProjectRecord> = {}
          if (isRecord(rawProjects)) {
            for (const [id, entry] of Object.entries(rawProjects)) {
              const project = normalizeProject(entry, id)
              if (project) map[project.id] = project
            }
          } else if (Array.isArray(rawProjects)) {
            for (const entry of rawProjects) {
              const project = normalizeProject(entry)
              if (project) map[project.id] = project
            }
          }
          const order = Array.isArray(parsed.order)
            ? parsed.order.filter((id): id is string => typeof id === 'string' && id in map)
            : []
          for (const id of Object.keys(map)) {
            if (!order.includes(id)) order.push(id)
          }
          return { data: { version: PROJECT_FILE_VERSION, order, projects: map }, migrated: false }
        }
      } catch {
        /* corrupt file: fall through to migration/empty */
      }
      return { data: empty, migrated: false }
    }

    const legacy = this.loadLegacyWorkspaces()
    if (legacy) return { data: legacy, migrated: true }
    return { data: empty, migrated: true }
  }

  private loadLegacyWorkspaces(): ProjectFile | null {
    const file = path.join(this.home, 'workspaces.json')
    if (!fs.existsSync(file)) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    } catch {
      return null
    }
    if (!isRecord(parsed)) return null
    const raw = parsed.workspaces
    const records: ProjectRecord[] = []
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        const project = normalizeProject(entry)
        if (project) records.push(project)
      }
    } else if (isRecord(raw)) {
      for (const [id, entry] of Object.entries(raw)) {
        const project = normalizeProject(entry, id)
        if (project) records.push(project)
      }
    }
    const map: Record<string, ProjectRecord> = {}
    for (const project of records) map[project.id] = project
    const order = Array.isArray(parsed.order)
      ? parsed.order.filter((id): id is string => typeof id === 'string' && id in map)
      : []
    for (const id of Object.keys(map)) {
      if (!order.includes(id)) order.push(id)
    }
    return { version: PROJECT_FILE_VERSION, order, projects: map }
  }

  /** The built-in project that receives sessions without an explicit one. */
  private ensureDefaultProject(): boolean {
    let changed = false
    const existing = this.data.projects[DEFAULT_PROJECT_ID]
    if (existing) {
      // The default project's directory moved from `<home>/projects` to the
      // application installation directory. Copy the old data once, then use
      // the installation path from now on.
      const legacyRoot = path.join(this.home, 'projects')
      if (
        existing.dirs.length === 1 &&
        !isInside(this.managedDir, existing.dirs[0]!) &&
        isInside(legacyRoot, existing.dirs[0]!)
      ) {
        const previous = existing.dirs[0]!
        const next = path.join(this.managedDir, 'default')
        fs.mkdirSync(next, { recursive: true })
        if (fs.existsSync(previous)) {
          try {
            fs.cpSync(previous, next, { recursive: true, force: false, errorOnExist: false })
          } catch {
            /* keep the old data in place; the new directory is still usable */
          }
        }
        existing.dirs = [next]
        changed = true
      }
      // The built-in project's directory is Denia-managed: restore it if the
      // user removed it, so "new session in the default project" never fails.
      for (const dir of existing.dirs) {
        if (isInside(this.managedDir, dir)) fs.mkdirSync(dir, { recursive: true })
      }
      // Keep the fallback at the bottom of the sidebar order.
      const order = this.data.order.filter((id) => id !== DEFAULT_PROJECT_ID)
      order.push(DEFAULT_PROJECT_ID)
      if (order.some((id, index) => id !== this.data.order[index])) {
        this.data.order = order
        changed = true
      }
      return changed
    }
    const dir = path.join(this.managedDir, 'default')
    fs.mkdirSync(dir, { recursive: true })
    this.data.projects[DEFAULT_PROJECT_ID] = {
      id: DEFAULT_PROJECT_ID,
      title: '默认项目',
      dirs: [dir],
      createdAt: Date.now(),
      sessionIds: [],
      builtin: 'default',
    }
    // The default project sits at the bottom: real projects keep the top spot.
    this.data.order.push(DEFAULT_PROJECT_ID)
    return true
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n', 'utf8')
  }

  list(): ProjectRecord[] {
    return this.data.order
      .map((id) => this.data.projects[id])
      .filter((project): project is ProjectRecord => project !== undefined)
  }

  get(id: string | null | undefined): ProjectRecord | undefined {
    if (!id) return undefined
    return this.data.projects[id]
  }

  get default(): ProjectRecord {
    return this.data.projects[DEFAULT_PROJECT_ID]!
  }

  /** Find the project owning a directory, preferring the deepest match. */
  projectForPath(target: string): ProjectRecord | undefined {
    const resolved = path.resolve(target)
    let best: { project: ProjectRecord; length: number } | undefined
    for (const project of Object.values(this.data.projects)) {
      for (const dir of project.dirs) {
        if (!isInside(dir, resolved)) continue
        const length = dir.length
        if (!best || length > best.length) best = { project, length }
      }
    }
    return best?.project
  }

  /**
   * All roots the model may touch for a session: the project's directories,
   * plus the session's own primary directory when it predates the project or
   * was migrated from an ungrouped legacy session.
   */
  rootsOf(project: ProjectRecord | undefined, primary: string): string[] {
    const roots = uniqueDirs([primary, ...(project?.dirs ?? [])])
    return roots.length > 0 ? roots : [path.resolve(primary)]
  }

  create(input: CreateProjectInput): ProjectRecord {
    const picked = uniqueDirs(input.dirs ?? [])
    const requestedTitle = typeof input.title === 'string' ? input.title.trim() : ''
    const title = requestedTitle !== '' ? requestedTitle : titleFromDirs(picked)
    const dirs = picked.length > 0 ? picked : [createManagedProjectDir(this.managedDir, title)]
    const project: ProjectRecord = {
      id: randomUUID(),
      title,
      dirs,
      createdAt: Date.now(),
      sessionIds: [],
    }
    this.data.projects[project.id] = project
    this.data.order = [project.id, ...this.data.order.filter((id) => id !== project.id)]
    this.save()
    return project
  }

  /** Remove a project record. The caller decides what happens to sessions. */
  remove(id: string): boolean {
    const project = this.data.projects[id]
    if (!project || project.builtin === 'default') return false
    delete this.data.projects[id]
    this.data.order = this.data.order.filter((entry) => entry !== id)
    this.save()
    return true
  }

  attachSession(projectId: string, sessionId: string): boolean {
    const project = this.data.projects[projectId]
    if (!project) return false
    let changed = false
    for (const entry of Object.values(this.data.projects)) {
      if (entry.id === projectId) continue
      if (!entry.sessionIds.includes(sessionId)) continue
      entry.sessionIds = entry.sessionIds.filter((id) => id !== sessionId)
      changed = true
    }
    if (!project.sessionIds.includes(sessionId)) {
      project.sessionIds = [sessionId, ...project.sessionIds]
      changed = true
    }
    return changed
  }

  detachSession(sessionId: string): boolean {
    let changed = false
    for (const project of Object.values(this.data.projects)) {
      if (!project.sessionIds.includes(sessionId)) continue
      project.sessionIds = project.sessionIds.filter((id) => id !== sessionId)
      changed = true
    }
    return changed
  }

  projectOfSession(sessionId: string): ProjectRecord | undefined {
    for (const project of Object.values(this.data.projects)) {
      if (project.sessionIds.includes(sessionId)) return project
    }
    return undefined
  }

  /** Managed directory hint shown by the create dialog. */
  managedRoot(): string {
    return this.managedDir
  }
}

/** Component-wise containment, case-insensitive on Windows. */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (relative === '') return true
  if (path.isAbsolute(relative)) return false
  const escapes =
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    (process.platform === 'win32' && relative.startsWith('../'))
  return !escapes
}
