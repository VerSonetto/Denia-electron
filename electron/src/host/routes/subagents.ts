import type { IncomingMessage, ServerResponse } from 'node:http'

import type { SessionDriver } from '../../agent/loop.ts'
import { presetForSession } from '../../agent/presets.ts'
import type { AppConfig } from '../../config.ts'
import { findProvider } from '../../config.ts'
import type { SessionHeader } from '../../core/wire.ts'
import { isRecord } from '../../core/util.ts'
import type { ProjectStore } from '../../project/store.ts'
import type { SessionStore } from '../../session/store.ts'
import { ProfileError, ProfileStore } from '../../subagents/profiles.ts'
import {
  effectivePermissionMode,
  modeOfPermission,
  parentGrant,
  resolveDispatch,
  toolCatalogRows,
} from '../../subagents/resolver.ts'
import type { SubagentRuntime } from '../../subagents/runtime.ts'
import type {
  ProfileColor,
  ProfileWriteScope,
  SubagentProfile,
} from '../../subagents/types.ts'
import { PROFILE_COLORS } from '../../subagents/types.ts'
import { lastSelectionOf, previewFingerprint } from '../helpers.ts'
import { apiError, isDirectory, json, notImplemented, readJson, safeDecode } from '../http.ts'

export interface SubagentsApiContext {
  home: string
  store: SessionStore
  driver: SessionDriver
  profiles: ProfileStore
  subagents: SubagentRuntime
  projects: ProjectStore
  config: () => AppConfig
  describedToolNames: () => string[]
  rootsOfHeader: (header: SessionHeader) => string[]
  broadcast: (event: { type: string; [key: string]: unknown }) => void
}

