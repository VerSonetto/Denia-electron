import type { IncomingMessage, ServerResponse } from 'node:http'

import { compactSession } from '../../agent/compact.ts'
import { summarizeContextUsage } from '../../agent/context-usage.ts'
import { deriveSurface } from '../../agent/history.ts'
import type { SessionDriver } from '../../agent/loop.ts'
import type { CompletionLifecycle } from '../../agent/lifecycle.ts'
import { presetSettings } from '../../agent/presets.ts'
import { estimatePressure } from '../../agent/prefix.ts'
import { scheduleSessionTitle } from '../../agent/session-title.ts'
import type { AppConfig } from '../../config.ts'
import { legacyModeOf, presetState, stateFromLegacy } from '../../core/permission.ts'
import { errorMessage } from '../../core/util.ts'
import type { ModelSelection, SessionHeader } from '../../core/wire.ts'
import { GoalCommandError, GoalRuntime } from '../../goal/runtime.ts'
import type { GoalStore } from '../../goal/store.ts'
import type { JobManager } from '../../jobs/manager.ts'
import { isInside } from '../../project/store.ts'
import type { ProjectRecord, ProjectStore } from '../../project/store.ts'
import type { FileHistoryStore } from '../../session/file-history.ts'
import type { SessionStore } from '../../session/store.ts'
import { discoverSkills } from '../../skills/skills.ts'
import type { SubagentRuntime } from '../../subagents/runtime.ts'
import type { ServerApprovalBridge } from '../approval-bridge.ts'
import { followPoll, followSse } from '../events.ts'
import {
  apiError,
  approvalAnswerOf,
  isDirectory,
  json,
  notImplemented,
  parseImages,
  queryNumber,
  readJson,
  safeDecode,
} from '../http.ts'
import { consolePermissionMode, permissionPresetState } from '../permissions.ts'

export interface SessionsApiContext {
  home: string
  store: SessionStore
  driver: SessionDriver
  projects: ProjectStore
  subagents: SubagentRuntime
  jobs: JobManager
  completions: CompletionLifecycle
  goalStore: GoalStore
  fileHistory: FileHistoryStore
  approvalChannel: ServerApprovalBridge | undefined
  goalRuntime: GoalRuntime
  config: () => AppConfig
  broadcast: (event: { type: string; [key: string]: unknown }) => void
  runningSessionIds: () => string[]
  rootsOfHeader: (header: SessionHeader) => string[]
}

