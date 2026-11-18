import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

import type { SessionDriver } from '../../agent/loop.ts'
import type { CompletionLifecycle } from '../../agent/lifecycle.ts'
import type { GoalStore } from '../../goal/store.ts'
import type { JobManager } from '../../jobs/manager.ts'
import type { ProjectStore } from '../../project/store.ts'
import type { FileHistoryStore } from '../../session/file-history.ts'
import type { SessionStore } from '../../session/store.ts'
import type { SubagentRuntime } from '../../subagents/runtime.ts'
import { listDirectories, listMentions, projectFile, treeListing } from '../fs-api.ts'
import { apiError, isDirectory, json, jsonOrError, readJson } from '../http.ts'

export interface WorkspaceApiContext {
  projects: ProjectStore
  store: SessionStore
  driver: SessionDriver
  subagents: SubagentRuntime
  jobs: JobManager
  completions: CompletionLifecycle
  goalStore: GoalStore
  fileHistory: FileHistoryStore
  broadcast: (event: { type: string; [key: string]: unknown }) => void
}

export async function handleWorkspaceApi(
  ctx: WorkspaceApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  method: string,
): Promise<boolean> {
  if (pathname === '/api/projects') {
    if (method === 'GET') {
      json(res, 200, {
        projects: ctx.projects.list(),
        managedRoot: ctx.projects.managedRoot(),
      })
      return true
    }
    if (method === 'POST') {
      const body = await readJson(req)
      const rawDirs = Array.isArray(body.dirs)
        ? body.dirs.filter((entry): entry is string => typeof entry === 'string')
        : []
      const dirs: string[] = []
      for (const dir of rawDirs) {
        const trimmed = dir.trim()
        if (trimmed === '') continue
        if (!isDirectory(trimmed)) {
          apiError(res, 400, 'project/bad-dir', `'${trimmed}' 不是目录`)
          return true
        }
        if (!dirs.includes(trimmed)) dirs.push(trimmed)
      }
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      const project = ctx.projects.create({ ...(title ? { title } : {}), dirs })
      ctx.broadcast({ type: 'sessions-updated' })
      json(res, 201, { project })
      return true
    }
  }
  const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(pathname)
  if (projectMatch && method === 'DELETE') {
    const id = projectMatch[1]!
    const project = ctx.projects.get(id)
    if (!project) {
      apiError(res, 404, 'project/not-found', 'project not found')
      return true
    }
    if (project.builtin === 'default') {
      apiError(res, 400, 'project/default', '默认项目不能删除')
      return true
    }
    // Deleting a project deletes its sessions (the UI says so); refuse
    // halfway states instead of leaving orphaned logs.
    const ids = new Set(project.sessionIds)
    for (const summary of ctx.store.list()) {
      if (summary.project_id === id) ids.add(summary.id)
    }
    for (const sessionId of ids) {
      if (ctx.driver.isRunning(sessionId)) {
        apiError(res, 409, 'session/running', '项目里还有会话在运行,请先取消')
        return true
      }
      try {
        ctx.subagents.ensureRemovable(sessionId)
      } catch (error) {
        apiError(res, 409, 'session/agents-running', errorMessage(error))
        return true
      }
    }
    for (const sessionId of ids) {
      ctx.subagents.removeOwner(sessionId)
      ctx.jobs.removeOwner(sessionId)
      ctx.completions.forget(sessionId)
      ctx.goalStore.remove(sessionId)
      ctx.driver.forgetCacheWarm(sessionId)
      ctx.store.flush(sessionId)
      ctx.store.delete(sessionId)
      ctx.fileHistory.forget(sessionId)
    }
    ctx.projects.remove(id)
    ctx.broadcast({ type: 'sessions-updated' })
    json(res, 200, { ok: true, deletedSessions: [...ids] })
    return true
  }

  if (pathname === '/api/fs/capability' && method === 'GET') {
    json(res, 200, { kind: 'browse' })
    return true
  }
  if (pathname === '/api/fs/dirs' && method === 'GET') {
    const target = url.searchParams.get('path')
    json(res, 200, listDirectories(target))
    return true
  }
  if (pathname === '/api/fs/pick' && method === 'POST') {
    json(res, 200, { path: null })
    return true
  }
  if (pathname === '/api/fs/pick-files' && method === 'POST') {
    json(res, 200, { paths: [] })
    return true
  }
  if (pathname === '/api/fs/mkdir' && method === 'POST') {
    const body = await readJson(req)
    const dir = typeof body.path === 'string' ? body.path : ''
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!dir || !name) {
      apiError(res, 400, 'fs/bad-request', 'path 与 name 都必填')
      return true
    }
    const created = path.join(dir, name)
    fs.mkdirSync(created, { recursive: true })
    json(res, 200, { path: created })
    return true
  }
  if (pathname === '/api/fs/mentions' && method === 'GET') {
    const root = url.searchParams.get('path') ?? ''
    const query = url.searchParams.get('query') ?? ''
    json(res, 200, { items: listMentions(root, query) })
    return true
  }
  if (pathname === '/api/fs/tree' && method === 'GET') {
    const root = url.searchParams.get('path') ?? ''
    const dir = url.searchParams.get('dir') ?? ''
    jsonOrError(res, () => treeListing(root, dir))
    return true
  }
  if (pathname === '/api/fs/file' && method === 'GET') {
    const root = url.searchParams.get('path') ?? ''
    const file = url.searchParams.get('file') ?? ''
    jsonOrError(res, () => projectFile(root, file))
    return true
  }
  if (pathname.startsWith('/api/fs/preview/')) {
    apiError(res, 404, 'fs/not-found', 'not found')
    return true
  }

  return false
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
