import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

import {
  deleteMemoryFile,
  memoryHealth,
  projectMemoryRoot,
  readMemoryFile,
  rebuildIndex,
  scanManifest,
  searchMemories,
} from '../../context/memory.ts'
import { isRecord } from '../../core/util.ts'
import type { ProjectStore } from '../../project/store.ts'
import {
  deleteSkill,
  getManagedSkill,
  importSkills,
  listManagedSkills,
  saveSkill,
  setSkillEnabled,
} from '../../skills/skills.ts'
import { apiError, json, queryNumber, readJson, safeDecode } from '../http.ts'

export interface SkillsApiContext {
  home: string
  projects: ProjectStore
  broadcast: (event: { type: string; [key: string]: unknown }) => void
}

export async function handleSkillsApi(
  ctx: SkillsApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  method: string,
): Promise<boolean> {
  const skillError = (error: unknown): void => {
    const message = errorMessage(error)
    const status = message.includes('找不到') ? 404 : 400
    apiError(res, status, 'skills/invalid', message)
  }
  const skillCwd = url.searchParams.get('cwd')
  if (pathname === '/api/skills' && method === 'GET') {
    try {
      json(res, 200, {
        skills: listManagedSkills(ctx.home, skillCwd),
        directory: path.join(ctx.home, 'skills'),
      })
    } catch (error) {
      skillError(error)
    }
    return true
  }
  if (pathname === '/api/skills/import' && method === 'POST') {
    try {
      const body = await readJson(req)
      const imported = importSkills(
        ctx.home,
        typeof body.cwd === 'string' ? body.cwd : null,
        typeof body.path === 'string' ? body.path : '',
        body.scope === 'project' ? 'project' : 'user',
      )
      ctx.broadcast({ type: 'skills-updated' })
      json(res, 200, { skills: imported })
    } catch (error) {
      skillError(error)
    }
    return true
  }
  const skillEnabledMatch = /^\/api\/skills\/([^/]+)\/enabled$/.exec(pathname)
  if (skillEnabledMatch && method === 'POST') {
    try {
      const body = await readJson(req)
      const skill = setSkillEnabled(
        ctx.home,
        typeof body.cwd === 'string' ? body.cwd : null,
        safeDecode(skillEnabledMatch[1]!),
        body.enabled !== false,
      )
      ctx.broadcast({ type: 'skills-updated' })
      json(res, 200, { skill })
    } catch (error) {
      skillError(error)
    }
    return true
  }
  const skillMatch = /^\/api\/skills\/([^/]+)$/.exec(pathname)
  if (skillMatch) {
    const name = safeDecode(skillMatch[1]!)
    try {
      if (method === 'GET') {
        json(res, 200, getManagedSkill(ctx.home, skillCwd, name))
        return true
      }
      if (method === 'PUT') {
        const body = await readJson(req)
        if (typeof body.content !== 'string') {
          apiError(res, 400, 'skills/invalid-content', 'content 必须是字符串')
          return true
        }
        const skill = saveSkill(
          ctx.home,
          typeof body.cwd === 'string' ? body.cwd : null,
          name,
          body.content,
          {
            create: body.create === true,
            scope: body.scope === 'project' ? 'project' : 'user',
          },
        )
        ctx.broadcast({ type: 'skills-updated' })
        json(res, 200, { skill })
        return true
      }
      if (method === 'DELETE') {
        deleteSkill(ctx.home, skillCwd, name)
        ctx.broadcast({ type: 'skills-updated' })
        json(res, 200, { ok: true })
        return true
      }
    } catch (error) {
      skillError(error)
      return true
    }
  }

  if (pathname === '/api/memories/projects' && method === 'GET') {
    const rows = ctx.projects.list().map((project) => {
      const root = projectMemoryRoot(ctx.home, project)
      const manifest = scanManifest(root)
      return {
        id: project.id,
        title: project.title,
        path: project.dirs[0] ?? '',
        dirs: project.dirs,
        ...(project.builtin ? { builtin: project.builtin } : {}),
        updatedAt: manifest.updatedAt,
        root: manifest.root,
        index: manifest.index,
        files: manifest.files,
      }
    })
    json(res, 200, { projects: rows })
    return true
  }
  const memoryIdMatch = /^\/api\/memories\/projects\/([^/]+)(\/.*)$/.exec(pathname)
  if (memoryIdMatch) {
    const id = safeDecode(memoryIdMatch[1]!)
    const restPath = memoryIdMatch[2]!
    const project = ctx.projects.get(id)
    if (!project) {
      apiError(res, 404, 'memory/project-not-found', 'project not found')
      return true
    }
    const root = projectMemoryRoot(ctx.home, project)
    if (restPath === '/search' && method === 'GET') {
      const query = url.searchParams.get('q') ?? ''
      const kindRaw = url.searchParams.get('kind')
      const kind =
        kindRaw === 'experience' || kindRaw === 'fact' ? kindRaw : undefined
      const limit = queryNumber(url, 'limit') ?? 20
      const includeSuperseded = url.searchParams.get('include_superseded') === 'true'
      json(res, 200, searchMemories(root, query, limit, kind, includeSuperseded))
      return true
    }
    if (restPath === '/index' && method === 'POST') {
      try {
        json(res, 200, { rebuilt: rebuildIndex(root) })
      } catch (error) {
        apiError(res, 400, 'memory/rebuild-failed', errorMessage(error))
      }
      return true
    }
    if (restPath === '/health' && method === 'GET') {
      json(res, 200, { health: memoryHealth(root) })
      return true
    }
    const file = safeDecode(restPath.replace(/^\/+/, ''))
    try {
      if (method === 'GET') {
        json(res, 200, readMemoryFile(root, file))
        return true
      }
      if (method === 'DELETE') {
        json(res, 200, { deleted: deleteMemoryFile(root, file) })
        return true
      }
    } catch (error) {
      const status = isRecord(error) && typeof error.status === 'number' ? error.status : 400
      apiError(
        res,
        status,
        status === 404 ? 'memory/file-not-found' : status === 413 ? 'memory/file-too-large' : 'memory/bad-path',
        errorMessage(error),
      )
      return true
    }
  }

  return false
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