export async function handleSessionsApi(
  ctx: SessionsApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  method: string,
): Promise<void> {
  const {
    home,
    store,
    driver,
    projects,
    subagents,
    jobs,
    completions,
    goalStore,
    fileHistory,
    approvalChannel,
    goalRuntime,
    config,
    broadcast,
    runningSessionIds,
    rootsOfHeader,
  } = ctx

    // —— sessions ——
    if (pathname === '/api/sessions') {
      if (method === 'GET') {
        json(res, 200, {
          sessions: store.list().map((summary) => {
            const project =
              projects.get(summary.project_id) ??
              (summary.cwd ? projects.projectForPath(summary.cwd) : undefined) ??
              projects.default
            return { ...summary, project_id: project.id }
          }),
        })
        return
      }
      if (method === 'POST') {
        const body = await readJson(req)
        const projectId = typeof body.projectId === 'string' ? body.projectId : undefined
        const requestedCwd = typeof body.cwd === 'string' ? body.cwd.trim() : ''
        let project: ProjectRecord | undefined
        if (projectId) {
          project = projects.get(projectId)
          if (!project) {
            apiError(res, 404, 'project/not-found', 'project not found')
            return
          }
        } else if (requestedCwd) {
          if (!isDirectory(requestedCwd)) {
            apiError(res, 400, 'session/bad-cwd', `'${requestedCwd}' 不是目录`)
            return
          }
          // Bare `cwd` callers (tests, integrations) still get a project:
          // every session must belong to exactly one project.
          project =
            projects.projectForPath(requestedCwd) ??
            projects.create({ dirs: [requestedCwd] })
        } else {
          project = projects.default
        }
        let cwd = requestedCwd
        if (cwd && projectId && !project.dirs.some((dir) => isInside(dir, cwd))) {
          apiError(res, 400, 'session/cwd-outside-project', '会话目录必须位于项目目录内')
          return
        }
        if (!cwd) cwd = project.dirs[0]!
        if (projectId && !project.dirs.some((dir) => isDirectory(dir))) {
          apiError(res, 400, 'project/no-directory', '项目没有可用目录')
          return
        }
        if (!isDirectory(cwd)) {
          apiError(res, 400, 'session/bad-cwd', `'${cwd}' 不是目录`)
          return
        }
        const preset = typeof body.agentPreset === 'string' && body.agentPreset.trim()
          ? body.agentPreset.trim()
          : presetSettings(home).default
        // 每次创建都重新读设置:进程启动后才改的默认档位必须对这个会话生效,
        // 不能沿用启动时的快照。
        const initial = permissionPresetState(consolePermissionMode(home))
        const header = store.create(cwd, { sandbox: true, projectId: project.id })
        store.append(header.id, { type: 'permission-mode', mode: legacyModeOf(initial) })
        store.append(header.id, {
          type: 'permission-selection',
          sandbox: initial.sandbox,
          approval: initial.approval,
          reviewer: initial.reviewer,
          collaboration: initial.collaboration,
        })
        store.append(header.id, { type: 'agent-preset', preset })
        if (projects.attachSession(project.id, header.id)) projects.save()
        broadcast({ type: 'sessions-updated' })
        json(res, 201, {
          session: {
            id: header.id,
            created_at: header.created_at,
            excerpt: null,
            cwd: header.cwd,
            sandbox: header.sandbox,
            project_id: project.id,
            agent_preset: preset,
          },
          project,
        })
        return
      }
    }

    const sessionMatch = /^\/api\/sessions\/([^/]+)(\/.*)?$/.exec(pathname)
    if (sessionMatch) {
      const sessionId = sessionMatch[1]!
      const rest = sessionMatch[2] ?? ''
      if (!store.header(sessionId)) {
        apiError(res, 404, 'session/not-found', 'session not found')
        return
      }
      if (rest === '' && method === 'GET') {
        const session = store.read(sessionId)
        if (!session) {
          apiError(res, 404, 'session/not-found', 'session not found')
          return
        }
        json(res, 200, session)
        return
      }
      if (rest === '' && method === 'DELETE') {
        if (driver.isRunning(sessionId)) {
          apiError(res, 409, 'session/running', 'cancel the running turn before deleting')
          return
        }
        try {
          subagents.ensureRemovable(sessionId)
        } catch (error) {
          apiError(res, 409, 'session/agents-running', errorMessage(error))
          return
        }
        subagents.removeOwner(sessionId)
        jobs.removeOwner(sessionId)
        completions.forget(sessionId)
        goalStore.remove(sessionId)
        driver.forgetCacheWarm(sessionId)
        store.flush(sessionId)
        store.delete(sessionId)
        fileHistory.forget(sessionId)
        if (projects.detachSession(sessionId)) projects.save()
        broadcast({ type: 'sessions-updated' })
        json(res, 200, { ok: true })
        return
      }
      if (rest === '/events' && method === 'GET') {
        const before = queryNumber(url, 'before')
        const limit = queryNumber(url, 'limit') ?? 500
        const page = store.readPage(sessionId, before, Math.max(1, Math.min(2000, Math.floor(limit))))
        if (!page) {
          apiError(res, 404, 'session/not-found', 'session not found')
          return
        }
        json(res, 200, page)
        return
      }
      if (rest === '/prompt' && method === 'POST') {
        if (driver.isRunning(sessionId)) {
          apiError(res, 409, 'session/running', '上一轮还在运行,请先等待或取消')
          return
        }
        const body = await readJson(req)
        const prompt = typeof body.prompt === 'string' ? body.prompt : ''
        if (prompt.trim() === '') {
          apiError(res, 400, 'prompt/empty', '消息不能为空')
          return
        }
        const selection: ModelSelection | undefined =
          typeof body.provider === 'string' && typeof body.model === 'string'
            ? {
                provider: body.provider,
                model: body.model,
                ...(typeof body.reasoningEffort === 'string'
                  ? { reasoningEffort: body.reasoningEffort }
                  : {}),
              }
            : undefined
        const images = parseImages(body.images)
        const skills = Array.isArray(body.skills)
          ? [...new Set(
              body.skills
                .filter((name): name is string => typeof name === 'string')
                .map((name) => name.trim())
                .filter((name) => name !== ''),
            )]
          : []
        void driver.startTurn(sessionId, prompt, {
          ...(selection ? { selection } : {}),
          ...(images.length > 0 ? { images } : {}),
          ...(skills.length > 0 ? { skills } : {}),
          ...(typeof body.source === 'string' ? { source: body.source } : {}),
        })
        void scheduleSessionTitle({
          store,
          config: config(),
          sessionId,
          ...(selection ? { selection } : {}),
          prompt,
          onUpdated: () => broadcast({ type: 'sessions-updated' }),
        })
        broadcast({ type: 'running-snapshot', ids: runningSessionIds() })
        json(res, 202, { accepted: true })
        return
      }
      if (rest === '/steer' && method === 'POST') {
        if (!driver.isRunning(sessionId)) {
          apiError(res, 409, 'session/not-running', '当前没有可引导的轮次')
          return
        }
        const body = await readJson(req)
        if (typeof body.prompt === 'string' && body.prompt.trim() !== '') {
          store.append(sessionId, { type: 'user-message', text: body.prompt, injected: false })
        }
        json(res, 202, { accepted: true })
        return
      }
      if (rest === '/cancel' && method === 'POST') {
        goalRuntime.pause(sessionId)
        driver.cancel(sessionId)
        json(res, 200, { ok: true })
        return
      }
      if (rest === '/permission' && method === 'PUT') {
        const body = await readJson(req)
        const mode = body.mode
        if (mode === 'read-only' || mode === 'auto-edit' || mode === 'plan' || mode === 'full') {
          const next = stateFromLegacy(mode, driver.permissionStateOf(sessionId))
          store.append(sessionId, { type: 'permission-mode', mode })
          store.append(sessionId, {
            type: 'permission-selection',
            sandbox: next.sandbox,
            approval: next.approval,
            reviewer: next.reviewer,
            collaboration: next.collaboration,
          })
          json(res, 200, { mode, selection: next })
          return
        }
        if (mode === 'approve-for-me') {
          const next = presetState('approve-for-me')
          store.append(sessionId, { type: 'permission-mode', mode: legacyModeOf(next) })
          store.append(sessionId, {
            type: 'permission-selection',
            sandbox: next.sandbox,
            approval: next.approval,
            reviewer: next.reviewer,
            collaboration: next.collaboration,
          })
          json(res, 200, { mode, selection: next })
          return
        }
        // Preset-level write (the agent-mode selector).
        const agentMode = body.agentMode
        if (agentMode === 'read-only' || agentMode === 'project-write' || agentMode === 'approve-for-me' || agentMode === 'full-access') {
          const next = presetState(agentMode)
          store.append(sessionId, { type: 'permission-mode', mode: legacyModeOf(next) })
          store.append(sessionId, {
            type: 'permission-selection',
            sandbox: next.sandbox,
            approval: next.approval,
            reviewer: next.reviewer,
            collaboration: next.collaboration,
          })
          json(res, 200, { agentMode, selection: next })
          return
        }
        apiError(res, 400, 'permission/bad-mode', '未知权限档位')
        return
      }
      if (rest === '/agent-preset' && method === 'PUT') {
        const body = await readJson(req)
        const preset = typeof body.preset === 'string' ? body.preset : 'standard'
        store.append(sessionId, { type: 'agent-preset', preset })
        json(res, 200, { preset })
        return
      }
      if (rest.startsWith('/approvals/') && method === 'POST') {
        const requestId = rest.slice('/approvals/'.length)
        const body = await readJson(req)
        const answer = approvalAnswerOf(body)
        if (!answer) {
          apiError(res, 400, 'approval/bad-decision', "decision must be 'allow-once', 'allow-session', 'reject' or 'cancel'")
          return
        }
        if (!approvalChannel || !approvalChannel.answer(requestId, answer)) {
          apiError(res, 404, 'approval/not-found', '该审批请求不存在或已结算')
          return
        }
        json(res, 200, { ok: true })
        return
      }
      if (rest.startsWith('/asks/') && method === 'POST') {
        json(res, 200, { ok: true })
        return
      }
      if (rest === '/follow' && method === 'GET') {
        followSse(store, req, res, sessionId)
        return
      }
      if (rest === '/follow/poll' && method === 'GET') {
        await followPoll(store, res, sessionId, url)
        return
      }
      if (rest === '/goal' && method === 'GET') {
        json(res, 200, goalRuntime.view(sessionId))
        return
      }
      if (rest === '/goal' && method === 'POST') {
        const body = await readJson(req)
        const action = typeof body.action === 'string' ? body.action : 'set'
        const objective = typeof body.objective === 'string' ? body.objective : ''
        const rawBudget = body.tokenBudget
        const tokenBudget =
          typeof rawBudget === 'number'
            ? rawBudget
            : rawBudget === null
              ? null
              : undefined
        const selection: ModelSelection | undefined =
          typeof body.provider === 'string' && typeof body.model === 'string'
            ? {
                provider: body.provider,
                model: body.model,
                ...(typeof body.reasoningEffort === 'string'
                  ? { reasoningEffort: body.reasoningEffort }
                  : {}),
              }
            : undefined
        if (typeof body.echoText === 'string' && body.echoText.trim() !== '') {
          store.append(sessionId, { type: 'command-run', name: 'goal', text: body.echoText })
        }
        try {
          if (action === 'pause') {
            goalRuntime.pause(sessionId)
          } else if (action === 'clear') {
            goalRuntime.clear(sessionId)
          } else if (action === 'resume') {
            goalRuntime.resume(sessionId, selection)
          } else if (action === 'set' || action === 'edit') {
            if (driver.isRunning(sessionId)) {
              apiError(res, 409, 'session/running', '上一轮还在运行，请先等待或暂停目标')
              return
            }
            goalRuntime.set(sessionId, objective, tokenBudget, selection)
          } else {
            apiError(res, 400, 'goal/bad-action', `未知的目标操作: ${action}`)
            return
          }
        } catch (error) {
          if (error instanceof GoalCommandError) {
            apiError(res, error.status, error.code, error.message)
            return
          }
          throw error
        }
        json(res, 200, goalRuntime.view(sessionId))
        return
      }
      if (rest === '/compact' && method === 'POST') {
        if (driver.isRunning(sessionId)) {
          apiError(res, 409, 'session/running', '会话正在运行，压缩不可用')
          return
        }
        json(res, 202, { accepted: true, id: sessionId })
        driver.cancelCacheWarm(sessionId)
        void compactSession({
          store,
          config: config(),
          sessionId,
          onFailed: (message) =>
            broadcast({ type: 'compaction-failed', id: sessionId, message }),
          onUpdated: () => broadcast({ type: 'sessions-updated' }),
        })
        return
      }
      if (rest === '/context-breakdown' && method === 'GET') {
        const events = store.read(sessionId)?.events ?? []
        const surface = deriveSurface(events)
        let lastWindow: number | undefined
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]!
          if (event.type === 'request-context' && event.context_window) {
            lastWindow = event.context_window
            break
          }
        }
        const pressure = estimatePressure(events, surface, lastWindow)
        const usage = {
          uncachedInputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        }
        for (const event of events) {
          if (event.type !== 'assistant-message' || !event.usage) continue
          usage.uncachedInputTokens += event.usage.inputTokens ?? 0
          usage.outputTokens += event.usage.outputTokens ?? 0
          usage.cacheReadTokens += event.usage.cacheReadTokens ?? 0
          usage.reasoningTokens += event.usage.reasoningTokens ?? 0
        }
        // Total is provider usage; parts estimate the same request surface
        // independently.
        const parts = driver.contextUsage(sessionId)?.parts ?? []
        json(res, 200, {
          breakdown: {
            ...summarizeContextUsage(parts),
            parts,
          },
          pressure: {
            ...(lastWindow ? { contextWindow: lastWindow } : {}),
            ...(pressure
              ? {
                  pressureTokens: pressure.anchorTokens,
                  projectedTokens: pressure.projectedTokens,
                }
              : {}),
          },
          usage,
        })
        return
      }
      if (rest === '/checkpoints' && method === 'GET') {
        const session = store.read(sessionId)
        if (!session) {
          apiError(res, 404, 'session/not-found', 'session not found')
          return
        }
        const checkpoints: { seq: number; time: number; text: string }[] = []
        for (const event of session.events) {
          if (event.type !== 'user-message' || event.injected) continue
          checkpoints.push({ seq: event.seq, time: event.time, text: event.text })
        }
        json(res, 200, { checkpoints })
        return
      }
      const checkpointDiff = /^\/checkpoints\/(\d+)\/diff$/.exec(rest)
      if (checkpointDiff && method === 'GET') {
        const header = store.header(sessionId)!
        const seq = Number(checkpointDiff[1])
        try {
          json(res, 200, { changes: fileHistory.diff(sessionId, rootsOfHeader(header), seq) })
        } catch (error) {
          apiError(res, 400, 'file-history/diff', errorMessage(error))
        }
        return
      }
      if (rest === '/rewind' && method === 'POST') {
        if (driver.isRunning(sessionId)) {
          apiError(res, 409, 'session/running', 'cancel the running turn before rewinding')
          return
        }
        const body = await readJson(req)
        const toSeq = typeof body.toSeq === 'number' ? body.toSeq : Number.NaN
        if (!Number.isInteger(toSeq) || toSeq <= 0) {
          apiError(res, 400, 'session/not-rewind-point', '回退点必须是正整数 seq')
          return
        }
        // Validate the target before touching files: a rejected rewind must not
        // restore half the project.
        const target = store.read(sessionId)?.events.find((event) => event.seq === toSeq)
        if (!target || target.type !== 'user-message' || target.injected) {
          apiError(res, 400, 'session/not-rewind-point', '只能回退到用户消息')
          return
        }
        const header = store.header(sessionId)!
        let changedFiles: string[]
        try {
          // Files first: if restoring fails the conversation log is untouched.
          changedFiles = fileHistory.rewind(sessionId, rootsOfHeader(header), toSeq)
        } catch (error) {
          apiError(res, 400, 'file-history/rewind', errorMessage(error))
          return
        }
        let outcome
        try {
          outcome = store.rewind(sessionId, toSeq)
        } catch (error) {
          apiError(res, 400, 'session/rewind', errorMessage(error))
          return
        }
        // The removed branch may have left paused flags or auto-wake budgets;
        // both point at events that no longer exist on the new branch.
        subagents.onSessionRewound(sessionId)
        driver.forgetCacheWarm(sessionId)
        broadcast({ type: 'sessions-updated' })
        json(res, 200, {
          ok: true,
          toSeq: outcome.toSeq,
          toMessage: outcome.toMessage,
          removedEvents: outcome.removedEvents,
          changedFiles,
        })
        return
      }
      if (rest === '/skills' && method === 'GET') {
        const header = store.header(sessionId)
        const skills = header ? discoverSkills(home, rootsOfHeader(header)).skills : []
        json(res, 200, {
          skills: skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            source: skill.source,
            modelInvocable: skill.modelInvocable,
            userInvocable: skill.userInvocable,
          })),
        })
        return
      }
      if (rest === '/agents' && method === 'GET') {
        json(res, 200, { agents: subagents.list(sessionId) })
        return
      }
      const agentActionMatch = /^\/agents\/([^/]+)\/(message|interrupt)$/.exec(rest)
      if (agentActionMatch && method === 'POST') {
        const target = safeDecode(agentActionMatch[1]!)
        const action = agentActionMatch[2]!
        try {
          if (action === 'message') {
            const body = await readJson(req)
            const message = typeof body.message === 'string' ? body.message : ''
            if (message.trim() === '') {
              apiError(res, 400, 'subagent/message-empty', '消息不能为空')
              return
            }
            json(res, 202, subagents.send(sessionId, target, message))
          } else {
            subagents.interrupt(sessionId, target)
            json(res, 200, { ok: true })
          }
        } catch (error) {
          apiError(res, 400, 'subagent/control-failed', errorMessage(error))
        }
        return
      }
      if (rest === '/jobs' && method === 'GET') {
        json(res, 200, { jobs: jobs.list(sessionId) })
        return
      }
      const jobMatch = /^\/jobs\/([^/]+)\/(output|kill)$/.exec(rest)
      if (jobMatch) {
        const jobId = jobMatch[1]!
        const action = jobMatch[2]
        try {
          if (action === 'output' && method === 'GET') {
            json(res, 200, jobs.peek(jobId, sessionId))
            return
          }
          if (action === 'kill' && method === 'POST') {
            jobs.kill(jobId, sessionId)
            json(res, 200, { ok: true })
            return
          }
        } catch (error) {
          apiError(res, 400, 'job/not-found', errorMessage(error))
          return
        }
      }
      notImplemented(res, pathname)
      return
    }

  notImplemented(res, pathname)
}