export async function handleSubagentsApi(
  ctx: SubagentsApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  method: string,
): Promise<boolean> {
  const scopeRoot = (sessionId: string | null, cwd: string | null): string | null => {
    if (sessionId) {
      const header = ctx.store.header(sessionId)
      if (!header) throw new ProfileError('subagent/profile-not-found', `未知的会话:${sessionId}`)
      const dir = ctx.rootsOfHeader(header).find((root) => isDirectory(root))
      if (!dir) {
        throw new ProfileError(
          'subagent/cwd-missing',
          `会话 ${sessionId} 的项目目录都已不存在：${ctx.rootsOfHeader(header).join('、')}`,
        )
      }
      return ProfileStore.projectRoot(dir)
    }
    if (cwd) {
      if (!isDirectory(cwd)) {
        throw new ProfileError('subagent/cwd-missing', `项目目录不存在：${cwd}`)
      }
      return ProfileStore.projectRoot(cwd)
    }
    return null
  }
  const profileError = (error: unknown): void => {
    if (error instanceof ProfileError) {
      const status = error.code === 'subagent/profile-not-found'
        ? 404
        : error.code === 'subagent/profile-exists' ||
            error.code === 'subagent/revision-conflict' ||
            error.code === 'subagent/profile-shadowed'
          ? 409
          : error.code === 'subagent/scope-forbidden'
            ? 403
            : error.code === 'subagent/ambiguous-spec' ||
                error.code === 'subagent/depth-config-removed' ||
                error.code === 'subagent/cwd-missing'
              ? 400
              : 422
      let message = error.message
      if (error.field) message += `（字段：${error.field}）`
      if (error.candidates.length > 0) message += `；可用候选：${error.candidates.join('、')}`
      apiError(res, status, error.code, message)
      return
    }
    apiError(res, 400, 'subagent/invalid', errorMessage(error))
  }
  const profileFromBody = (raw: unknown): {
    profile: SubagentProfile
    body: string
  } => {
    if (!isRecord(raw)) throw new ProfileError('subagent/profile-invalid', 'profile 必须是对象', 'profile')
    const profile: SubagentProfile = {
      schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
      id: typeof raw.id === 'string' ? raw.id : '',
      name: typeof raw.name === 'string' ? raw.name : '',
      description: typeof raw.description === 'string' ? raw.description : '',
      instructions: typeof raw.instructions === 'string' ? raw.instructions : '',
      enabled: raw.enabled !== false,
      tools: isRecord(raw.tools)
        ? raw.tools.mode === 'allowlist'
          ? {
              mode: 'allowlist',
              names: Array.isArray(raw.tools.names)
                ? raw.tools.names.filter((name): name is string => typeof name === 'string')
                : [],
            }
          : { mode: 'inherit' }
        : { mode: 'inherit' },
      model: isRecord(raw.model) && raw.model.mode === 'explicit' && isRecord(raw.model.selection)
        ? {
            mode: 'explicit',
            selection: {
              provider: typeof raw.model.selection.provider === 'string' ? raw.model.selection.provider : '',
              model: typeof raw.model.selection.model === 'string' ? raw.model.selection.model : '',
              ...(typeof raw.model.selection.reasoningEffort === 'string'
                ? { reasoningEffort: raw.model.selection.reasoningEffort }
                : {}),
            },
          }
        : { mode: 'inherit' },
      permissionCeiling: raw.permissionCeiling === 'read-only' ? 'read-only' : 'inherit',
      ...(typeof raw.color === 'string' && (PROFILE_COLORS as string[]).includes(raw.color)
        ? { color: raw.color as ProfileColor }
        : {}),
    }
    return { profile, body: profile.instructions }
  }

  if (pathname === '/api/subagent-profiles' && method === 'GET') {
    try {
      const root = scopeRoot(url.searchParams.get('sessionId'), url.searchParams.get('cwd'))
      const catalog = ctx.profiles.catalog(root)
      json(res, 200, {
        scope: root ? 'project' : 'user',
        projectRoot: catalog.projectRoot,
        projectDir: catalog.projectDir,
        userDir: catalog.userDir,
        revision: catalog.revision,
        effective: catalog.effective,
        shadowed: catalog.shadowed,
        diagnostics: catalog.diagnostics,
        colors: PROFILE_COLORS,
        sources: ['builtin', 'user', 'project'],
      })
    } catch (error) {
      profileError(error)
    }
    return true
  }
  if (pathname === '/api/subagent-profiles' && method === 'POST') {
    try {
      const body = await readJson(req)
      const root = scopeRoot(
        typeof body.sessionId === 'string' ? body.sessionId : null,
        typeof body.cwd === 'string' ? body.cwd : null,
      )
      const scope = body.scope === 'project' ? 'project' : 'user'
      const parsed = profileFromBody(body.profile)
      const view = ctx.profiles.create(scope, root, parsed.profile, parsed.body)
      ctx.broadcast({ type: 'subagents-updated' })
      json(res, 201, { profile: view })
    } catch (error) {
      profileError(error)
    }
    return true
  }
  if (pathname === '/api/subagent-profiles/preview' && method === 'POST') {
    const body = await readJson(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null
    if (!sessionId) {
      json(res, 200, {
        sessionId: null,
        final: false,
        note: '未指定父会话：只能显示定义请求集合，不能判断最终可用工具。',
        requested:
          typeof body.profileId === 'string'
            ? body.profileId
            : isRecord(body.inline) && typeof body.inline.name === 'string'
              ? body.inline.name
              : null,
      })
      return true
    }
    try {
      const header = ctx.store.header(sessionId)
      if (!header) {
        apiError(res, 404, 'subagent/profile-not-found', `未知的会话:${sessionId}`)
        return true
      }
      const root = isDirectory(header.cwd) ? ProfileStore.projectRoot(header.cwd) : null
      const mode = modeOfPermission(ctx.driver.permissionStateOf(sessionId))
      const selection = lastSelectionOf(ctx.store.read(sessionId)?.events ?? [], ctx.config())
      const registered = ctx.describedToolNames()
      const profileId = typeof body.profileId === 'string' ? body.profileId : undefined
      const inline = body.inline
      const resolved = profileId
        ? ctx.profiles.resolve(root, profileId)
        : inline === undefined
          ? ctx.profiles.resolveDefault(root)
          : undefined
      const dispatch = resolveDispatch({
        args: {
          prompt: 'preview',
          ...(profileId ? { profile_id: profileId } : {}),
          ...(inline !== undefined ? { inline } : {}),
        },
        fork: false,
        parent: { registered, mode, selection },
        ...(resolved ? { profile: resolved } : {}),
        defaulted: profileId === undefined && inline === undefined,
      })
      let model = dispatch.selection
      let origin = dispatch.modelOrigin
      let modelFallback: string | null = null
      const provider = findProvider(ctx.config(), model.provider)
      if (!provider || !provider.models.some((entry) => entry.id === model.model)) {
        if (origin === 'profile-explicit') {
          modelFallback = `定义的模型 ${model.provider}/${model.model} 当前不可用，实际会回退为跟随主会话 ${selection.provider}/${selection.model}`
          model = selection
          origin = 'parent'
        } else {
          apiError(res, 400, 'subagent/model-unavailable', `模型 ${model.provider}/${model.model} 当前不可用`)
          return true
        }
      }
      json(res, 200, {
        sessionId,
        final: true,
        profile: {
          qualifiedId: dispatch.qualifiedId,
          name: dispatch.name,
          description: dispatch.description,
          inline: dispatch.inline,
          revision: dispatch.revision,
        },
        tools: dispatch.tools,
        toolCount: dispatch.tools.length,
        model,
        modelOrigin: origin,
        modelFallback,
        permissionCeiling: dispatch.permissionCeiling,
        effectivePermissionMode: effectivePermissionMode(dispatch.permissionCeiling, mode),
        delegationAllowed: false,
        instructionScope: 'project-only',
        fingerprint: previewFingerprint(dispatch.qualifiedId, dispatch.tools, dispatch.instructions),
      })
    } catch (error) {
      profileError(error)
    }
    return true
  }
  const resetMatch = /^\/api\/subagent-profiles\/([^/]+)\/reset$/.exec(pathname)
  if (resetMatch && method === 'POST') {
    try {
      const body = await readJson(req)
      const root = scopeRoot(
        typeof body.sessionId === 'string' ? body.sessionId : null,
        typeof body.cwd === 'string' ? body.cwd : null,
      )
      const scope = body.scope === 'project' ? 'project' : 'user'
      const restored = ctx.profiles.reset(root, safeDecode(resetMatch[1]!), scope)
      ctx.broadcast({ type: 'subagents-updated' })
      json(res, 200, { restored })
    } catch (error) {
      profileError(error)
    }
    return true
  }
  const profileMatch = /^\/api\/subagent-profiles\/([^/]+)$/.exec(pathname)
  if (profileMatch) {
    const qualifiedId = safeDecode(profileMatch[1]!)
    try {
      if (method === 'PUT') {
        const body = await readJson(req)
        const root = scopeRoot(
          typeof body.sessionId === 'string' ? body.sessionId : null,
          typeof body.cwd === 'string' ? body.cwd : null,
        )
        if (typeof body.expectedRevision !== 'number') {
          apiError(res, 400, 'subagent/revision-required', 'expectedRevision 必须是数字')
          return true
        }
        const parsed = profileFromBody(body.profile)
        const view = ctx.profiles.update(root, qualifiedId, parsed.profile, parsed.body, body.expectedRevision)
        ctx.broadcast({ type: 'subagents-updated' })
        json(res, 200, { profile: view })
        return true
      }
      if (method === 'DELETE') {
        const root = scopeRoot(
          url.searchParams.get('sessionId'),
          url.searchParams.get('cwd'),
        )
        const expectedRaw = url.searchParams.get('expectedRevision')
        const expected = expectedRaw === null ? undefined : Number(expectedRaw)
        let scope: ProfileWriteScope | undefined =
          url.searchParams.get('scope') === 'project'
            ? 'project'
            : url.searchParams.get('scope') === 'user'
              ? 'user'
              : undefined
        if (!scope) {
          const catalog = ctx.profiles.catalog(root)
          const view = catalog.effective.find((entry) => entry.qualifiedId === qualifiedId)
          if (!view) {
            throw new ProfileError('subagent/profile-not-found', `未知的子代理定义：${qualifiedId}`)
          }
          scope = ctx.profiles.writeScopeFor(view)
        }
        const restored = ctx.profiles.delete(root, qualifiedId, scope, expected)
        ctx.broadcast({ type: 'subagents-updated' })
        json(res, 200, { restored })
        return true
      }
    } catch (error) {
      profileError(error)
      return true
    }
    notImplemented(res, pathname)
    return true
  }
  if (pathname === '/api/subagent-tools' && method === 'GET') {
    try {
      const sessionId = url.searchParams.get('sessionId')
      const registered = ctx.describedToolNames()
      let grant: string[] | null = null
      if (sessionId) {
        const header = ctx.store.header(sessionId)
        if (!header) {
          apiError(res, 404, 'subagent/profile-not-found', `未知的会话:${sessionId}`)
          return true
        }
        const preset = presetForSession(ctx.home, header, ctx.store.read(sessionId)?.events ?? [])
        grant = parentGrant(
          registered,
          preset.tools,
          modeOfPermission(ctx.driver.permissionStateOf(sessionId)),
          preset.features,
        )
      } else if (url.searchParams.get('cwd')) {
        scopeRoot(null, url.searchParams.get('cwd'))
      }
      json(res, 200, {
        sessionId,
        registered: registered.length,
        tools: toolCatalogRows(registered, grant),
      })
    } catch (error) {
      profileError(error)
    }
    return true
  }

  return false
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
